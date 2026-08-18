# Benchmark Integrity Audit

**Date:** 2026-08-17 · **Engine:** `euthynos@0.1.0` at `50803e3` (+ working tree)
**Scope:** every benchmark harness in this repository and every published number
derived from one.
**Status:** historical record of a completed audit.

> **The figures in §7, §8 and §9 are not V1 public claims.** That includes every
> "real value" quoted in the §8 classification table and every figure named in
> the §9 remediation list. They were measured internally during this audit. A
> later controlled comparison could not be completed, so V1 publishes no precise
> latency figures at all — see
> [PROVENANCE.md](PROVENANCE.md). This document is retained because what it
> found, and the gates it produced, remain true and are the reason the current
> bar for publishing a performance number is what it is. Read the tables below
> as a record of what the audit measured, not as figures Euthynos stands behind
> today.

> **The frozen M2 evidence was not touched.** No answer key, preregistration,
> result, ledger row or session artifact was modified during this audit. The
> preregistration and the results are published unmodified in
> [`research/`](../research/); the answer keys and session ledger are not, so
> nothing in this document asks you to take a private hash on trust.

---

## 1. Why this audit happened

A stale cold-scan figure in the README led to the harness behind it. The harness
did not do what its own documentation said it did. Pulling that thread found
that **two separate benchmark harnesses were timing argument-validation errors
as if they were measurements**, and that a published methodology statement
described a procedure no committed code performs.

The failure mode is worth stating plainly, because it is silent by construction:

```
callTool('find_symbol', { name: 'helper7' })
  -> { text: "Tool 'find_symbol' failed: Missing or invalid 'query' argument", isError: true }
```

The library **returns** this. It does not throw. A harness that does not read
`isError` receives an ordinary-looking object, times it, and records the number.
A rejection returns in **1–2 ms**; the real call takes **150–425 ms**. The
resulting table does not look broken — it looks like an extraordinary
performance result.

---

## 2. Benchmark inventory

| harness | what it measures | invocations | invalid | verdict |
|---|---|---|---|---|
| `scripts/measurement/measure-tools.mjs` | tool latency, 3 synthetic scales | 9 | **0** | **SUPERSEDED** — args valid, but no edit loop and "p95" is a max |
| `scripts/measurement/measure-scale.mjs` | tool latency + index size | 6 | **2** | **SUPERSEDED** — sole origin of the "≤0.3 ms" claim |
| `scripts/latency-bench.mjs` | warm tool latency on a real subject | 13 | **8** (+1 nonexistent tool) | **SUPERSEDED** — never published anything |
| `scripts/token-bench.mjs` | agent-session tokens | 0 | 0 | **VALID** — drives `claude` sessions, never `callTool` |
| `scripts/experiment-harness.mjs` | agent-session experiments (M2) | 0 | 0 | **VALID** — same; M2 is unaffected |
| `scripts/evidence-substitution.mjs` | tool-substitution evidence | 0 | 0 | **VALID** — already checks `isError` |
| `scripts/measurement/measure-latency.mjs` | **new authoritative harness** | 12 | **0** | **VALID** |
| `scripts/measurement/audit-harness-args.mjs` | **new**: schema auditor / CI gate | — | — | **VALID** |

**40 invocations audited · 10 invalid.**

**M2 is not implicated.** The token/recall benchmark drives agent sessions and
never calls the tool layer, so this entire defect class cannot reach it. That is
why its records are preserved unchanged rather than re-run.

---

## 3. Methodology actually performed vs methodology published

`SUPPORTED-SCALE.md` states, verbatim:

> "**The edit loop is the honest benchmark.** A static repository makes every
> cache hit and flatters the numbers; the tables above re-edit a file before
> every call on purpose."

`measure-tools.mjs` contains **no write operation of any kind**. It deletes the
index, primes once, then times repeated calls on a static repository — precisely
the thing the paragraph claims it avoids. `git log` confirms the file has exactly
one commit and never contained a write.

**Classification: the labels were false; the numbers were partly not.** See §6 —
several published rows *do* reproduce under a genuine edit loop, which means they
came from a real edit-loop procedure that was never committed. The methodology
was therefore **unreproducible from this repository**, which under the stated
hard rule is disqualifying regardless of how the numbers originated.

---

## 4. Argument / schema verification

Every invocation was checked against the **live registry** (`TOOLS` from the
built `dist`), not against documentation or memory.

| tool | harness passed | schema requires | result |
|---|---|---|---|
| `find_symbol` | `{ name }` | `query` | rejected in ~2 ms |
| `read_function` | `{ name }` | `function` | rejected in ~0.8 ms |
| `find_references` | `{ name }` | `symbol` | rejected |
| `callers_of` | `{ name }` | `function` | rejected |
| `callees_of` | `{ name }` | `function` | rejected |
| `tests_for` | `{ name }` | `target` | rejected |
| `context_bundle` | `{ name }` | `target` | rejected |
| `similar_code` | — | **no such tool** | never existed; real name is `similar_logic_exists` |

Measured side by side on the 1,500-file fixture:

```
find_symbol   { name: … }      2.25 ms   isError=true
find_symbol   { query: … }   326.44 ms   success
read_function { name: … }      0.81 ms   isError=true
read_function { function: … } 377.73 ms   success
```

`audit-harness-args.mjs` now performs this check statically and **exits 1** on
any invalid invocation, so it can gate CI.

---

## 5. Mutation verification

The new harness does not assume an edit was observed; it proves it, and refuses
to record a sample otherwise.

Per iteration: **mutate → assert observation → time → restore → assert sha256
matches the original.** The mutation has two parts, because one is insufficient:

- it **appends** a function that calls the target, making the graph tools
  observable (a new caller appears in the answer), and
- it **modifies an existing function body**, because `change_impact` traces
  *modified* and *removed* symbols and correctly answers *"added symbols have no
  callers yet by definition"* — an add-only edit gives it nothing to do.

The injected statement is a **call**, not a comment or a literal: body hashing is
deliberately literal-blind (D9), so a cosmetic edit would not register as a
modified symbol and the mutation would be invisible by design.

Observation predicates: graph tools must contain the new symbol; diff tools must
contain the mutated file path. Two gates fired during development and both were
correct — one caught a wrong predicate of mine (`change_impact` on an add-only
edit), one would have caught a hardcoded probe file that is an importer at 1,500
files but not at 5,000 or 10,000. The probe is now discovered at runtime.

---

## 6. Statistical verification

**The published "p95" was a maximum.**

```js
const at = (q) => a[Math.min(a.length - 1, Math.floor(q * a.length))];
// n = 9  ->  at(0.95) = a[min(8, floor(8.55))] = a[8] = max
```

The median was computed correctly. The p95 column was the largest of 9 samples.

**The published sample count was wrong in every document.** The harness ran
`REPS = 9`; `SUPPORTED-SCALE.md`, the research page, the blog post and the feed
all state **7 repetitions**.

The replacement uses **nearest-rank** percentile (no interpolation, so every
reported figure is an observation that actually occurred), reports `n` with every
figure, and **refuses to emit a percentile it cannot express distinctly** —
at n=9 it returns `p95: null` with the reason, rather than a max in a
percentile's clothing.

---

## 7. Re-measured results (internal, superseded — see the status note above)

`measure-latency.mjs`, n=20 per cell, cold n=1 by definition, nearest-rank p95,
Windows 11 / Node 24 / 16 GB, engine `50803e3`.

**Warm (median / p95 ms)** — repeated calls, no mutation, labelled warm:

| tool | 1,500 | 5,000 | 10,000 |
|---|---|---|---|
| `repo_map` | 141.5 / 153.2 | 196.0 / 214.6 | 350.1 / 365.7 |
| `find_symbol` | 143.5 / 149.2 | 206.9 / 213.4 | 366.8 / 374.6 |
| `read_function` | 155.0 / 173.1 | 214.5 / 231.1 | 380.3 / 430.3 |
| `find_references` | 141.9 / 157.3 | 203.9 / 216.2 | 348.7 / 359.5 |
| `callers_of` | 139.0 / 149.0 | 191.4 / 244.4 | 332.7 / 371.0 |
| `impact_of` | 138.7 / 146.1 | 194.5 / 216.6 | 333.7 / 342.6 |
| `boundary_check` | 492.4 / 551.2 | 547.8 / 593.1 | 996.4 / 1050.2 |
| `check_my_changes` | 480.5 / 489.4 | 489.2 / 537.5 | 827.4 / 880.7 |

**Edit-loop, mutation-verified (median / p95 ms)** — a real filesystem edit
before every measured query, observation asserted, file restored:

| tool | 1,500 | 5,000 | 10,000 |
|---|---|---|---|
| `find_references` | 177.5 / 217.1 | 350.8 / 474.4 | 583.3 / 892.3 |
| `callers_of` | 334.3 / 379.4 | 697.7 / 894.7 | 1497.2 / 1815.4 |
| `impact_of` | 328.8 / 438.0 | 704.2 / 852.7 | 1497.5 / 1805.0 |
| `check_my_changes` | 799.5 / 914.7 | 1215.5 / 1447.9 | 2748.9 / 3069.7 |
| `change_impact` | 767.1 / 980.6 | 1089.1 / 1243.3 | 2146.9 / 2464.1 |
| `diff_context` | 732.5 / 843.7 | 1095.4 / 1295.8 | 2231.1 / 2490.1 |

**Cold build (n=1):** 1,833 ms · 4,739 ms · 9,144 ms
**RSS before → after:** 139→384 MB · 369→714 MB · 652→1093 MB

---

## 8. Claim-by-claim classification

| # | claim | classification | basis |
|---|---|---|---|
| 1 | Pure index reads "stay at **≤0.3 ms at every scale**" | **INVALID** | Measured an argument rejection. Real: **142–425 ms**, and it *scales with repository size* — the central assertion (scale-invariance) is false, not just the magnitude. `find_references` was never measured at all. |
| 2 | "Medians and p95 over **7 repetitions**" | **INVALID** | Harness ran 9. |
| 3 | The **p95 column** | **INVALID** | Was the maximum of 9 samples. |
| 4 | "the tables above **re-edit a file** before every call on purpose" | **INVALID as stated** | No committed harness performs an edit. |
| 5 | `callers_of` / `impact_of` "after edit" | **RE-MEASURED — confirmed** | Published 341/333 @1.5k; measured 334.3/328.8. Reproduces at 1.5k and 5k; 10k differs ~18% (published 1836, measured 1497). |
| 6 | `check_my_changes` "after edit" | **RE-MEASURED — confirmed** | 814→799.5, 1317→1215.5, 2837→2748.9. |
| 7 | `change_impact` / `diff_context` "after edit" | **NEEDS RE-MEASUREMENT** | Published is 21–95% *below* my verified edit loop and does not match warm either. Consistent with an **add-only** edit, where `change_impact` returns the degenerate "nothing to trace" path. The published figure likely times a no-op. |
| 8 | `boundary_check` "after edit" | **UNSUPPORTED** | No observation predicate exists for it, so no edit-loop figure can be verified. Warm is measured (492/548/996). |
| 9 | Cold build 1.85 / 5.48 / 10.18 s | **RE-MEASURED — confirmed** | 1.83 / 4.74 / 9.14 s. Within run-to-run variance; the 5k/10k figures are 10–14% optimistic. |
| 10 | Warm `repo_map` 159 / 208 / 367 ms | **RE-MEASURED — confirmed** | 141.5 / 196.0 / 350.1 ms. |
| 11 | RSS 142→405, 389→681, 620→1092 MB | **RE-MEASURED — confirmed** | 139→384, 369→714, 652→1093 MB. |
| 12 | Memory is the binding constraint | **VALID** | Reproduced: 1,093 MB peak at 10k. |
| 13 | Everything from `latency-bench.mjs` | **UNSUPPORTED — but unpublished** | 8/13 invocations invalid; no artifact or doc reference exists anywhere. Nothing shipped depends on it. |
| 14 | All M2 token/recall figures | **VALID — untouched** | Different instrument, different layer; no `callTool` path. |

---

## 9. Files requiring publication updates

Nothing below has been changed yet — the corrected numbers are not published.

**Must change before any release:**

| file | what is wrong |
|---|---|
| `SUPPORTED-SCALE.md` | the "≤0.3 ms" sentence (§8-1); "7 repetitions" (§8-2); the p95 column header (§8-3); the "re-edit a file" paragraph (§8-4); `change_impact`/`diff_context`/`boundary_check` rows (§8-7, §8-8) |
| `landing-page/research/index.html:525` | "medians of 7 repetitions, edit-loop methodology" |
| `landing-page/research/index.html:530-539` | the scale table + the "≤0.3 ms at every scale" sentence |
| `landing-page/posts.json` | blog body: rep count and the pure-index-reads paragraph — **edit here, then rebuild**; it generates the blog page *and* `feed.xml` |
| `landing-page/blog/euthynos-mcp-setup-claude-code/index.html:468,470` | generated — regenerate |
| `landing-page/feed.xml:619,621` | generated — regenerate |

**Already corrected in the working tree (uncommitted):** `README.md:294-299`,
`src/mcp/server.ts:35-42`, and the blog/feed cold-scan figures — the superseded
1.5–2.4 s range now reads 1.85 / 5.48 / 10.18 s. **Those figures are themselves
now superseded by §7** and should be restated as 1.83 / 4.74 / 9.14 s, or the
whole family re-run once on a quiet machine and stated from that single run.

**Marked superseded (done):** `measure-tools.mjs`, `measure-scale.mjs`,
`latency-bench.mjs` each carry a header explaining precisely why their output
must not be quoted.

---

## 10. Other benchmarks that could produce a valid-looking number from a non-event

| risk | present? | mitigation |
|---|---|---|
| Error return timed as a result | **was present** in 3 harnesses | `call()` asserts `isError !== true`, non-empty text, and no `Tool '…' failed:` prefix |
| Empty result timed as a result | possible | same assertion |
| Nonexistent tool silently skipped | **was present** (`similar_code`) | schema check throws before the run |
| Mutation benchmark where no mutation occurred | **was present** | observation predicate + size check + sha256 restore check |
| Degenerate fast path recorded as real work | **suspected** (§8-7) | two-part mutation gives every tool actual work |
| Percentile that is really a maximum | **was present** | `percentileIsDistinct` refuses it |
| Stale/foreign build measured | **latent** — harnesses imported a hardcoded absolute path through a machine-local junction | new harness resolves `dist` relative to itself |
| Fixture drift between scales | **was latent** — probe file is an importer only at 1,500 | probe discovered at runtime per scale |

---

## 11. Recommendation

**The launch evidence is not publishable as it stands.** Three published claims
are invalid, two need re-measurement, and one is unsupported.

It is publishable **after** §9 is applied, and the evidence is in better shape
than the defect count suggests:

- **M2 — the headline benchmark — is unaffected.** Different instrument, no
  `callTool` path, records preserved byte-identical. The 13–31% token result and
  the 42/42 recall identity stand exactly as they were.
- **Most of the scale table survives re-measurement.** Cold build, warm
  `repo_map`, RSS, and the `callers_of` / `impact_of` / `check_my_changes`
  edit-loop rows all reproduce under a verified methodology.
- **The damage is concentrated in one sentence** — the "≤0.3 ms" claim — plus
  the statistical labelling. That sentence was the most impressive number on the
  page and it was measuring an error return. It should be deleted and replaced
  with the measured 142–425 ms, including the fact that read latency scales with
  repository size.

**Recommended sequence:** apply §9 → re-run `measure-latency.mjs` once on an
idle machine as the single authoritative source → restate every figure from that
one artifact → add `audit-harness-args.mjs` to CI so a malformed invocation can
never silently become a number again.

**Hard rule applied:** no number in §7 comes from an invocation that was not
schema-checked, assertion-passed, and — where labelled edit-loop —
mutation-verified with a restore check. Anything that could not meet that bar is
classified UNSUPPORTED above rather than estimated.
