# M2 — Launch-Candidate Milestone Benchmark · PREREGISTRATION (DRAFT)

**Status: APPROVED by the founder 2026-08-15, as written. FROZEN by this
commit — no edit after the first session is valid.** The ≤52-session
budget below is authorized. Calibration task (the one degree of freedom
the draft left open, fixed now, before session 1): **duplicate-audit** —
the task with the longest-frozen key and the prior calibration precedent.
Phase 6 proved the product works as engineered; **M2 exists to determine
which launch claims are honestly makeable** — it measures whatever it
measures, and the claims are whatever survives.

## What M2 measures

Repo: the isolated subject `D:\euthynos-experiments\subjects\hono` @
`26de7313` with the frozen profile (`ba1d202f…`).
Engine: one commit, built and stamped, identical across all arms.
Suite: **Task Suite v2** (`scripts/tasks-hono-v2.json`) — the five M0/M1
prompts VERBATIM (comparability) + orientation + guided-edit.
Design: **7 tasks × 2 arms (baseline / mcp) × 3 reps = 42 sessions**, all
through the G1–G7 gated harness (`experiment-harness.mjs` suite mode);
model id and turn cap recorded; the direct token-bench path is retired for
experiments.

**Primary endpoints (per task, medians over VALID reps):**
1. Fresh input tokens (exact API fields) — the M0/M1 headline lineage.
2. Context-read tokens (chars/4, labeled estimate).
3. **Recall vs the frozen answer keys** (`M2-ANSWER-KEYS.md` +
   `H3A-ANSWER-KEY.md`), hand-graded from `finalAnswer` BEFORE any read
   inspection — the Phase-6-era lesson: token wins with recall losses are
   regressions, and automated probes almost mis-graded H-honesty.
4. False positives and incorrect exhaustiveness claims per key.

**Secondary (reported, never gating):** adoption funnel (LOADED / CHOSEN /
USEFUL / empty), exploration vs verification ingestion (route-agnostic
classifier v2; FORBIDDEN to sum), permission-fallback and unknown events,
denial classes P/E/U, execution attempts/denials, per-tool call counts
(does the edit-loop surface get chosen on guided-edit — the deferred
Phase 6 adoption clause, measured here), latency per call.

**Quotable output:** ONE ledger milestone section in the M0/M1 format —
per-task table, overall medians, verbatim caveats, all transcripts
archived. Nothing else from M2 is quotable. Comparability note: 5 tasks
comparable to M0/M1; orientation and guided-edit are NEW columns with no
prior, reported without trend claims.

## Validity rules (preregistered, mechanical)

A session is VALID iff: exit 0 · non-empty finalAnswer, no transport
error · zero profile-rule denials · zero unexpected denials (fail-closed:
any new denial text stops grading until hand-classified and recorded).
**Expansion-policy denials are retained** and reported (calibration:
arm-symmetric CLI constant). Turn-capped sessions: retained, flagged,
invalid-for-recall (no answer), included in the attempted/valid counts.
Replacements ONLY via `--replace arm:rep --reason`, appended to the
manifest (never re-initialized), originals preserved. Per-session G1
hash recheck before/after; drift = experiment INVALID from that point.
Subject clean-tree recheck after every session.

## The anti-H3a checklist (every item enforced before session 1)

1. **G1–G7 pass in check-only mode** and the manifest is archived — the
   9-broken-configs reliability net stands between us and another
   uncontrolled run.
2. **Calibration precedes measurement:** a 4-session calibration (2+2 on
   one task) re-verifying determinism byte-identity, arm isolation, zero
   drift — counted inside the approved M2 budget, reported as calibration,
   never as results.
3. **Answer keys frozen by commit BEFORE session 1** (G6 hashes recorded);
   any key edit after session 1 invalidates the run.
4. **No mid-run methodology edits** — prompts, instructions, engine,
   profile, grading rules all hash-pinned; a needed change = stop, record,
   restart as a new run.
5. **Recall graded before reads**, by hand, against the keys — probes may
   assist but never decide (H-honesty footnote rule).
6. **Denial taxonomy dispositions preregistered** (above) — the H3a
   attrition failure (blanket discard consumed 6 of 8 sessions over an
   arm-symmetric constant) cannot recur.
7. **Attempted vs valid counts in the final report**; capped and invalid
   sessions preserved in the manifest; no silent replacement.
8. **The report states what M2 does NOT show** (single repository; agent
   nondeterminism; no causal isolation of individual tools) with the same
   prominence as what it shows.

## Session budget

42 measurement + 4 calibration + a replacement allowance of up to 6
(explicitly recorded) = **≤52 sessions**, the largest spend in the
project's history — which is why this document exists before a single one
runs. Interruptions (rate limits, transport) follow the validity rules;
the harness stops, never improvises.

## Freeze facts (recorded 2026-08-15, Phase 7)

Everything below was verified by a check-only G1–G7 pass on the REAL M2
spec — all 7 gates PASS, zero sessions started, status `GATES_PASSED`:

- Spec: `contexthub/scripts/experiments/m2.spec.json` (7 tasks ×
  baseline/mcp × 3 reps; `treatmentKeys: ["mode"]` — G4 confirmed mode is
  the only arm difference).
- Task suite: `scripts/tasks-hono-v2.json`, frozen at engine commit
  `69c6e71` (5 M0/M1 prompts verbatim + orientation + guided-edit).
- Answer keys, frozen at saas commit `17e7b58`, G6 hashes:
  `M2-ANSWER-KEYS.md` = `8f210e13a8…`, `H3A-ANSWER-KEY.md` = `8cf7e0ff4c…`.
- Subject: `D:\euthynos-experiments\subjects\hono` @ `26de7313`, clean
  (G3), frozen profile intact (G1).
- Instrument: `evidence-substitution.mjs` classifier v2 (G7); ledger via
  `ledger-ingest.mjs` (append-only; the 123 historical archived sessions
  are already ingested into `docs/experiment-ledger.jsonl`).
- Latency instrument: `latency-bench.mjs`; recorded artifact
  `docs/LATENCY-20260815-hono.json` (engine 2a11b07 runtime build: cold
  first-call 1.4 s incl. index build; warm medians — reads ≤0.1 ms, graph
  walks ~34-36 ms, boundary_check/check_my_changes ~300 ms; median+p95,
  machine-stamped).

The engine commit that will run M2 is pinned at approval time (G2 pins it
mechanically); the numbers above are Phase 7 verification facts, not M2
results.

## What happens after

Results → one ledger milestone section + `M2-RESULTS.md` (attempted/valid
accounting, per-key recall tables, funnel, the not-shown list) → the
founder's launch decision per the standing contract. If M2's numbers do
not support a wanted claim, the claim changes — never the methodology,
never retroactively the keys.
