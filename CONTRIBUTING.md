# Contributing

Thanks for looking. This is a one-person project maintained on a best-effort
basis, so the most useful thing you can do before writing code is open an issue.
A small fix is always welcome; a large one is worth agreeing on first.

## Getting set up

Node 22.18 or newer. There are no npm dependencies.

```bash
npm install     # installs nothing, and that is the point
npm test        # no network, no API key, no cost
```

`npm test` passes on a fresh clone with no keys. If it does not, that is a bug
worth reporting on its own.

To run it on your own product you need a PostHog personal API key (read only)
and, for the two paid steps, an OpenRouter key. See the README.

## Sign your commits off

Every commit needs a `Signed-off-by` line, which certifies that you wrote the
patch or otherwise have the right to submit it under the MIT licence. This is
the [Developer Certificate of Origin](https://developercertificate.org): one
line, no paperwork, no copyright assignment.

```bash
git commit -s -m "Your message"
```

## What makes a change likely to be merged

**A digest change comes with a fixture.** `lib/rrweb.mjs` decides what a model
will ever know about a session. Several of its rules exist because a real
recording was read wrongly: a value the page set counted as typing, a tap in a
text field reported as a dead button. If you change what it writes, add the
events to `test/fixtures.mjs` and the expected line to `test/rrweb.test.mjs`.
Invent the events; never paste a real recording.

**The purity boundary holds.** `lib/posthog.mjs`, `lib/llm.mjs` and
`lib/jev.mjs` are the only files that read a key or open a socket, and all take
their transport as an argument. A change that reads `process.env` elsewhere in `lib/` makes the
library harder to embed and the tests harder to trust.

**Code produces the facts, the model judges.** Line numbers in, line numbers
out, quotes pulled back by code. A change that lets a model write a quote, an
id or a number into the report is a regression even if the report reads better.

**Report what you measured.** For a prompt or model change, give the model, the
number of sessions, the measured cost and what changed in the findings. A worse
model here does not fail loudly: it writes a plausible friction that is not in
the timeline.

**No new dependency.** A dependency needs an argument in an issue first.

**Comments explain why, not what.** The existing ones are long on purpose: they
record what went wrong before.

**No em dashes**, anywhere.

## Reporting a bug

Include the commit, the command, and the few timeline lines around the problem
with anything personal replaced. A digest bug is almost always reproducible
from a dozen invented rrweb events.

For anything with security or privacy implications, read
[SECURITY.md](./SECURITY.md) instead of opening a public issue.
