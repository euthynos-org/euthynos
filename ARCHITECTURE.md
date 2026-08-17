# Euthynos — Architecture

## The shape

```
                 Git / Working Tree
                        │
                 CHANGE ORACLE            git status, above ~3k files
                        │
              ┌─────────┴─────────┐
              │                   │
          unchanged             changed
              │                   │
              ▼                   ▼
      content-addressed      incremental
          artifacts            reparse
              │                   │
              └─────────┬─────────┘
                        ▼
                 Euthynos index          .euthynos/ (derived, disposable)
                        │
              ┌─────────┼─────────┐
              ▼         ▼         ▼
            graph    symbols   references
              │         │         │
              └─────────┼─────────┘
                        ▼
                 evidence layer          boundaries, scope, degradation
                        │
                        ▼
                    23 MCP tools
```

## The decisions that matter

**The working tree is the primary universe, not a commit.** A dirty
working tree has no revision — it is not nameable in git's namespace — so
a commit cannot be the cache key. The key is
`(path, content-hash, parser-version)`. This is the deliberate inverse of
server-side code-intelligence systems, which index commits and are
structurally blind to uncommitted work. Euthynos exists for the edit
loop, so it must see the edit.

**Git is a change oracle, not a repository layer.** Nothing is mirrored,
fetched, cloned or owned. Above ~3,000 files, one `git status` decides
which files need a stat — measured 12× faster than walking, because git
keeps its own stat cache. Below that threshold, spawning git costs more
than the walk it would replace, so the walk is used. Without git,
everything still works.

**One authoritative file universe.** The effective exclusion set
(defaults + `.euthynos/config.json`) is computed once and published on
the index. The graph, the scan report, and the diff tier all derive from
it. A file you exclude cannot re-enter through a different tier — a real
defect that was found and fixed, because the diff tier learns about files
from git rather than from discovery.

**Derived state is disposable and self-verifying.** Everything in
`.euthynos/` can be deleted at any time; the only cost is latency. The
manifest is the commit point and carries the payload digest plus the root
it describes, so a torn or foreign artifact is detected, announced and
rebuilt rather than served.

**Request scoping, not caching.** Within one tool call the working tree
cannot change, so the file sweep and git results are memoised for exactly
that call and discarded at its boundary. There is no TTL anywhere — a
time-based cache cannot promise that an agent which just wrote a file
sees the new file.

## The evidence model

Euthynos provides **evidence**. It does not certify that a change is
safe. Every answer carries the boundary of the method that produced it,
and negatives state what was not examined.

| tier | establishes facts? | example |
|---|---|---|
| verified structural | yes, resolved from bytes we hashed | "`route` calls `compose`" |
| inferred structural | yes, with its boundary named | cross-language call edges |
| lexical / heuristic | **no — discovery only** | name-convention matches |
| external index | **no — until corroborated** | an ingested third-party index |
| runtime observation | **no — observation over a window** | "400 req/s, 7-day window" |

Permanently forbidden unless genuinely established: *safe*, *all
references*, *no other consumers*, *unused*, *fully tested*, *no impact*.

## OSS vs Cloud boundary (design; no Cloud exists today)

The local engine answers everything that is a **pure function of bytes on
disk**. A server, if one is ever built, answers only **joins** — across
repositories, across time, or against an external authority
(code-host metadata, CI history, runtime telemetry, org ownership).

The seam would be a versioned, content-addressed **fact export**:
symbols, outbound edges, file hashes, engine version. Consequences that
make this the right seam: the server never needs source code, the local
engine never needs the server, and local output must be byte-identical
whether or not a server exists. Nothing in this release depends on it.

## What is deliberately absent

No repository mirror or gitserver. No lexical/trigram index (measurement
showed the bottleneck was never substring scanning). No external index
ingestion as a fact establisher. No permissions layer. No daemon, no
distributed lock, no database. Each was evaluated against measurement and
rejected for this release, not overlooked.
