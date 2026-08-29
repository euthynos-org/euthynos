# Changelog

## 0.2.0 — 2026-08-29

Call-graph resolution across languages, plus the change-detection and disclosure
fixes two independent field reports surfaced. Every resolved edge still carries a
graded confidence, and the resolver declines rather than guesses when a target is
ambiguous, external, or unknown — an unresolved call is counted, never invented.

Cross-file and cross-class call resolution

- **Import-binding (ts / js / py / vue).** A bare call to a relatively-imported
  name resolves to the exact file it was imported from, so `callers_of` on a
  fully-qualified target no longer returns a same-named function's callers. Binds
  only to a name the target file exports (confidence 0.9, reason
  `import-binding`); barrels, aliased imports, and type-only imports decline.
- **Package-granular modules for JVM / build layouts.** `src/main/java/com/acme/…`
  now keys the module on the package (`com/acme/…`) instead of collapsing every
  file to `main`, and keeps distinct monorepo build roots distinct. Import edges
  and architecture metrics follow the real package structure.
- **Receiver-type resolution (Java, Kotlin, C#, C++, Swift, PHP).** A member call
  `x.method()` whose receiver has a declared type — a local, parameter, field, or
  `new Foo()` — resolves to the method declared on that class (confidence 0.85,
  reason `receiver-type`), including same-package calls that carry no import. An
  external, unknown, or ambiguous receiver type resolves to nothing; an
  interface / protocol receiver is left to the existing over-approximation. The
  method is matched on the receiver's own class, so an inherited method or a
  same-named method on a sibling class is never mistaken for it.

check_my_changes

- **Body edits are detected.** The symbol diff uses a rename-sensitive hash that
  keeps identifier and literal text, so an edit that renames a local, changes a
  property access, or swaps a literal is reported as a modified symbol. Comment-
  and whitespace-only edits stay silent. The index schema is bumped so a stale
  cache rebuilds rather than reporting every function modified.

Honesty

- **Negative answers carry a lower bound.** `callers_of`, `callees_of`, and
  `path_between` disclose the repo-wide count of calls that could not be resolved
  when they return an empty result, matching `impact_of` — an empty answer is a
  lower bound, not a proof of absence.

## 0.1.5 — 2026-08-21

Registry metadata only. No behaviour change: `dist/`, the 23 tools and their
schemas are identical to 0.1.4.

- **Published to the official MCP Registry.** `server.json` added at the repo
  root (schema 2025-12-11) describing the npm package with the `mcp` positional
  argument, so clients configuring from the registry start the stdio server
  rather than the CLI help screen.
- **`mcpName` added to package.json** — `io.github.euthynos-org/euthynos`. The
  registry verifies npm package ownership by reading this field from the
  published tarball, which is why this is a release rather than a repo-only
  change.

## 0.1.4 — 2026-08-20

Three correctness fixes, all found by running the CLI against this repository
rather than by reading it. Each shipped in 0.1.3 because no test asserted it.

- **An unscannable root no longer scores 100/100.** `euthynos scan
  /path/that/does/not/exist` reported `Architecture Health 100/100 [Strong]`:
  zero files discovered means zero problems detected, so a mistyped path
  produced the best possible result. `policy --strict` inherited it and printed
  "all architecture policies passed" with exit 0, so a misconfigured CI gate
  went green precisely because it had measured nothing. `scan()` now throws when
  the root is missing or is not a directory, and every command built on it —
  `scan`, `policy`, `alerts`, `graph`, `dashboard` — fails closed with exit 1.
- **Call paths reported the node count, not the hop count.** A direct `a → b`
  call was described as "2 hops". This was wrong in the `graph --path` CLI output
  and in the `path_between` MCP tool, so agents reasoning about call distance
  received a value one too high. Both now count edges, and render "1 hop"
  correctly in the singular.
- **`policy --strict` documented as a CI gate that could never fail.** The
  built-in ratchet policy is warn-only, and `--strict` exits non-zero only on a
  block-mode violation, so the default invocation could not fail — verified
  against a synthetic 50-point health regression, which still exited 0. The flag
  that arms it, `--block`, was absent from the help text, the README and the
  docs, while `--ratchet` was documented as "fail only on regressions" but was
  never read by `loadPolicy()`. The help now documents `--block`, drops the dead
  `--ratchet`, and states both working gate recipes:
  `policy --block --base prior.json --strict`, or `policy --policy rules.json
  --strict` with `"defaultMode": "block"` in the file. Behaviour is unchanged —
  observe-first remains the default; only the documentation was wrong.

No change to the 23 tools, their schemas, or the scoring model. `alerts` still
always exits 0 by design: alerts inform, the policy gate enforces.

## 0.1.3 — 2026-08-19

Documentation and comments only. No engine change: `dist/` behaviour, the 23
tools and their schemas are unchanged.

- **Internal planning vocabulary removed from source comments.** Comments across
  30 files referenced an internal sprint system — "Phase 6 C5", "Slice 2.5",
  "pillars 11+12", "blueprint §21-22", "PHASE6-COMPLETION-PLAN §1/§5", "ADR-008"
  — pointing at documents no reader outside the project can open. Each is now a
  sentence describing what the code does or guarantees. Verified line by line as
  a comments-only change: no executable line, identifier, type or assertion was
  altered.
- **Fixed a leak in tool output.** The tests section of `context_bundle` printed
  "call-graph-aware tests_for lands in Phase 6" to the calling agent. It now
  states the boundary instead: the heuristic is import-edge based and therefore
  a lower bound.
- **Documentation moved into `docs/`.** ARCHITECTURE, SUPPORTED-SCALE,
  PROVENANCE, BENCHMARK-INTEGRITY-AUDIT, TRADEMARK, CONTRIBUTING and SECURITY
  now live there. README, CHANGELOG, LICENSE, NOTICE and DCO stay at the root,
  where npm and GitHub expect them; GitHub still detects CONTRIBUTING and
  SECURITY under `docs/`.
- **`research/` deliberately not moved.** `.gitattributes` pins
  `research/** -text` to preserve the frozen artifacts' byte-identity, and
  PROVENANCE publishes their sha256 against those paths. Moving them would break
  both.
- All 32 internal documentation links re-pointed and verified to resolve.
- README: the team-platform section now leads with early access at euthynos.dev,
  and still states plainly that no public instance exists yet.

## 0.1.2 — 2026-08-18

Documentation only. No engine change; `dist/` behaviour, the 23 tools and their
schemas are unchanged from 0.1.0.

- **README rewritten** with the project mark, an at-a-glance badge row, and the
  M2 benchmark presented as a table — the per-task fresh-token medians and the
  42-of-42 recall result, quoted from `research/M2-RESULTS.md` and matching it
  figure for figure, with the validity caveats kept next to the numbers rather
  than in a footnote.
- **Added a section on the team platform the same engine drives**, marked
  explicitly as *not yet available* — no hosted instance and no sign-up exists
  today, and the section says so before describing anything.
- **Install section rewritten.** The global flag is now called out
  explicitly, with a verification step and a troubleshooting block for the
  most common failure: a local `npm install euthynos` leaves no command on
  PATH, so an MCP client reports only *Failed to connect — Connection
  closed*, which does not point at the cause.
- No comparative claim against any other tool: no head-to-head benchmark has
  been run, so none is stated.

## 0.1.1 — 2026-08-18

Packaging only. No engine change: `dist/` is byte-identical in behaviour to
0.1.0, and the test suite, tool count and tool schemas are unchanged.

- **npm keywords rewritten.** 0.1.0 shipped with keywords describing an
  architecture-metrics tool (`module-depth`, `github-action`) and never
  mentioned MCP, so a registry search for "mcp server" or "model context
  protocol" did not return this package at all. The only query that found it
  was the brand name, which nobody has a reason to search yet. Now indexed
  under `mcp`, `model-context-protocol`, `mcp-server`, `claude`,
  `claude-code`, `cursor`, `ai-agent` and `coding-agent` alongside the
  existing analysis terms.

## 0.1.0 — 2026-08-18

First public release. Local-first repository intelligence over MCP: 23
read-only tools that answer structural questions about a working tree and
state the boundary of every answer.

### Capabilities

- 23 MCP tools: repository map, health and module metrics, symbol and
  reference lookup, call graph (callers/callees/impact/path-between),
  module dependencies, near-clone and similar-logic detection, test
  discovery, context bundles, and an edit-loop surface
  (`check_my_changes`, `boundary_check`, `diff_context`, `change_impact`).
- 16 languages parsed, via three strategies: TypeScript, JavaScript and Vue
  SFCs through the TypeScript compiler API; Python, Go, Java, Ruby, Rust,
  PHP, C, C++, C#, Dart, Kotlin and Swift through tree-sitter; COBOL through
  a deterministic line parser.
- Persistent, content-addressed incremental index under `.euthynos/`.
- Works fully offline. Works without git (history-derived signals degrade
  and say so).
- CLI as `euthynos` — a single binary. The internal `contexthub` alias was
  removed before release to avoid colliding with the unrelated npm package
  of that name.

### Architecture work in this candidate

> **On the figures that used to appear in this section.** Earlier drafts quoted
> specific speed-ups here: a warm-sweep multiplier, before-and-after
> `callers_of` timings at two repository sizes, and a percentage off the diff
> tools. Those came from the internal measurement set that V1 does not publish —
> two internally consistent runs disagreed, and the controlled experiment that
> would have established which to trust could not be completed. They are
> **superseded internal measurements, not V1 claims**, and are deliberately not
> repeated below. The changes themselves are real and their *direction* is not
> in doubt; only their magnitude is unpublished. See
> [docs/PROVENANCE.md](docs/PROVENANCE.md) for the reasoning and
> [docs/BENCHMARK-INTEGRITY-AUDIT.md](docs/BENCHMARK-INTEGRITY-AUDIT.md) for the audit
> that set the bar. Measure your own machine with
> `scripts/measurement/measure-latency.mjs`.

- **Change oracle** — above ~3,000 files, `git status` decides which files
  need a stat instead of walking and stat-ing everything. Warm sweeps get
  cheaper at 5k/10k; no regression on small repositories, which deliberately
  keep the walk because spawning git costs more there.
- **Graph on the incremental store** — graph rebuilds consume the stored
  parsed artifacts instead of re-parsing the repository (twice). This is the
  largest structural improvement in the candidate: `callers_of` after a single
  edit no longer pays for a full re-parse of the tree.
- **Request-scoped git sharing** — the change oracle and the diff engine
  no longer each run their own `git status` inside one tool call, removing a
  duplicated subprocess from every large diff call.
- **One authoritative file universe** — the effective exclusion set is
  computed once and used by the index, graph, scan report and diff tier
  alike.
- **Self-verifying index** — the manifest is the commit point and carries
  the payload digest plus the root it describes.

### Fixed

- `callers_of` missed callers defined as class properties holding arrow
  functions (`fetch = async () => …`), so their calls were invisible to
  the graph. Found by the M2 benchmark; the release candidate ships the
  fix.
- Configured exclusions were honoured by the index, graph and scan but
  **not** by the diff tier, so an ignored file could reappear as a
  "changed file" in the evidence tools. Now excluded consistently,
  including renames and untracked additions inside ignored trees.
- The index tier and the graph tier could answer from different file sets
  when a repository configured ignore globs.
- Torn artifact pairs, orphaned payloads and indexes copied from another
  repository were accepted as valid. All three are now detected,
  announced and rebuilt.

### Known limitations

See `docs/SUPPORTED-SCALE.md` for the validated scale envelope and
`docs/ARCHITECTURE.md` for what is deliberately absent. In short: validated to
~10,000 files; memory is the binding constraint above that; precise latency
figures are not published in V1; analysis is static, so dynamic dispatch and
reflection are invisible and every answer says so.
