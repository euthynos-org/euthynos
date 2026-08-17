import { beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadLanguages } from '../src/parse/treesitter/loader.js';
import { scan } from '../src/scan.js';
import { buildRepoGraph } from '../src/graph/repo.js';
import { findFunction, callersOf, impactOf } from '../src/graph/query.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, 'fixtures', 'pysample');

beforeAll(async () => {
  await loadLanguages(['python']);
});

describe('python: full scan pipeline', () => {
  const report = () => scan(FIXTURE, { months: 6 });

  it('discovers and groups Python modules', () => {
    const names = report().modules.map((m) => m.name).sort();
    expect(names).toContain('payment');
    expect(names).toContain('auth');
    expect(names).toContain('orders');
    expect(names).toContain('app');
  });

  function mod(name: string) {
    const m = report().modules.find((m) => m.name === name);
    if (!m) throw new Error(`module ${name} missing`);
    return m;
  }

  it('depth: the rich payment engine scores deeper than the one-liner auth module', () => {
    expect(mod('payment').depth.score!).toBeGreaterThan(mod('auth').depth.score!);
    expect(mod('auth').depth.score!).toBeLessThan(60); // shallow
  });

  it('seams: payment has an interface file (__init__.py), auth does not', () => {
    expect(mod('payment').seams.detail).not.toMatch(/no interface file/);
    expect(mod('auth').seams.detail).toMatch(/no interface file/);
  });

  it('leverage: payment is imported by multiple modules', () => {
    expect(mod('payment').callerCount).toBeGreaterThanOrEqual(2);
  });

  it('contamination: detects the cross-module clone (validate_payment ≈ validate_transaction)', () => {
    const f = report().contamination.findings.find((x) => x.kind === 'clone');
    expect(f).toBeDefined();
    const blob = `${f!.a.file} ${f!.a.name} ${f!.b.file} ${f!.b.name}`;
    expect(blob).toMatch(/validate_payment/);
    expect(blob).toMatch(/validate_transaction/);
    expect(f!.confidence).toBeGreaterThanOrEqual(90);
  });
});

describe('python: knowledge graph', () => {
  const graph = () => buildRepoGraph(FIXTURE, { withMetrics: true });

  it('resolves call edges and computes blast radius across modules', () => {
    const g = graph();
    const r = findFunction(g, 'compute_fee');
    expect('node' in r).toBe(true);
    if (!('node' in r)) return;

    const callers = callersOf(g, r.node.id).map((c) => c.label);
    expect(callers).toContain('validate_transaction');
    expect(callers).toContain('capture');
    expect(callers).toContain('validate_payment');

    const imp = impactOf(g, r.node.id);
    expect(imp.crossesModuleBoundary).toBe(true);
    expect(imp.affectedModules).toEqual(expect.arrayContaining(['payment', 'orders']));
  });
});
