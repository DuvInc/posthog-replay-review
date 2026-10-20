---
name: posthog-replay-review
description: Review a product's PostHog session replays to find why people leave, where they get stuck and what to fix - hard filters, readable timelines rebuilt from rrweb in code, a fast-model triage, a cheap-model analysis and a report whose quotes come from the timelines. Use when asked to look at replays, explain what a user did, find friction in onboarding or at a paywall, or review a week of sessions. Not for aggregate funnels or traffic numbers. Spends money on the two model steps: dry run and a stated budget first.
---

# Review PostHog session replays

> [!IMPORTANT]
> The `triage` and `analyze` steps call a paid model and send text describing
> what real people did. Before each one: run it with `--dry-run`, tell the person
> the number of calls and the estimated cost, and wait for an explicit yes. Then
> run it with `--max-usd` set to the budget they gave. The other steps are free
> and read only.

## Before you start

- A PostHog personal API key with read access to recordings and queries, the
  host and the project id, in `.env` (see `.env.example`).
- An OpenRouter key for the paid steps, or another OpenAI-compatible gateway
  (`LLM_BASE_URL`, `LLM_API_KEY`) whose models accept a JSON schema.
- A `replays.config.json` copied from `examples/`: one or two sentences on the
  product and how it charges (the models read it), the app's URL pattern, and the
  product events that mark a decision, with weights.
- Output goes to `replays-out/`. It contains personal data: keep it local.

## Workflow

1. **Hard filters (free).**
   ```bash
   node bin/replays.mjs candidates --days 7
   ```
   Prints the best-scored sessions. If almost everything scores zero, the config
   is missing the product's decision events: add them before going further.
2. **Timelines (free).**
   ```bash
   node bin/replays.mjs timelines --top 20      # or --all, or --ids a,b
   ```
   About 3 requests per session. PostHog's rate limit can impose a wait; the CLI
   honours it and a rerun reuses the cache. **Read two timelines yourself** before
   paying for anything: if they do not make sense to you, they will not to a model.
3. **Triage (paid).** Dry run, state the cost, wait for the yes, then run with the
   budget. Pilot ten or fewer first (`--full` is required above ten).
   ```bash
   node bin/replays.mjs triage --dry-run
   node bin/replays.mjs triage --max-usd 0.01
   ```
   Skip it when the hard filters already did the cut: behind good filters it kept
   25 of 25 in one run.
4. **Analysis (paid).** Same rule.
   ```bash
   node bin/replays.mjs analyze --dry-run          # add --all to skip triage
   node bin/replays.mjs analyze --max-usd 0.05
   ```
   Writes `replays-out/report.md`, with every quote pulled from the timelines.
5. **Verify before you tell anyone.** For each friction you plan to report, open
   its timeline at the cited lines and check it says what the report says. Drop
   the known false positives: a file picker or a download opening nothing visible
   is expected; the person's own instruction echoed in another language is not an
   i18n bug.
6. **Look only where text is not enough.**
   ```bash
   node bin/replays.mjs player <id>
   ```
   then serve the page locally and jump with `goto("HH:MM:SS")` in the console.
7. **Check the code before recommending a fix.** A friction seen last week may be
   fixed already. Compare each session's date with the history of the code it
   points at, and only recommend what is still true.
8. **Synthesise.** Group frictions that recur across sessions, rank by frequency
   and severity, say how many sessions each one rests on. Two sessions is a
   signal, not a statistic: say so.

## What it costs, measured

On 136 sessions of a file-translation SaaS over 14 days (2026-10-19): triage
with `inception/mercury-2.5` $0.013, analysis with `openai/gpt-6-luna` on the flex
tier $0.026, about $0.0003 per session. The time goes to downloads, not models.

## Checklist

- [ ] `replays-out/` stays local and out of every repository
- [ ] Two timelines read by hand before any paid step
- [ ] Dry run shown, cost stated, explicit yes received, `--max-usd` set
- [ ] Measured cost and failures reported after each paid step
- [ ] Every friction checked against its timeline and against the current code
