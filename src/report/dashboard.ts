import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join, resolve } from 'node:path';
import { scan } from '../scan.js';
import { buildRepoGraph } from '../graph/repo.js';
import { loadLanguages } from '../parse/treesitter/loader.js';
import { TREE_SITTER_LANGS } from '../parse/dispatch.js';
import type { CodeGraph, ScanReport } from '../types.js';

const here = dirname(fileURLToPath(import.meta.url));

/** Read the dashboard template, robust to running from src (tsx) or dist (built). */
function template(): string {
  const candidates = [
    join(here, 'dashboard.html'), // dist/report or src/report
    join(here, '..', '..', 'src', 'report', 'dashboard.html'), // dist/report → src
  ];
  for (const p of candidates) {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      // try the next candidate
    }
  }
  throw new Error('dashboard.html template not found next to dashboard.js');
}

/**
 * Build a single self-contained dashboard HTML for a scan + its knowledge graph.
 * The data is injected into the template's placeholder; `<` is escaped so a path
 * or symbol containing `</script>` can't break out of the inline data block.
 */
export function renderDashboard(report: ScanReport, graph: CodeGraph): string {
  const data = {
    // Basename only: the artifact is served to browsers — a full local path
    // leaks usernames/layout and means nothing off the machine that scanned.
    repo: basename(report.root) || report.root,
    scannedAt: report.scannedAt,
    health: report.health,
    averages: report.averages,
    contamination: {
      score: report.contamination.score,
      label: report.contamination.label,
      findings: report.contamination.findings,
      violations: report.contamination.violations,
      cloneFnIds: report.contamination.cloneFnIds,
    },
    modules: report.modules,
    stats: graph.stats,
    graph: {
      nodes: [...graph.nodes.values()],
      edges: graph.edges,
    },
  };
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  // Function replacement so `$` sequences in the data aren't treated as patterns.
  return template().replace('__EUTHYNOS_DATA__', () => json);
}

/** `euthynos dashboard [path] [--out file.html]` — scan, graph, write the dashboard. */
export async function runDashboard(rest: string[]): Promise<void> {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith('--')) {
      const next = rest[i + 1];
      if (next && !next.startsWith('--')) {
        flags.set(a.slice(2), next);
        i++;
      } else flags.set(a.slice(2), 'true');
    } else positional.push(a);
  }

  const root = resolve(positional[0] ?? process.cwd());
  const months = Number(flags.get('months') ?? 6);
  const ignore = (flags.get('ignore') ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0);

  await loadLanguages([...TREE_SITTER_LANGS]);
  const report = scan(root, { months, ignore });
  // Reuse the scan's report so we don't re-run git history just for metrics.
  const graph = buildRepoGraph(root, { withMetrics: true, months, report, ignore });
  const html = renderDashboard(report, graph);

  const outFlag = flags.get('out');
  const out = outFlag && outFlag !== 'true' ? resolve(outFlag) : join(root, '.euthynos', 'dashboard.html');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html);

  console.log(`  dashboard → ${out}`);
  console.log('  open it in a browser — self-contained, no server, no deps');
}
