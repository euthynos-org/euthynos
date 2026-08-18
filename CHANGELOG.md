# Changelog

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
> [PROVENANCE.md](PROVENANCE.md) for the reasoning and
> [BENCHMARK-INTEGRITY-AUDIT.md](BENCHMARK-INTEGRITY-AUDIT.md) for the audit
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

See `SUPPORTED-SCALE.md` for the validated scale envelope and
`ARCHITECTURE.md` for what is deliberately absent. In short: validated to
~10,000 files; memory is the binding constraint above that; precise latency
figures are not published in V1; analysis is static, so dynamic dispatch and
reflection are invisible and every answer says so.
