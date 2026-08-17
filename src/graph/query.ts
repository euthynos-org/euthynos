import type { CodeGraph, CodeNode } from '../types.js';

/**
 * Deterministic graph queries — callers, callees, blast radius, shortest path.
 * No LLM, no database round-trip: BFS over in-memory adjacency. Every answer
 * is reproducible from the same commit.
 */

export interface Reachable {
  id: string;
  label: string;
  file?: string;
  line?: number;
  module: string;
  depth: number;
  /** Weakest call-edge confidence (0-1) along the path to this node. */
  confidence?: number;
}

export interface ImpactReport {
  target: { id: string; label: string; file?: string; line?: number; module: string };
  affectedFunctions: Reachable[];
  affectedFiles: string[];
  affectedModules: string[];
  crossesModuleBoundary: boolean;
  blastRadius: 'isolated' | 'local' | 'moderate' | 'wide';
  /** Leverage of the changed function's module, when the graph carries metrics. */
  moduleLeverage: number | null;
  /** True when unresolved calls exist repo-wide — real blast radius may be larger. */
  lowerBound: boolean;
  summary: string;
}

/**
 * How a query resolved to a node — carried into every tool response so an
 * agent can weigh the answer (§29 confidence contract). A `substring` match
 * is NOT the same claim as an exact one and must never read like it.
 */
export type MatchKind = 'qualified' | 'exact' | 'substring';

/** Resolve a user string to a single function node, or report ambiguity. */
export function findFunction(
  graph: CodeGraph,
  query: string,
): { node: CodeNode; match: MatchKind } | { error: string; candidates?: string[] } {
  const fns = [...graph.nodes.values()].filter((n) => n.kind === 'function');

  // file#name exact
  if (query.includes('#')) {
    const hit = fns.find((n) => `${n.file}#${n.label}` === query || n.id === `fn:${query}`);
    if (hit) return { node: hit, match: 'qualified' };
  }
  const exact = fns.filter((n) => n.label === query);
  if (exact.length === 1) return { node: exact[0]!, match: 'exact' };
  if (exact.length > 1) {
    return { error: `'${query}' is ambiguous`, candidates: exact.map((n) => `${n.file}#${n.label}`) };
  }
  const partial = fns.filter((n) => n.label.toLowerCase().includes(query.toLowerCase()));
  if (partial.length === 1) return { node: partial[0]!, match: 'substring' };
  if (partial.length > 1) {
    return { error: `'${query}' matches ${partial.length} functions`, candidates: partial.slice(0, 12).map((n) => `${n.file}#${n.label}`) };
  }
  return { error: `function '${query}' not found` };
}

/** Functions that (transitively) call `id`. */
export function callersOf(graph: CodeGraph, id: string, maxDepth = 6): Reachable[] {
  return bfs(graph, id, graph.callsIn, maxDepth, 'in');
}

/** Functions that `id` (transitively) calls. */
export function calleesOf(graph: CodeGraph, id: string, maxDepth = 6): Reachable[] {
  return bfs(graph, id, graph.callsOut, maxDepth, 'out');
}

/**
 * Blast radius: everything that could break if `id` changes (its transitive
 * callers), with a risk read from module spread and leverage.
 */
export function impactOf(graph: CodeGraph, id: string): ImpactReport {
  const target = graph.nodes.get(id)!;
  const affected = callersOf(graph, id);
  const files = unique(affected.map((r) => r.file).filter((f): f is string => !!f));
  const modules = unique(affected.map((r) => r.module));
  const n = affected.length;
  const blastRadius = n === 0 ? 'isolated' : n <= 3 ? 'local' : n <= 10 ? 'moderate' : 'wide';
  const moduleLeverage = graph.nodes.get(`module:${target.module}`)?.metrics?.leverage ?? null;

  const unresolved = graph.stats.unresolvedCalls;
  const parts = [`${n} function${n === 1 ? '' : 's'} call ${target.label} (transitively)`];
  if (modules.length > 1) parts.push(`across ${modules.length} modules`);
  if (moduleLeverage !== null && moduleLeverage >= 70) {
    parts.push(`— ${target.module} is high-leverage (${moduleLeverage}); change its interface with care`);
  }
  if (unresolved > 0) {
    parts.push(`(lower bound — ${unresolved} repo-wide call${unresolved === 1 ? '' : 's'} couldn't be resolved to a definition)`);
  }

  return {
    target: { id: target.id, label: target.label, file: target.file, line: target.line, module: target.module },
    affectedFunctions: affected,
    affectedFiles: files,
    affectedModules: modules,
    crossesModuleBoundary: modules.length > 1,
    blastRadius,
    moduleLeverage,
    lowerBound: unresolved > 0,
    summary: parts.join(' '),
  };
}

/** Shortest dependency path between two functions over call edges (either direction tried). */
export function pathBetween(graph: CodeGraph, fromId: string, toId: string): Reachable[] | null {
  const fwd = shortestPath(graph, fromId, toId, graph.callsOut);
  if (fwd) return fwd;
  return shortestPath(graph, fromId, toId, graph.callsIn);
}

// ── internals ──

function bfs(graph: CodeGraph, start: string, adj: Map<string, Set<string>>, maxDepth: number, dir: 'in' | 'out'): Reachable[] {
  const seen = new Set<string>([start]);
  const out: Reachable[] = [];
  let frontier = [...(adj.get(start) ?? [])].map((id) => ({ id, conf: edgeConf(graph, dir, start, id) }));
  let depth = 1;
  while (frontier.length && depth <= maxDepth) {
    const next: { id: string; conf: number }[] = [];
    for (const { id, conf } of frontier) {
      if (seen.has(id)) continue;
      seen.add(id);
      const n = graph.nodes.get(id);
      if (n) out.push({ id, label: n.label, file: n.file, line: n.line, module: n.module, depth, confidence: conf });
      for (const m of adj.get(id) ?? []) {
        if (!seen.has(m)) next.push({ id: m, conf: Math.min(conf, edgeConf(graph, dir, id, m)) });
      }
    }
    frontier = next;
    depth++;
  }
  return out;
}

/** Confidence of the call edge an adjacency hop `a → b` represents (weakest-link source). */
function edgeConf(graph: CodeGraph, dir: 'in' | 'out', a: string, b: string): number {
  // callsIn hop a→b means "b calls a" (edge b→a); callsOut hop a→b means "a calls b".
  const key = dir === 'in' ? `${b}|${a}` : `${a}|${b}`;
  return graph.callMeta.get(key)?.confidence ?? 1;
}

function shortestPath(graph: CodeGraph, from: string, to: string, adj: Map<string, Set<string>>): Reachable[] | null {
  if (from === to) return [];
  const prev = new Map<string, string>();
  const seen = new Set<string>([from]);
  let frontier = [from];
  while (frontier.length) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const m of adj.get(id) ?? []) {
        if (seen.has(m)) continue;
        seen.add(m);
        prev.set(m, id);
        if (m === to) return reconstruct(graph, prev, from, to);
        next.push(m);
      }
    }
    frontier = next;
  }
  return null;
}

function reconstruct(graph: CodeGraph, prev: Map<string, string>, from: string, to: string): Reachable[] {
  const ids: string[] = [to];
  let cur = to;
  while (cur !== from) {
    cur = prev.get(cur)!;
    ids.unshift(cur);
  }
  return ids.map((id, i) => {
    const n = graph.nodes.get(id)!;
    return { id, label: n.label, file: n.file, line: n.line, module: n.module, depth: i };
  });
}

function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}
