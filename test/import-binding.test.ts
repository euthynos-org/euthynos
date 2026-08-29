import { describe, expect, it } from 'vitest';
import { parseTsSource } from '../src/parse/ts.js';
import { buildGraph } from '../src/graph/imports.js';
import { buildKnowledgeGraph } from '../src/graph/knowledge.js';
import { callersOf, findFunction } from '../src/graph/query.js';
import type { CodeGraph } from '../src/types.js';

/**
 * Regression for the WORST field-report defect: callers_of on a FULLY-QUALIFIED
 * target returned the callers of a DIFFERENT same-named function. Two files define
 * `mergePath`; module-level import scoping attributed url.ts's callers to the
 * client copy and lost url.ts's real callers entirely. The fix threads each
 * caller's own import binding into the resolver, so a bare call to an imported
 * name resolves to the exact file it was imported from — never a same-named twin.
 */

const URL_UTIL = `export function mergePath(base, path) {
  return base + '/' + path
}
`;

// A second, unrelated mergePath in another module — the twin that was conflated.
const CLIENT_UTIL = `export function mergePath(...parts) {
  return parts.join('/')
}
`;

// hono-base (module (root)) imports the URL copy and calls it.
const HONO_BASE = `import { mergePath } from './utils/url'

export function buildPath(a, b) {
  return mergePath(a, b)
}
export function routePath(x) {
  return mergePath(x, 'route')
}
`;

// client/client.ts (module client) imports the CLIENT copy and calls it via hc.
// It ALSO imports from utils (module client imports module utils) to reproduce the
// exact mis-attribution precondition the old module-scoping rule tripped on.
const CLIENT = `import { mergePath } from './utils'
import { helper } from '../utils/helper'

export function hc(url) {
  return mergePath(url, 'x')
}
export function testClient(url) {
  return mergePath(url, 'y')
}
`;

// a utils/helper the client imports, so module client → module utils exists.
const HELPER = `export function helper() { return 1 }
`;

function graphOf(): CodeGraph {
  const files = [
    parseTsSource('utils/url.ts', 'utils', false, URL_UTIL),
    parseTsSource('utils/helper.ts', 'utils', false, HELPER),
    parseTsSource('client/utils.ts', 'client', false, CLIENT_UTIL),
    parseTsSource('hono-base.ts', '(root)', false, HONO_BASE),
    parseTsSource('client/client.ts', 'client', false, CLIENT),
  ];
  return buildKnowledgeGraph(files, buildGraph(files), {});
}

const callerLabels = (g: CodeGraph, id: string) =>
  callersOf(g, id).map((c) => `${c.label}@${c.file}`);

describe('import-binding resolves same-named functions to the right file', () => {
  it('callers_of url.ts#mergePath = only hono-base, never the client twin', () => {
    const g = graphOf();
    const r = findFunction(g, 'utils/url.ts#mergePath');
    expect('node' in r).toBe(true);
    if (!('node' in r)) return;
    expect(r.match).toBe('qualified');
    const callers = callerLabels(g, r.node.id);
    expect(callers).toContain('buildPath@hono-base.ts');
    expect(callers).toContain('routePath@hono-base.ts');
    expect(callers).not.toContain('hc@client/client.ts');
    expect(callers).not.toContain('testClient@client/client.ts');
  });

  it('callers_of client/utils.ts#mergePath = only the client callers, never hono-base', () => {
    const g = graphOf();
    const r = findFunction(g, 'client/utils.ts#mergePath');
    expect('node' in r).toBe(true);
    if (!('node' in r)) return;
    const callers = callerLabels(g, r.node.id);
    expect(callers).toContain('hc@client/client.ts');
    expect(callers).toContain('testClient@client/client.ts');
    expect(callers).not.toContain('buildPath@hono-base.ts');
    expect(callers).not.toContain('routePath@hono-base.ts');
  });

  it('the edge is labeled import-binding at confidence 0.9', () => {
    const g = graphOf();
    const url = findFunction(g, 'utils/url.ts#mergePath');
    const base = findFunction(g, 'hono-base.ts#buildPath');
    if (!('node' in url) || !('node' in base)) throw new Error('setup');
    const meta = g.callMeta.get(`${base.node.id}|${url.node.id}`);
    expect(meta?.reason).toBe('import-binding');
    expect(meta?.confidence).toBe(0.9);
  });
});

describe('import-binding never invents an edge', () => {
  it('BARREL GUARD: a name imported from an index that only re-exports binds to nothing', () => {
    // index.ts re-exports mergePath but defines no function of that name.
    const BARREL = `export { mergePath } from './url'\n`;
    const CONSUMER = `import { mergePath } from './barrel'\nexport function use(a, b) { return mergePath(a, b) }\n`;
    const files = [
      parseTsSource('m/url.ts', 'm', false, URL_UTIL),
      parseTsSource('m/barrel.ts', 'm', false, BARREL),
      parseTsSource('m/consumer.ts', 'm', false, CONSUMER),
    ];
    const g = buildKnowledgeGraph(files, buildGraph(files), {});
    const use = findFunction(g, 'm/consumer.ts#use');
    if (!('node' in use)) throw new Error('setup');
    // Because m/url.ts#mergePath is the ONLY definition of that name, unique-name
    // (0.9) still resolves it — but the edge must NOT be attributed through the
    // barrel file, and must never be reason 'import-binding' (the barrel defines
    // no mergePath, so binding correctly declined).
    const url = findFunction(g, 'm/url.ts#mergePath');
    if ('node' in url) {
      const meta = g.callMeta.get(`${use.node.id}|${url.node.id}`);
      if (meta) expect(meta.reason).not.toBe('import-binding');
    }
  });

  it('MEMBER GUARD: obj.mergePath() does not bind to the imported function', () => {
    const CONSUMER = `import { mergePath } from './utils/url'\nexport function use(obj, a) { return obj.mergePath(a) }\n`;
    const files = [
      parseTsSource('utils/url.ts', 'utils', false, URL_UTIL),
      parseTsSource('consumer.ts', '(root)', false, CONSUMER),
    ];
    const g = buildKnowledgeGraph(files, buildGraph(files), {});
    const url = findFunction(g, 'utils/url.ts#mergePath');
    const use = findFunction(g, 'consumer.ts#use');
    if (!('node' in url) || !('node' in use)) throw new Error('setup');
    // The only mergePath definition exists, but the call is a member call on obj,
    // so import-binding (bare-only) must not fire.
    const meta = g.callMeta.get(`${use.node.id}|${url.node.id}`);
    if (meta) expect(meta.reason).not.toBe('import-binding');
  });

  it('EXPORT GUARD: a bare call matching a PRIVATE (non-exported) helper in the imported file does not bind to it', () => {
    // consumer imports the exported `mergePath`, but also happens to call helper();
    // url.ts defines a NON-exported helper() — import-binding must not reach it,
    // because the caller never imported it (localByFile carries private fns too).
    const URL_WITH_PRIVATE = `function helper() { return 1 }\nexport function mergePath(a, b) { return a + '/' + b + helper() }\n`;
    const CONSUMER = `import { mergePath } from './utils/url'\nexport function use(a, b) { return mergePath(a, b) + helper() }\n`;
    const files = [
      parseTsSource('utils/url.ts', 'utils', false, URL_WITH_PRIVATE),
      parseTsSource('consumer.ts', '(root)', false, CONSUMER),
    ];
    const g = buildKnowledgeGraph(files, buildGraph(files), {});
    const url = findFunction(g, 'utils/url.ts#mergePath');
    const helper = findFunction(g, 'utils/url.ts#helper');
    const use = findFunction(g, 'consumer.ts#use');
    if (!('node' in url) || !('node' in helper) || !('node' in use)) throw new Error('setup');
    // mergePath IS exported and imported → binds.
    expect(g.callMeta.get(`${use.node.id}|${url.node.id}`)?.reason).toBe('import-binding');
    // helper() is private in url.ts and never imported → NO import-binding edge to it.
    const hMeta = g.callMeta.get(`${use.node.id}|${helper.node.id}`);
    if (hMeta) expect(hMeta.reason).not.toBe('import-binding');
  });

  it('ALIAS GUARD: import { mergePath as mp }; mp() creates no import-binding edge', () => {
    const CONSUMER = `import { mergePath as mp } from './utils/url'\nexport function use(a, b) { return mp(a, b) }\n`;
    const files = [
      parseTsSource('utils/url.ts', 'utils', false, URL_UTIL),
      parseTsSource('client/utils.ts', 'client', false, CLIENT_UTIL), // a twin so unique-name can't save it
      parseTsSource('consumer.ts', '(root)', false, CONSUMER),
    ];
    const g = buildKnowledgeGraph(files, buildGraph(files), {});
    const url = findFunction(g, 'utils/url.ts#mergePath');
    const use = findFunction(g, 'consumer.ts#use');
    if (!('node' in url) || !('node' in use)) throw new Error('setup');
    // The parser binds the LOCAL name `mp`, which url.ts does not define, so no
    // import-binding edge forms; with a same-named twin present, no wrong edge is
    // invented either (safe under-approximation, documented).
    const meta = g.callMeta.get(`${use.node.id}|${url.node.id}`);
    if (meta) expect(meta.reason).not.toBe('import-binding');
  });
});
