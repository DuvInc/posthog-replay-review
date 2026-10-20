# Security policy

## Reporting a vulnerability

Please report privately rather than in a public issue, using GitHub's
[private vulnerability reporting](https://github.com/DuvInc/posthog-replay-review/security/advisories/new)
on this repository.

This is a one-person project. You should get an acknowledgement within a few
days; if a week passes with no reply, feel free to nudge by opening a public
issue that says only that you are waiting on a private report, with no details.

## What is in scope

This tool downloads recordings of what real people did in a product and sends a
text version of them to a model. The surface that matters:

- **Key handling.** Anything that causes `POSTHOG_API_KEY` or
  `OPENROUTER_API_KEY` to be written to a tracked file, printed, or sent
  anywhere other than the configured host. `lib/posthog.mjs` and `lib/llm.mjs`
  are the only files that should read them.
- **What leaves the machine.** Only the numbered timeline text goes to the
  model: no raw recording, no screenshot, no event properties beyond the ones
  named in `eventProperties`. Inputs arrive masked by the recorder, and
  `lib/redact.mjs` strips emails, long numbers and URL tokens from the rest. A
  change that sends more, or sends it elsewhere, is in scope whether or not it
  is exploitable: the data belongs to people who never agreed to it.
- **Untrusted text.** Everything in a recording came from a page a stranger
  used, and it ends up in a prompt and in a Markdown report. Text that tries to
  steer the model, or Markdown that renders as a link somewhere unexpected, is
  worth reporting.
- **The player page.** `replays player` inlines recorded events into an HTML
  page. Recorded text containing `</script>` is escaped; a way around that is
  in scope.

## What is out of scope

- PostHog, OpenRouter and the model providers themselves. Report those to their
  operators.
- Review quality. A friction the model missed or invented is a bug, not a
  vulnerability.
- A vulnerability that requires the attacker to already have commit access, or
  to already be able to run code as you.

## If you run this on your own product

Three things this repository cannot do for you:

- **Decide the transfer is allowed.** Timelines are personal data even after
  redaction: names, free text and behaviour pass through. Sending them to a
  model provider makes it a sub-processor. Whether that is permitted, and
  documented in your privacy policy, is yours to decide.
- **Keep the output safe.** `replays-out/` holds recordings and timelines.
  It is gitignored here; keep it out of your repositories and shared drives,
  and delete it when the review is done.
- **Mask what your recorder did not.** If your PostHog project records inputs
  unmasked, the recordings contain what people typed. Check your replay
  settings before running this.

## If you forked this tool

Replace the link above with your own repository. This file arrived with the
code and points at somebody else's advisories.
