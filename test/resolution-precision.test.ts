import { describe, expect, it } from 'vitest';
import { parseTsSource } from '../src/parse/ts.js';
import { buildGraph } from '../src/graph/imports.js';
import { buildKnowledgeGraph } from '../src/graph/knowledge.js';
import { callersOf, findFunction } from '../src/graph/query.js';

/**
 * Regression fixtures from the 2026-08-11 token benchmark, where a real
 * Claude Code session wrote:
 *   "the semantic index conflated it with composeRef in the JSX code, so this
 *    is from reading the actual call sites"
 * and re-read every file it had already asked us about. Precision -> trust ->
 * adoption -> tokens: these tests encode the shapes that broke that chain.
 */

// The hono shape, reduced: a bare `compose()` call inside CLASS METHODS, an
// unrelated `composeRef` in another module, and an ARRAY `.every()` call in a
// third module that must not become a caller of the `every` middleware.
const COMPOSE = `export function compose(handlers, onError) {
  return (ctx, next) => {
    let index = -1;
    return dispatch(0);
    function dispatch(i) { index = i; return handlers[i](ctx, next); }
  };
}
`;

const HONO_BASE = `import { compose } from './compose'

export class Hono {
  #dispatch(request, executionCtx) {
    const composed = compose(this.matchResult, this.errorHandler)
    return composed(request)
  }
  route(path, app) {
    return compose([], app.errorHandler)
  }
}
`;

const JSX_COMPONENTS = `export function ErrorBoundary(props) {
  const htmlArray = props.children
  if (htmlArray.every((html) => !html.callbacks?.length)) {
    return htmlArray.join('')
  }
  return null
}
`;

const COMBINE = `export function every(...middleware) {
  return async function (ctx, next) {
    return middleware.length ? ctx.run(next) : next()
  }
}
`;

const JSX_DOM = `export function composeRef(ref, callback) {
  return (e) => { callback(e); return ref }
}
`;

function graphOf() {
  const files = [
    parseTsSource('compose.ts', '(root)', false, COMPOSE),
    parseTsSource('hono-base.ts', '(root)', false, HONO_BASE),
    parseTsSource('jsx/components.ts', 'jsx', false, JSX_COMPONENTS),
    parseTsSource('jsx/dom/render.ts', 'jsx', false, JSX_DOM),
    parseTsSource('middleware/combine/index.ts', 'middleware', false, COMBINE),
  ];
  return buildKnowledgeGraph(files, buildGraph(files), {});
}

describe('call-graph precision (benchmark regressions)', () => {
  it('class methods are call-graph nodes — the real callers of compose', () => {
    const graph = graphOf();
    const r = findFunction(graph, 'compose');
    expect('node' in r).toBe(true);
    if (!('node' in r)) return;
    const callers = callersOf(graph, r.node.id).map((c) => `${c.label}@${c.file}`);
    // Both class methods call compose; before this fix the TS parser only
    // walked top-level statements and both were invisible.
    expect(callers).toContain('#dispatch@hono-base.ts');
    expect(callers).toContain('route@hono-base.ts');
  });

  it('an array .every() call never becomes a caller of the every middleware', () => {
    const graph = graphOf();
    const r = findFunction(graph, 'every');
    expect('node' in r).toBe(true);
    if (!('node' in r)) return;
    const callers = callersOf(graph, r.node.id).map((c) => `${c.label}@${c.file}`);
    expect(callers).not.toContain('ErrorBoundary@jsx/components.ts');
  });

  it('composeRef is never conflated with compose', () => {
    const graph = graphOf();
    const compose = findFunction(graph, 'compose');
    const composeRef = findFunction(graph, 'composeRef');
    expect('node' in compose && compose.node.file).toBe('compose.ts');
    expect('node' in composeRef && composeRef.node.file).toBe('jsx/dom/render.ts');
    // And composeRef's callers never leak into compose's caller set.
    if ('node' in compose) {
      const callers = callersOf(graph, compose.node.id).map((c) => c.file);
      expect(callers).not.toContain('jsx/dom/render.ts');
    }
  });

  it('a substring resolution is labeled, never presented as exact', () => {
    const graph = graphOf();
    const r = findFunction(graph, 'composeR'); // matches composeRef only
    expect('node' in r).toBe(true);
    if ('node' in r) {
      expect(r.node.label).toBe('composeRef');
      expect(r.match).toBe('substring');
    }
    const exact = findFunction(graph, 'compose');
    expect('node' in exact && exact.match).toBe('exact');
  });
});
