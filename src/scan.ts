import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { discoverFiles, moduleOf } from './discover.js';
import { parseDiscovered } from './parse/dispatch.js';
import { buildGraph } from './graph/imports.js';
import { analyzeHistory } from './git/history.js';
import { analyzeAuthors } from './git/authors.js';
import { inferOwner, knowledgeRisk } from './metrics/ownership.js';
import { moduleDepth } from './metrics/depth.js';
import { moduleLocality } from './metrics/locality.js';
import { moduleLeverage } from './metrics/leverage.js';
import { moduleSeams } from './metrics/seams.js';
import { contamination } from './metrics/contamination.js';
import { moduleEvidence } from './metrics/evidence.js';
import { architectureHealth } from './metrics/health.js';
import type { ModuleInfo, ModuleReport, ParsedFile, ScanReport } from './types.js';

export interface ScanOptions {
  months?: number;
  /** Modules with fewer code lines than this are folded out of the report. */
  minModuleLines?: number;
  /** Ignore globs applied at discovery (vendored/generated code). */
  ignore?: string[];
  /** Discovery file cap override — a test/ops seam for exercising the cap
   *  without a 60,000-file fixture; production uses the built-in ceiling. */
  maxFiles?: number;
  /**
   * Parsed artifacts from the incremental store (G5). When supplied, this
   * scan reuses them verbatim instead of re-discovering and re-parsing the
   * repository: the store already holds a content-addressed artifact per
   * file and already applied THIS root's effective ignore set, so a second
   * traversal would only re-derive the same answer at full cost — and risk
   * a second, divergent file universe (the G2 defect class).
   *
   * The store is the authority for the file SET; everything below is
   * derived from `parsed` exactly as it would have been from a fresh walk,
   * so module grouping, metrics, ordering and confidence labels are
   * unchanged.
   */
  files?: ParsedFile[];
}

export function scan(rootInput: string, opts: ScanOptions = {}): ScanReport {
  const root = resolve(rootInput);

  // Fail closed on a root that is not there.
  //
  // Without this, a typo'd path discovers zero files, and zero files means
  // zero detected problems, which scores 100/100 [Strong] — the BEST possible
  // result for a path that does not exist. That propagates: `policy --strict`
  // then prints "all architecture policies passed" and exits 0, so a
  // misconfigured CI gate goes green precisely because it measured nothing.
  // An unmeasurable repository must be an error, never a perfect score.
  if (opts.files === undefined) {
    let stat;
    try {
      stat = statSync(root);
    } catch {
      throw new Error(
        `cannot scan ${root}: no such directory.\n` +
        `  A path that does not exist would otherwise score 100/100 — zero files means zero findings.`,
      );
    }
    if (!stat.isDirectory()) {
      throw new Error(`cannot scan ${root}: not a directory.`);
    }
  }

  const months = opts.months ?? 6;
  const minLines = opts.minModuleLines ?? 10;

  const discoveryMeta: { truncated?: boolean } = {};
  const parsed: ParsedFile[] = [];
  // A file that fails to parse VANISHES from the graph — silently, that is a
  // trust bug (a whole class disappears and callers_of answers "none").
  // Skipped files are counted and reported so the gap is visible.
  const skipped: { file: string; reason: string }[] = [];
  if (opts.files !== undefined) {
    // Reuse path: the store already excluded unparseable files and already
    // recorded them as skipped, so nothing is silently dropped here.
    parsed.push(...opts.files);
  } else {
    const discovered = discoverFiles(root, opts.ignore ?? [], discoveryMeta, {
      ...(opts.maxFiles !== undefined ? { maxFiles: opts.maxFiles } : {}),
    });
    for (const f of discovered) {
      try {
        parsed.push(parseDiscovered(f));
      } catch (e) {
        skipped.push({ file: f.rel, reason: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  const modules = groupModules(parsed).filter(
    (m) => m.codeLines >= minLines || m.files.length > 1,
  );
  const graph = buildGraph(parsed);
  const git = analyzeHistory(root, months, moduleOf);
  const authors = analyzeAuthors(root, months, moduleOf);
  const contam = contamination(parsed, graph);

  const reports: ModuleReport[] = modules.map((mod) => {
    const depth = moduleDepth(mod);
    const seams = moduleSeams(mod, graph, mod.files.every((f) => f.isTest));
    const locality = moduleLocality(mod.name, git);
    const lev = moduleLeverage(mod, graph, modules.length);
    const aStats = authors.perModule.get(mod.name);
    return {
      name: mod.name,
      files: mod.files.length,
      codeLines: mod.codeLines,
      depth,
      seams,
      locality,
      leverage: lev,
      exportedCount: mod.exportedNames.size,
      callerCount: lev.callers,
      utilizationPct: lev.utilizationPct,
      ownership: {
        owner: inferOwner(aStats),
        busFactor: aStats?.busFactor ?? null,
        topShare: aStats?.topShare ?? null,
        topAuthor: aStats?.topAuthor ?? null,
        risk: knowledgeRisk(aStats),
      },
      // Drill-down contract: the raw primitives each score was computed from.
      evidence: moduleEvidence(mod, graph, git),
    };
  });

  const averages = {
    depth: avg(reports.map((r) => r.depth.score)),
    seams: avg(reports.map((r) => r.seams.score)),
    locality: avg(reports.map((r) => r.locality.score)),
    leverage: avg(reports.map((r) => r.leverage.score)),
  };

  const health = architectureHealth({ ...averages, contamination: contam.score });

  return {
    root,
    scannedAt: new Date().toISOString(),
    filesScanned: parsed.length,
    modules: reports.sort((a, b) => (a.depth.score ?? 101) - (b.depth.score ?? 101)),
    contamination: contam,
    health,
    averages,
    opportunities: opportunities(reports, contam.findings.length),
    gitAvailable: git.available,
    ...(skipped.length > 0 ? { skippedFiles: skipped.slice(0, 50) } : {}),
    ...(discoveryMeta.truncated === true ? { discoveryTruncated: true } : {}),
    // Inside the report on purpose: the gate evaluates stored reports, and a
    // boundary verdict must be able to say what it could NOT judge.
    importEdges: graph.importEdges,
    unresolvedImports: graph.unresolvedImports,
    externalImports: graph.externalImports,
    files: parsed.map((f) => f.path),
    graph: {
      nodes: modules.length,
      edges: [...graph.imports.values()].reduce((n, tos) => n + tos.size, 0),
      cycles: graph.cycles.length,
    },
  };
}

function groupModules(files: ParsedFile[]): ModuleInfo[] {
  const map = new Map<string, ModuleInfo>();
  for (const f of files) {
    let m = map.get(f.module);
    if (!m) {
      m = { name: f.module, files: [], exportedNames: new Set(), hasInterfaceFile: false, codeLines: 0 };
      map.set(f.module, m);
    }
    m.files.push(f);
    m.codeLines += f.codeLines;
    if (f.isIndex && !f.isTest) m.hasInterfaceFile = true;
    for (const e of f.exports) if (!f.isTest) m.exportedNames.add(e.name);
  }
  return [...map.values()];
}

function avg(xs: Array<number | null>): number | null {
  const vals = xs.filter((x): x is number => x !== null);
  if (vals.length === 0) return null;
  return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
}

/** The "top deepening opportunities" list from the spec's dashboard. */
function opportunities(reports: ModuleReport[], contamCount: number): string[] {
  const out: string[] = [];
  for (const r of reports) {
    if (r.depth.score !== null && r.depth.score < 40) {
      out.push(`${r.name} — Depth ${r.depth.score} (${r.depth.label}): ${r.depth.detail}`);
    }
  }
  for (const r of reports) {
    if (r.leverage.score !== null && r.leverage.score < 40 && r.exportedCount >= 8) {
      out.push(`${r.name} — Leverage ${r.leverage.score}: ${r.leverage.detail}`);
    }
  }
  for (const r of reports) {
    if (r.seams.score !== null && r.seams.score < 60) {
      out.push(`${r.name} — Seams ${r.seams.score} (${r.seams.label}): ${r.seams.detail}`);
    }
  }
  for (const r of reports) {
    if (r.ownership.risk.score !== null && r.ownership.risk.score < 40) {
      out.push(`${r.name} — Knowledge risk: ${r.ownership.risk.detail}`);
    }
  }
  if (contamCount > 0) {
    out.push(`${contamCount} duplicate-logic finding${contamCount > 1 ? 's' : ''} — run with --json for file:line pairs`);
  }
  return out.slice(0, 8);
}
