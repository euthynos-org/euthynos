import { basename } from 'node:path';
import type { CodeGraph, ModuleGraph, ParsedFile, ScanReport } from '../types.js';

/**
 * REPO MAP — one call that replaces the orientation phase of a session
 * (project structure, major modules, entry points, layout, conventions).
 * Budget: ~1,500 tokens for a normal repository, enforced by truncating
 * ranked lists with an explicit overflow row — never silently.
 */

const MAX_MODULES = 18;
const MAX_ENTRY_POINTS = 8;
const MAX_EDGES = 12;

export interface RepoMapInput {
  root: string;
  report: ScanReport;
  files: ParsedFile[];
  moduleGraph: ModuleGraph;
  graph?: CodeGraph;
}

export function renderRepoMap(input: RepoMapInput): string {
  const { report, files, moduleGraph } = input;
  const lines: string[] = [];
  const testFiles = files.filter((f) => f.isTest);
  const srcFiles = files.filter((f) => !f.isTest);

  lines.push(`Repository: ${basename(input.root)} — ${report.filesScanned} files, ${report.modules.length} modules`);
  if (report.discoveryTruncated === true) {
    // A capped list without its total IS an exhaustiveness claim — the cap
    // must never be silent (LAUNCH-READINESS-REVIEW §4.2).
    lines.push(
      '⚠ discovery stopped at the file cap — this map describes a TRUNCATED view of the repository, not the whole of it.',
    );
  }
  lines.push(
    `Health ${report.health.score} (${report.health.label}) · duplication ${report.contamination.score} · ` +
      `git history ${report.gitAvailable ? 'available' : 'NOT available (ownership/locality are n/a)'}`,
  );
  lines.push('');

  // Languages, by file count — tells the agent what it is dealing with.
  const byLang = new Map<string, number>();
  for (const f of srcFiles) {
    const ext = f.path.includes('.') ? f.path.slice(f.path.lastIndexOf('.') + 1) : 'other';
    byLang.set(ext, (byLang.get(ext) ?? 0) + 1);
  }
  const langs = [...byLang.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  lines.push(`Languages: ${langs.map(([e, n]) => `.${e} (${n})`).join(', ')}`);
  lines.push(`Tests: ${testFiles.length} test files${testFiles.length > 0 ? ` (e.g. ${testFiles[0]!.path})` : ''}`);
  lines.push('');

  // Modules, worst structural shape first — the same ordering the dashboard
  // uses, so a team and its agents look at the same priority list.
  lines.push('MODULES (worst structural shape first)');
  const mods = [...report.modules].sort((a, b) => (a.depth.score ?? 101) - (b.depth.score ?? 101));
  for (const m of mods.slice(0, MAX_MODULES)) {
    const topExports = topExportNames(files, m.name, 3);
    lines.push(
      `  ${m.name.padEnd(16)} ${String(m.codeLines).padStart(6)} LOC  ` +
        `depth ${fmt(m.depth.score)} seams ${fmt(m.seams.score)} leverage ${fmt(m.leverage.score)}` +
        (topExports.length > 0 ? `  · ${topExports.join(', ')}` : ''),
    );
  }
  if (mods.length > MAX_MODULES) lines.push(`  ... and ${mods.length - MAX_MODULES} more modules`);
  lines.push('');

  // Entry points: index files and conventional program entries.
  const entries = srcFiles
    .filter((f) => f.isIndex || /(^|\/)(main|index|app|program|server|cli)\.[a-z]+$/i.test(f.path))
    .map((f) => f.path)
    .sort();
  if (entries.length > 0) {
    lines.push('ENTRY POINTS');
    for (const e of entries.slice(0, MAX_ENTRY_POINTS)) lines.push(`  ${e}`);
    if (entries.length > MAX_ENTRY_POINTS) lines.push(`  ... and ${entries.length - MAX_ENTRY_POINTS} more`);
    lines.push('');
  }

  // The dependency shape: which modules depend on which, most-depended first.
  const fanIn = new Map<string, number>();
  for (const tos of moduleGraph.imports.values()) for (const to of tos) fanIn.set(to, (fanIn.get(to) ?? 0) + 1);
  const edges: string[] = [];
  for (const [from, tos] of [...moduleGraph.imports.entries()].sort()) {
    for (const to of [...tos].sort()) edges.push(`${from} -> ${to}`);
  }
  if (edges.length > 0) {
    lines.push('DEPENDENCIES');
    for (const e of edges.slice(0, MAX_EDGES)) lines.push(`  ${e}`);
    if (edges.length > MAX_EDGES) lines.push(`  ... and ${edges.length - MAX_EDGES} more edges`);
    if (moduleGraph.cycles.length > 0) {
      lines.push(`  CYCLES (${moduleGraph.cycles.length}): ${moduleGraph.cycles.slice(0, 3).map((c) => c.join(' <-> ')).join(' · ')}`);
    }
    lines.push('');
  }

  if (report.opportunities.length > 0) {
    lines.push('WHERE THE SCORE IS LOST');
    for (const o of report.opportunities.slice(0, 3)) lines.push(`  ${o}`);
    lines.push('');
  }

  if ((report.skippedFiles ?? []).length > 0) {
    lines.push(`NOTE: ${report.skippedFiles!.length} file(s) could not be parsed and are absent from every answer.`);
    lines.push('');
  }

  lines.push('Next: file_outline({ file }) · find_symbol({ query }) · read_function({ function })');
  return lines.join('\n');
}

function fmt(n: number | null): string {
  return n === null ? 'n/a' : String(n).padStart(2);
}

/** A module's most prominent exported names — the "what lives here" signal. */
function topExportNames(files: ParsedFile[], module: string, limit: number): string[] {
  const names: string[] = [];
  for (const f of files) {
    if (f.module !== module || f.isTest) continue;
    for (const e of f.exports) {
      if (e.kind === 'reexport' || e.name === '*' || e.name === '(default)') continue;
      names.push(e.name);
    }
  }
  return names.slice(0, limit);
}
