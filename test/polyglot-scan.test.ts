import { beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadLanguages } from '../src/parse/treesitter/loader.js';
import { TREE_SITTER_LANGS } from '../src/parse/dispatch.js';
import { buildRepoGraph } from '../src/graph/repo.js';
import { findFunction, callersOf } from '../src/graph/query.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, 'fixtures', 'polyglot');

beforeAll(async () => {
  await loadLanguages([...TREE_SITTER_LANGS]);
});

// One repo, five languages (C#, Dart, Vue, COBOL — plus the resolver) flowing
// through the SAME discovery → dispatch → parse → graph pipeline.
describe('polyglot: 5 languages through one graph pipeline', () => {
  it('discovers and parses every language in the fixture', () => {
    const g = buildRepoGraph(FIXTURE);
    // engine.dart(2) + checkout.dart(1) + Invoice.cs(3) + Cart.vue(1) + PAYROLL.cob(3)
    expect(g.stats.functions).toBeGreaterThanOrEqual(10);
  });

  it('resolves a Dart cross-file, cross-module call edge via relative import', () => {
    const g = buildRepoGraph(FIXTURE);
    const fee = findFunction(g, 'computeFee');
    expect('node' in fee).toBe(true);
    if (!('node' in fee)) return;
    const callers = callersOf(g, fee.node.id).map((c) => c.label);
    expect(callers).toContain('checkout'); // orders/checkout.dart → payment/engine.dart
  });

  it('parses the C# method surface', () => {
    const g = buildRepoGraph(FIXTURE);
    expect('node' in findFunction(g, 'Compute')).toBe(true);
  });

  it('parses the Vue <script> function', () => {
    const g = buildRepoGraph(FIXTURE);
    expect('node' in findFunction(g, 'subtotal')).toBe(true);
  });

  it('parses COBOL program + paragraph nodes and the PERFORM edge', () => {
    const g = buildRepoGraph(FIXTURE);
    expect('node' in findFunction(g, 'PAYROLL')).toBe(true);
    const calc = findFunction(g, 'CALC-NET');
    expect('node' in calc).toBe(true);
    const main = findFunction(g, 'MAIN-PARA');
    if ('node' in main && 'node' in calc) {
      const callers = callersOf(g, calc.node.id).map((c) => c.label);
      expect(callers).toContain('MAIN-PARA'); // PERFORM CALC-NET
    }
  });
});
