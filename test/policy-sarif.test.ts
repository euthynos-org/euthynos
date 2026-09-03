import { describe, expect, it } from 'vitest';
import { evaluatePolicy, type PolicyResult, type Violation } from '../src/policy/evaluate.js';
import { fingerprintOf, scopeToDiff } from '../src/policy/diff.js';
import { SARIF_SCHEMA, SARIF_VERSION, sarifText, toSarif } from '../src/policy/sarif.js';
import type { ImportEdge, ScanReport } from '../src/types.js';

/**
 * C4 — SARIF output. What matters: the mapping is faithful (no fabricated
 * location, honest levels), the fingerprint is the line-stable one GitHub
 * can track alerts by, and a verdict that could not run is not a clean file.
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

const OPTS = { version: '0.2.1' };

describe('toSarif — shape', () => {
  it('is a SARIF 2.1.0 log with one run, the engine as driver, and sorted deduped rules', () => {
    const log = toSarif(result([v({ ruleId: 'zeta' }), v({ ruleId: 'alpha' }), v({ ruleId: 'zeta' })]), rep(), OPTS);
    expect(log.$schema).toBe(SARIF_SCHEMA);
    expect(log.version).toBe(SARIF_VERSION);
    expect(log.runs).toHaveLength(1);
    expect(log.runs[0]!.tool.driver.name).toBe('euthynos');
    expect(log.runs[0]!.tool.driver.version).toBe('0.2.1');
    expect(log.runs[0]!.tool.driver.rules.map((r) => r.id)).toEqual(['alpha', 'zeta']);
    expect(log.runs[0]!.results).toHaveLength(3);
  });

  it('maps block → error and warn → warning', () => {
    const log = toSarif(result([v({ mode: 'block' }), v({ mode: 'warn' })]), rep(), OPTS);
    expect(log.runs[0]!.results.map((r) => r.level)).toEqual(['error', 'warning']);
  });
});

describe('toSarif — locations and remedies', () => {
  it('a localized violation gets a physical location with the exact lines, relative to the source root', () => {
    const report = rep({ importEdges: [edge()] });
    const r = evaluatePolicy({ rules: [{ id: 'no-ui-to-db', type: 'forbidden-dependency', from: 'ui', to: 'db', mode: 'block' }] }, report);
    const res = toSarif(r, report, OPTS).runs[0]!.results[0]!;
    expect(res.locations).toEqual([{ physicalLocation: { artifactLocation: { uri: 'src/ui/cart.ts', uriBaseId: '%SRCROOT%' }, region: { startLine: 3 } } }]);
    expect(res.properties!['toFile']).toBe('src/db/orders.ts');
  });

  it('an aggregate violation gets NO location — nothing is fabricated', () => {
    const base = rep({ health: { score: 64, label: 'Stable' } });
    const head = rep({ health: { score: 58, label: 'Drifting' } });
    const r = evaluatePolicy({ rules: [{ type: 'health-delta', maxDrop: 3 }] }, head, base);
    const res = toSarif(r, head, OPTS).runs[0]!.results[0]!;
    expect(res.locations).toBeUndefined();
  });

  it('the remedy is in the message text (for readers) and in properties (for tools)', () => {
    const report = rep({ importEdges: [edge()] });
    const r = evaluatePolicy({ rules: [{ type: 'forbidden-dependency', from: 'ui', to: 'db', allowedVia: 'services' }] }, report);
    const res = toSarif(r, report, OPTS).runs[0]!.results[0]!;
    expect(res.message.text).toContain('Reach db through services');
    expect((res.properties!['remedy'] as { kind: string }).kind).toBe('reroute-import');
  });
});

describe('toSarif — fingerprints and diff scope', () => {
  it('partialFingerprints is the line-stable fingerprint, so a line shift does not open a new alert', () => {
    const a = v({ location: { file: 'src/ui/cart.ts', line: 3 }, toFile: 'src/db/orders.ts' });
    const b = v({ location: { file: 'src/ui/cart.ts', line: 90 }, toFile: 'src/db/orders.ts' });
    const [ra, rb] = toSarif(result([a, b]), rep(), OPTS).runs[0]!.results;
    expect(ra!.partialFingerprints['euthynos/v1']).toBe(fingerprintOf(a));
    expect(ra!.partialFingerprints['euthynos/v1']).toBe(rb!.partialFingerprints['euthynos/v1']);
  });

  it('in diff scope each result says whether this change introduced it', () => {
    const old = v({ ruleId: 'r', location: { file: 'src/ui/cart.ts', line: 3 }, toFile: 'src/db/orders.ts', message: 'old' });
    const fresh = v({ ruleId: 'r', location: { file: 'src/services/x.ts', line: 1 }, toFile: 'src/db/orders.ts', message: 'fresh' });
    const head = result([old, fresh]);
    const diff = scopeToDiff(head, result([old]));
    const res = toSarif(head, rep(), { ...OPTS, diff }).runs[0]!.results;
    expect(res.map((r) => [r.message.text, r.properties!['introduced']])).toEqual([['old', false], ['fresh', true]]);
  });
});

describe('toSarif — honesty', () => {
  it('a config error makes the invocation unsuccessful and is reported as an error notification', () => {
    const r = evaluatePolicy({ rules: [{ type: 'forbidden-dependency', from: 'ui' }] }, rep({ importEdges: [] }));
    const inv = toSarif(r, rep(), OPTS).runs[0]!.invocations[0]!;
    expect(inv.executionSuccessful).toBe(false);
    expect(inv.toolExecutionNotifications[0]).toEqual({ level: 'error', message: { text: expect.stringContaining('requires "to"') } });
  });

  it('skips, unmatched globs and partial coverage become notifications — a clean-looking file never hides them', () => {
    const r = result([], { skippedEdgeRules: 1, unmatchedGlobs: [{ ruleId: 'x', side: 'to', glob: 'db' }], partialCoverage: { skippedFiles: 2, discoveryTruncated: false } });
    const notes = toSarif(r, rep(), OPTS).runs[0]!.invocations[0]!.toolExecutionNotifications.map((n) => n.message.text);
    expect(notes.some((t) => t.includes('no import edges'))).toBe(true);
    expect(notes.some((t) => t.includes('matches no module'))).toBe(true);
    expect(notes.some((t) => t.includes('2 file(s) failed to parse'))).toBe(true);
  });

  it('serializes deterministically and round-trips', () => {
    const r = result([v({ location: { file: 'a.ts', line: 1 }, toFile: 'b.ts' })]);
    const t1 = sarifText(toSarif(r, rep(), OPTS));
    const t2 = sarifText(toSarif(r, rep(), OPTS));
    expect(t1).toBe(t2);
    expect(t1.endsWith('\n')).toBe(true);
    expect(JSON.parse(t1).runs[0].results[0].ruleId).toBe('r');
  });
});
