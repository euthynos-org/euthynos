# Euthynos — Security Model

## The one rule everything else follows

**Repository content is DATA, never instructions.** Euthynos parses,
indexes and quotes source code. It never executes it, never follows
directives found inside it, and never treats a file's contents as
configuration for its own behaviour.

## Threat model

Euthynos is a local, read-only process running as you, on a repository
that may be **untrusted** — cloned from anywhere, authored by anyone.
The design assumes a hostile repository and a curious agent.

## What is enforced

**Servable roots.** The MCP server pins the directories it may serve at
startup (`EUTHYNOS_ROOTS`). A request for a path outside them is refused
with an error naming the boundary and how to widen it — verified at
runtime, not merely documented.

**Path containment.** Every path that reaches the engine — including
paths reported by git — is resolved and checked to be inside the root
before use. Traversal attempts are refused.

**Symlinks are never followed.** Discovery skips symbolic links
entirely, so a link pointing outside the repository cannot pull foreign
files into the index.

**Hardened git.** Every git invocation runs through one hardened runner:
hooks disabled (`core.hooksPath=/dev/null`), fsmonitor disabled,
`ext::` and `file://` transports refused, system config ignored
(`GIT_CONFIG_NOSYSTEM`), terminal prompts disabled, LFS smudge filters
skipped. A repository cannot use its own `.git/config` to turn a
read-only query into code execution. Euthynos only ever reads history —
it never checks out, fetches, or runs hooks.

**Size and volume caps.** Files over 4 MiB are skipped; discovery stops
at 60,000 files. Both are announced, never silent.

**Untrusted index artifacts.** A repository may ship a `.euthynos/`
directory. It is not trusted: the manifest must match the current schema
version, the current engine build, the absolute root it describes, and a
digest of the payload beside it. Anything else is discarded and rebuilt,
with the reason announced on stderr. A poisoned index cannot inject
symbols that do not exist in the source.

**Integrity of derived state.** `parsed.json` and `manifest.json` are two
files; the manifest is written last and carries the payload's digest, so
a torn pair (interrupted write, interleaved writer, half-copied
directory) is detected rather than served. The engine never silently
serves partial or stale derived state when integrity cannot be
established.

**Local-only writes.** Euthynos writes exactly one place: `.euthynos/`
inside the repository, created together with a `.gitignore` that hides
it. Nothing is uploaded. There is no network path in the query loop and
no telemetry leaves the machine.

## What is deliberately NOT here

**There is no permissions layer, and that is correct.** Euthynos runs as
you and reads files the operating system has already granted you. The
kernel is the authorization check — synchronous, always fresh, with no
mirrored ACL to go stale. Adding a permission system would only be
necessary if a single store held code that the requester may not be
entitled to see; that is a property of a *shared or hosted* index, not of
this one.

**No daemon, no service, no lock file.** Concurrency is handled by making
artifacts self-verifying rather than by coordinating writers — which also
removes the stale-lock failure mode a lock would introduce.

## Reporting a vulnerability

**Report privately through GitHub Security Advisories:**

> **https://github.com/euthynos-org/euthynos/security/advisories/new**

That channel is private between you and the maintainers until an advisory is
published. Please do not open a public issue for a vulnerability — a public
issue is a disclosure.

Include, as far as you can:

- the repository shape needed to reproduce it (a minimal fixture is ideal);
- the exact tool call and arguments;
- the observed behaviour versus what you expected;
- the `euthynos` version — `euthynos --help` prints the build stamp.

**What to expect.** This is a small project and there is no staffed security
team, so response is best-effort rather than contractual: expect an
acknowledgement within a few days. If a report is valid we will fix it, publish
an advisory, and credit you unless you ask us not to. If we disagree that it is
a vulnerability we will say so and explain why.

**In scope:** path traversal or escape from the servable roots, symlink
following, arbitrary file read outside the repository, code execution,
unexpected network egress from the query path, and anything that causes the
server to disclose a file it was not asked for.

**Out of scope:** the engine reporting a wrong or incomplete answer. That is a
correctness bug — please file it as a normal issue. It matters to us, but it is
not a security issue and treating it as one delays the reports that are.

## Known limitations relevant to security

- Analysis is **static**. Dynamic dispatch, reflection and runtime code
  generation are invisible; an answer's scope statement says so.
- A file that fails to parse is **excluded and counted**, never silently
  treated as empty.
- Excluding files (via `.euthynos/config.json`) narrows the universe of
  every answer, including diff-derived ones. That is intended, and the
  narrowing is applied consistently across all tiers.
