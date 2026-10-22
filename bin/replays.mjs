#!/usr/bin/env node
// The command line: the four steps, in order, writing everything under --out.
//
//   replays candidates [--days 7] [--limit 500]       free: hard filters
//   replays timelines  [--top 20 | --all | --ids a,b] free: download and digest
//   replays triage     [--dry-run] [--max-usd 0.05]   paid: fast model, worth reading?
//   replays analyze    [--dry-run] [--max-usd 0.10] [--all]  paid: cheap model, frictions
//   replays player <id>                               free: a local page that replays one session
//
// Common: --config replays.config.json (default) and --out replays-out (default).
// Keys come from the environment or a .env next to where you run it.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  analyze,
  buildTimeline,
  createCompleter,
  createDecisionCompleter,
  isDecisionModel,
  createPostHogClient,
  decodeSnapshots,
  renderReport,
  REVIEW_DEFAULTS,
  scoreRecordings,
  triage,
} from "../lib/index.mjs";

const here = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    const [key, value] = a.slice(2).split("=");
    if (value !== undefined) out[key] = value;
    else if (argv[i + 1] && !argv[i + 1].startsWith("--")) out[key] = argv[++i];
    else out[key] = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const command = args._[0];
if (existsSync(".env")) process.loadEnvFile(".env");

const configPath = resolve(args.config ?? "replays.config.json");
const out = resolve(args.out ?? "replays-out");
const log = (...parts) => console.error(...parts);

function loadConfig() {
  if (!existsSync(configPath)) {
    log(`No config at ${configPath}. Copy examples/replays.config.example.json and describe your product.`);
    process.exit(1);
  }
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  if (!config.product) {
    log("The config needs `product`: one or two sentences on what the product does and how it charges.");
    process.exit(1);
  }
  return config;
}

const readJson = (file, fallback) => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : fallback);
const quote = (s) => `'${String(s).replace(/'/g, "")}'`;

function posthog() {
  return createPostHogClient({ onWait: ({ seconds }) => log(`PostHog rate limit: waiting ${seconds}s as it asks`) });
}

async function candidates() {
  const config = loadConfig();
  const ph = posthog();
  const days = Number(args.days ?? config.days ?? 7);
  const recordings = await ph.listRecordings({ days, limit: Number(args.limit ?? 500) });
  log(`${recordings.length} recordings in the last ${days} days`);

  const distinctIds = [...new Set(recordings.map((r) => r.distinct_id))];
  const personByDistinctId = new Map();
  for (let i = 0; i < distinctIds.length; i += 200) {
    const list = distinctIds.slice(i, i + 200).map(quote).join(",");
    const rows = await ph.query(
      `select distinct_id, any(person_id) as p from events where distinct_id in (${list}) and timestamp > now() - interval ${days + 1} day group by distinct_id`,
    );
    for (const row of rows) personByDistinctId.set(row.distinct_id, String(row.p));
  }
  const personIds = [...new Set(personByDistinctId.values())];
  const skip = ["$autocapture", "$pageleave", "$set", "$groupidentify", "$identify", "$feature_flag_called", "$web_vitals", "$snapshot"];
  const eventsByPerson = new Map();
  for (let i = 0; i < personIds.length; i += 200) {
    const list = personIds.slice(i, i + 200).map(quote).join(",");
    const rows = await ph.query(
      `select toString(person_id) as p, event, toUnixTimestamp64Milli(timestamp) as t from events where toString(person_id) in (${list}) and timestamp > now() - interval ${days + 1} day and event not in (${skip.map(quote).join(",")}) order by timestamp limit 100000`,
    );
    for (const row of rows) {
      if (!eventsByPerson.has(row.p)) eventsByPerson.set(row.p, []);
      eventsByPerson.get(row.p).push({ event: row.event, t: Number(row.t) });
    }
  }
  const scored = scoreRecordings(recordings, eventsByPerson, personByDistinctId, config);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "candidates.json"), JSON.stringify(scored, null, 1));
  const positive = scored.filter((c) => c.score > 0);
  log(`${scored.length} pass the filters, ${positive.length} with a positive score -> ${join(out, "candidates.json")}`);
  for (const c of positive.slice(0, 15)) console.log(`${String(c.score).padStart(3)}  ${c.id}  ${c.start.slice(0, 16)}  ${c.activeSeconds}s  ${c.signals.join(" ")}`);
}

async function timelines() {
  const config = loadConfig();
  const ph = posthog();
  const cands = readJson(join(out, "candidates.json"), []);
  const ids = args.ids
    ? String(args.ids).split(",")
    : args.all
      ? cands.map((c) => c.id)
      : cands.filter((c) => c.score > 0).slice(0, Number(args.top ?? 20)).map((c) => c.id);
  if (!ids.length) {
    log("No session selected: run `replays candidates` first, or pass --ids.");
    process.exit(1);
  }
  const cacheDir = join(out, "cache");
  const dir = join(out, "timelines");
  mkdirSync(cacheDir, { recursive: true });
  mkdirSync(dir, { recursive: true });
  const props = config.eventProperties ?? [];
  let next = 0;
  const failed = [];
  await Promise.all(
    Array.from({ length: Number(args.parallel ?? 2) }, async () => {
      while (next < ids.length) {
        const id = ids[next++];
        const started = Date.now();
        try {
          const cache = join(cacheDir, `${id}.jsonl`);
          const raw = existsSync(cache) ? readFileSync(cache, "utf8") : await ph.downloadSnapshots(id);
          if (!existsSync(cache)) writeFileSync(cache, raw);
          const events = decodeSnapshots(raw);
          if (!events.length) {
            log(`${id}: empty recording, skipped`);
            continue;
          }
          const cand = cands.find((c) => c.id === id);
          const personId = cand?.personId ?? (await ph.recording(id)).person?.uuid;
          let productEvents = [];
          if (personId) {
            const start = events[0].timestamp - 60_000;
            const end = events[events.length - 1].timestamp + 60_000;
            const select = props.map((p) => `properties.${p} as ${p}`).join(", ");
            const rows = await ph.query(
              `select event, toUnixTimestamp64Milli(timestamp) as t${select ? `, ${select}` : ""} from events where toString(person_id) = ${quote(personId)} and timestamp between fromUnixTimestamp64Milli(${start}) and fromUnixTimestamp64Milli(${end}) and (not startsWith(event, '$') or event in ('$rageclick', '$exception')) order by timestamp`,
            );
            productEvents = rows.map((r) => ({ event: r.event, t: Number(r.t), props: Object.fromEntries(props.map((p) => [p, r[p]])) }));
          }
          const timeline = buildTimeline({ id, events, productEvents, candidate: cand });
          writeFileSync(join(dir, `${id}.txt`), timeline.text);
          log(`${id}: ${timeline.lines.length} lines, ${(raw.length / 1e6).toFixed(1)} MB, ${((Date.now() - started) / 1000).toFixed(0)}s`);
        } catch (error) {
          failed.push(id);
          log(`${id}: failed, ${String(error.message ?? error).slice(0, 200)} (a rerun reuses the cache)`);
        }
      }
    }),
  );
  log(`${ids.length - failed.length} of ${ids.length} timelines in ${dir}. Read two by hand before paying for anything.`);
}

function loadTimelines(selected) {
  const dir = join(out, "timelines");
  if (!existsSync(dir)) {
    log("No timelines: run `replays timelines` first.");
    process.exit(1);
  }
  const all = readdirSync(dir)
    .filter((f) => f.endsWith(".txt"))
    .map((f) => ({ id: f.slice(0, -4), text: readFileSync(join(dir, f), "utf8") }));
  return selected ? all.filter((t) => selected.has(t.id)) : all;
}

function report(stage, result) {
  const { cost } = result;
  log(`${stage}: ${cost.calls} calls, ~${cost.tokensIn} input tokens, estimated $${cost.estimate.toFixed(4)} (at most $${cost.upperBound.toFixed(4)})`);
}

async function runStage(stage) {
  const config = loadConfig();
  const maxUsd = args["max-usd"] !== undefined ? Number(args["max-usd"]) : undefined;
  const dryRun = Boolean(args["dry-run"]);
  const complete = createCompleter();
  // Triage defaults to a decision model (jev); another decision model such as
  // "inception/mercury-decide" uses the same endpoint, and a chat model goes
  // through lib/llm.mjs. Analysis always needs a chat model.
  const triageModel = args["triage-model"] ?? config.triageModel ?? REVIEW_DEFAULTS.triageModel;
  const triageComplete = isDecisionModel(triageModel)
    ? createDecisionCompleter({ threshold: config.triageThreshold })
    : complete;
  let result;
  try {
    if (stage === "triage") {
      const items = loadTimelines();
      if (items.length > 10 && !args.full && !dryRun) {
        log(`${items.length} sessions: run a pilot of ten or fewer first, read it, then pass --full.`);
        process.exit(1);
      }
      result = await triage(items, { product: config.product, complete: triageComplete, model: triageModel, maxUsd, dryRun, prices: config.prices });
    } else {
      const triaged = readJson(join(out, "triage.json"), []);
      const keep = args.all ? null : new Set(triaged.filter((t) => t.ok && t.value.worth_analysis).map((t) => t.id));
      const items = loadTimelines(keep);
      if (!items.length) {
        log("Nothing to analyse: run `replays triage`, or pass --all.");
        process.exit(1);
      }
      result = await analyze(items, { product: config.product, notes: config.notes ?? [], complete, triage: triaged, model: config.analysisModel, maxUsd, dryRun, prices: config.prices });
      if (!dryRun) writeFileSync(join(out, "report.md"), renderReport(result.results, items));
    }
  } catch (error) {
    if (error.code === "over_budget") {
      log(error.message);
      process.exit(2);
    }
    throw error;
  }
  report(stage, result);
  if (dryRun) {
    log("--- first request, user message (600 characters) ---");
    log(result.sample?.user.slice(0, 600) ?? "(none)");
    return;
  }
  // Written before anything else can fail: these calls are paid for.
  writeFileSync(join(out, `${stage === "triage" ? "triage" : "analysis"}.json`), JSON.stringify(result.results, null, 1));
  const failed = result.results.filter((r) => !r.ok);
  log(`measured cost $${result.spent.toFixed(5)}, ${failed.length} failed`);
  for (const f of failed) log(`  ${f.id}: ${f.error.slice(0, 160)}`);
  if (stage === "triage") {
    for (const r of result.results.filter((x) => x.ok)) console.log(`${r.value.worth_analysis ? "KEEP" : "skip"}  ${r.id}  ${r.value.category.padEnd(16)} ${r.value.reasoning}`);
  } else {
    log(`report: ${join(out, "report.md")}`);
  }
}

function player() {
  const id = args._[1];
  if (!id) {
    log("Usage: replays player <recording id> (after `replays timelines` has cached it)");
    process.exit(1);
  }
  const cache = join(out, "cache", `${id}.jsonl`);
  if (!existsSync(cache)) {
    log(`Not cached: run \`replays timelines --ids ${id}\` first.`);
    process.exit(1);
  }
  const events = decodeSnapshots(readFileSync(cache, "utf8"));
  const template = readFileSync(join(here, "..", "demo", "player.html"), "utf8");
  // `</` in recorded text would close the script tag early.
  const page = template.replace("/*EVENTS*/[]", JSON.stringify(events).replace(/<\//g, "<\\/"));
  const file = join(out, "player", `${id}.html`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, page);
  log(`${file}\nOpen it through a local server (it loads rrweb-player from a CDN): python3 -m http.server --directory ${dirname(file)} 8799`);
}

const commands = { candidates, timelines, triage: () => runStage("triage"), analyze: () => runStage("analyze"), player };
if (!commands[command]) {
  log("Usage: replays <candidates|timelines|triage|analyze|player> [options]. See README.md.");
  process.exit(command ? 1 : 0);
}
try {
  await commands[command]();
} catch (error) {
  // A missing key or a refused request is a message, not a stack trace.
  log(String(error?.message ?? error));
  process.exit(1);
}
