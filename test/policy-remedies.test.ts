import { describe, expect, it } from 'vitest';
import { evaluatePolicy } from '../src/policy/evaluate.js';
import { renderPolicyMarkdown, renderPolicyTerminal } from '../src/policy/render.js';
import { toSarif } from '../src/policy/sarif.js';
import { toCheckRun } from '../src/policy/checkrun.js';
import { contamination } from '../src/metrics/contamination.js';
import { buildGraph } from '../src/graph/imports.js';
import { parseTsSource } from '../src/parse/ts.js';
import type { ContaminationFinding, ImportEdge, ScanReport } from '../src/types.js';

/**
 * C2 review regressions. Every case here is a WRONG VERDICT the first cut
 * produced — a remedy pointing at the untouched file, a route that was itself
 * a violation, a "new" pair that merely rose past a presentation cap — and the
 * rule is the same each time: derive it from the report, or say you cannot.
 */

const edge = (over: Partial<ImportEdge> = {}): ImportEdge => ({
  fromFile: 'src/ui/cart.ts', fromModule: 'ui', line: 3,
  toFile: 'src/db/orders.ts', toModule: 'db',
  isTypeOnly: false, fromIsTest: false,
  ...over,
});

const contam = (findings: ContaminationFinding[], over: Partial<ScanReport['contamination']> = {}): ScanReport['contamination'] =>
  ({ score: 0, label: 'Clean', findings, violations: 0, cloneFnIds: [], ...over } as ScanReport['contamination']);

function rep(over: Partial<ScanReport> = {}): ScanReport {
  return {
    root: '/r', scannedAt: 't', filesScanned: 1, modules: [],
    contamination: contam([]),
    health: { score: 60, label: 'Stable' },
    averages: { depth: 50, seams: 70, locality: 50, leverage: 50 },
    opportunities: [], gitAvailable: true, ...over,
  };
}

// a is the path-EARLIER side, exactly as the contamination cascade orders it.
const pair = (af: string, an: string, al: number, bf: string, bn: string, bl: number): ContaminationFinding =>
  ({ kind: 'clone', a: { file: af, name: an, line: al, endLine: al + 4 }, b: { file: bf, name: bn, line: bl, endLine: bl + 4 }, confidence: 90, signals: ['ast-clone'] });

const DUP = { rules: [{ id: 'dup', type: 'no-new-duplication' as const, mode: 'block' as const }] };

describe('no-new-duplication — which copy is new is decided from the base, never by path order', () => {
  // Path order puts the ORIGINAL first: src/api/helper.ts sorts before src/util/helper2.ts.
  const head = rep({ contamination: contam([pair('src/api/helper.ts', 'fmt', 1, 'src/util/helper2.ts', 'fmt2', 1)]) });

  it('locates the violation at the copy whose file did NOT exist in the base, and names the old one as the target', () => {
    const base = rep({ files: ['src/api/helper.ts'] }); // helper2.ts is new
    const v = evaluatePolicy(DUP, head, base).violations[0]!;
    expect(v.location).toEqual({ file: 'src/util/helper2.ts', line: 1, endLine: 5 });
    expect(v.remedy!.sideKnown).toBe(true);
    expect(v.remedy!.suggestedTargets).toEqual([{ file: 'src/api/helper.ts', why: expect.stringContaining('pre-existing') }]);
    expect(v.remedy!.instruction).toContain('fmt2 (helper2.ts) is a new copy of fmt (helper.ts)');
  });

  it('a function that was already a clone in the base is the old side even without a file list', () => {
    const base = rep({ contamination: contam([], { cloneFnIds: ['fn:src/util/helper2.ts#fmt2'] }) });
    const v = evaluatePolicy(DUP, head, base).violations[0]!;
    expect(v.location!.file).toBe('src/api/helper.ts'); // the OTHER side is the new one
  });

  it('when the base cannot say (no file list, no clone record) there is NO location and the remedy says so', () => {
    const v = evaluatePolicy(DUP, head, rep()).violations[0]!;
    expect(v.location).toBeUndefined();
    expect(v.remedy!.sideKnown).toBe(false);
    expect(v.remedy!.instruction).toContain('cannot say which copy is new');
    expect(v.remedy!.suggestedTargets.map((t) => t.file).sort()).toEqual(['src/api/helper.ts', 'src/util/helper2.ts']);
  });

  it('two old files that now share a body is also "cannot say" — the report does not know which body changed', () => {
    const base = rep({ files: ['src/api/helper.ts', 'src/util/helper2.ts'] });
    const v = evaluatePolicy(DUP, head, base).violations[0]!;
    expect(v.location).toBeUndefined();
    expect(v.remedy!.sideKnown).toBe(false);
  });

  it('two NEW files sharing a body: both are this change; located at one, worded as both new', () => {
    const base = rep({ files: ['src/other.ts'] });
    const v = evaluatePolicy(DUP, head, base).violations[0]!;
    expect(v.location!.file).toBe('src/api/helper.ts');
    expect(v.remedy!.sideKnown).toBe(true);
    expect(v.remedy!.instruction).toContain('are both new to this change');
  });
});

describe('no-new-duplication — "absent from base" is only "new" when the base set is complete', () => {
  it('uses the uncapped pairKeys when present: a pair past the base cap that rose into the head list is NOT new', () => {
    const p = pair('src/m1/f21.ts', 'fn', 1, 'src/m2/f21.ts', 'fn', 1);
    const base = rep({ contamination: contam([], { findingsTotal: 21, pairKeys: ['src/m1/f21.ts:fn|src/m2/f21.ts:fn'] }) }); // listed nothing, but the set knows it
    const head = rep({ contamination: contam([p], { findingsTotal: 1, pairKeys: ['src/m1/f21.ts:fn|src/m2/f21.ts:fn'] }) });
    const r = evaluatePolicy(DUP, head, base);
    expect(r.violations).toHaveLength(0);
    expect(r.skippedIncompleteRules).toBe(0);
  });

  it('a capped base with no pairKeys cannot prove newness: the rule is SKIPPED and counted, not passed', () => {
    const twenty = Array.from({ length: 20 }, (_, i) => pair(`src/a/f${i}.ts`, 'fn', 1, `src/b/f${i}.ts`, 'fn', 1));
    const base = rep({ contamination: contam(twenty, { findingsTotal: 21 }) }); // 20 shown of 21
    const head = rep({ contamination: contam([pair('src/x.ts', 'g', 1, 'src/y.ts', 'g', 1)], { findingsTotal: 1 }) });
    const r = evaluatePolicy(DUP, head, base);
    expect(r.violations).toHaveLength(0);
    expect(r.skippedIncompleteRules).toBe(1);
    expect(renderPolicyTerminal(r, head)).toContain('cannot be established');
  });

  it('an older base with no total is trusted only under the cap', () => {
    const under = rep({ contamination: contam([pair('src/a.ts', 'x', 1, 'src/b.ts', 'x', 1)]) }); // 1 < 20 → complete
    const head = rep({ contamination: contam([pair('src/a.ts', 'x', 1, 'src/b.ts', 'x', 1), pair('src/c.ts', 'y', 1, 'src/d.ts', 'y', 1)]), files: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'] });
    const r = evaluatePolicy(DUP, head, under);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]!.message).toContain('src/c.ts:y');
  });

  it('a capped HEAD is a disclosed safe miss, not a skip', () => {
    const twenty = Array.from({ length: 20 }, (_, i) => pair(`src/a/f${i}.ts`, 'fn', 1, `src/b/f${i}.ts`, 'fn', 1));
    const base = rep({ contamination: contam([], { findingsTotal: 0 }) });
    const head = rep({ contamination: contam(twenty, { findingsTotal: 25 }) });
    const r = evaluatePolicy(DUP, head, base);
    expect(r.duplicationHeadCapped).toBe(true);
    expect(r.violations).toHaveLength(20);
    expect(renderPolicyMarkdown(r, head)).toContain('pairs beyond the cap were not judged');
  });
});

describe('forbidden-dependency remedies — a route is never a violator, and never the violator itself', () => {
  const uiToDb = edge();
  const servicesToDb = edge({ fromFile: 'src/services/orders.ts', fromModule: 'services', line: 1 });
  const ONLY_SERVICES = { rules: [{ id: 'only-services', type: 'forbidden-dependency' as const, to: 'db', allowedVia: 'services', mode: 'block' as const }] };

  it('with from = * the allowed route is exempt, so only the real violator fires and the route is offered as the fix', () => {
    const r = evaluatePolicy(ONLY_SERVICES, rep({ importEdges: [uiToDb, servicesToDb] }));
    expect(r.violations.map((v) => v.location!.file)).toEqual(['src/ui/cart.ts']);
    expect(r.violations[0]!.remedy!.suggestedTargets.map((t) => t.file)).toEqual(['src/services/orders.ts']);
  });

  it('a file is never suggested as its own route', () => {
    // The violator sits INSIDE a module that also matches allowedVia by prefix glob.
    const rule = { rules: [{ type: 'forbidden-dependency' as const, from: 'ui', to: 'db', allowedVia: 'ui-*' }] };
    const violator = edge({ fromFile: 'src/ui/cart.ts', fromModule: 'ui' });
    const r = evaluatePolicy(rule, rep({ importEdges: [violator] }));
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]!.remedy!.suggestedTargets).toEqual([]);
  });

  it('prefers a route to the SAME target file; a module-only match is offered with the mismatch stated', () => {
    const viaUsers = edge({ fromFile: 'src/services/users.ts', fromModule: 'services', toFile: 'src/db/users.ts', line: 1 });
    const viaOrders = edge({ fromFile: 'src/services/orders.ts', fromModule: 'services', toFile: 'src/db/orders.ts', line: 1 });
    const exact = evaluatePolicy(ONLY_SERVICES, rep({ importEdges: [uiToDb, viaUsers, viaOrders] })).violations[0]!.remedy!;
    expect(exact.suggestedTargets.map((t) => t.file)).toEqual(['src/services/orders.ts']); // users.ts imports a different db file
    expect(exact.instruction).toContain('e.g. via src/services/orders.ts');
    const fallback = evaluatePolicy(ONLY_SERVICES, rep({ importEdges: [uiToDb, viaUsers] })).violations[0]!.remedy!;
    expect(fallback.suggestedTargets[0]!.why).toContain('users.ts, not orders.ts');
    expect(fallback.instruction).toContain('no file in services currently reaches orders.ts');
    expect(fallback.instruction).toContain('reaches db via users.ts');
  });
});

describe('clone locations point at the declaration, not the body', () => {
  it('a cross-module clone finding records the signature line, as the intra-module branch already does', () => {
    const body = [
      'const a = x + 1;', 'const b = a * 2;', 'const c = b - 3;', 'const d = c / 4;', 'const e = d + a;',
      'const f = e * b;', 'const g = f - c;', 'const h = g + d;', 'const i = h * e;', 'return i + f + g + h;',
    ].join('\n  ');
    const src = (name: string) => `// header\nexport function ${name}(\n  x: number,\n): number {\n  ${body}\n}\n`;
    const files = [parseTsSource('src/m1/a.ts', 'm1', false, src('one')), parseTsSource('src/m2/b.ts', 'm2', false, src('two'))];
    const c = contamination(files, buildGraph(files));
    expect(c.findings.length).toBeGreaterThan(0);
    expect(c.findings[0]!.a.line).toBe(2); // `export function one(` — not the body's first statement
    expect(c.pairKeys).toEqual(['src/m1/a.ts:one|src/m2/b.ts:two']);
  });
});

describe('markdown cells', () => {
  it('escape _ and * so __init__.py does not render as bold "init.py"', () => {
    const report = rep({ importEdges: [edge({ fromFile: 'src/pkg/__init__.py', fromModule: 'pkg' })] });
    const r = evaluatePolicy({ rules: [{ type: 'forbidden-dependency', from: 'pkg', to: 'db' }] }, report);
    const md = renderPolicyMarkdown(r, report);
    expect(md).toContain('\\_\\_init\\_\\_.py');
    expect(md).not.toContain('| src/pkg/__init__.py');
  });
});

/**
 * Found by dogfooding: a scan root that HOLDS the project one level down
 * collapses everything into one module, so no cross-module edge exists and
 * the ratchet passes vacuously — and silently. Now it says so, on every surface.
 */
describe('single-module tree — a vacuous pass is disclosed, not hidden', () => {
  const mod = (name: string) => ({
    name, files: 1894, codeLines: 100000,
    depth: { score: 50, label: '', detail: '' }, seams: { score: 70, label: '', detail: '' },
    locality: { score: 50, label: '', detail: '' }, leverage: { score: 50, label: '', detail: '' },
    exportedCount: 1, callerCount: 1, utilizationPct: 50,
    ownership: { owner: 'a', busFactor: 2, topShare: 0.5, topAuthor: 'a', risk: { score: 60, label: '', detail: '' } },
  });
  const collapsed = rep({ filesScanned: 1894, modules: [mod('bench-repos')], importEdges: [] });
  const RATCHET = { rules: [{ type: 'no-new-duplication' as const, mode: 'block' as const }, { type: 'forbidden-dependency' as const, to: '*' }] };

  it('is flagged when many files scanned as exactly one module, and named', () => {
    const r = evaluatePolicy(RATCHET, collapsed, collapsed);
    expect(r.passed).toBe(true); // nothing fired — that is the problem being disclosed
    expect(r.singleModuleTree).toBe('bench-repos');
  });

  it('reaches the terminal, the markdown, the SARIF notifications and the Check Run summary', () => {
    const r = evaluatePolicy(RATCHET, collapsed, collapsed);
    expect(renderPolicyTerminal(r, collapsed)).toContain('scanned as one module ("bench-repos")');
    expect(renderPolicyMarkdown(r, collapsed)).toContain('point the scan at the project root'.replace('point', 'Point'));
    const notes = toSarif(r, collapsed, { version: 't' }).runs[0]!.invocations[0]!.toolExecutionNotifications;
    expect(notes.some((n) => n.level === 'warning' && n.message.text.includes('bench-repos'))).toBe(true);
    expect(toCheckRun(r, collapsed, { scope: 'repo', strict: true }).output.summary).toContain('Scanned as a single module');
  });

  it('is absent for a real multi-module tree, and for a single file', () => {
    const multi = rep({ filesScanned: 3, modules: [mod('ui'), mod('db')], importEdges: [edge()] });
    expect(evaluatePolicy(RATCHET, multi, multi).singleModuleTree).toBeUndefined();
    const oneFile = rep({ filesScanned: 1, modules: [mod('app')], importEdges: [] });
    expect(evaluatePolicy(RATCHET, oneFile, oneFile).singleModuleTree).toBeUndefined();
  });
});
