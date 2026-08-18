<p align="center">
  <img src="assets/euthynos-logo.svg" alt="Euthynos" width="360">
</p>

<p align="center">
  <strong>A local, read-only MCP server that gives AI coding agents structural
  evidence about your repository — and names the boundary of every answer.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/euthynos"><img alt="npm" src="https://img.shields.io/npm/v/euthynos?color=0BABB4&label=npm"></a>
  <img alt="node" src="https://img.shields.io/badge/node-%E2%89%A518-0BABB4">
  <img alt="tests" src="https://img.shields.io/badge/tests-685%20passing-0BABB4">
  <img alt="tools" src="https://img.shields.io/badge/MCP%20tools-23-0BABB4">
  <img alt="languages" src="https://img.shields.io/badge/languages-16-0BABB4">
  <a href="LICENSE"><img alt="licence" src="https://img.shields.io/badge/licence-Apache--2.0-0BABB4"></a>
</p>

<p align="center">
  <a href="https://euthynos.dev">euthynos.dev</a> ·
  <a href="#the-23-tools-by-the-question-they-answer">Tools</a> ·
  <a href="#measured-not-asserted">Benchmark</a> ·
  <a href="#verify-the-claims-yourself">Verify it yourself</a> ·
  <a href="#what-euthynos-does-not-claim">What it won't claim</a>
</p>

---

An agent reading a file can see what that file depends on. It cannot see what
depends on *the file*. Inbound edges are invisible from the inside, so agents
compensate by reading more files, which burns context and still misses callers.
Euthynos answers those questions from the AST, the import graph and git history
instead — **zero LLM calls**, no network in the query path.

It provides evidence. **It does not certify that a change is safe.**

## Install

**Install globally.** The `-g` matters: it is what puts the `euthynos` command on
your PATH, which is how your MCP client starts the server.

```bash
npm install -g euthynos
```

Check it landed before wiring anything up:

```bash
euthynos --help
```

Then register it with your agent:

```bash
claude mcp add euthynos -- euthynos mcp
```

Or in any MCP client config:

```json
{ "mcpServers": { "euthynos": { "command": "euthynos", "args": ["mcp"] } } }
```

Requires Node.js 18+. Works on Windows, macOS and Linux.

<details>
<summary><strong>“euthynos is not recognized” / “Failed to connect — Connection closed”</strong></summary>

Almost always a **local install instead of a global one**. `npm install euthynos`
without `-g` drops the binary in `./node_modules/.bin/`, which is not on your
PATH, so your MCP client has nothing to run. Confirm with:

```bash
npm ls -g euthynos --depth=0
```

If that prints `(empty)`, reinstall with `-g`. To clean up the accidental local
copy, delete the `node_modules` folder and `package.json` it created in whatever
directory you ran the command from.

If it *is* installed globally and still not found, your npm global bin directory
is not on PATH — `npm config get prefix` shows where it lives. Or point your
client at the binary directly:

```json
{ "mcpServers": { "euthynos": { "command": "C:\\full\\path\\to\\euthynos.cmd", "args": ["mcp"] } } }
```
</details>

<p align="center">
  <img src="assets/scan-demo.gif" alt="euthynos scan running against the hono repository: 382 files, 13 modules, Architecture Health 68 of 100, per-module table of depth, seams, leverage and callers, and a contamination score" width="900">
</p>

<p align="center">
  <sub>A real run against <a href="https://github.com/honojs/hono">hono</a> at <code>26de7313</code> &mdash; 382 files, 13 modules, Architecture Health 68. Clone that commit and the numbers should match.</sub>
</p>

## The 23 tools, by the question they answer

| group | tools | what you get |
|---|---|---|
| **Who depends on this?** | `callers_of` `callees_of` `dependents_of` `dependencies_of` `find_references` `path_between` | Transitive callers with depth and confidence, module-level dependency edges, and the shortest call path between two functions. |
| **What does this change reach?** | `impact_of` `change_impact` `check_my_changes` `diff_context` `boundary_check` | Blast radius before you edit; after you edit, which symbols moved, which module boundaries the diff crossed, and what the diff did **not** cover. |
| **Read exactly this much** | `read_function` `read_span` `file_outline` `find_symbol` `context_bundle` | Exact source spans instead of whole files. `context_bundle` composes source, callers, tests and blast radius under a token budget. |
| **Orient in an unfamiliar repo** | `repo_map` `query_repository` `architecture_health` `module_metrics` | Module map, structural metrics, and where the weak boundaries are. |
| **Before you write it again** | `similar_logic_exists` `compare_implementations` `tests_for` | Near-duplicate detection before you add a third copy, and route-labelled test discovery. |

Every answer states its own scope. A negative answer says what was *not*
examined rather than implying nothing exists.

## Measured, not asserted

**M2** is a preregistered benchmark: the tasks, validity rules and answer keys
were frozen by commit *before any session ran*, recall was hand-graded blind from
final answers only, and the invalid sessions are published alongside the valid
ones. Same model, same repository, same prompts — one arm with Euthynos mounted,
one without.

On the three tasks that reached full measurement:

| task | arm | fresh tokens | recall vs frozen key | false positives |
|---|---|---:|:---:|:---:|
| **who calls this** | baseline | 70,878 | 12 / 12 | 1 |
| | **Euthynos** | **49,476** &nbsp;`−30%` | **12 / 12** | **0** |
| **is this logic duplicated** | baseline | 33,429 | 15 / 15 | 0 |
| | **Euthynos** | **29,120** &nbsp;`−13%` | **15 / 15** | **0** |
| **what does this change reach** | baseline | 56,481 | 15 / 15 | 0 |
| | **Euthynos** | **39,242** &nbsp;`−31%` | **15 / 15** | **0** |

**Recall was identical and perfect in both arms — 42 of 42 required items each —
while the Euthynos arm used 13–31% fewer fresh tokens.** The agent reached the
same answer having read less. A preregistered trap designed to induce a plausible
wrong caller did not fire in either arm.

**What this does not say.** 21 of 46 attempted sessions were valid; an external
rate-limit wall took 14 of them. **Guided-edit and orientation tasks were never
measured** and no number is implied for them. One harness, one repository. This
is work saved, not answer quality improved — and we would rather publish that
sentence than a bigger number.

**No latency figures are published.** Two internally valid measurements
disagreed and the controlled experiment that would have settled it could not be
completed, so we publish neither and ship the harness instead —
[PROVENANCE.md](PROVENANCE.md) has the reasoning.

## Local-first

- **Nothing is uploaded from the query path.** The MCP server makes zero network
  calls and zero LLM calls. It reads your working tree, including uncommitted
  edits.
- **Read-only.** It never modifies your source.
- **Path-sandboxed.** The server pins its servable roots at start; a path outside
  them is refused. Symlinks are not followed.
- **One directory on disk:** `.euthynos/` at the repository root, holding the
  content-addressed index and a local metadata-only telemetry log. It is created
  with its own `.gitignore`, and deleting it costs only a re-scan.
  Opt out with `EUTHYNOS_NO_INDEX=1` and `EUTHYNOS_NO_TELEMETRY=1`.
- **One exception, opt-in and CLI-only:** `euthynos scan --ai` sends candidate
  duplicate snippets to the Anthropic API to confirm findings. It requires
  `ANTHROPIC_API_KEY`, is off by default, and is **not** part of the MCP server.

## Scale — what we will and will not claim

Euthynos is validated to roughly **10,000 files**. Below about **1,500** it is
comfortable. Above 10,000 it is **not validated** and should not be assumed to
work.

**~10,000 files is the top of the validated envelope, not a guarantee.**

**Memory is the binding constraint at the upper end, not latency.** The parsed
corpus is held in memory: a 10,000-file repository takes process RSS from roughly
0.6 GB to ~1.1 GB during an edit loop. Extrapolating linearly — *an estimate, not
a measurement* — a default Node heap is likely exhausted somewhere around
25,000–35,000 files. The 60,000-file discovery cap in the code is therefore **not
a reachable limit**.

**Precise latency figures are not published in V1.** We hold two internally
consistent measurements that disagree on the larger sizes, and the controlled
experiment that would have resolved which to trust could not be completed. Rather
than publish a number we cannot stand behind, we publish none and ship the
harness so you can measure your own machine:

```bash
node scripts/measurement/gen-scale-repos.mjs
node --expose-gc scripts/measurement/measure-latency.mjs --reps=20
```

The reasoning is in [PROVENANCE.md](PROVENANCE.md); the envelope and what affects
performance are in [SUPPORTED-SCALE.md](SUPPORTED-SCALE.md).

Other limits worth knowing before you install:

- **Dispatch is synchronous.** One tool call at a time, and the cold first scan
  blocks the queue for its whole duration — seconds, growing with repository
  size. There is no per-call timeout; your MCP client must supply one that
  tolerates that first call.
- **Index reads are not free and not scale-invariant.** `find_symbol`,
  `read_function` and `find_references` cost real time and grow with repository
  size. An earlier version of this file claimed they stayed under a millisecond
  at every scale; that figure was an argument-rejection error path, not a read.
  See [BENCHMARK-INTEGRITY-AUDIT.md](BENCHMARK-INTEGRITY-AUDIT.md).
- **The edit loop costs several times a warm call**, because changed files must
  be re-parsed. Any figure that does not say which of the two it measured is not
  telling you much.
- **Cold-build timings depend on the machine and storage environment.** Building
  the index is I/O-bound.
- All measurement to date has been on **TypeScript**. Other languages will differ.

## Languages

**16 parse, via three strategies.** TypeScript, JavaScript and Vue SFCs through
the TypeScript compiler API; Python, Go, Java, Ruby, Rust, PHP, C, C++, C#, Dart,
Kotlin and Swift through tree-sitter WASM; COBOL through a deterministic line
parser.

Every grammar runs as **pure WASM** — no native bindings, no platform-matched
prebuilds, no compiler toolchain. Call-graph resolution quality is strongest for
TypeScript.

## What Euthynos does not claim

It is a **static analyser**. It sees imports, declarations and call edges. It
does not see reflection, dynamic dispatch, runtime code generation, string-built
symbol names, dynamic imports or framework wiring — and it never pretends
otherwise.

These phrases are forbidden in its output and the ban is enforced by tests:

> `is safe` · `safe to …` · `no other consumers` · `all references` · `unused` ·
> `fully tested` · `no impact` · any claim of mathematical proof of safety

`callers_of` returning nothing means *the static graph found no callers*, never
*nothing calls this*. Ambiguous cross-module names produce **no edge** rather
than a guess, so answers are a lower bound and the count of unresolved calls is
printed alongside.

## Verify the claims yourself

Nothing here asks you to take a number on trust:

| what | where |
|---|---|
| The token/recall benchmark, preregistered before it ran | [`research/M2-PREREG.md`](research/M2-PREREG.md) |
| Its results, published unmodified | [`research/M2-RESULTS.md`](research/M2-RESULTS.md) |
| **Where our own published numbers were wrong, and how** | [BENCHMARK-INTEGRITY-AUDIT.md](BENCHMARK-INTEGRITY-AUDIT.md) |
| Measure latency on your own machine | `scripts/measurement/measure-latency.mjs` |
| **What is and is not verifiable here — including why latency figures are deferred** | [PROVENANCE.md](PROVENANCE.md) |

That last one is not an accident of disclosure. Two of our benchmark harnesses
were timing argument-validation errors as though they were measurements, and one
published claim was wrong by three orders of magnitude. The audit documents what
broke, what was invalidated, what was re-measured, and what remains unsupported.

**What is not published:** the M2 answer keys and the full session ledger. Any
statement about those is unverified from this repository, and we would rather say
so than imply otherwise.

## The same engine, for a team — in development

> **Not yet available.** There is no hosted instance and no sign-up today. This
> section describes software that exists and runs, so you know where the project
> is going — not a product you can buy. When it opens, it will be announced at
> [euthynos.dev](https://euthynos.dev).

The engine in this repository also drives a team platform. A repository is
connected through a GitHub App; every push and pull request is scanned
server-side, and the result lands where the decision gets made:

- **A merge policy you write as rules** — *health may not fall more than N
  points*, *no new duplication*, *a module needs more than one owner* — each set
  to warn or block. Thresholds are enforced by the server, not the form.
- **A GitHub check run on every pull request**, with the verdict recorded
  against the rule that produced it.
- **An interactive dependency graph** per scan, generated by the same engine
  you can run locally.
- **Architecture health over time**, per module, with ownership and bus factor
  from git history.
- **An evidence export an auditor can read** — the rule set as it stood, every
  merge verdict in a date range, and each override with its actor and written
  reason.

**Zero LLM calls here too.** The same diff produces the same verdict, every time.
Nothing is sampled, so there is nothing to hallucinate and nothing to
prompt-inject.

The CLI in this repository stays free, local and Apache-2.0. It does not phone
the platform, and the platform never touches your machine.

## CLI

The MCP server is the main surface, but the CLI stands alone:

```
euthynos scan [path]        architecture scan — six metrics, module table
euthynos graph [path]       build the call graph; --impact/--callers/--path
euthynos dashboard [path]   self-contained interactive HTML, zero runtime deps
euthynos index [path]       inspect or rebuild the local index
euthynos mcp                start the MCP stdio server
```

`euthynos --help` prints the full flag set and the build stamp.

## Documentation

[ARCHITECTURE.md](ARCHITECTURE.md) · [SUPPORTED-SCALE.md](SUPPORTED-SCALE.md) ·
[SECURITY.md](SECURITY.md) · [CONTRIBUTING.md](CONTRIBUTING.md) ·
[TRADEMARK.md](TRADEMARK.md) · [PROVENANCE.md](PROVENANCE.md) · [CHANGELOG.md](CHANGELOG.md)

## Security

Report vulnerabilities privately through
[GitHub Security Advisories](https://github.com/euthynos-org/euthynos/security/advisories/new),
not a public issue. Scope and expectations: [SECURITY.md](SECURITY.md).

## Licence

**Apache License 2.0** — see [LICENSE](LICENSE) and [NOTICE](NOTICE).

Copyright © 2026 Tonil Kumar.

The licence covers the code. It does not cover the name: "Euthynos" is claimed as
an **unregistered** trademark of Tonil Kumar — no registration has been applied
for or granted. See [TRADEMARK.md](TRADEMARK.md).

---

<p align="center">
  <img src="assets/euthynos-symbol.svg" alt="" width="28"><br>
  <a href="https://euthynos.dev"><strong>euthynos.dev</strong></a><br>
  <sub>Named for the <em>euthynoi</em> — the magistrates of classical Athens who
  audited every official at the end of their term.</sub>
</p>
