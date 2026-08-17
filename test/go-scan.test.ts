import { beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadLanguages } from '../src/parse/treesitter/loader.js';
import { discoverFiles } from '../src/discover.js';
import { parseDiscovered } from '../src/parse/dispatch.js';
import { buildGraph } from '../src/graph/imports.js';
import { buildRepoGraph } from '../src/graph/repo.js';
import { findFunction, callersOf } from '../src/graph/query.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, 'fixtures', 'gosample');

beforeAll(async () => {
  await loadLanguages(['go']);
});

// End-to-end proof that a Go import path (`gosample/payment`) — a module path,
// not a relative path — resolves through the real parser into a module edge.
describe('go: module-path imports resolve cross-package', () => {
  it('wires the module import graph from the Go import path', () => {
    const files = discoverFiles(FIXTURE).map(parseDiscovered);
    const mg = buildGraph(files);
    expect([...(mg.imports.get('orders') ?? [])]).toContain('payment');
    expect([...(mg.importedBy.get('payment') ?? [])]).toContain('orders');
  });

  it('resolves the cross-package call edge Checkout → ComputeFee', () => {
    const g = buildRepoGraph(FIXTURE);
    const fee = findFunction(g, 'ComputeFee');
    expect('node' in fee).toBe(true);
    if (!('node' in fee)) return;
    expect(callersOf(g, fee.node.id).map((c) => c.label)).toContain('Checkout');
  });
});
