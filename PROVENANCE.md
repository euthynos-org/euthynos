# Provenance

What in this repository you can verify yourself, what you cannot, and why.

This page exists because the alternative — letting you assume everything here is
equally checkable — would be the same kind of overclaim the engine is built to
avoid.

---

## This is a curated public repository

Euthynos is developed in a **private repository** and published as a curated
tree. The public repository starts from a single initial commit representing the
launch baseline.

**It does not contain the development history.** That is a deliberate choice,
not an accident and not a claim that the project appeared fully formed:

- the private history contains identifiers belonging to a **client** whose code
  was used as an early test case, and republishing it would disclose their
  internal API surface;
- rewriting that history to strip them would destroy the internal engineering
  record, which is the more valuable artifact of the two.

The private repository keeps the complete history; the public repository gets a
clean, honest baseline. **We would rather publish a short history than a
laundered one.**

---

## Precise latency figures are not published in V1

This is the one place where we have deliberately published *less* than we could.

We hold two internally consistent latency measurements. Each is schema-checked
against the live tool registry, fails closed on any errored call, performs a
real edit loop with mutation verification and file restoration, uses nearest-rank
percentiles, and retains every raw sample.

The two disagree. On the larger repository sizes, the diff-family tools differ by
roughly **27–38%** between them, and the difference is **directional and scales
with repository size** — which is the signature of a systematic effect, not
run-to-run noise.

The obvious way to resolve that is a controlled experiment: re-measure with the
fixture *path* renamed and everything else — same repositories, same git object
stores, same machine, same disk, same methodology — held identical. **We could
not complete it.** The original fixture repositories were deleted during
routine disk cleanup before that experiment was run, so the control condition no
longer exists and cannot be reconstructed. Regenerating fixtures would introduce
exactly the variable the experiment was designed to eliminate.

So:

- **We are not claiming either measurement is wrong.** Both are internally valid.
- **We are not offering an explanation for the difference.** We have a
  hypothesis; we could not test it, and an untested hypothesis is not evidence.
- **We are not regenerating fixtures until the numbers agree.** That would be
  selecting a result rather than measuring one.
- **We are not publishing either as V1 benchmark evidence.**

Both artifacts are retained privately for provenance and future research.
[SUPPORTED-SCALE.md](SUPPORTED-SCALE.md) states the validated envelope and the
memory constraint, which are stable across every measurement we have taken, and
ships the harness so you can measure your own machine.

A precise, controlled latency benchmark is deferred to a later release, run on a
machine with adequate headroom. **A number we cannot stand behind is worth less
than no number.**

---

## The three states of evidence here

### 1. Verifiable in this repository

The engine and its tests. `npm test` runs 685 tests; `npx tsc --noEmit` is clean;
`npm run build` produces the shipped `dist/`.

You can also generate and verify your own latency measurement — see
[SUPPORTED-SCALE.md](SUPPORTED-SCALE.md). The verifier deliberately does not
import the measurement harness; it re-implements nearest-rank percentile
independently and compares. A summary checked only by the code that produced it
is not checked.

### 2. Published as frozen evidence, but not re-runnable here

**`research/M2-PREREG.md`** and **`research/M2-RESULTS.md`** — the token/recall
benchmark, published **byte-identical** to the frozen originals.

That is a checkable claim, so here is what to check it against:

```
421a3a960ebf6cdaf1a3a35e9c4194bd4672ca29ba056b7ac3908fc029d601ee  research/M2-RESULTS.md
b0159dc389b560973a111aab65fb22172c717442d583b8d6702d1934ab60d167  research/M2-PREREG.md
```

```bash
sha256sum research/M2-RESULTS.md research/M2-PREREG.md
```

These files are marked `-text` in `.gitattributes` so that no platform's
line-ending conversion can alter them on checkout. Without that, Git for Windows
— which defaults to `core.autocrlf=true` — would hand you CRLF copies whose
hashes do not match, and the byte-identity claim above would be false for a large
share of readers through no fault of their own.

> **The M2 execution harness is not included in this repository.** M2 drives real
> agent sessions through a private experiment harness that is not part of the
> public surface. You can **read M2 at source** — the preregistration written
> before any session ran, and the results with their caveats intact — but you
> **cannot independently re-run M2** from this repository.

Also not published: the **M2 answer keys** and the **full session ledger**. Any
statement that depends on those is unverified from here.

### 3. Not published at all

The latency artifacts, for the reasons above. Neither the figures nor the JSON
appear in this repository.

---

## Where our own numbers were wrong

[BENCHMARK-INTEGRITY-AUDIT.md](BENCHMARK-INTEGRITY-AUDIT.md) documents a real
failure: two benchmark harnesses were timing argument-validation errors as though
they were measurements, and one published claim was wrong by roughly three orders
of magnitude.

The broken harnesses are **still in this repository**, carrying DO-NOT-RUN
headers, so you can open them and confirm the defect yourself rather than taking
the audit's word for it.

That audit is why the current position on latency is what it is. Having once
published numbers that were measuring an error, the bar for publishing a
performance figure is now: reproducible from a valid operation, under a stated
methodology, with the control that establishes it. The V1 latency figures did not
clear that bar, so they are not here.

---

## Summary

| artifact | published | verifiable here | re-runnable here |
|---|---|---|---|
| engine source and tests | yes | **yes** — `npm test` | yes |
| `research/M2-RESULTS.md` | yes, unmodified | as a document | **no** — harness private |
| `research/M2-PREREG.md` | yes, unmodified | as a document | n/a |
| M2 answer keys / session ledger | **no** | no | no |
| latency artifacts | **no** — deferred | n/a | you can measure your own |
| validated scale envelope | yes | by running the harness | yes |

Questions about any of this belong in an issue. If something here is misleading,
that is a bug and we would like to know.
