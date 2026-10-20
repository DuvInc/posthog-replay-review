import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { createJevCompleter } from "../lib/jev.mjs";
import { analyze, triage } from "../lib/review.mjs";
import { buildTimeline } from "../lib/timeline.mjs";
import { recording } from "./fixtures.mjs";

const timeline = () => buildTimeline({ id: "s1", events: recording() });
const reply = (answers, cost = 0.00004) => new Response(JSON.stringify({ answers, usage: { cost } }), { status: 200 });

describe("decision model triage", () => {
  test("sends the session as state and yes/no questions, returns the triage shape", async () => {
    let body;
    const fetch = async (_url, init) => {
      body = JSON.parse(init.body);
      return reply({ worth: { noul: 0.91 }, bug: { noul: 0.2 }, ux_friction: { noul: 0.83 }, blocked_by_price: { noul: 0.4 }, confusion: { noul: 0.1 }, unexpected_use: { noul: 0.02 } });
    };
    const complete = createJevCompleter({ apiKey: "k", fetch });
    const { results, spent } = await triage([timeline()], { product: "A SaaS.", complete, model: "typesafe/jev-1.13" });
    assert.equal(body.model, "typesafe/jev-1.13");
    assert.match(body.state, /tap button "Create workspace"/, "the timeline is the state");
    assert.ok(Object.values(body.questions).every((q) => q.type === "noul"));
    assert.deepEqual(Object.keys(body.questions).sort(), ["blocked_by_price", "bug", "confusion", "unexpected_use", "ux_friction", "worth"]);
    assert.equal(results[0].ok, true);
    assert.deepEqual({ ...results[0].value, reasoning: undefined }, { reasoning: undefined, worth_analysis: true, category: "ux_friction", key_lines: [] });
    assert.equal(spent, 0.00004);
  });

  test("below the threshold a session is skipped as smooth", async () => {
    const complete = createJevCompleter({ apiKey: "k", fetch: async () => reply({ worth: { noul: 0.2 }, bug: { noul: 0.9 } }) });
    const { results } = await triage([timeline()], { product: "A SaaS.", complete });
    assert.equal(results[0].value.worth_analysis, false);
    assert.equal(results[0].value.category, "smooth");
  });

  test("refuses the analysis step, which needs prose", async () => {
    const complete = createJevCompleter({ apiKey: "k", fetch: async () => reply({}) });
    const { results } = await analyze([timeline()], { product: "A SaaS.", complete });
    assert.equal(results[0].ok, false);
    assert.match(results[0].error, /decision model/);
  });

  // A gateway under load answers with an HTML page; say so instead of a parse error.
  test("an HTML error page becomes a readable error", async () => {
    const complete = createJevCompleter({ apiKey: "k", fetch: async () => new Response("<html>Bad gateway</html>", { status: 502 }) });
    const { results } = await triage([timeline()], { product: "A SaaS.", complete });
    assert.match(results[0].error, /Non-JSON response, HTTP 502/);
  });

  test("the dry run prices it like the other models", async () => {
    const r = await triage([timeline()], { product: "A SaaS.", dryRun: true, model: "typesafe/jev-1.13", complete: async () => ({}) });
    assert.ok(r.cost.estimate > 0 && Number.isFinite(r.cost.estimate));
  });
});
