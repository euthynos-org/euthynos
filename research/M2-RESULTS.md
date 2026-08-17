# M2 — Launch-Candidate Milestone Benchmark · RESULTS (2026-08-15)

Run exactly as preregistered (`M2-PREREG.md`, frozen at saas `dc11405`):
engine `81337c8` (dist stamped `+81337c8fe467`), subject `hono @ 26de7313`,
Task Suite v2, keys frozen at `17e7b58` (G6 hashes `8f210e13a8` /
`8cf7e0ff4c`). All sessions through the G1–G7 harness; manifest
`bench-results/exp-m2-2026-08-14T20-26-28/`. Model: claude-opus-5, every
session. Zero permission drift; subject clean after every session; zero
harness-level failures across all 46 attempted sessions.

## Attempted vs valid (the whole truth first)

**46 attempted (4 calibration + 42 measurement) · 21 measurement sessions
VALID · 21 INVALID.** Invalidity, by preregistered class:

- **14 sessions lost to an external rate-limit wall**: the subscription
  session limit was hit at duplicate-audit:mcp:1; that session and the 13
  after it (all of guided-edit, all of orientation, the rest of
  duplicate-audit:mcp) received "You've hit your session limit" with ZERO
  API usage in 13 of the 14 (9-second refusals at the door). Transport
  class → invalid, preserved in the manifest. **guided-edit and
  orientation are therefore UNMEASURED in M2, and duplicate-audit has no
  valid mcp arm.**
- **5 profile-rule-denial discards** (4 baseline, 1 mcp-capped):
  architecture-overview:baseline ×3, duplicate-audit:baseline:1, plus
  architecture-overview:mcp:1/:3 turn-capped with empty answers (capped =
  invalid-for-recall). The baseline arm's denials repeat the calibration
  pattern: compound commands (`xargs`, `sort`, and `node -e` INSIDE a
  compound — the G5 caveat live), never the frozen profile's own rules.
- **2 fail-closed denial texts hand-classified during validity review**
  ("Contains expansion"-family static-analysis texts and PowerShell
  script-block guards → expansion-policy; "Exit code N" tool results →
  tool-answer, not denials). Two sessions became VALID on re-binning
  (callers:mcp:3, duplicate-audit:baseline:3). No text outside the
  recorded families appeared.

**Environment fact (all 46 sessions, arm-symmetric, also true of every
prior frozen experiment checked):** the CLI ignored the frozen profile's
17 allow rules — "workspace has not been trusted" — so runtime permissions
were the CLI's static-analysis defaults, not the profile's allows. G1
froze the file; G5's recorded caveat (literal presence ≠ runtime effect)
is now empirically demonstrated. Internally consistent for M2 and for
comparisons with H-honesty-era runs (same warning present); a trust-dialog
fix is a POST-M2 harness change, never mid-run.

## Primary endpoints (medians over VALID sessions)

| task | arm | n | fresh tokens | ctx-read tok (est) | recall vs key | FP | unhedged-exhaustiveness |
|---|---|---|---|---|---|---|---|
| callers | baseline | 3 | 70,878 | 10,308 | **12/12** | 1 (F2 tests-as-callers) | 1/3 |
| callers | mcp | 3 | **49,476 (−30%)** | 7,326 | **12/12** | 0 | 0/3 |
| similar-logic | baseline | 3 | 33,429 | 2,908 | **15/15** | 0 | 2/3 |
| similar-logic | mcp | 3 | **29,120 (−13%)** | 3,692 | **15/15** | 0 | 3/3 |
| blast-radius | baseline | 3 | 56,481 | 7,013 | **15/15** | 0 | 3/3 |
| blast-radius | mcp | 3 | **39,242 (−31%)** | 5,088 | **15/15** | 0 | 0/3 |
| architecture-overview | baseline | 0 | — | — | — | — | — |
| architecture-overview | mcp | 1 | 5,644 | 1,313 | 3/3 | 1 (F1 "request" slip) | 0/1 |
| duplicate-audit | baseline | 2 | 214,225 | 18,314 | 4/4 and 3/4 | F2×2, F3×1 | 1/2 |
| duplicate-audit | mcp | 0 | — | — | — | — | — |

Recall grading: hand-graded from full `finalAnswer` result events BEFORE
any transcript/read inspection, against the frozen keys; a 16-agent blind
panel (2 independent graders per cell, key-only ground truth, forbidden
from source) cross-checked every grade. 25 grader-vs-hand disagreements
were adjudicated one by one under a single recorded standard: *a
totality/only claim ("full", "all", "only N", "no other") is an
exhaustiveness violation unless the answer states its evidence basis
(method, scope, or instrument limit) anywhere.* The panel caught two real
misses of mine (the architecture answer's fabricated "request" module in
prose → F1; duplicate-audit:baseline:3's claim that isContentTypeBinary
is on the lambda-edge package surface → F3, the exact A1-era error). I
overruled the panel where an answer's stated instrument boundary
satisfied the standard (e.g. "the graph missed it — it's a method call").

## What the numbers say (within-run, arm vs arm — the only comparison M2 makes)

1. **On the three fully-measured comparable tasks (callers, similar-logic,
   blast-radius): recall is IDENTICAL and PERFECT in both arms (42/42
   slots each), and the mcp arm used 13–31% fewer fresh tokens** (median,
   per task). Same answers, cheaper — the evidence-substitution claim in
   its honest form, now with recall held constant by measurement rather
   than assumption.
2. **The serializeSigned trap did not fire in either arm**: all six valid
   blast-radius sessions correctly identified serializeSigned as a
   `_serialize` sibling, not a caller — the preregistered
   sharpest-answer credit, 6/6.
3. **FP/honesty asymmetry favors the mcp arm where both arms ran**:
   baseline accumulated 4 FPs (incl. the A1-era F3 package-surface error
   resurfacing in a 178k-token baseline sweep) and 7/11 sessions with
   unhedged exhaustiveness claims; mcp accumulated 1 FP and 3/10 — and
   the mcp blast-radius cell is the only cell where sessions explicitly
   disclosed the instrument's boundary ("callers_of missed client.ts —
   method call; ~1673 unresolved calls repo-wide"), which is the honesty
   contract propagating into agent output.
4. **Both arms beat the frozen key once**: all 6 valid blast-radius
   sessions found `src/client/client.ts:101` as a direct caller of
   serialize — verified real post-grading (plain import, line 3). Two
   findings recorded, key untouched: (a) K3 has a missing required slot
   (a key-v2 item for any future run); (b) **the engine's callers_of
   missed a statically resolvable call site inside a class method** — an
   engine precision gap now on the post-M2 fix list, found BY the
   benchmark exactly as the benchmark is meant to.
5. **Baseline duplicate-audit recovered the sub-declaration items**
   (R3 both sessions, R4 one session) at 178k–250k fresh tokens/session —
   whole-file sweeps still buy peripheral vision, at ~4× the token cost
   of the (calibration-only, non-quotable) mcp sessions, and with the F3
   error and a toSSG-wrapper F2 in both sessions as the cost of sweeping.
6. **architecture-overview inverts the attrition story**: all three
   baseline sessions died on profile-rule denials trying to script
   repo-wide measurements the permission surface blocks, while the one
   valid mcp session answered from 7 tool calls at 5,644 fresh tokens
   with 3/3 recall — but n=1 valid vs 0, so M2 records this as an
   attrition observation, not a token claim.

## What M2 does NOT show (equal prominence, per prereg)

- Nothing about guided-edit or orientation — the rate-limit wall consumed
  every session of both. The Phase 6 edit-loop adoption clause remains
  UNMEASURED.
- No duplicate-audit arm comparison — the mcp cell has zero valid
  sessions (calibration ran clean but calibration is never results).
- Single repository (hono), single model (claude-opus-5), one permission
  environment (untrusted-workspace CLI defaults) — no generalization.
- Agent nondeterminism: n=3 per cell at best; medians, no significance
  claims.
- No causal isolation of individual tools; arm difference is the whole
  MCP surface.
- Token deltas are within-M2 arm-vs-arm only. M0/M1 numbers are quotable
  from their own frozen sections; M2 does not restate or extend them.

## Session-limit incident + the open decision

The harness kept attempting sessions after the wall (the CLI exits 0 on
a session-limit error, so no stop signal existed — recorded as harness
gap H-G1 for post-M2). 13 of the 14 lost sessions consumed zero API
usage. Budget: 46 attempted of the ≤52 ceiling; 6 replacement slots
unused. **Completing the two unmeasured tasks needs 14 sessions — more
than the recorded replacement allowance — so it is a founder decision,
not a harness action**: rerun as a recorded interruption-resumption
(prereg amendment), or accept M2 as reported with two tasks unmeasured.
Nothing here changes the grades or numbers above either way.

**Quotable output: the single M2 milestone section appended to
BENCH-LEDGER.md. Everything else in this file is supporting record.**
