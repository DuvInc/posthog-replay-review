import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { createPostHogClient, PostHogError } from "../lib/posthog.mjs";

/** A fake PostHog: `routes` maps a path pattern to a handler returning [status, body]. */
function fakePostHog(routes) {
  const calls = [];
  const fetch = async (url) => {
    const path = new URL(url).pathname + new URL(url).search;
    calls.push(path);
    for (const [pattern, handler] of routes) {
      const m = path.match(pattern);
      if (m) {
        const [status, body] = await handler(m, path);
        return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
      }
    }
    return new Response("not found", { status: 404 });
  };
  return { fetch, calls };
}

const client = (fake, extra = {}) =>
  createPostHogClient({ host: "https://ph.test", projectId: "42", apiKey: "phx_test", fetch: fake.fetch, sleep: async () => {}, ...extra });

describe("posthog client", () => {
  // One request per blob made ~4,000 requests for 136 sessions and hit the
  // 1,200-an-hour cap. Twenty per request is the endpoint's maximum.
  test("downloads 45 blobs in 3 requests of at most 20, in order", async () => {
    const fake = fakePostHog([
      [/snapshots\?blob_v2=true$/, () => [200, { sources: Array.from({ length: 45 }, (_, i) => ({ source: "blob_v2", blob_key: String(44 - i) })) }]],
      [/start_blob_key=(\d+)&end_blob_key=(\d+)/, (m) => {
        const [from, to] = [Number(m[1]), Number(m[2])];
        if (to - from + 1 > 20) return [400, { detail: "Cannot request more than 20 blob keys at once" }];
        return [200, `range ${from}-${to}`];
      }],
    ]);
    const text = await client(fake).downloadSnapshots("rec1");
    assert.equal(text, "range 0-19\nrange 20-39\nrange 40-44");
    assert.equal(fake.calls.filter((c) => c.includes("start_blob_key")).length, 3);
  });

  test("never asks for more than 20 blobs, whatever it is told", async () => {
    const fake = fakePostHog([
      [/snapshots\?blob_v2=true$/, () => [200, { sources: Array.from({ length: 30 }, (_, i) => ({ source: "blob_v2", blob_key: String(i) })) }]],
      [/start_blob_key=(\d+)&end_blob_key=(\d+)/, (m) => [Number(m[2]) - Number(m[1]) < 20 ? 200 : 400, "ok"]],
    ]);
    await client(fake).downloadSnapshots("rec1", { blobsPerRequest: 50 });
  });

  test("a 429 waits the time PostHog asks for, then retries", async () => {
    let first = true;
    const waits = [];
    const slept = [];
    const fake = fakePostHog([
      [/\/query\//, () => {
        if (first) {
          first = false;
          return [429, { detail: "Request was throttled. Expected available in 960 seconds." }];
        }
        return [200, { columns: ["n"], results: [[1]] }];
      }],
    ]);
    const rows = await client(fake, { onWait: (w) => waits.push(w.seconds), sleep: async (ms) => slept.push(ms) }).query("select 1 as n");
    assert.deepEqual(rows, [{ n: 1 }]);
    assert.deepEqual(waits, [960]);
    assert.deepEqual(slept, [965_000]);
  });

  test("a client error is thrown, not retried", async () => {
    const fake = fakePostHog([[/\/query\//, () => [403, { detail: "forbidden" }]]]);
    await assert.rejects(client(fake).query("select 1"), (e) => e instanceof PostHogError && e.status === 403);
    assert.equal(fake.calls.length, 1);
  });

  // A request once hung for twenty minutes: a network failure is retried.
  test("a network failure is retried", async () => {
    let n = 0;
    const fetch = async () => {
      n++;
      if (n < 3) throw new TypeError("fetch failed");
      return new Response(JSON.stringify({ columns: ["n"], results: [[2]] }), { status: 200 });
    };
    const rows = await createPostHogClient({ host: "https://ph.test", projectId: "1", apiKey: "k", fetch, sleep: async () => {} }).query("q");
    assert.deepEqual(rows, [{ n: 2 }]);
    assert.equal(n, 3);
  });

  // The list answers has_next without a `next` URL: paging is by offset.
  test("lists recordings page by page by offset", async () => {
    const fake = fakePostHog([
      [/session_recordings\/\?date_from=-7d&limit=200&offset=(\d+)/, (m) => {
        const offset = Number(m[1]);
        const results = Array.from({ length: offset === 0 ? 200 : 50 }, (_, i) => ({ id: `r${offset + i}` }));
        return [200, { results, has_next: offset === 0 }];
      }],
    ]);
    const list = await client(fake).listRecordings({ days: 7, limit: 1000 });
    assert.equal(list.length, 250);
    assert.equal(list.at(-1).id, "r249");
  });

  test("refuses to start without a key or a project", () => {
    assert.throws(() => createPostHogClient({ host: "h", projectId: "1", apiKey: "" }), /API key/);
    assert.throws(() => createPostHogClient({ host: "h", projectId: "", apiKey: "k" }), /project id/);
  });
});
