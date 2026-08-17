import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildRepoGraph, serializeGraph } from '../src/graph/repo.js';
import { findFunction, callersOf, calleesOf, impactOf, pathBetween } from '../src/graph/query.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, 'fixtures', 'sample');

const graph = buildRepoGraph(FIXTURE, { withMetrics: true });

function id(query: string): string {
  const r = findFunction(graph, query);
  if ('error' in r) throw new Error(`${query}: ${r.error}`);
  return r.node.id;
}

describe('knowledge graph build', () => {
  it('has function nodes and resolved call edges', () => {
    expect(graph.stats.functions).toBeGreaterThan(8);
    expect(graph.stats.callEdges).toBeGreaterThan(5);
    expect(graph.stats.importEdges).toBeGreaterThanOrEqual(1);
  });

  it('attaches module metrics to module nodes', () => {
    const payment = graph.nodes.get('module:payment');
    expect(payment?.metrics?.leverage).not.toBeNull();
    expect(payment?.metrics?.depth).toBeGreaterThan(0);
  });

  it('resolves same-file calls locally (capture → computeFee)', () => {
    const callers = callersOf(graph, id('computeFee')).map((r) => r.label);
    expect(callers).toContain('capture');
  });
});

describe('callers / callees', () => {
  it('computeFee is called by validateTransaction, validatePayment, capture', () => {
    const callers = callersOf(graph, id('computeFee')).map((r) => r.label);
    expect(callers).toContain('validateTransaction');
    expect(callers).toContain('validatePayment');
    expect(callers).toContain('capture');
  });

  it('transitive callers reach the top-level checkout', () => {
    const callers = callersOf(graph, id('computeFee')).map((r) => r.label);
    expect(callers).toContain('checkout');
  });

  it('checkout calls down into payment + auth + orders', () => {
    const callees = calleesOf(graph, id('checkout')).map((r) => r.label);
    expect(callees).toContain('validateTransaction');
    expect(callees).toContain('hasToken');
    expect(callees).toContain('validatePayment');
  });
});

describe('blast radius (impact)', () => {
  it('changing computeFee crosses module boundaries', () => {
    const imp = impactOf(graph, id('computeFee'));
    expect(imp.crossesModuleBoundary).toBe(true);
    expect(imp.affectedModules).toContain('payment');
    expect(imp.affectedModules).toContain('orders');
    expect(imp.affectedModules).toContain('app');
  });

  it('an isolated leaf reports zero blast radius', () => {
    const imp = impactOf(graph, id('checkout')); // top-level, nobody calls it
    expect(imp.blastRadius).toBe('isolated');
    expect(imp.affectedFunctions).toHaveLength(0);
  });

  it('summary surfaces high-leverage owning modules', () => {
    const imp = impactOf(graph, id('computeFee'));
    expect(imp.moduleLeverage).not.toBeNull();
    expect(typeof imp.summary).toBe('string');
    expect(imp.summary).toMatch(/call/);
  });
});

describe('shortest call path', () => {
  it('finds checkout → … → computeFee', () => {
    const path = pathBetween(graph, id('checkout'), id('computeFee'));
    expect(path).not.toBeNull();
    const labels = path!.map((n) => n.label);
    expect(labels[0]).toBe('checkout');
    expect(labels[labels.length - 1]).toBe('computeFee');
    expect(path!.length).toBeGreaterThanOrEqual(2);
  });
});

describe('function resolution', () => {
  it('reports ambiguity instead of guessing', () => {
    const r = findFunction(graph, 'assess'); // assessRisk + assessDanger
    expect('error' in r).toBe(true);
    if ('error' in r) expect(r.candidates!.length).toBeGreaterThanOrEqual(2);
  });

  it('resolves an exact unique name', () => {
    const r = findFunction(graph, 'validateTransaction');
    expect('node' in r).toBe(true);
  });
});

describe('serialization', () => {
  it('produces a portable node-link artifact', () => {
    const json = JSON.parse(serializeGraph(graph));
    expect(json.version).toBe(1);
    expect(Array.isArray(json.nodes)).toBe(true);
    expect(Array.isArray(json.edges)).toBe(true);
    expect(json.edges.some((e: { kind: string }) => e.kind === 'calls')).toBe(true);
  });
});
