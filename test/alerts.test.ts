import { describe, expect, it } from 'vitest';
import { diffReports } from '../src/alerts/diff.js';
import { renderAlertsMarkdown, renderAlertsTerminal } from '../src/alerts/render.js';
import type { ContaminationFinding, MetricScore, ModuleReport, ScanReport } from '../src/types.js';

const ms = (score: number | null, detail = ''): MetricScore => ({ score, label: '', detail });

function mod(name: string, over: Partial<ModuleReport> = {}): ModuleReport {
  return {
    name, files: 2, codeLines: 100,
    depth: ms(50), seams: ms(70), locality: ms(50), leverage: ms(50),
    exportedCount: 1, callerCount: 1, utilizationPct: 50,
    ownership: { owner: 'alice', busFactor: 2, topShare: 0.5, topAuthor: 'alice', risk: ms(60) },
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

describe('health-regression alerts (diffReports)', () => {
  it('fires a critical band-drop when the composite crosses a band boundary', () => {
    const base = rep({ health: { score: 61, label: 'Stable' } });
    const head = rep({ health: { score: 58, label: 'Drifting' } });
    const events = diffReports(base, head);
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('health-band-drop');
    expect(events[0]!.severity).toBe('critical');
    expect(events[0]!.before).toBe(61);
    expect(events[0]!.after).toBe(58);
  });

  it('fires a warn health-drop within the same band, respecting the threshold', () => {
    const base = rep({ health: { score: 70, label: 'Stable' } });
    expect(diffReports(base, rep({ health: { score: 68, label: 'Stable' } }))).toHaveLength(0); // -2 < default 3
    const events = diffReports(base, rep({ health: { score: 66, label: 'Stable' } }));
    expect(events.map((e) => e.kind)).toEqual(['health-drop']);
    expect(events[0]!.severity).toBe('warn');
  });

  it('stays silent on improvement, even across bands', () => {
    const base = rep({ health: { score: 58, label: 'Drifting' } });
    const head = rep({ health: { score: 64, label: 'Stable' } });
    expect(diffReports(base, head)).toHaveLength(0);
  });

  it('routes a bus-factor collapse to the dominant author as critical', () => {
    const base = rep({ modules: [mod('payment')] });
    const head = rep({
      modules: [mod('payment', { ownership: { owner: 'bob', busFactor: 1, topShare: 0.91, topAuthor: 'bob', risk: ms(10) } })],
    });
    const events = diffReports(base, head);
    expect(events).toHaveLength(1);
    expect(events[0]!).toMatchObject({ kind: 'bus-factor-one', severity: 'critical', module: 'payment', routeTo: 'bob', before: 2, after: 1 });
    expect(events[0]!.message).toContain('91%');
  });

  it('treats a metric becoming n/a as info, never a drop', () => {
    const base = rep({ modules: [mod('auth', { locality: ms(55) })] });
    const head = rep({ modules: [mod('auth', { locality: ms(null) })] });
    const events = diffReports(base, head);
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('metric-unavailable');
    expect(events[0]!.severity).toBe('info');
    expect(events[0]!.message).toContain('renormalize');
  });

  it('fires per-module metric drops only at the threshold', () => {
    const base = rep({ modules: [mod('auth', { depth: ms(60) })] });
    expect(diffReports(base, rep({ modules: [mod('auth', { depth: ms(52) })] }))).toHaveLength(0); // -8 < 10
    const events = diffReports(base, rep({ modules: [mod('auth', { depth: ms(48) })] }));
    expect(events.map((e) => e.kind)).toEqual(['metric-drop']);
    expect(events[0]!.metric).toBe('depth');
  });

  it('flags a module entering an import cycle as critical', () => {
    const base = rep({ modules: [mod('api', { seams: ms(70, 'no interface file') })] });
    const head = rep({ modules: [mod('api', { seams: ms(45, 'no interface file · circular dependency') })] });
    const events = diffReports(base, head);
    expect(events.some((e) => e.kind === 'new-cycle' && e.severity === 'critical')).toBe(true);
  });

  it('detects new clone pairs and contamination spikes', () => {
    const base = rep({ contamination: { score: 4, label: 'Minor', findings: [clone('a.ts', 'x', 'b.ts', 'x')], violations: 0, cloneFnIds: [] } });
    const head = rep({ contamination: { score: 16, label: 'Minor', findings: [clone('a.ts', 'x', 'b.ts', 'x'), clone('c.ts', 'y', 'd.ts', 'y')], violations: 0, cloneFnIds: [] } });
    const kinds = diffReports(base, head).map((e) => e.kind).sort();
    expect(kinds).toEqual(['contamination-spike', 'new-clones']);
  });

  it('reports module additions and removals as info', () => {
    const base = rep({ modules: [mod('old')] });
    const head = rep({ modules: [mod('fresh')] });
    const kinds = diffReports(base, head).map((e) => e.kind).sort();
    expect(kinds).toEqual(['module-added', 'module-removed']);
    expect(diffReports(base, head).every((e) => e.severity === 'info')).toBe(true);
  });

  it('orders events deterministically: critical before warn before info', () => {
    const base = rep({
      health: { score: 61, label: 'Stable' },
      modules: [mod('payment'), mod('gone')],
    });
    const head = rep({
      health: { score: 55, label: 'Drifting' },
      modules: [mod('payment', { ownership: { owner: 'bob', busFactor: 1, topShare: 0.9, topAuthor: 'bob', risk: ms(10) } })],
    });
    const sev = diffReports(base, head).map((e) => e.severity);
    expect(sev).toEqual([...sev].sort((a, b) => ({ critical: 0, warn: 1, info: 2 }[a]! - { critical: 0, warn: 1, info: 2 }[b]!)));
  });
});

describe('alert rendering', () => {
  it('renders terminal + markdown with the upsert marker and routing column', () => {
    const base = rep({ modules: [mod('payment')] });
    const head = rep({ modules: [mod('payment', { ownership: { owner: 'bob', busFactor: 1, topShare: 0.9, topAuthor: 'bob', risk: ms(10) } })] });
    const events = diffReports(base, head);
    const term = renderAlertsTerminal(events, head);
    expect(term).toContain('1 critical');
    const md = renderAlertsMarkdown(events, head);
    expect(md).toContain('<!-- euthynos-alerts -->');
    // legacy anchor kept so an existing consumer still upserts its comment
    expect(md).toContain('<!-- contexthub-alerts -->');
    expect(md).toContain('bus-factor-one');
    expect(md).toContain('bob');
  });

  it('renders the all-clear state', () => {
    const md = renderAlertsMarkdown([], rep());
    expect(md).toContain('No regressions');
  });
});
