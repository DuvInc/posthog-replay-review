## What this changes

<!-- One or two sentences. If it fixes an issue, write "Fixes #123". -->

## Why

<!-- What the digest got wrong, what the review missed, or what could not be done before. -->

## Checklist

- [ ] `npm test` passes locally
- [ ] Commits are signed off (`git commit -s`); see CONTRIBUTING.md
- [ ] If `lib/rrweb.mjs` changed: a case in `test/fixtures.mjs` and `test/rrweb.test.mjs` shows the new line
- [ ] If a prompt, a schema or a default model changed: the model is named, with sessions, cost and what changed in the report
- [ ] `lib/` is still pure outside `lib/posthog.mjs` and `lib/llm.mjs`: no env var, no socket, no log
- [ ] No new dependency, or it was discussed in an issue first
- [ ] No real recording, timeline, key or customer name is in this diff
