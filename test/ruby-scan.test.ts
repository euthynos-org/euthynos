import { beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadLanguages } from '../src/parse/treesitter/loader.js';
import { buildRepoGraph } from '../src/graph/repo.js';
import { findFunction, callersOf } from '../src/graph/query.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, 'fixtures', 'rbsample');

beforeAll(async () => {
  await loadLanguages(['ruby']);
});

describe('ruby: cross-file resolution through the full graph', () => {
  it('resolves require_relative imports and cross-module call edges', () => {
    const g = buildRepoGraph(FIXTURE);
    const r = findFunction(g, 'compute_fee');
    expect('node' in r).toBe(true);
    if (!('node' in r)) return;

    const callers = callersOf(g, r.node.id).map((c) => c.label);
    expect(callers).toContain('checkout'); // cross-file caller (orders module)
    expect(callers).toContain('capture'); // same-file caller (payment module)
    expect(g.stats.importEdges).toBeGreaterThanOrEqual(1); // require_relative resolved
  });
});
