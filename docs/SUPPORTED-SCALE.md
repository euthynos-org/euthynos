# Euthynos — Supported Scale

**What we are willing to state, and what we are not.**

Euthynos is validated to roughly **10,000 files**. Below about **1,500 files** it
is comfortable. Above 10,000 it is **not validated** and should not be assumed to
work. At the upper end the binding constraint is **memory, not latency**.

> **Precise latency figures are deliberately not published in V1.** See
> [PROVENANCE.md](PROVENANCE.md) for why. The short version: our controlled
> comparison could not be completed, and we would rather publish no number than
> one we cannot stand behind.

---

## The envelope

| repository size | verdict |
|---|---|
| **up to ~1,500 files** | **Fully supported.** Comfortable for interactive use — queries return fast enough that the agent does not stall waiting. |
| **~5,000 files** | **Supported.** Noticeably slower, still usable. |
| **~10,000 files** | **Supported with caveats.** Works, but the edit loop becomes slow enough to notice, and peak memory approaches ~1 GB. |
| **above ~10,000 files** | **Not validated. Do not assume it works.** |

## Memory is the binding constraint

This is the part that actually limits you, and it is stable across every
measurement we have taken.

The parsed corpus is held in memory (`parsedByHash`). On a 10,000-file
repository, process RSS rises from roughly **0.6 GB to ~1.1 GB** during an edit
loop. Extrapolating linearly — **an estimate, not a measurement** — a default
Node heap is likely exhausted somewhere around **25,000–35,000 files**.

Consequently the **60,000-file discovery cap in the code is not a reachable
limit.** It bounds discovery, not memory, and the engine will run out of heap
long before it.

Reducing this requires changing the in-memory model, which is a persistence
redesign and is deliberately **out of scope for this release**.

## What affects performance

Stated as characteristics, not as guarantees:

- **Repository size.** Cost grows with the number of files, roughly linearly for
  index reads and more steeply for the graph and diff tools.
- **Machine and storage.** **Cold-build timings in particular are dependent on
  the machine and storage environment** — building the index is I/O-bound, and
  we have observed materially different cold-build times for the same repository
  on different storage devices. Warm queries are far less sensitive to disk.
- **The edit loop costs several times a warm query.** Querying a repository that
  just changed is meaningfully more expensive than querying a static one, because
  the changed files must be re-parsed. Any figure that does not say which of the
  two it measured is not telling you much.
- **git present.** Above roughly 3,000 files the change oracle uses `git status`
  to decide which files need a stat, which is faster than walking the tree.
  Without git everything still works; sweeps are slower on large repositories.
- **Language.** All our measurement has been on TypeScript. Other languages parse
  through different front ends and will differ.

## Measure it yourself

We ship the harness rather than asking you to trust a table:

```bash
node scripts/measurement/gen-scale-repos.mjs            # synthetic fixtures
node --expose-gc scripts/measurement/measure-latency.mjs --reps=20
node scripts/measurement/verify-artifact.mjs            # check its own output
```

The harness is schema-checked against the live tool registry, fails closed on
any errored call, performs a real edit loop with mutation verification and
restoration, uses nearest-rank percentiles, and retains every raw sample so you
can re-derive any statistic. It reports what it measured on **your** machine,
which is the only figure that should inform your decision.

If you do run it, the numbers that matter most are the *shape*: how cost grows
with repository size, and where memory lands.

## Languages

**16 languages parse, via three strategies:**

- **TypeScript compiler API (3):** TypeScript, JavaScript, and Vue SFCs (the
  `<script>` block, delegated to the same compiler).
- **tree-sitter WASM (12):** Python, Go, Java, Ruby, Rust, PHP, C, C++, C#,
  Dart, Kotlin, Swift — exactly the grammars in `TREE_SITTER_LANGS`.
- **Deterministic line parser (1):** COBOL, which has no grammar in the WASM set.

Call-graph resolution quality is strongest for TypeScript.
