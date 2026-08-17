import { describe, expect, it } from 'vitest';
import { buildGraph } from '../src/graph/imports.js';
import { buildKnowledgeGraph, fnId } from '../src/graph/knowledge.js';
import { callersOf, impactOf } from '../src/graph/query.js';
import type { FunctionRecord, ParsedFile } from '../src/types.js';

function fn(name: string, file: string, calls: string[], exported = false): FunctionRecord {
  return { name, file, startLine: 1, endLine: 5, exported, paramCount: 0, paramNames: [], bodyHash: 0, bodyTokens: 5, calls };
}
function pf(path: string, module: string, functions: FunctionRecord[], exports: string[]): ParsedFile {
  return {
    path, module, isTest: false, isIndex: false, codeLines: 10,
    exports: exports.map((name) => ({ name, kind: 'function', requiredParams: 0, totalParams: 0 })),
    internalFunctions: 0, functions, imports: [],
  };
}

const svc = pf('lib/svc/run.ts', 'svc', [
  fn('run', 'lib/svc/run.ts', ['helper', 'compute', 'missing'], true),
  fn('helper', 'lib/svc/run.ts', [], false),
], ['run']);
const calc = pf('lib/calc/engine.ts', 'calc', [fn('compute', 'lib/calc/engine.ts', [], true)], ['compute']);

const files = [svc, calc];
const mg = buildGraph(files);
const g = buildKnowledgeGraph(files, mg);

const runId = fnId('lib/svc/run.ts', 'run');
const helperId = fnId('lib/svc/run.ts', 'helper');
const computeId = fnId('lib/calc/engine.ts', 'compute');

describe('call edges carry resolution confidence + reason', () => {
  it('a same-file call is certain (1.0, same-file)', () => {
    expect(g.callMeta.get(`${runId}|${helperId}`)).toEqual({ confidence: 1, reason: 'same-file' });
  });

  it('a unique cross-module name is high confidence (0.9, unique-name)', () => {
    expect(g.callMeta.get(`${runId}|${computeId}`)).toEqual({ confidence: 0.9, reason: 'unique-name' });
    const edge = g.edges.find((e) => e.from === runId && e.to === computeId);
    expect(edge?.reason).toBe('unique-name');
  });

  it('an unresolved call is counted and makes impact a lower bound', () => {
    expect(g.stats.unresolvedCalls).toBeGreaterThanOrEqual(1); // the 'missing' call
    const imp = impactOf(g, computeId);
    expect(imp.lowerBound).toBe(true);
    expect(imp.summary).toContain('lower bound');
  });

  it('threads the call-edge confidence onto reachable callers', () => {
    const callers = callersOf(g, computeId);
    const run = callers.find((c) => c.id === runId);
    expect(run?.confidence).toBe(0.9);
    const viaHelper = callersOf(g, helperId).find((c) => c.id === runId);
    expect(viaHelper?.confidence).toBe(1);
  });
});
