import type { CodeEdge, CodeGraph, CodeNode, ModuleGraph, ModuleReport, ParsedFile } from '../types.js';

/**
 * The code knowledge graph — Euthynos's structural map of a repo.
 *
 * Unlike a navigation graph, every node here is metric-aware: module nodes
 * carry depth/seams/leverage/locality and an inferred owner, so a blast-radius
 * query returns not just "what breaks" but "how risky the thing you're changing
 * is". Pure in-memory adjacency — no graph database, no native deps.
 *
 * Nodes:  module:<name> · file:<path> · fn:<path>#<name>
 * Edges:  contains (module→file→fn) · imports (module→module, file→file) · calls (fn→fn)
 */

export const modId = (name: string): string => `module:${name}`;
export const fileId = (path: string): string => `file:${path}`;
export const fnId = (file: string, name: string): string => `fn:${file}#${name}`;

export interface BuildOptions {
  /** Module-level metric reports from a scan, indexed by module name. Optional. */
  metricsByModule?: Map<string, ModuleReport>;
}

export function buildKnowledgeGraph(
  files: ParsedFile[],
  moduleGraph: ModuleGraph,
  opts: BuildOptions = {},
): CodeGraph {
  const nodes = new Map<string, CodeNode>();
  const edges: CodeEdge[] = [];
  const callsOut = new Map<string, Set<string>>();
  const callsIn = new Map<string, Set<string>>();
  const callMeta = new Map<string, { confidence: number; reason: string }>();

  const src = files.filter((f) => !f.isTest);
  const modules = new Set(src.map((f) => f.module));

  // ── Module + file + function nodes, contains edges ──
  for (const m of modules) {
    const report = opts.metricsByModule?.get(m);
    nodes.set(modId(m), {
      id: modId(m),
      kind: 'module',
      label: m,
      module: m,
      metrics: report
        ? { depth: report.depth.score, seams: report.seams.score, leverage: report.leverage.score, locality: report.locality.score }
        : undefined,
      owner: report?.ownership.owner ?? null,
      busFactor: report?.ownership.busFactor ?? null,
    });
  }

  // name -> fn ids (global), and per-file name -> fn id (local)
  const globalByName = new Map<string, string[]>();
  const localByFile = new Map<string, Map<string, string>>();
  /** fn id -> the FunctionRecord, so we can read its raw callee names in pass 2. */
  const fnCalls = new Map<string, string[]>();
  /** fn id -> the subset of those names that were receiver calls (`x.foo()`). */
  const fnMemberCalls = new Map<string, Set<string>>();

  for (const f of src) {
    nodes.set(fileId(f.path), { id: fileId(f.path), kind: 'file', label: f.path, module: f.module, file: f.path });
    edges.push({ from: modId(f.module), to: fileId(f.path), kind: 'contains' });

    const local = new Map<string, string>();
    localByFile.set(f.path, local);

    for (const fn of f.functions) {
      const id = fnId(f.path, fn.name);
      if (nodes.has(id)) continue; // first declaration wins
      nodes.set(id, {
        id,
        kind: 'function',
        label: fn.name,
        module: f.module,
        file: f.path,
        line: fn.startLine,
        exported: fn.exported,
      });
      edges.push({ from: fileId(f.path), to: id, kind: 'contains' });
      callsOut.set(id, new Set());
      callsIn.set(id, new Set());
      fnCalls.set(id, fn.calls);
      if (fn.memberCalls !== undefined) fnMemberCalls.set(id, new Set(fn.memberCalls));
      local.set(fn.name, id);
      const g = globalByName.get(fn.name);
      if (g) g.push(id);
      else globalByName.set(fn.name, [id]);
    }
  }

  // ── Import edges (module-level from the module graph; file-level for context) ──
  let importEdges = 0;
  for (const [from, tos] of moduleGraph.imports) {
    for (const to of tos) {
      if (nodes.has(modId(from)) && nodes.has(modId(to))) {
        edges.push({ from: modId(from), to: modId(to), kind: 'imports' });
        importEdges++;
      }
    }
  }

  // ── Call edges (deterministic resolver; ambiguous names are skipped, not guessed) ──
  let callEdges = 0;
  let unresolvedCalls = 0;
  for (const [callerId, names] of fnCalls) {
    const caller = nodes.get(callerId)!;
    const viaMember = fnMemberCalls.get(callerId);
    for (const name of names) {
      // A name reached through a receiver (`arr.every()`) is only a candidate
      // edge with structural evidence — see resolveCall.
      const form: CallForm = viaMember?.has(name) === true ? 'member' : 'bare';
      const resolved = resolveCall(name, form, caller, localByFile, globalByName, moduleGraph, nodes);
      if (resolved.length === 0) {
        unresolvedCalls++;
        continue;
      }
      for (const res of resolved) {
        if (res.id === callerId) continue;
        const targetId = res.id;
        if (!callsOut.get(callerId)!.has(targetId)) {
          callsOut.get(callerId)!.add(targetId);
          callsIn.get(targetId)!.add(callerId);
          edges.push({ from: callerId, to: targetId, kind: 'calls', confidence: res.confidence, reason: res.reason });
          callMeta.set(`${callerId}|${targetId}`, { confidence: res.confidence, reason: res.reason });
          callEdges++;
        }
      }
    }
  }

  return {
    nodes,
    edges,
    callsOut,
    callsIn,
    callMeta,
    stats: {
      modules: modules.size,
      files: src.length,
      functions: [...nodes.values()].filter((n) => n.kind === 'function').length,
      callEdges,
      importEdges,
      unresolvedCalls,
    },
  };
}

interface Resolved {
  id: string;
  /** 0-1 evidence weight: how sure we are this is the right target. */
  confidence: number;
  reason: string;
}

/** How the callee was written: `foo()` vs `receiver.foo()`. */
type CallForm = 'bare' | 'member';

/**
 * Resolve one callee name to concrete function node(s), with evidence weights:
 *   1. same-file function       → 1.0  'same-file'   (the strongest evidence)
 *      — unless that hit is the CALLER ITSELF and other definitions exist:
 *        a controller method delegating to a same-named service method
 *        (`_svc.Method()` inside `Method`) must not self-shadow the target.
 *   2. unique whole-repo match  → 0.9  'unique-name' — BARE CALLS ONLY. A
 *      member call's name is usually a built-in (`arr.every()`, `p.then()`,
 *      `list.Select()`); resolving it by repo-wide name uniqueness invents
 *      edges (hono: every `.every()` array call became a caller of the
 *      `every` middleware, polluting its blast radius).
 *   3. import-scoped match      → 0.7  'import-scoped' (one of N, but the caller's
 *                                       module imports exactly its owning module)
 *   4. all remaining candidates in ONE imported module (≤4, e.g. an interface
 *      and its implementation) → 0.5 'module-scoped' edges to EACH — dispatch
 *      cannot be narrowed statically, so the graph over-approximates and says so.
 *   5. otherwise ambiguous → [] (we never guess across modules)
 */
function resolveCall(
  name: string,
  form: CallForm,
  caller: CodeNode,
  localByFile: Map<string, Map<string, string>>,
  globalByName: Map<string, string[]>,
  moduleGraph: ModuleGraph,
  nodes: Map<string, CodeNode>,
): Resolved[] {
  const all = globalByName.get(name) ?? [];
  const local = localByFile.get(caller.file!)?.get(name);
  if (local && !(local === caller.id && all.length > 1)) {
    return [{ id: local, confidence: 1, reason: 'same-file' }];
  }

  const cands = all.filter((id) => id !== caller.id);
  if (cands.length === 0) return [];
  if (cands.length === 1 && form === 'bare') {
    return [{ id: cands[0]!, confidence: 0.9, reason: 'unique-name' }];
  }

  // Multiple same-named functions: scope by what the caller's module imports.
  const imports = moduleGraph.imports.get(caller.module) ?? new Set<string>();
  const importedCands = cands.filter((id) => {
    const mod = nodes.get(id)?.module;
    return mod && mod !== caller.module && imports.has(mod);
  });
  if (importedCands.length === 1) {
    return [{ id: importedCands[0]!, confidence: 0.7, reason: 'import-scoped' }];
  }
  if (importedCands.length >= 2 && importedCands.length <= 4) {
    const mods = new Set(importedCands.map((id) => nodes.get(id)?.module));
    if (mods.size === 1) {
      return importedCands.map((id) => ({ id, confidence: 0.5, reason: 'module-scoped' }));
    }
  }
  // Module cohesion: exactly one candidate inside the caller's OWN module.
  // Recovers cross-file sibling calls that import-scoping cannot see (a
  // module does not import itself).
  //
  // BARE CALLS ONLY. A benchmark agent caught this rule wiring
  // `Array.prototype.every()` in middleware/language.ts to the `every`
  // middleware in the same module — the same phantom-edge class the
  // unique-name rule was restricted for. Same-module is weaker evidence
  // than an import edge, so a receiver call needs more than proximity.
  if (form === 'bare') {
    const localMod = cands.filter((id) => nodes.get(id)?.module === caller.module);
    if (localMod.length === 1) {
      return [{ id: localMod[0]!, confidence: 0.6, reason: 'module-local' }];
    }
  }
  return [];
}
