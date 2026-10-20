// The only file in this repository that talks to PostHog.
//
// Everything it does is a read: list recordings, run a HogQL query, download a
// recording's snapshots. It never writes, never creates, never deletes.
//
// The transport is injected (`fetch`, `sleep`), which is how the tests run with
// no key and no network, and how you point it at a proxy instead of PostHog.
//
// Three things here were learned the hard way, on a real project:
//
// 1. Snapshots come in blobs, 20 to 70 per session. One request per blob made
//    about 4,000 requests for 136 sessions and ran into PostHog's 1,200-an-hour
//    cap on a personal API key, with 16 to 27 minute waits. Blobs now go 20 per
//    request, the most the endpoint accepts ("Cannot request more than 20 blob
//    keys at once"): about three requests per session.
// 2. A 429 says when to come back ("Expected available in 960 seconds"). The
//    client waits that long instead of hammering, and says so through `onWait`.
// 3. One request hung for more than twenty minutes with no answer. Every
//    request has a timeout, then a retry.

export const POSTHOG_DEFAULTS = Object.freeze({
  host: "https://us.posthog.com",
  /** Blobs per snapshot request. 20 is PostHog's maximum. */
  blobsPerRequest: 20,
  /** Snapshot requests in flight for one recording. */
  concurrency: 4,
  timeoutMs: 120_000,
  retries: 4,
});

export class PostHogError extends Error {
  constructor(status, path, body) {
    super(`PostHog ${status} on ${path}: ${String(body).slice(0, 300)}`);
    this.name = "PostHogError";
    this.status = status;
  }
}

/**
 * Settings read at call time, never at import: a key cached in a module
 * constant survives a rotation and cannot be overridden in a test.
 */
export function settingsFromEnv(env = process.env) {
  return {
    host: (env.POSTHOG_HOST || POSTHOG_DEFAULTS.host).replace(/\/$/, ""),
    projectId: env.POSTHOG_PROJECT_ID || "",
    apiKey: (env.POSTHOG_API_KEY || "").trim(),
  };
}

/**
 * @param {object} [options]
 * @param {string} [options.host]       e.g. https://eu.posthog.com
 * @param {string} [options.projectId]  the number in your PostHog URL
 * @param {string} [options.apiKey]     a personal API key with read access (phx_...)
 * @param {typeof fetch} [options.fetch]
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @param {(info: { seconds: number, path: string }) => void} [options.onWait]
 */
export function createPostHogClient(options = {}) {
  const env = settingsFromEnv();
  const host = (options.host ?? env.host).replace(/\/$/, "");
  const projectId = options.projectId ?? env.projectId;
  const apiKey = options.apiKey ?? env.apiKey;
  const doFetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const onWait = options.onWait ?? (() => {});
  const timeoutMs = options.timeoutMs ?? POSTHOG_DEFAULTS.timeoutMs;
  const retries = options.retries ?? POSTHOG_DEFAULTS.retries;

  if (!projectId) throw new Error("PostHog project id missing: set POSTHOG_PROJECT_ID or pass projectId.");
  if (!apiKey) throw new Error("PostHog API key missing: set POSTHOG_API_KEY (a personal key with read access) or pass apiKey.");

  async function request(path, init = {}) {
    const url = `${host}/api/projects/${projectId}${path}`;
    for (let attempt = 0; ; attempt++) {
      let response;
      try {
        response = await doFetch(url, {
          ...init,
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", ...(init.headers || {}) },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        // DNS, socket or timeout: retry like a 5xx.
        if (attempt < retries) {
          await sleep(2_000 * (attempt + 1));
          continue;
        }
        throw error;
      }
      if (response.ok) return response;
      const body = await response.text();
      if (response.status === 429 && attempt < retries) {
        const seconds = Number(/available in (\d+)/i.exec(body)?.[1] ?? 60);
        onWait({ seconds, path });
        await sleep((seconds + 5) * 1_000);
        continue;
      }
      if (response.status >= 500 && attempt < retries) {
        await sleep(2_000 * (attempt + 1));
        continue;
      }
      throw new PostHogError(response.status, path, body);
    }
  }

  return {
    /** HogQL query -> rows as objects. */
    async query(hogql) {
      const res = await request("/query/", {
        method: "POST",
        body: JSON.stringify({ query: { kind: "HogQLQuery", query: hogql } }),
      });
      const json = await res.json();
      return (json.results || []).map((row) => Object.fromEntries((json.columns || []).map((c, i) => [c, row[i]])));
    },

    /**
     * Recordings of the last `days`, newest first, up to `limit`.
     * The list answers `has_next` without a `next` URL, so it pages by offset.
     */
    async listRecordings({ days = 7, limit = 500 } = {}) {
      const out = [];
      for (let offset = 0; out.length < limit; offset += 200) {
        const res = await request(`/session_recordings/?date_from=-${days}d&limit=200&offset=${offset}`);
        const json = await res.json();
        out.push(...(json.results || []));
        if (!json.has_next || !(json.results || []).length) break;
      }
      return out.slice(0, limit);
    },

    async recording(id) {
      return (await request(`/session_recordings/${encodeURIComponent(id)}/`)).json();
    },

    /** The blob keys of a recording, sorted. */
    async blobKeys(id) {
      const res = await request(`/session_recordings/${encodeURIComponent(id)}/snapshots?blob_v2=true`);
      const { sources = [] } = await res.json();
      return sources
        .filter((s) => s.source === "blob_v2")
        .map((s) => Number(s.blob_key))
        .sort((a, b) => a - b);
    },

    /**
     * Every snapshot of a recording, as raw JSON lines (feed them to
     * `decodeSnapshots`). Ranges of `blobsPerRequest`, `concurrency` at a time.
     */
    async downloadSnapshots(id, { blobsPerRequest = POSTHOG_DEFAULTS.blobsPerRequest, concurrency = POSTHOG_DEFAULTS.concurrency } = {}) {
      const per = Math.min(Math.max(1, blobsPerRequest), 20);
      const keys = await this.blobKeys(id);
      const ranges = [];
      for (let i = 0; i < keys.length; i += per) ranges.push([keys[i], keys[Math.min(i + per, keys.length) - 1]]);
      const parts = new Array(ranges.length);
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(concurrency, ranges.length) }, async () => {
          while (next < ranges.length) {
            const i = next++;
            const [from, to] = ranges[i];
            const res = await request(
              `/session_recordings/${encodeURIComponent(id)}/snapshots?source=blob_v2&start_blob_key=${from}&end_blob_key=${to}`,
            );
            parts[i] = await res.text();
          }
        }),
      );
      return parts.join("\n");
    },
  };
}
