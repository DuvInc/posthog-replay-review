// The only file in this repository that talks to a language model.
//
// It speaks the OpenAI chat-completions format with a JSON schema, which
// OpenRouter, OpenAI and most gateways accept. To use something else, write a
// function with this signature and pass it as `complete` to triage/analyze:
//
//   async ({ model, system, user, schema, maxTokens, flex, strict, reasoning }) =>
//     ({ value: object, cost: number, tier: string })
//
// `test/review.test.mjs` does exactly that, which is why the tests need no key.
//
// Things that bit, kept as code:
// - A provider failure can arrive inside an HTTP 200 (`{ error }` in the body),
//   and an empty answer with finish_reason "stop" is billed: both are retried.
// - Inception Mercury answers every `strict: false` schema with "unknown issue
//   with your input" inside a 200. Strict schemas need `additionalProperties:
//   false` and every key in `required`, which is how the triage schema is written.
// - Flex (OpenRouter's `service_tier: "flex"`, about half price on some
//   providers) never falls back by itself: flex twice, then the normal tier.

export const LLM_DEFAULTS = Object.freeze({
  baseUrl: "https://openrouter.ai/api/v1",
  timeoutMs: 180_000,
  attempts: 4,
});

/** Read at call time: a rotated key is picked up, a test can override it. */
const keyFromEnv = () => (process.env.OPENROUTER_API_KEY || process.env.LLM_API_KEY || "").trim();
const baseFromEnv = () => (process.env.LLM_BASE_URL || LLM_DEFAULTS.baseUrl).replace(/\/$/, "");

export const hasKey = () => !!keyFromEnv();

/**
 * @param {object} [options]
 * @param {typeof fetch} [options.fetch]
 * @param {string} [options.apiKey]
 * @param {string} [options.baseUrl]
 * @param {(ms: number) => Promise<void>} [options.sleep]
 */
export function createCompleter(options = {}) {
  const doFetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  async function once(body, { attempts = LLM_DEFAULTS.attempts, timeoutMs = LLM_DEFAULTS.timeoutMs } = {}) {
    const apiKey = options.apiKey ?? keyFromEnv();
    if (!apiKey) throw new Error("No model key: set OPENROUTER_API_KEY (or LLM_API_KEY with LLM_BASE_URL).");
    const baseUrl = (options.baseUrl ?? baseFromEnv()).replace(/\/$/, "");
    let last = "unknown";
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const response = await doFetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const json = await response.json().catch(() => null);
        if (response.ok && json && !json.error) {
          const content = json.choices?.[0]?.message?.content;
          if (content) {
            return { content, cost: json.usage?.cost ?? 0, tier: json.service_tier ?? "default" };
          }
          last = "empty answer";
        } else {
          last = `HTTP ${response.status} ${JSON.stringify(json?.error ?? json)?.slice(0, 200)}`;
          if (response.status >= 400 && response.status < 500 && response.status !== 429) break;
        }
      } catch (error) {
        last = String(error?.message ?? error);
      }
      if (attempt < attempts) await sleep(1_500 * attempt);
    }
    throw new Error(last);
  }

  return async function complete({ model, system, user, schema, maxTokens = 1_200, flex = false, strict = false, reasoning }) {
    const body = {
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: maxTokens,
      usage: { include: true },
      ...(reasoning ? { reasoning } : {}),
      // The schema constrains the decoder. Describing it in the prompt only asks.
      response_format: { type: "json_schema", json_schema: { name: "output", strict, schema } },
      // Without this a provider may ignore the schema silently.
      provider: { require_parameters: true, allow_fallbacks: true },
    };
    let result;
    if (flex) {
      try {
        result = await once({ ...body, service_tier: "flex" }, { attempts: 2, timeoutMs: 240_000 });
      } catch {
        result = await once(body);
      }
    } else {
      result = await once(body);
    }
    let value;
    try {
      value = JSON.parse(result.content);
    } catch {
      throw new Error(`answer is not JSON: ${result.content.slice(0, 120)}`);
    }
    return { value, cost: result.cost, tier: result.tier };
  };
}
