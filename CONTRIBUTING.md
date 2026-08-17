# Contributing to Euthynos

Thanks for looking. A few things worth knowing before you spend time on a change.

## The one rule that shapes everything else

Euthynos's product is **trustworthy answers about code**, and its differentiator
is that it states what it could not see. That has a direct consequence for
contributions:

> **A tool must never claim more than it can support.**

These phrases are forbidden in tool output and are enforced by the test suite:

```
is safe · safe to … · no other consumers · all references · unused
fully tested · no impact · proven · guaranteed · certified
```

An empty result must say what was *not* examined, not imply that nothing exists.
`callers_of` returning nothing means "the static graph found no callers", never
"nothing calls this". If your change makes an answer sound more confident, it is
probably going the wrong way.

## Sign your work

**There is no CLA, and there will not be one.** The engine stays Apache-2.0
permanently.

Apache-2.0 already handles inbound licensing. Section 5 says that unless you
explicitly state otherwise, anything you intentionally submit for inclusion is
licensed to the project under Apache-2.0 — the same terms the project ships
under. You keep the copyright in your contribution. Nothing is assigned to
anyone, and no separate agreement is needed to merge your work.

What we do ask for is a **sign-off**: one line per commit certifying the
[Developer Certificate of Origin 1.1](https://developercertificate.org) — that
you wrote the code, or otherwise have the right to submit it under Apache-2.0.
The full text is in [DCO](DCO) so you can read what you are certifying without
leaving the repository. Git adds the line for you:

```
git commit -s -m "your message"
```

Already committed without it? Fix the whole branch at once:

```
git rebase --signoff origin/main
git push --force-with-lease
```

The sign-off name and email must match the commit author — that is what the
`DCO` check compares. If the email on your commits is not registered to your
GitHub account, add it under **Settings → Emails** and push again. Merge commits
are skipped. `Co-authored-by:` trailers count as additional authors, so
pair-programmed and AI-assisted commits need every author signed off.

Copyright in the project is held by **Tonil Kumar** (© 2026), who maintains it
as an individual. Euthynos is not a company. The name is claimed as an
unregistered trademark and is not covered by the code licence — see
[TRADEMARK.md](TRADEMARK.md), which also spells out what you may do without
asking (quite a lot, including forking and selling).

## Before you open a PR

- **Discuss anything large first.** An issue costs you ten minutes; a rejected
  500-line PR costs you an afternoon.
- **Tests are not optional** for behaviour changes. `npm test` — 685 tests, and
  they run with a worker cap (see `vitest.config.ts`, which explains why).
- **Typecheck is clean or the PR is not ready:** `npx tsc --noEmit`.
- **Never weaken a test to make it pass.** If a test is wrong, fix the test and
  say so in the PR; if the code is wrong, fix the code. We have a written record
  of getting this exactly wrong once — see `BENCHMARK-INTEGRITY-AUDIT.md`.

## If you touch measurement

Read `BENCHMARK-INTEGRITY-AUDIT.md` first. It documents how this project
published performance numbers that were measuring an argument-validation error
for weeks, and the gates that now prevent it:

- every benchmark invocation is schema-checked against the live tool registry
  before it runs — `node scripts/measurement/audit-harness-args.mjs`;
- every call asserts success before its result can enter a measurement;
- a mutation benchmark proves the mutation was observed and restores the file;
- a percentile is never a maximum wearing a percentile's name.

**Any new performance number must be reproducible from a valid operation under a
stated methodology**, produced by a harness that is schema-checked against the
live registry and fails closed on an errored call. A figure that cannot meet that
bar does not get published — see [PROVENANCE.md](PROVENANCE.md) for why V1 ships
no precise latency figures at all. This is not bureaucracy; it is the thing the
product is selling.

## What we are unlikely to accept

- New tools that answer questions the engine cannot actually resolve.
- Heuristics that raise recall by guessing. Ambiguity should produce *no edge*,
  not a plausible one.
- Anything that makes output more confident without making it more correct.
- Network calls in the query path. The engine is local and offline by design.

## Code style

Match the surrounding code. Comments explain *why*, not *what* — the code
already says what. If a comment restates the line beneath it, delete it.

## Reporting a vulnerability

Do not open a public issue. See [SECURITY.md](SECURITY.md).
