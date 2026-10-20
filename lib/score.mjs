// Step 1, free: hard filters. Which recordings are worth reading at all.
//
// Most recordings are a page view and a bounce. Sending every one of them to a
// model wastes money and, worse, buries the ten sessions that matter. So the
// first cut is deterministic: activity, the app's own URL, and a score from the
// product events of the person during the recording, with weights you set.
//
// Pure. The caller fetches the recordings and the events (see bin/replays.mjs).

export const SCORE_DEFAULTS = Object.freeze({
  /** Recordings with less active time than this are dropped. */
  minActiveSeconds: 15,
  /** Product events that make a session interesting, and how much. */
  signals: { $rageclick: 3, $exception: 2 },
  /** Events that mean the person got what they came for. Lower the score. */
  goals: [],
  goalWeight: -2,
  consoleErrorWeight: 2,
  /** Events are matched to a recording within this margin around it. */
  marginMs: 60_000,
});

/**
 * @param {object[]} recordings  PostHog recording rows (id, start_time, end_time, active_seconds, ...)
 * @param {Map<string, {event: string, t: number}[]>} eventsByPerson  keyed by person id
 * @param {Map<string, string>} personByDistinctId
 * @param {object} config  see SCORE_DEFAULTS, plus optional `startUrlMatch` (a regex source)
 */
export function scoreRecordings(recordings, eventsByPerson, personByDistinctId, config = {}) {
  const c = { ...SCORE_DEFAULTS, ...config, signals: { ...(config.signals ?? SCORE_DEFAULTS.signals) } };
  const urlMatch = c.startUrlMatch ? new RegExp(c.startUrlMatch) : null;
  const out = [];
  for (const r of recordings) {
    if (r.ongoing) continue;
    if ((r.active_seconds ?? 0) < c.minActiveSeconds) continue;
    if (urlMatch && !urlMatch.test(r.start_url || "")) continue;
    const personId = personByDistinctId.get(r.distinct_id) ?? null;
    const from = Date.parse(r.start_time) - c.marginMs;
    const to = Date.parse(r.end_time) + c.marginMs;
    // Server-side events carry no session id, so they are matched by person and
    // time, not by session. That is what lets "checkout_completed", sent by a
    // webhook, count for the session where the person paid.
    const events = (eventsByPerson.get(personId) || []).filter((e) => e.t >= from && e.t <= to).map((e) => e.event);
    const signals = [];
    let score = 0;
    for (const [name, weight] of Object.entries(c.signals)) {
      const n = events.filter((e) => e === name).length;
      if (!n) continue;
      signals.push(`${name}x${n}`);
      score += weight;
    }
    if (r.console_error_count) {
      signals.push(`console_errorsx${r.console_error_count}`);
      score += c.consoleErrorWeight;
    }
    const goals = c.goals.filter((g) => events.includes(g));
    if (goals.length) score += c.goalWeight;
    out.push({
      id: r.id,
      start: r.start_time,
      activeSeconds: r.active_seconds,
      durationSeconds: r.recording_duration,
      startUrl: r.start_url ?? null,
      personId,
      signals,
      goals,
      score,
    });
  }
  return out.sort((a, b) => b.score - a.score || (b.activeSeconds ?? 0) - (a.activeSeconds ?? 0));
}
