import { describe, expect, it } from 'vitest';
import { evaluatePolicy, ratchetPolicy } from '../src/policy/evaluate.js';
import type { ContaminationFinding, MetricScore, ModuleReport, ScanReport } from '../src/types.js';

const ms = (score: number | null): MetricScore => ({ score, label: '', detail: '' });

function mod(name: string, over: Partial<ModuleReport> = {}): ModuleReport {
  return {
    name, files: 1, codeLines: 10,
    depth: ms(50), seams: ms(70), locality: ms(50), leverage: ms(50),
    exportedCount: 1, callerCount: 1, utilizationPct: 50,
    ownership: { owner: 'a', busFactor: 2, topShare: 0.5, topAuthor: 'a', risk: ms(60) },
    ...over,
  };
}
function clone(af: string, an: string, bf: string, bn: string): ContaminationFinding {
  return { kind: 'clone', a: { file: af, name: an, line: 1, endLine: 5 }, b: { file: bf, name: bn, line: 1, endLine: 5 }, confidence: 90, signals: ['ast-clone'] };
}
function rep(over: Partial<ScanReport> = {}): ScanReport {
  return {
    root: '/r', scannedAt: 't', filesScanned: 1, modules: [],
    contamination: { score: 0, label: 'Clean', findings: [], violations: 0, cloneFnIds: [] },
    health: { score: 60, label: 'Stable' },
    averages: { depth: 50, seams: 70, locality: 50, leverage: 50 },
    opportunities: [], gitAvailable: true, ...over,
  };
}

describe('architecture policy engine', () => {
  it('flags a health regression beyond the allowed drop (block mode)', () => {
    const base = rep({ health: { score: 64, label: 'Stable' } });
    const head = rep({ health: { score: 58, label: 'Drifting' } });
    const r = evaluatePolicy({ rules: [{ type: 'health-delta', maxDrop: 3, mode: 'block' }] }, head, base);
    expect(r.passed).toBe(false);
    expect(r.blocked).toBe(true);
    expect(r.violations[0]!.after).toBe(58);
  });

  it('passes when the health drop is within budget', () => {
    const base = rep({ health: { score: 64, label: 'Stable' } });
    const head = rep({ health: { score: 62, label: 'Stable' } });
    const r = evaluatePolicy({ rules: [{ type: 'health-delta', maxDrop: 3 }] }, head, base);
    expect(r.passed).toBe(true);
  });

  it('detects new duplicate pairs introduced vs base', () => {
    const base = rep({ contamination: { score: 5, label: 'Minor', findings: [clone('a.ts', 'x', 'b.ts', 'x')], violations: 0, cloneFnIds: [] } });
    const head = rep({ contamination: { score: 12, label: 'Minor', findings: [clone('a.ts', 'x', 'b.ts', 'x'), clone('c.ts', 'y', 'd.ts', 'y')], violations: 0, cloneFnIds: [] } });
    const r = evaluatePolicy({ rules: [{ type: 'no-new-duplication', mode: 'block' }] }, head, base);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]!.message).toContain('1 new duplicate');
  });

  it('enforces a metric floor per matched module glob', () => {
    const head = rep({ modules: [mod('payment', { seams: ms(40) }), mod('auth', { seams: ms(85) })] });
    const r = evaluatePolicy({ rules: [{ type: 'metric-floor', metric: 'seams', min: 70, module: '*' }] }, head);
    expect(r.violations.map((v) => v.module)).toEqual(['payment']); // auth (85) is fine
  });

  it('enforces a minimum bus factor (min-owners)', () => {
    const head = rep({ modules: [mod('payment', { ownership: { owner: 'alice', busFactor: 1, topShare: 1, topAuthor: 'alice', risk: ms(0) } })] });
    const r = evaluatePolicy({ rules: [{ type: 'min-owners', minOwners: 2, module: 'payment', mode: 'block' }] }, head);
    expect(r.blocked).toBe(true);
    expect(r.violations[0]!.message).toContain('bus factor 1');
  });

  it('skips delta rules (and reports it) when no base is supplied', () => {
    const r = evaluatePolicy(ratchetPolicy('warn'), rep());
    expect(r.passed).toBe(true);
    expect(r.skippedDeltaRules).toBe(3); // health-delta + contamination-delta + no-new-duplication
  });

  it('ratchet passes on no regression and carries the chosen mode', () => {
    const base = rep({ health: { score: 60, label: 'Stable' }, contamination: { score: 4, label: 'Minor', findings: [], violations: 0, cloneFnIds: [] } });
    const head = rep({ health: { score: 60, label: 'Stable' }, contamination: { score: 4, label: 'Minor', findings: [], violations: 0, cloneFnIds: [] } });
    const r = evaluatePolicy(ratchetPolicy('block'), head, base);
    expect(r.passed).toBe(true);
  });
});
