# AGENTS.md

Instructions for any AI agent working in this repository. One file, no
per-vendor copy: Claude Code, Cursor, Codex and the rest all read `AGENTS.md`.

Read this before changing the digest or the prompts. Most rules below exist
because the failure they prevent is quiet: a timeline that reads fine and says
something the person never did, and a report that turns it into a fix.

## What this repository is

A library and a CLI that turn PostHog session replays into findings.

```text
recordings ──▶ hard filters ──▶ rrweb digest ──▶ numbered timeline ──▶ triage (decision model) ──▶ analysis (cheap model) ──▶ report with exact quotes
   PostHog      free, code      free, code        free, redacted         paid, --max-usd         paid, --max-usd          code pulls lines by number
```

The library is the product (`lib/`). The CLI (`bin/replays.mjs`) wires it to
PostHog and to a model, and writes everything under `replays-out/`.

There are no dependencies. Node 22.18 or newer.

## Layout

| Path | What it is |
| :--- | :--- |
| `lib/rrweb.mjs` | `decodeSnapshots` and `digest`: rrweb events -> readable lines. **Pure**, the file with the most judgement |
| `lib/timeline.mjs` | digest + product events -> one numbered, redacted text. **Pure** |
| `lib/redact.mjs` | emails, long numbers, URL tokens. **Pure** |
| `lib/score.mjs` | the hard filters and the deterministic score. **Pure** |
| `lib/review.mjs` | prompts, schemas, cost estimate, budget guard, triage, analysis, report. Pure apart from the injected `complete` |
| `lib/posthog.mjs` | **the only file that talks to PostHog**. Read only. Injected `fetch` |
| `lib/llm.mjs` | **the only file that talks to a chat model**. Injected `fetch` |
| `lib/decide.mjs` | **the only file that talks to a decision model** (jev, Mercury Decide; triage only). Injected `fetch` |
| `bin/replays.mjs` | the CLI: `candidates`, `timelines`, `triage`, `analyze`, `player` |
| `demo/player.html` | the template `replays player` fills, to look at one session |
| `examples/replays.config.example.json` | a config for an invented product |
| `test/` | no network, no key, no cost. `fixtures.mjs` is an invented recording |
| `skills/posthog-replay-review/SKILL.md` | the procedure, as a skill |

## Commands

```bash
npm test                                   # no network, no key, no cost
node bin/replays.mjs candidates --days 7   # free
node bin/replays.mjs timelines --top 20    # free
node bin/replays.mjs triage --dry-run      # free: prints the calls and the cost
node bin/replays.mjs analyze --dry-run     # free
```

## Rules

1. **Code produces every fact; the model judges.** Timelines are numbered, the
   model answers with line numbers, `renderReport` pulls the text back. Never
   let a model write a quote, an id, a count or a URL into the report. A cited
   line that does not exist is flagged (`invalidLines`), never trusted.
2. **Three files talk to the outside world**, `lib/posthog.mjs`,
   `lib/llm.mjs` and `lib/decide.mjs`, and all take `fetch` as an argument. No `process.env`, no
   socket and no log anywhere else in `lib/`.
3. **Every paid step has `--dry-run` and `--max-usd`.** The guard uses the upper
   bound (no flex discount) and refuses before the first call. Results are
   written to disk before anything that can fail after paying.
4. **Inputs stay masked.** The digest reports which field and how many
   characters, never the content. A file input reports that a file was chosen,
   never its path. Do not add a code path that reads `text` of an input into a
   line.
5. **A value the page set is not typing.** Only an input on the field that has
   focus counts. Recorders do not reliably send rrweb's `userTriggered`.
6. **Only action controls can be "no visible change".** A tap in a text field
   changing nothing is normal; flagging it buried real dead buttons under noise.
7. **PostHog is read in ranges of 20 blobs** and its 429 waits are honoured.
   One request per blob hit the 1,200-an-hour cap with 16 to 27 minute waits.
8. **Triage defaults to a decision model** (`lib/decide.mjs`, jev 1.13; Mercury Decide on the same endpoint). A chat
   model can take its place through `lib/llm.mjs`, with a strict schema:
   some providers (Inception Mercury) reject any
   `strict: false` schema with an error inside an HTTP 200. Strict needs
   `additionalProperties: false` and every key in `required`.
9. **A rule in a prompt comes from a run that got it wrong.** `ANALYSIS_RULES`
   in `lib/review.mjs` lists them. Add one only with the case that needed it.
10. **No real data in the repository.** Fixtures are invented. `replays-out/`
    and `replays.config.json` are gitignored for that reason.

## Things that bite

- **The snapshot list answers `has_next` without `next`**: page by offset.
- **Server-side events have no session id.** They are matched to a recording by
  person and time, with a one-minute margin.
- **A jump in the rrweb player shows animated elements blank.** Start playing a
  couple of seconds before the moment you want.
- **The Browser pane of some agent apps does not paint frames** when hidden, so
  animations there look frozen. Not a bug in the page.
- **The triage step adds little behind good hard filters**: on a filtered set of
  25 sessions it kept all 25. It earns its cost on an unfiltered set.
- **Hard filters need your product's events.** With only `$rageclick` and
  `$exception`, most sessions score zero. Name the events that mark a decision
  (paywall shown, checkout started, account deleted) in the config.
