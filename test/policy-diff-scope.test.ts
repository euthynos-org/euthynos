import { describe, expect, it } from 'vitest';
import { evaluatePolicy, type PolicyResult, type Violation } from '../src/policy/evaluate.js';
import { fingerprintOf, renderDiffScopeMarkdown, renderDiffScopeTerminal, scopeToDiff } from '../src/policy/diff.js';
import type { ImportEdge, ScanReport } from '../src/types.js';

/**
 * C3 — diff scoping. The identity of a violation must survive the edits made
 * while fixing something else (never the line), and only what a change
 * INTRODUCED may block. Pre-existing debt is reported, never punished.
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
    contamination: { score: 0, label: 'Clean', findings: [], violations: 0, cloneFnIds: [] },
    health: { score: 60, label: 'Stable' },
    averages: { depth: 50, seams: 70, locality: 50, leverage: 50 },
    opportunities: [], gitAvailable: true, ...over,
  };
}

const v = (over: Partial<Violation>): Violation => ({ ruleId: 'r', type: 'forbidden-dependency', mode: 'block', message: 'm', ...over });
const result = (violations: Violation[]): PolicyResult => ({
  violations, blocked: violations.some((x) => x.mode === 'block'), passed: violations.length === 0,
  skippedDeltaRules: 0, skippedEdgeRules: 0, invalidRules: [], unmatchedGlobs: [], edgeRulesEvaluated: 1,
});

const NO_TO_DB = { id: 'no-to-db', type: 'forbidden-dependency' as const, to: 'db', mode: 'block' as const };

describe('fingerprintOf — identity that survives a line shift', () => {
  it('forbidden-dependency: same file → same target is the same crossing on any line', () => {
    const a = v({ location: { file: 'src/ui/cart.ts', line: 3 }, toFile: 'src/db/orders.ts' });
    const b = v({ location: { file: 'src/ui/cart.ts', line: 41 }, toFile: 'src/db/orders.ts' });
    expect(fingerprintOf(a)).toBe(fingerprintOf(b));
  });

  it('forbidden-dependency: a different target file is a different crossing', () => {
    const a = v({ location: { file: 'src/ui/cart.ts', line: 3 }, toFile: 'src/db/orders.ts' });
    const b = v({ location: { file: 'src/ui/cart.ts', line: 3 }, toFile: 'src/db/users.ts' });
    expect(fingerprintOf(a)).not.toBe(fingerprintOf(b));
  });

  it('no-new-duplication: the pair is the identity regardless of which side carries the location', () => {
    const ab = v({ ruleId: 'd', type: 'no-new-duplication', location: { file: 'a.ts', line: 10 }, remedy: { kind: 'extract-shared', instruction: '', suggestedTargets: [{ file: 'b.ts', why: '' }] } });
    const ba = v({ ruleId: 'd', type: 'no-new-duplication', location: { file: 'b.ts', line: 99 }, remedy: { kind: 'extract-shared', instruction: '', suggestedTargets: [{ file: 'a.ts', why: '' }] } });
    expect(fingerprintOf(ab)).toBe(fingerprintOf(ba));
  });

  it('metric-floor / min-owners key on the module; repo-wide deltas key on the rule alone', () => {
    expect(fingerprintOf(v({ ruleId: 'floor', type: 'metric-floor', module: 'payment' })))
      .toBe(fingerprintOf(v({ ruleId: 'floor', type: 'metric-floor', module: 'payment', after: 12 })));
    expect(fingerprintOf(v({ ruleId: 'floor', type: 'metric-floor', module: 'payment' })))
      .not.toBe(fingerprintOf(v({ ruleId: 'floor', type: 'metric-floor', module: 'auth' })));
    expect(fingerprintOf(v({ ruleId: 'h', type: 'health-delta', before: 64, after: 58 }))).toBe('h');
  });
});

describe('scopeToDiff — only what the change introduced can block', () => {
  it('partitions head violations into introduced vs pre-existing by fingerprint, and lists what was resolved', () => {
    const old = v({ ruleId: 'r', location: { file: 'src/ui/cart.ts', line: 3 }, toFile: 'src/db/orders.ts' });
    const gone = v({ ruleId: 'r', location: { file: 'src/ui/old.ts', line: 1 }, toFile: 'src/db/orders.ts' });
    const shifted = v({ ...old, location: { file: 'src/ui/cart.ts', line: 17 } }); // same crossing, lines moved
    const fresh = v({ ruleId: 'r', location: { file: 'src/services/x.ts', line: 2 }, toFile: 'src/db/orders.ts' });
    const d = scopeToDiff(result([shifted, fresh]), result([old, gone]));
    expect(d.introduced).toEqual([fresh]);
    expect(d.preExisting).toEqual([shifted]);
    expect(d.resolved).toEqual([fingerprintOf(gone)]);
    expect(d.blocked).toBe(true);
  });

  it('a pre-existing BLOCK-mode violation does not block in diff scope', () => {
    const old = v({ mode: 'block', location: { file: 'src/ui/cart.ts', line: 3 }, toFile: 'src/db/orders.ts' });
    const d = scopeToDiff(result([old]), result([old]));
    expect(d.preExisting).toHaveLength(1);
    expect(d.introduced).toHaveLength(0);
    expect(d.blocked).toBe(false);
  });

  it('an introduced WARN-mode violation is reported but does not block', () => {
    const w = v({ mode: 'warn', location: { file: 'src/ui/cart.ts', line: 3 }, toFile: 'src/db/orders.ts' });
    const d = scopeToDiff(result([w]), result([]));
    expect(d.introduced).toEqual([w]);
    expect(d.blocked).toBe(false);
  });

  it('is deterministic: identical inputs give byte-identical output', () => {
    const a = v({ location: { file: 'a.ts', line: 1 }, toFile: 'b.ts' });
    const x = scopeToDiff(result([a]), result([]));
    const y = scopeToDiff(result([a]), result([]));
    expect(JSON.stringify(x)).toBe(JSON.stringify(y));
  });
});

describe('end to end over real evaluations', () => {
  it('a line shift in an existing crossing is pre-existing; a new crossing is introduced', () => {
    const base = rep({ importEdges: [edge({ line: 3 })] });
    const head = rep({ importEdges: [edge({ line: 9 }), edge({ fromFile: 'src/services/x.ts', fromModule: 'services', line: 2 })] });
    const policy = { rules: [NO_TO_DB] };
    const d = scopeToDiff(evaluatePolicy(policy, head, base), evaluatePolicy(policy, base));
    expect(d.preExisting.map((x) => x.location?.file)).toEqual(['src/ui/cart.ts']);
    expect(d.introduced.map((x) => x.location?.file)).toEqual(['src/services/x.ts']);
    expect(d.blocked).toBe(true);
  });

  it('removing a crossing shows up as resolved', () => {
    const base = rep({ importEdges: [edge()] });
    const head = rep({ importEdges: [] });
    const policy = { rules: [NO_TO_DB] };
    const d = scopeToDiff(evaluatePolicy(policy, head, base), evaluatePolicy(policy, base));
    expect(d.resolved).toHaveLength(1);
    expect(d.introduced).toHaveLength(0);
  });

  it('a pre-existing metric-floor breach in an untouched module is not blamed on the change', () => {
    const mod = (name: string, seams: number) => ({
      name, files: 1, codeLines: 10,
      depth: { score: 50, label: '', detail: '' }, seams: { score: seams, label: '', detail: '' },
      locality: { score: 50, label: '', detail: '' }, leverage: { score: 50, label: '', detail: '' },
      exportedCount: 1, callerCount: 1, utilizationPct: 50,
      ownership: { owner: 'a', busFactor: 2, topShare: 0.5, topAuthor: 'a', risk: { score: 60, label: '', detail: '' } },
    });
    const policy = { rules: [{ id: 'seams-floor', type: 'metric-floor' as const, metric: 'seams' as const, min: 70, mode: 'block' as const }] };
    const base = rep({ modules: [mod('payment', 40)] });
    const head = rep({ modules: [mod('payment', 40), mod('auth', 30)] }); // payment unchanged; auth newly below the floor
    const d = scopeToDiff(evaluatePolicy(policy, head), evaluatePolicy(policy, base));
    expect(d.preExisting.map((x) => x.module)).toEqual(['payment']);
    expect(d.introduced.map((x) => x.module)).toEqual(['auth']);
  });
});

describe('renderers', () => {
  it('state the counts and list only what was introduced', () => {
    const fresh = v({ ruleId: 'no-to-db', location: { file: 'src/services/x.ts', line: 2 }, toFile: 'src/db/orders.ts', message: 'src/services/x.ts:2 imports db' });
    const old = v({ ruleId: 'no-to-db', location: { file: 'src/ui/cart.ts', line: 3 }, toFile: 'src/db/orders.ts', message: 'src/ui/cart.ts:3 imports db' });
    const d = scopeToDiff(result([fresh, old]), result([old]));
    const t = renderDiffScopeTerminal(d);
    expect(t).toContain('1 introduced');
    expect(t).toContain('1 pre-existing (not blocking)');
    expect(t).toContain('src/services/x.ts:2');
    expect(t).not.toContain('src/ui/cart.ts:3');
    const m = renderDiffScopeMarkdown(d);
    expect(m).toContain('**1 introduced**');
    expect(m).toContain('| 🚫 | `no-to-db` | src/services/x.ts:2 imports db |');
  });
});
