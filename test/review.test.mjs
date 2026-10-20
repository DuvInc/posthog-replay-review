import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { analyze, clip, estimateCost, renderReport, triage, TRIAGE_SCHEMA } from "../lib/review.mjs";
import { createCompleter } from "../lib/llm.mjs";
import { scoreRecordings } from "../lib/score.mjs";
import { buildTimeline } from "../lib/timeline.mjs";
import { recording } from "./fixtures.mjs";

const timeline = () => buildTimeline({ id: "s1", events: recording() });
const product = "A file translation SaaS.";

describe("triage", () => {
  test("keeps valid answers, rejects valid JSON of the wrong shape", async () => {
    const answers = [
      { worth_analysis: true, category: "ux_friction", key_lines: [2, 3], reasoning: "dead button" },
      [2, 3, 4], // seen in a real run: a bare array of line numbers
    ];
    let i = 0;
    const complete = async () => ({ value: answers[i++], cost: 0.0001, tier: "default" });
    const items = [timeline(), { ...timeline(), id: "s2" }];
    const { results, spent } = await triage(items, { product, complete, concurrency: 1 });
    assert.equal(results[0].ok, true);
    assert.equal(results[1].ok, false);
    assert.match(results[1].error, /wrong shape/);
    assert.equal(spent, 0.0002, "a rejected answer was still paid for, and counted");
  });

  test("flags cited lines that do not exist", async () => {
    const complete = async () => ({ value: { worth_analysis: true, category: "bug", key_lines: [1, 999], reasoning: "" }, cost: 0 });
    const { results } = await triage([timeline()], { product, complete });
    assert.deepEqual(results[0].invalidLines, [999]);
  });

  // Inception Mercury rejects every strict:false schema inside an HTTP 200.
  test("asks for a strict schema the provider accepts", async () => {
    let seen;
    await triage([timeline()], { product, complete: async (req) => ((seen = req), { value: { worth_analysis: false, category: "smooth", key_lines: [], reasoning: "" }, cost: 0 }) });
    assert.equal(seen.strict, true);
    assert.equal(TRIAGE_SCHEMA.additionalProperties, false);
    assert.deepEqual([...TRIAGE_SCHEMA.required].sort(), Object.keys(TRIAGE_SCHEMA.properties).sort());
  });
});

describe("budget", () => {
  test("a dry run spends nothing and says what it would cost", async () => {
    let called = false;
    const r = await analyze([timeline()], { product, dryRun: true, complete: async () => ((called = true), {}) });
    assert.equal(called, false);
    assert.equal(r.cost.calls, 1);
    assert.ok(r.cost.estimate > 0 && r.cost.estimate <= r.cost.upperBound);
  });

  test("refuses a batch whose upper bound exceeds the budget", async () => {
    let called = false;
    await assert.rejects(
      analyze([timeline(), timeline()], { product, maxUsd: 0.000001, complete: async () => ((called = true), {}) }),
      (e) => e.code === "over_budget",
    );
    assert.equal(called, false);
  });

  test("flex halves the estimate, never the upper bound", () => {
    const req = { model: "openai/gpt-6-luna", system: "x".repeat(3500), user: "", maxTokens: 0 };
    const normal = estimateCost([req]);
    const flex = estimateCost([{ ...req, flex: true }]);
    assert.equal(flex.estimate, normal.estimate / 2);
    assert.equal(flex.upperBound, normal.upperBound);
  });
});

describe("analysis report", () => {
  test("quotes come from the timeline by number, never from the model", async () => {
    const t = timeline();
    const complete = async () => ({
      value: {
        story: "They tried to create a workspace.",
        outcome: "left_before_value",
        frictions: [{ kind: "ux", severity: "high", what: "The button did nothing visible.", lines: [3, 4], fix: "Show the error under the field." }],
      },
      cost: 0,
    });
    const { results } = await analyze([t], { product, complete });
    const md = renderReport(results, [t]);
    assert.match(md, /\| left_before_value \| 1 \|/);
    assert.match(md, /`3 00:04 click tap button "Create workspace"`/);
    assert.match(md, /`4 00:06 screen no visible change after the click`/);
  });

  test("long timelines keep their head and tail", () => {
    const text = ["session x", "", ...Array.from({ length: 900 }, (_, i) => `${i + 1} 00:00 click x`)].join("\n");
    const { header, body } = clip(text, 400);
    assert.equal(header, "session x");
    assert.match(body, /^1 00:00/);
    assert.match(body, /lines omitted/);
    assert.match(body, /900 00:00 click x$/);
  });
});

describe("score", () => {
  const rec = (id, extra = {}) => ({ id, distinct_id: `d-${id}`, start_time: "2026-10-19T14:00:00Z", end_time: "2026-10-19T14:05:00Z", active_seconds: 60, start_url: "https://app.example.com/new", ...extra });
  const t = Date.parse("2026-10-19T14:02:00Z");

  test("weights signals, lowers goals, drops short and off-app sessions", () => {
    const people = new Map([["d-a", "pa"], ["d-b", "pb"]]);
    const events = new Map([
      ["pa", [{ event: "upgrade_prompt_viewed", t }, { event: "$rageclick", t }]],
      ["pb", [{ event: "upgrade_prompt_viewed", t }, { event: "checkout_completed", t }]],
    ]);
    const out = scoreRecordings(
      [rec("a"), rec("b"), rec("short", { active_seconds: 5 }), rec("site", { start_url: "https://example.com/" })],
      events,
      people,
      { startUrlMatch: "^https://app\\.example\\.com", signals: { $rageclick: 3, upgrade_prompt_viewed: 2 }, goals: ["checkout_completed"] },
    );
    assert.deepEqual(out.map((c) => [c.id, c.score]), [["a", 5], ["b", 0]]);
    assert.deepEqual(out[1].goals, ["checkout_completed"]);
  });

  // Server-side events carry no session id: they count by person and time.
  test("an event outside the recording window does not count", () => {
    const out = scoreRecordings([rec("a")], new Map([["pa", [{ event: "$rageclick", t: t + 3_600_000 }]]]), new Map([["d-a", "pa"]]), { signals: { $rageclick: 3 } });
    assert.equal(out[0].score, 0);
  });
});

describe("llm transport", () => {
  const ok = (content, extra = {}) => new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { cost: 0.001 }, ...extra }), { status: 200 });

  // A provider failure can arrive inside an HTTP 200.
  test("retries an error inside an HTTP 200, and an empty answer", async () => {
    const replies = [new Response(JSON.stringify({ error: { message: "Upstream error" } }), { status: 200 }), ok(""), ok('{"a":1}')];
    const complete = createCompleter({ apiKey: "k", baseUrl: "https://llm.test", sleep: async () => {}, fetch: async () => replies.shift() });
    const r = await complete({ model: "m", system: "s", user: "u", schema: {} });
    assert.deepEqual(r.value, { a: 1 });
    assert.equal(replies.length, 0);
  });

  test("flex falls back to the normal tier", async () => {
    const tiers = [];
    const fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      tiers.push(body.service_tier ?? "normal");
      return body.service_tier === "flex" ? new Response(JSON.stringify({ error: { message: "no capacity" } }), { status: 503 }) : ok('{"b":2}');
    };
    const r = await createCompleter({ apiKey: "k", baseUrl: "https://llm.test", sleep: async () => {}, fetch })({ model: "m", system: "s", user: "u", schema: {}, flex: true });
    assert.deepEqual(r.value, { b: 2 });
    assert.deepEqual(tiers, ["flex", "flex", "normal"]);
  });

  test("sends the schema as response_format, with require_parameters", async () => {
    let body;
    const fetch = async (_url, init) => ((body = JSON.parse(init.body)), ok("{}"));
    await createCompleter({ apiKey: "k", baseUrl: "https://llm.test", fetch })({ model: "m", system: "s", user: "u", schema: { type: "object" }, strict: true });
    assert.equal(body.response_format.json_schema.strict, true);
    assert.deepEqual(body.response_format.json_schema.schema, { type: "object" });
    assert.equal(body.provider.require_parameters, true);
  });
});
