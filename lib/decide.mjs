// A decision model for the triage step: TypeSafe's jev (the default) or any
// other model served on the same decisions endpoint, such as Inception's
// Mercury Decide (`inception/mercury-decide`, or `:free`).
//
// Triage is a yes/no question per session: is this one worth a closer look?
// A decision model answers exactly that kind of question, typed, with a
// probability instead of prose. This adapter sends one session as the `state`
// and a handful of yes/no questions (worth a look, and one per category), and
// returns the same shape the chat triage returns, so the rest of the pipeline
// does not know which one answered.
//
// It speaks OpenRouter's decisions endpoint (see
// https://github.com/DuvInc/jev-table-import-mapper for another use). A
// decision model has no line numbers to give: `key_lines` comes back empty, and
// the analysis step works without it.
//
// Like lib/llm.mjs it is a `complete` function, and the only code here that
// talks to that endpoint. Pass it as `complete` to `triage()`; `analyze()`
// needs prose and refuses it.

export const DECIDE_DEFAULTS = Object.freeze({
  endpoint: "https://openrouter.ai/api/alpha/decisions",
  model: "typesafe/jev-1.13",
  /** Probability above which a session is kept. */
  threshold: 0.5,
});

/** Decision models answer on the decisions endpoint; everything else is a chat model. */
export function isDecisionModel(model) {
  const id = String(model ?? "");
  return id.startsWith("typesafe/") || /-decide(\b|:|-|$)/.test(id);
}

/** Kept for code written against the first name. */
export const createJevCompleter = (options) => createDecisionCompleter(options);
export const JEV_DEFAULTS = DECIDE_DEFAULTS;

const CATEGORIES = {
  blocked_by_price: "The person reached a price, credit or plan limit and stopped there",
  ux_friction: "A control, form or step made the person hesitate, repeat an action or go around",
  bug: "Something broke: an error message, a console error, a control that did nothing",
  confusion: "The person did not understand where to go or what the product does",
  unexpected_use: "The person used the product for something it was not designed for",
};

/**
 * @param {object} [options]
 * @param {typeof fetch} [options.fetch]
 * @param {string} [options.apiKey]
 * @param {string} [options.endpoint]
 * @param {number} [options.threshold]
 */
export function createDecisionCompleter(options = {}) {
  const doFetch = options.fetch ?? globalThis.fetch;
  const endpoint = options.endpoint ?? process.env.DECISIONS_ENDPOINT ?? DECIDE_DEFAULTS.endpoint;
  const threshold = options.threshold ?? DECIDE_DEFAULTS.threshold;

  return async function complete(request) {
    if (request.task !== "triage") {
      throw new Error("A decision model answers yes/no questions: use it for triage, and a chat model for analysis.");
    }
    // Read at call time: a rotated key is picked up, a test can override it.
    const apiKey = options.apiKey ?? (process.env.OPENROUTER_API_KEY || "").trim();
    if (!apiKey) throw new Error("No OPENROUTER_API_KEY for the decision model.");
    const model = isDecisionModel(request.model) ? request.model : DECIDE_DEFAULTS.model;

    const questions = {
      worth: {
        type: "noul",
        instructions: { question: "Does this session show friction, confusion, a bug, an abandon at a decision point, or an unexpected use, worth a founder's attention?" },
        criteria: {
          true: "Something in the timeline is worth reading closely: a problem, a hesitation, a drop at a decision point",
          false: "A smooth session, or too little activity to say anything",
        },
      },
    };
    for (const [id, meaning] of Object.entries(CATEGORIES)) {
      questions[id] = {
        type: "noul",
        instructions: { question: `Is this the main thing that happened in the session: ${meaning.toLowerCase()}?` },
        criteria: { true: meaning, false: "Not the main thing in this session" },
      };
    }

    const response = await doFetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, state: `${request.system}\n\n${request.user}`, questions }),
      signal: AbortSignal.timeout(120_000),
    });
    // Read as text first: a gateway under load answers with an HTML page.
    const raw = await response.text();
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new Error(`Non-JSON response, HTTP ${response.status}: ${raw.slice(0, 200)}`);
    }
    if (!response.ok || body.error) throw new Error(body.error?.message || `HTTP ${response.status}`);

    const p = (id) => Number(body.answers?.[id]?.noul ?? 0);
    const worth = p("worth");
    const [category, pc] = Object.keys(CATEGORIES)
      .map((id) => [id, p(id)])
      .sort((a, b) => b[1] - a[1])[0];
    return {
      value: {
        reasoning: `worth ${worth.toFixed(2)}, ${category} ${pc.toFixed(2)}`,
        worth_analysis: worth >= threshold,
        category: worth >= threshold ? category : "smooth",
        key_lines: [],
      },
      cost: body.usage?.cost ?? 0,
      tier: "decision",
    };
  };
}
