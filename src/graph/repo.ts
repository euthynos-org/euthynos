import { resolve } from 'node:path';
import { discoverFiles } from '../discover.js';
import { parseDiscovered } from '../parse/dispatch.js';
import { buildGraph } from './imports.js';
import { buildKnowledgeGraph } from './knowledge.js';
import { scan } from '../scan.js';
import type { CodeGraph, ModuleGraph, ParsedFile, ScanReport } from '../types.js';

export interface RepoGraphOptions {
  /** Run a full scan so module nodes carry depth/seams/leverage/owner. */
  withMetrics?: boolean;
  months?: number;
  /** Reuse an already-computed scan report instead of re-scanning for metrics. */
  report?: ScanReport;
  /** Ignore globs applied at discovery (must match the scan's). */
  ignore?: string[];
  /**
   * Parsed artifacts from the incremental store (G5). Supplying these skips
   * discovery and parsing entirely — the store already holds one
   * content-addressed artifact per file under this root's effective ignore
   * set, and re-deriving them cost a full repository parse on EVERY graph
   * rebuild. Since `generation` bumps on any edit, that rebuild ran on the
   * next tool call after every single edit — the dominant cost in the edit
   * loop, and the reason this parameter exists.
   */
  files?: ParsedFile[];
  /** Module graph already built over those same artifacts by the store. */
  moduleGraph?: ModuleGraph;
}

/** Discover → parse → module graph → knowledge graph for a repo path. */
export function buildRepoGraph(rootInput: string, opts: RepoGraphOptions = {}): CodeGraph {
  const root = resolve(rootInput);
  let parsed: ParsedFile[];
  if (opts.files !== undefined) {
    parsed = opts.files;
  } else {
    const discovered = discoverFiles(root, opts.ignore ?? []);
    parsed = [];
    for (const f of discovered) {
      try {
        parsed.push(parseDiscovered(f));
      } catch {
        // unparseable file (or grammar not pre-loaded): skip
      }
    }
  }
  // The store's module graph is built from these exact artifacts by the same
  // buildGraph(), so reusing it is an identity, not an approximation.
  const moduleGraph = opts.moduleGraph ?? buildGraph(parsed);
  let metricsByModule;
  if (opts.withMetrics) {
    const report =
      opts.report ??
      scan(root, {
        months: opts.months,
        ignore: opts.ignore,
        ...(opts.files !== undefined ? { files: opts.files } : {}),
      });
    metricsByModule = new Map(report.modules.map((m) => [m.name, m]));
  }
  return buildKnowledgeGraph(parsed, moduleGraph, { metricsByModule });
}

/** Portable JSON artifact — node-link form, no Maps/Sets. Writes to `.euthynos/graph.json`. */
export function serializeGraph(graph: CodeGraph): string {
  return JSON.stringify(
    {
      version: 1,
      stats: graph.stats,
      nodes: [...graph.nodes.values()],
      edges: graph.edges,
    },
    null,
    2,
  );
}
