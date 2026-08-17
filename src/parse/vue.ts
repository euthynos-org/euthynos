import { readFileSync } from 'node:fs';
import ts from 'typescript';
import type { DiscoveredFile } from '../discover.js';
import type { ParsedFile, SymbolSpan } from '../types.js';
import { parseTsSource } from './ts.js';
import { totalLinesOf } from './treesitter/util.js';

/**
 * Vue Single-File Component parser → the parser-agnostic `ParsedFile` shape.
 *
 * A `.vue` file is `<template>` + `<script>` + `<style>` blocks. All the real
 * logic — functions, imports, exported API — lives in the `<script>` (or
 * `<script setup>`) block, which is plain JS/TS. So rather than lean on the
 * shallow `tree-sitter-vue` grammar (which doesn't deeply parse the script), we
 * extract the script block(s) and feed them straight into the TypeScript
 * compiler API via `parseTsSource` — full-fidelity export/param/call semantics,
 * the same engine that backs our `.ts`/`.js` parsing.
 *
 * Line fidelity: each script block is left-padded with blank lines equal to its
 * offset in the SFC, so reported start/end lines map back to the `.vue` file.
 * An SFC may carry both a classic `<script>` and a `<script setup>`; we parse
 * every block and merge. `lang="ts"` / `lang="tsx"` picks the script kind.
 */
export function parseVueFile(f: DiscoveredFile): ParsedFile {
  return parseVueSource(f.rel, f.module, f.isTest, readFileSync(f.abs, 'utf8'));
}

/** `<script ...>` ... `</script>` — attrs in group 1, body in group 2. */
const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;

export function parseVueSource(
  path: string,
  module: string,
  isTest: boolean,
  text: string,
): ParsedFile {
  const blocks = [...text.matchAll(SCRIPT_RE)];

  const merged: ParsedFile = {
    path,
    module,
    isTest,
    isIndex: false, // an SFC is never a module-interface index file
    codeLines: 0,
    exports: [],
    internalFunctions: 0,
    functions: [],
    imports: [],
    symbols: [],
    // The whole SFC, not just the script block — a reader asking how much of
    // this file the outline covers means the file they opened.
    totalLines: totalLinesOf(text),
  };

  for (const m of blocks) {
    const attrs = m[1] ?? '';
    const content = m[2] ?? '';
    if (!content.trim()) continue;

    // Offset = number of newlines before the script content starts in the SFC,
    // so padding with that many blank lines keeps line numbers aligned.
    const contentStart = (m.index ?? 0) + m[0].indexOf(content);
    const offsetLines = countNewlines(text, contentStart);
    const padded = '\n'.repeat(offsetLines) + content;

    const sub = parseTsSource(path, module, isTest, padded, {
      scriptKind: scriptKindOf(attrs),
      isIndex: false,
    });

    merged.exports.push(...sub.exports);
    merged.functions.push(...sub.functions);
    merged.imports.push(...sub.imports);
    (merged.symbols as SymbolSpan[]).push(...(sub.symbols ?? []));
    merged.internalFunctions += sub.internalFunctions;
    merged.codeLines += sub.codeLines;
  }

  return merged;
}

/** Map a `<script>` tag's attribute string to a TS ScriptKind. Default JS. */
function scriptKindOf(attrs: string): ts.ScriptKind {
  const lang = /\blang\s*=\s*["']?(tsx|ts|jsx|js)\b/i.exec(attrs)?.[1]?.toLowerCase();
  switch (lang) {
    case 'ts': return ts.ScriptKind.TS;
    case 'tsx': return ts.ScriptKind.TSX;
    case 'jsx': return ts.ScriptKind.JSX;
    default: return ts.ScriptKind.JS;
  }
}

/** Count newline characters in `text` before byte offset `end`. */
function countNewlines(text: string, end: number): number {
  let n = 0;
  for (let i = 0; i < end && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) n++;
  }
  return n;
}
