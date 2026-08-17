import type {
  EvidenceItem,
  GitHistory,
  ModuleEvidence,
  ModuleGraph,
  ModuleInfo,
} from '../types.js';

/**
 * Raw evidence behind each metric score (drill-down contract): the same
 * primitives the scorers consume, stated as facts with file/line references.
 * Every list is capped, and a cap always leaves an explicit overflow row —
 * a truncated list must never read as a complete one.
 */

const CAP = 12;

function overflow(kind: string, hidden: number, what: string): EvidenceItem {
  return { kind: `${kind}-overflow`, text: `... and ${hidden} more ${what}`, effect: 'input' };
}

export function moduleEvidence(mod: ModuleInfo, graph: ModuleGraph, git: GitHistory): ModuleEvidence {
  return {
    depth: depthEvidence(mod),
    seams: seamsEvidence(mod, graph),
    locality: localityEvidence(mod.name, git),
    leverage: leverageEvidence(mod, graph),
  };
}

// ── depth: interface surface vs implementation ──────────────────────────────

function depthEvidence(mod: ModuleInfo): EvidenceItem[] {
  const src = mod.files.filter((f) => !f.isTest);
  if (src.length === 0) {
    return [{ kind: 'tests-only', text: 'module contains only test files — depth is not computable', effect: 'input' }];
  }

  const items: EvidenceItem[] = [];
  let exportedFns = 0;
  let exportedTypes = 0;
  let exportedConsts = 0;
  let reExports = 0;
  let requiredParams = 0;
  let privateFns = 0;
  let loc = 0;
  for (const f of src) {
    loc += f.codeLines;
    privateFns += f.internalFunctions;
    for (const e of f.exports) {
      if (e.kind === 'function' || e.kind === 'class') {
        exportedFns++;
        requiredParams += e.requiredParams;
      } else if (e.kind === 'type') exportedTypes++;
      else if (e.kind === 'const') exportedConsts++;
      else if (e.kind === 'reexport') reExports++;
    }
  }

  items.push({
    kind: 'totals',
    text:
      `interface: ${exportedFns} exported fns/classes, ${exportedTypes} types, ${exportedConsts} consts, ` +
      `${reExports} re-exports, ${requiredParams} required params · implementation: ${loc} LOC, ${privateFns} private fns`,
    effect: 'input',
  });

  // The per-file surface: where the interface actually lives.
  const surfaced = src
    .filter((f) => f.exports.length > 0)
    .sort((a, b) => b.exports.length - a.exports.length);
  for (const f of surfaced.slice(0, CAP)) {
    const fns = f.exports.filter((e) => e.kind === 'function' || e.kind === 'class').length;
    const types = f.exports.filter((e) => e.kind === 'type').length;
    items.push({
      kind: 'file-surface',
      file: f.path,
      text: `exports ${f.exports.length} symbols (${fns} fns/classes, ${types} types) in ${f.codeLines} LOC`,
      effect: 'input',
    });
  }
  if (surfaced.length > CAP) items.push(overflow('file-surface', surfaced.length - CAP, 'exporting files'));

  // Wide signatures inflate interface complexity (0.5 pts per required param).
  const wide: { name: string; params: number; file: string; line?: number }[] = [];
  for (const f of src) {
    for (const e of f.exports) {
      if ((e.kind === 'function' || e.kind === 'class') && e.requiredParams >= 4) {
        const fn = f.functions.find((fr) => fr.exported && fr.name === e.name);
        wide.push({ name: e.name, params: e.requiredParams, file: f.path, ...(fn === undefined ? {} : { line: fn.startLine }) });
      }
    }
  }
  wide.sort((a, b) => b.params - a.params);
  for (const w of wide.slice(0, 5)) {
    items.push({
      kind: 'wide-export',
      file: w.file,
      ...(w.line === undefined ? {} : { line: w.line }),
      text: `${w.name} takes ${w.params} required params — widens the interface`,
      effect: 'penalty',
    });
  }
  if (wide.length > 5) items.push(overflow('wide-export', wide.length - 5, 'wide exports'));

  const surface = exportedFns + exportedTypes + exportedConsts + reExports;
  if (surface === 0) {
    items.push({ kind: 'internal-only', text: `no exports — internal-only module (${loc} LOC)`, effect: 'input' });
  } else if (reExports / surface > 0.8 && loc < 30) {
    items.push({
      kind: 'reexport-barrel',
      text: `re-export barrel: ${reExports} of ${surface} exported symbols are re-exports in under 30 LOC — capped at Very Shallow`,
      effect: 'penalty',
    });
  }
  return items;
}

// ── seams: mirrors moduleSeams' deductions exactly ──────────────────────────

function seamsEvidence(mod: ModuleInfo, graph: ModuleGraph): EvidenceItem[] {
  const items: EvidenceItem[] = [];

  if (mod.hasInterfaceFile) {
    items.push({ kind: 'interface-file', text: 'an index file defines the public surface', effect: 'credit' });
  } else {
    items.push({ kind: 'no-interface-file', text: 'no interface (index) file — nothing marks the public surface (-35 pts)', effect: 'penalty' });
  }

  const deep = graph.deepImports.filter((d) => d.toModule === mod.name);
  for (const d of deep.slice(0, CAP)) {
    items.push({
      kind: 'deep-import',
      file: d.fromFile,
      text: `${d.fromFile} imports ${d.toFile} directly, bypassing the interface`,
      effect: 'penalty',
    });
  }
  if (deep.length > CAP) items.push(overflow('deep-import', deep.length - CAP, 'deep imports'));
  if (deep.length > 0) {
    items.push({
      kind: 'deep-import-penalty',
      text: `${deep.length} deep import${deep.length > 1 ? 's' : ''} cost ${Math.min(deep.length * 8, 30)} pts (8 each, capped at 30)`,
      effect: 'input',
    });
  }

  const partners = [...new Set(graph.cycles.filter((c) => c.includes(mod.name)).flat())].filter((n) => n !== mod.name);
  if (partners.length > 0) {
    items.push({
      kind: 'cycle',
      text: `circular dependency with ${partners.join(', ')} (-25 pts)`,
      effect: 'penalty',
    });
  }

  const boundaryTested = mod.files.some((f) => f.isTest);
  const allTests = mod.files.every((f) => f.isTest);
  if (!boundaryTested && !allTests) {
    items.push({ kind: 'boundary-untested', text: 'no test exercises this module\'s boundary (-10 pts)', effect: 'penalty' });
  } else if (boundaryTested) {
    items.push({ kind: 'boundary-tested', text: 'tests exercise the boundary', effect: 'credit' });
  }
  return items;
}

// ── locality: the co-change numbers the score is computed from ──────────────

function localityEvidence(moduleName: string, git: GitHistory): EvidenceItem[] {
  if (!git.available) {
    return [{ kind: 'no-git', text: 'no git history available — locality is not computable', effect: 'input' }];
  }
  const stats = git.perModule.get(moduleName);
  if (!stats || stats.commits < 2) {
    return [{
      kind: 'too-few-commits',
      text: `${stats?.commits ?? 0} commit(s) touched this module in the ${git.windowMonths}-month window — too few to judge`,
      effect: 'input',
    }];
  }
  return [
    { kind: 'commits', text: `${stats.commits} commits touched this module in the ${git.windowMonths}-month window`, effect: 'input' },
    {
      kind: 'dir-spread',
      text: `those commits swept ${stats.avgDirSpread.toFixed(1)} top-level directories on average (1.0 = perfectly local)`,
      effect: stats.avgDirSpread > 2 ? 'penalty' : 'input',
    },
    {
      kind: 'file-spread',
      text: `${stats.avgFilesTouched.toFixed(1)} files changed per touching commit`,
      effect: stats.avgFilesTouched > 6 ? 'penalty' : 'input',
    },
    { kind: 'formula', text: 'scatter = 0.7 x directory spread + 0.3 x file spread; locality = 1 - scatter', effect: 'input' },
  ];
}

// ── leverage: who uses it, and which exports nobody uses ────────────────────

function leverageEvidence(mod: ModuleInfo, graph: ModuleGraph): EvidenceItem[] {
  const exported = mod.exportedNames.size;
  if (exported === 0) {
    return [{ kind: 'no-surface', text: 'no exported surface — leverage is not computable', effect: 'input' }];
  }

  const items: EvidenceItem[] = [];
  const callers = [...(graph.importedBy.get(mod.name) ?? [])].sort();
  const used = graph.usedExports.get(mod.name) ?? new Set<string>();

  items.push({
    kind: 'usage-summary',
    text: `${used.size} of ${exported} exports are imported somewhere, across ${callers.length} caller module(s)`,
    effect: 'input',
  });

  if (callers.length === 0) {
    items.push({ kind: 'no-callers', text: `${exported} exports, zero caller modules — dead weight`, effect: 'penalty' });
  }
  for (const c of callers.slice(0, CAP)) {
    items.push({ kind: 'caller', text: `imported by ${c}`, effect: 'credit' });
  }
  if (callers.length > CAP) items.push(overflow('caller', callers.length - CAP, 'caller modules'));

  const unused = [...mod.exportedNames].filter((n) => !used.has(n)).sort();
  for (const name of unused.slice(0, CAP)) {
    let file: string | undefined;
    let line: number | undefined;
    for (const f of mod.files) {
      if (f.exports.some((e) => e.name === name)) {
        file = f.path;
        line = f.functions.find((fr) => fr.exported && fr.name === name)?.startLine;
        break;
      }
    }
    items.push({
      kind: 'unused-export',
      ...(file === undefined ? {} : { file }),
      ...(line === undefined ? {} : { line }),
      text: `export '${name}' is never imported by another module`,
      effect: 'penalty',
    });
  }
  if (unused.length > CAP) items.push(overflow('unused-export', unused.length - CAP, 'unused exports'));

  return items;
}
