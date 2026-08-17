import type { ParsedFile } from '../types.js';

/**
 * FILE OUTLINE — what is in this file and on which lines, so an agent can
 * pick ONE span to read instead of opening the file. Target: 50-150 tokens
 * for a normal file.
 *
 * Honesty: the outline reports how much of the file it actually accounted
 * for. A parser that maps 40% of a file must not leave the impression that
 * the other 60% is empty.
 */

export interface OutlineRow {
  startLine: number;
  endLine: number;
  label: string;
  /** Members of a class/interface are indented under it, never dropped. */
  depth: number;
}

export interface FileOutline {
  file: string;
  module: string;
  totalLines: number;
  /** False when the parser does not record file length — coverage is unknown. */
  totalLinesKnown: boolean;
  rows: OutlineRow[];
  /** Percentage of lines covered by the rows above. */
  coveragePct: number;
  /** True when the parser records declarations other than functions. */
  symbolsIndexed: boolean;
}

export function buildOutline(file: ParsedFile): FileOutline {
  const rows: OutlineRow[] = [];

  // Contiguous runs of import lines, so a second import block further down
  // the file is its own row instead of one span swallowing everything between.
  const importLines = file.imports
    .map((i) => i.line)
    .filter((l): l is number => typeof l === 'number')
    .sort((a, b) => a - b);
  let run: number[] = [];
  const flushImports = (): void => {
    if (run.length === 0) return;
    rows.push({
      startLine: run[0]!,
      endLine: run[run.length - 1]!,
      label: `imports (${run.length})`,
      depth: 0,
    });
    run = [];
  };
  for (const l of importLines) {
    if (run.length > 0 && l > run[run.length - 1]! + 2) flushImports();
    run.push(l);
  }
  flushImports();

  // Declarations that are not functions (classes/interfaces/types/enums).
  const symbols = file.symbols ?? [];
  const containers = symbols.filter((s) => s.kind === 'class' || s.kind === 'interface');
  for (const s of symbols) {
    rows.push({
      startLine: s.startLine,
      endLine: s.endLine,
      label: `${s.kind} ${s.name}${s.exported ? '' : ' (internal)'}`,
      depth: 0,
    });
  }

  // Class members are INDENTED under their container, never dropped: a
  // 500-line class outlining to one row tells a reader nothing.
  for (const fn of file.functions) {
    const start = fn.declLine ?? fn.startLine;
    const inside = containers.find((s) => s.startLine <= start && s.endLine >= fn.endLine);
    rows.push({
      startLine: start,
      endLine: fn.endLine,
      label: `${fn.name}()${fn.exported ? '' : ' (internal)'}`,
      depth: inside === undefined ? 0 : 1,
    });
  }

  rows.sort((a, b) => a.startLine - b.startLine || a.depth - b.depth || a.endLine - b.endLine);

  // Coverage is computed from TOP-LEVEL rows only (members are inside their
  // container's span) and reported only when the true line count is known.
  const knownTotal = file.totalLines;
  let covered = 0;
  let cursor = 0;
  for (const r of rows) {
    if (r.depth > 0) continue;
    const from = Math.max(r.startLine, cursor + 1);
    if (r.endLine >= from) {
      covered += r.endLine - from + 1;
      cursor = r.endLine;
    }
  }

  return {
    file: file.path,
    module: file.module,
    totalLines: knownTotal ?? 0,
    totalLinesKnown: knownTotal !== undefined,
    rows,
    coveragePct: knownTotal !== undefined && knownTotal > 0 ? Math.round((covered / knownTotal) * 100) : 0,
    symbolsIndexed: file.symbols !== undefined,
  };
}

export function renderOutline(o: FileOutline): string {
  const head = o.totalLinesKnown ? `${o.totalLines} lines` : 'length not indexed';
  const lines: string[] = [`${o.file} — ${head}, module '${o.module}'`, ''];
  const width = String(o.totalLines || 999).length * 2 + 1;
  for (const r of o.rows) {
    const range = r.startLine === r.endLine ? `${r.startLine}` : `${r.startLine}-${r.endLine}`;
    lines.push(`  ${range.padEnd(width)}  ${'  '.repeat(r.depth)}${r.label}`);
  }
  if (o.rows.length === 0) lines.push('  (no declarations indexed in this file)');
  lines.push('');
  if (o.totalLinesKnown) {
    lines.push(
      o.symbolsIndexed
        ? `${o.coveragePct}% of lines mapped to a declaration.`
        : `${o.coveragePct}% of lines mapped. Types/classes are not indexed for this language yet — only functions are listed.`,
    );
  } else {
    lines.push(
      'Coverage unknown: this language records declarations but not file length, so lines outside the ranges above are unaccounted for.',
    );
  }
  lines.push(`Read one with: read_function({ function: "<name>" }) or read_span({ file, startLine, endLine }).`);
  return lines.join('\n');
}
