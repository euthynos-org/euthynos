import { describe, expect, it } from 'vitest';
import { evaluatePolicy, type PolicyResult, type Violation } from '../src/policy/evaluate.js';
import { scopeToDiff } from '../src/policy/diff.js';
import { MAX_ANNOTATIONS, checkRunText, toCheckRun } from '../src/policy/checkrun.js';
import type { ImportEdge, ScanReport } from '../src/types.js';

/**
 * C5 — the Check Run payload. The one invariant that matters: the
 * conclusion mirrors the exit-code contract, so branch protection and the
 * terminal can never disagree. Then: honest annotations (only where there is
 * a line), pre-existing findings not blamed, the 50-cap disclosed.
 */

const edge = (over: Partial<ImportEdge> = {}): ImportEdge => ({
  fromFile: 'src/ui/cart.ts', fromModule: 'ui', line: 3,
  toFile: 'src/db/orders.ts', toModule: 'db',
  isTypeOnly: false, fromIsTest: false,
  ...over,
});

function rep(over: Partial<ScanReport> = {}): ScanReport {
  return {
    root: '/r', scannedAt: 't', filesScanned: 1, modules: [],
    contamination: { score: 0, label: 'Clean', findings: [], violations: 0, cloneFnIds: [] } as ScanReport['contamination'],
    health: { score: 60, label: 'Stable' },
    averages: { depth: 50, seams: 70, locality: 50, leverage: 50 },
    opportunities: [], gitAvailable: true, ...over,
  };
}

const v = (over: Partial<Violation>): Violation => ({ ruleId: 'r', type: 'forbidden-dependency', mode: 'block', message: 'm', ...over });
const result = (violations: Violation[], over: Partial<PolicyResult> = {}): PolicyResult => ({
  violations, blocked: violations.some((x) => x.mode === 'block'), passed: violations.length === 0,
  skippedDeltaRules: 0, skippedEdgeRules: 0, invalidRules: [], unmatchedGlobs: [], edgeRulesEvaluated: 1,
  skippedIncompleteRules: 0, duplicationHeadCapped: false, ...over,
});

const BLOCK = { rules: [{ id: 'no-ui-to-db', type: 'forbidden-dependency' as const, from: 'ui', to: 'db', mode: 'block' as const }] };

describe('conclusion mirrors the exit-code contract', () => {
  const report = rep({ importEdges: [edge()] });
  const blocked = evaluatePolicy(BLOCK, report);

  it('no findings → success', () => {
    expect(toCheckRun(evaluatePolicy(BLOCK, rep({ importEdges: [] })), rep(), { scope: 'repo', strict: true }).conclusion).toBe('success');
  });

  it('blocking finding + --strict → failure (exit 1)', () => {
    const c = toCheckRun(blocked, report, { scope: 'repo', strict: true });
    expect(c.conclusion).toBe('failure');
    expect(c.output.title).toContain('Blocked — 1 blocking');
  });

  it('blocking finding WITHOUT --strict → neutral, and the summary says it is observe mode (exit 0)', () => {
    const c = toCheckRun(blocked, report, { scope: 'repo', strict: false });
    expect(c.conclusion).toBe('neutral');
    expect(c.output.summary).toContain('Observe mode');
  });

  it('a config error → failure even with no findings (exit 2 must never read as a pass)', () => {
    const bad = evaluatePolicy({ rules: [{ type: 'forbidden-dependency', from: 'ui' }] }, report);
    const c = toCheckRun(bad, report, { scope: 'repo', strict: false });
    expect(c.conclusion).toBe('failure');
    expect(c.output.title).toContain('config error');
  });

  it('diff scope: a pre-existing block-mode finding does not fail the check', () => {
    const diff = scopeToDiff(blocked, blocked); // base == head → everything pre-existing
    const c = toCheckRun(blocked, report, { scope: 'diff', diff, strict: true });
    expect(c.conclusion).toBe('neutral');
    expect(c.output.title).toContain('0 introduced · 1 pre-existing');
  });

  it('diff scope: an introduced block-mode finding fails the check under --strict', () => {
    const diff = scopeToDiff(blocked, result([]));
    const c = toCheckRun(blocked, report, { scope: 'diff', diff, strict: true });
    expect(c.conclusion).toBe('failure');
    expect(c.output.title).toContain('introduced by this change');
  });
});

describe('annotations', () => {
  it('pins a localized violation to its exact line with the remedy in the message; block → failure, warn → warning', () => {
    const report = rep({ importEdges: [edge(), edge({ fromFile: 'src/ui/list.ts', line: 7 })] });
    const r = evaluatePolicy({ rules: [{ id: 'a', type: 'forbidden-dependency', from: 'ui', to: 'db', mode: 'block' }, { id: 'b', type: 'forbidden-dependency', from: 'ui', to: 'db', mode: 'warn' }] }, report);
    const ann = toCheckRun(r, report, { scope: 'repo', strict: true }).output.annotations;
    expect(ann).toHaveLength(4);
    expect(ann[0]).toEqual({ path: 'src/ui/cart.ts', start_line: 3, end_line: 3, annotation_level: 'failure', message: expect.stringContaining('Remove the direct import'), title: 'a' });
    expect(ann.filter((x) => x.annotation_level === 'warning')).toHaveLength(2);
  });

  it('an aggregate finding is not annotated (no line to pin) and the summary says so', () => {
    const base = rep({ health: { score: 64, label: 'Stable' } });
    const head = rep({ health: { score: 58, label: 'Drifting' } });
    const r = evaluatePolicy({ rules: [{ type: 'health-delta', maxDrop: 3, mode: 'block' }] }, head, base);
    const c = toCheckRun(r, head, { scope: 'repo', strict: true });
    expect(c.output.annotations).toEqual([]);
    expect(c.output.summary).toContain('1 aggregate finding(s) have no single line');
    expect(c.conclusion).toBe('failure'); // still enforced — it just lives in the text
  });

  it('in diff scope a pre-existing finding is a notice, never a failure', () => {
    const report = rep({ importEdges: [edge()] });
    const r = evaluatePolicy(BLOCK, report);
    const c = toCheckRun(r, report, { scope: 'diff', diff: scopeToDiff(r, r), strict: true });
    expect(c.output.annotations[0]!.annotation_level).toBe('notice');
    expect(c.output.annotations[0]!.title).toBe('no-ui-to-db (pre-existing)');
  });

  it('caps at GitHub\'s limit and discloses the overflow', () => {
    const many = Array.from({ length: MAX_ANNOTATIONS + 7 }, (_, i) => v({ location: { file: `src/f${i}.ts`, line: 1 }, toFile: 'x' }));
    const c = toCheckRun(result(many), rep(), { scope: 'repo', strict: false });
    expect(c.output.annotations).toHaveLength(MAX_ANNOTATIONS);
    expect(c.output.summary).toContain('7 more annotation(s) omitted');
  });
});

describe('payload', () => {
  it('carries the PR-comment markdown as details and serializes deterministically', () => {
    const report = rep({ importEdges: [edge()] });
    const r = evaluatePolicy(BLOCK, report);
    const c = toCheckRun(r, report, { scope: 'repo', strict: true });
    expect(c.name).toBe('Euthynos policy');
    expect(c.output.text).toContain('## ◉ Euthynos — architecture policy');
    expect(checkRunText(c)).toBe(checkRunText(toCheckRun(r, report, { scope: 'repo', strict: true })));
  });
});
