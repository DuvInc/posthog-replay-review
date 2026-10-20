// Step 2, free: one numbered, redacted timeline per session.
//
// The replay digest (what the person did and saw) and the product events (what
// the app recorded: a paywall shown, a checkout started) merged on one clock.
// Lines are numbered so a model can cite them by number and the report can pull
// the exact text back: no model ever writes a quote.
//
// Pure: takes decoded rrweb events and product events, returns text.

import { digest, mmss } from "./rrweb.mjs";
import { redact } from "./redact.mjs";

/**
 * @param {object} input
 * @param {string} input.id
 * @param {object[]} input.events          decoded rrweb events
 * @param {{event: string, t: number, props?: Record<string, unknown>}[]} [input.productEvents]
 * @param {{signals?: string[], goals?: string[]}} [input.candidate]
 * @param {object} [input.digestOptions]
 * @returns {{ id: string, header: string[], lines: {n: number, at: string, kind: string, text: string}[], text: string } | null}
 */
export function buildTimeline({ id, events, productEvents = [], candidate, digestOptions }) {
  if (!events.length) return null;
  const start = events[0].timestamp;
  const end = events[events.length - 1].timestamp;
  const merged = digest(events, digestOptions).map((l) => ({ ...l }));
  let last = null;
  for (const e of productEvents) {
    const props = Object.entries(e.props || {})
      .filter(([, v]) => v !== null && v !== undefined && v !== "")
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    const text = `${e.event}${props ? ` (${props})` : ""}`;
    // The same event fired again with the same facts says nothing new.
    if (text === last) continue;
    last = text;
    merged.push({ t: e.t, kind: "event", text });
  }
  merged.sort((a, b) => a.t - b.t);
  const width = events.find((e) => e.type === 4)?.data?.width;
  const header = [
    `session ${id}`,
    `duration ${mmss(end - start)}, viewport ${width ?? "?"}px wide`,
    candidate ? `signals: ${candidate.signals?.join(" ") || "none"}; goals reached: ${candidate.goals?.join(",") || "none"}` : "signals: not scored",
  ];
  const lines = merged.map((l, i) => ({ n: i + 1, at: mmss(l.t - start), kind: l.kind, text: redact(l.text) }));
  const text = [...header, "", ...lines.map((l) => `${String(l.n).padStart(3)} ${l.at} ${l.kind.padEnd(7)} ${l.text}`)].join("\n") + "\n";
  return { id, header, lines, text };
}

/** Timeline text -> Map(line number -> line), to pull quotes back by number. */
export function linesByNumber(text) {
  const map = new Map();
  for (const line of String(text).split("\n")) {
    const m = /^\s*(\d+) (\d\d:\d\d) (\S+)\s+(.*)$/.exec(line);
    if (m) map.set(Number(m[1]), `${m[2]} ${m[3]} ${m[4]}`);
  }
  return map;
}
