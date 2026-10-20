// Steps 3 and 4, paid: triage with a fast model, analysis with a cheap one.
//
// The rule that shapes everything here: code produces every fact, the model
// only judges. Timelines are numbered; the model cites line numbers; the report
// pulls the exact line text back. A model cannot invent a quote, and a cited
// line that does not exist is flagged instead of trusted.
//
// Pure apart from the injected `complete` (see lib/llm.mjs).

import { linesByNumber } from "./timeline.mjs";

export const REVIEW_DEFAULTS = Object.freeze({
  triageModel: "inception/mercury-2.5",
  analysisModel: "openai/gpt-6-luna",
  /** Dollars per token, input and output. Read from openrouter.ai/api/v1/models on 2026-10-19. */
  prices: {
    "inception/mercury-2.5": [0.04e-6, 0.15e-6],
    "openai/gpt-6-luna": [0.1e-6, 0.5e-6],
  },
  /** Flex tier discount assumed in the estimate; the upper bound ignores it. */
  flexDiscount: 0.5,
  /** Longest timeline sent; longer ones keep their head and tail. */
  maxLines: 400,
  concurrency: 8,
});

const LEGEND =
  "Timeline format: `<line> <mm:ss> <kind> <text>`. kind: nav (page load), click/tap (element and its label), type (typing, content masked), screen (what appeared after an action, or open dialog/toast text), idle (no input), console (browser errors), event (product analytics event).";

// Rules a pilot proved the model needs. Each one is here because a run got it wrong.
const ANALYSIS_RULES = [
  "Typed content is masked: never guess what was typed.",
  "'no visible change after the click' right after a button means the button did nothing the person could see.",
  "A click on a file input or its drop zone opens the system file picker, which the recording cannot show: that is not a friction.",
  "A download button opening nothing visible is expected: the browser saves the file without changing the page.",
  "Screen text in a language other than the interface's can be an i18n defect, or the person's own instruction echoed back: only report it when it is product copy.",
  "Cite moments by line number only. A fix is a product change, not 'investigate'.",
];

export const TRIAGE_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    reasoning: { type: "string", description: "two sentences, 250 characters at most" },
    worth_analysis: { type: "boolean" },
    category: { type: "string", enum: ["blocked_by_price", "ux_friction", "bug", "confusion", "unexpected_use", "smooth", "too_little"] },
    key_lines: { type: "array", items: { type: "integer" }, maxItems: 8 },
  },
  required: ["reasoning", "worth_analysis", "category", "key_lines"],
  additionalProperties: false,
});

export const ANALYSIS_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    story: { type: "string", description: "what the person tried to do and how it ended, 3 sentences, 400 characters at most" },
    outcome: { type: "string", enum: ["converted", "left_at_paywall", "left_before_value", "got_value_free", "still_active", "unclear"] },
    frictions: {
      type: "array",
      maxItems: 6,
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["bug", "ux", "copy", "i18n", "pricing", "performance", "onboarding", "other"] },
          severity: { type: "string", enum: ["high", "medium", "low"] },
          what: { type: "string", description: "200 characters at most" },
          lines: { type: "array", items: { type: "integer" }, minItems: 1, maxItems: 5 },
          fix: { type: "string", description: "200 characters at most" },
        },
        required: ["kind", "severity", "what", "lines", "fix"],
      },
    },
    open_question: { type: "string", description: "what only watching the video or asking the person would settle, 200 characters at most" },
  },
  required: ["story", "outcome", "frictions"],
});

/** Timeline text -> what is sent: the header, then at most `maxLines` lines (head and tail). */
export function clip(text, maxLines = REVIEW_DEFAULTS.maxLines) {
  const all = String(text).trimEnd().split("\n");
  const blank = all.indexOf("");
  const header = all.slice(0, blank < 0 ? 0 : blank);
  const body = all.slice(blank < 0 ? 0 : blank + 1);
  const kept = body.length > maxLines ? [...body.slice(0, maxLines / 2), "... (lines omitted) ...", ...body.slice(-maxLines / 2)] : body;
  return { header: header.join("\n"), body: kept.join("\n") };
}

function triageRequest(product, timeline, model) {
  const { header, body } = clip(timeline.text);
  return {
    model,
    strict: true,
    maxTokens: 300,
    reasoning: { effort: "none" },
    schema: TRIAGE_SCHEMA,
    system: [
      "You triage product session recordings for a founder who will only read the ones that teach something.",
      `Product: ${product}`,
      LEGEND,
      "worth_analysis is true when the session shows friction, confusion, a bug, an abandon at a decision point, or an unexpected use. False for a smooth session or one with too little activity to say anything.",
      "key_lines: the line numbers (at most 8) of the important moments.",
    ].join("\n"),
    user: `${header}\n\n${body}`,
  };
}

function analysisRequest(product, timeline, model, triage) {
  const { header, body } = clip(timeline.text);
  return {
    model,
    flex: true,
    maxTokens: 1_200,
    reasoning: { effort: "none" },
    schema: ANALYSIS_SCHEMA,
    system: [
      "You analyse one product session recording for the founder, as a sharp UX researcher. Facts only: everything you say must be visible in the timeline.",
      `Product: ${product}`,
      LEGEND,
      ...ANALYSIS_RULES,
    ].join("\n"),
    user: `${header}\n${triage ? `Triage: ${triage.category}, key lines ${triage.key_lines.join(",")}\n` : ""}\n${body}`,
  };
}

/**
 * What a batch will cost before it runs. Tokens are estimated at 3.5 characters
 * each, output at half the cap. `upperBound` ignores the flex discount.
 */
export function estimateCost(requests, prices = REVIEW_DEFAULTS.prices, flexDiscount = REVIEW_DEFAULTS.flexDiscount) {
  let estimate = 0;
  let upperBound = 0;
  let tokensIn = 0;
  for (const r of requests) {
    const [pIn, pOut] = prices[r.model] ?? [NaN, NaN];
    const tin = (r.system.length + r.user.length) / 3.5;
    tokensIn += tin;
    const usd = tin * pIn + (r.maxTokens / 2) * pOut;
    upperBound += usd;
    estimate += usd * (r.flex ? flexDiscount : 1);
  }
  return { calls: requests.length, tokensIn: Math.round(tokensIn), estimate, upperBound };
}

async function runAll(requests, complete, concurrency) {
  const results = new Array(requests.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, requests.length) }, async () => {
      while (next < requests.length) {
        const i = next++;
        try {
          results[i] = { ok: true, ...(await complete(requests[i])) };
        } catch (error) {
          results[i] = { ok: false, error: String(error?.message ?? error), cost: 0 };
        }
      }
    }),
  );
  return results;
}

function guardBudget(requests, maxUsd, prices) {
  const cost = estimateCost(requests, prices);
  if (maxUsd !== undefined && cost.upperBound > maxUsd) {
    const error = new Error(`Refused: up to $${cost.upperBound.toFixed(4)} for ${cost.calls} calls exceeds the budget of $${maxUsd}.`);
    error.code = "over_budget";
    error.cost = cost;
    throw error;
  }
  return cost;
}

/**
 * @param {{ id: string, text: string }[]} timelines
 * @param {{ product: string, complete: Function, model?: string, maxUsd?: number, dryRun?: boolean, concurrency?: number, prices?: object }} options
 */
export async function triage(timelines, options) {
  const model = options.model ?? REVIEW_DEFAULTS.triageModel;
  const requests = timelines.map((t) => triageRequest(options.product, t, model));
  const cost = guardBudget(requests, options.maxUsd, options.prices ?? REVIEW_DEFAULTS.prices);
  if (options.dryRun) return { cost, sample: requests[0] ?? null, results: [] };
  const raw = await runAll(requests, options.complete, options.concurrency ?? REVIEW_DEFAULTS.concurrency);
  const results = raw.map((r, i) => {
    const out = { id: timelines[i].id, ...r };
    // Valid JSON of the wrong shape is the one failure a schema does not stop:
    // seen as a bare array of line numbers, twice in 27 calls.
    if (r.ok && (typeof r.value?.worth_analysis !== "boolean" || !Array.isArray(r.value?.key_lines))) {
      return { id: out.id, ok: false, error: `wrong shape: ${JSON.stringify(r.value).slice(0, 160)}`, cost: r.cost };
    }
    if (r.ok) out.invalidLines = invalidLines(timelines[i].text, r.value.key_lines);
    return out;
  });
  return { cost, spent: results.reduce((s, r) => s + (r.cost || 0), 0), results };
}

/**
 * @param {{ id: string, text: string }[]} timelines
 * @param {{ product: string, complete: Function, triage?: object[], model?: string, maxUsd?: number, dryRun?: boolean, concurrency?: number, prices?: object }} options
 */
export async function analyze(timelines, options) {
  const model = options.model ?? REVIEW_DEFAULTS.analysisModel;
  const triageById = new Map((options.triage || []).filter((t) => t.ok).map((t) => [t.id, t.value]));
  const requests = timelines.map((t) => analysisRequest(options.product, t, model, triageById.get(t.id)));
  const cost = guardBudget(requests, options.maxUsd, options.prices ?? REVIEW_DEFAULTS.prices);
  if (options.dryRun) return { cost, sample: requests[0] ?? null, results: [] };
  const raw = await runAll(requests, options.complete, options.concurrency ?? REVIEW_DEFAULTS.concurrency);
  const results = raw.map((r, i) => {
    const out = { id: timelines[i].id, ...r };
    if (r.ok && (!Array.isArray(r.value?.frictions) || typeof r.value?.story !== "string")) {
      return { id: out.id, ok: false, error: `wrong shape: ${JSON.stringify(r.value).slice(0, 160)}`, cost: r.cost };
    }
    if (r.ok) out.invalidLines = invalidLines(timelines[i].text, r.value.frictions.flatMap((f) => f.lines || []));
    return out;
  });
  return { cost, spent: results.reduce((s, r) => s + (r.cost || 0), 0), results };
}

function invalidLines(text, cited) {
  const known = linesByNumber(text);
  const bad = (cited || []).filter((n) => !known.has(n));
  return bad.length ? bad : undefined;
}

/**
 * Analysis results -> a Markdown report. Every quote is the timeline line
 * itself, pulled by number.
 */
export function renderReport(analysis, timelines) {
  const byId = new Map(timelines.map((t) => [t.id, linesByNumber(t.text)]));
  const ok = analysis.filter((r) => r.ok);
  const outcomes = {};
  for (const r of ok) outcomes[r.value.outcome] = (outcomes[r.value.outcome] || 0) + 1;
  const md = [
    "# Session replay review",
    "",
    `${ok.length} sessions analysed${analysis.length > ok.length ? `, ${analysis.length - ok.length} failed` : ""}.`,
    "",
    "| Outcome | Sessions |",
    "| :--- | ---: |",
    ...Object.entries(outcomes)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `| ${k} | ${v} |`),
    "",
  ];
  const order = { high: 0, medium: 1, low: 2 };
  for (const r of ok) {
    const lines = byId.get(r.id) ?? new Map();
    md.push(`## ${r.id} (${r.value.outcome})`, "", r.value.story, "");
    for (const f of [...r.value.frictions].sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3))) {
      md.push(`- **${f.severity} · ${f.kind}**: ${f.what}`, `  - Fix: ${f.fix}`);
      for (const n of f.lines) if (lines.has(n)) md.push(`  - \`${n} ${lines.get(n).slice(0, 160)}\``);
    }
    if (r.value.open_question) md.push("", `Open question: ${r.value.open_question}`);
    if (r.invalidLines) md.push("", `(cited lines not in the timeline: ${r.invalidLines.join(", ")})`);
    md.push("");
  }
  return md.join("\n");
}
