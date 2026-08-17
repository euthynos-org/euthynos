import { readFileSync } from 'node:fs';
import type { DiscoveredFile } from '../discover.js';
import type { CallSite, ExportedSymbol, FunctionRecord, ImportRecord, ParsedFile } from '../types.js';

/**
 * COBOL parser → the parser-agnostic `ParsedFile` shape.
 *
 * COBOL has no tree-sitter grammar in our WASM set. It's line-oriented and
 * column-sensitive, so
 * we parse it deterministically by line — no AST, no native deps — and still
 * emit the SAME shape every other language does, so all six metrics + the
 * knowledge graph light up for COBOL too (which a plain regex extractor can't do).
 *
 * Mapping to our model:
 *   PROGRAM-ID            → the file's exported public surface (kind:'function'),
 *                           its params = the PROCEDURE DIVISION USING list, and a
 *                           FunctionRecord so cross-program `CALL` edges resolve.
 *   PARAGRAPH / SECTION   → internal FunctionRecord units (the behavior blocks).
 *   PERFORM <para>        → a call edge (intra-program).
 *   CALL '<prog>'         → a call edge (cross-program; resolves to that PROGRAM-ID).
 *   COPY <copybook>       → an import (like C's #include).
 *
 * Fixed-format (cols 1-6 sequence, col 7 indicator, 8-72 code) and free-format
 * are both handled leniently: a line is a comment if col 7 is `*`/`/` or the
 * trimmed line starts with `*`.
 */
export function parseCobolFile(f: DiscoveredFile): ParsedFile {
  return parseCobolSource(f.rel, f.module, f.isTest, readFileSync(f.abs, 'utf8'));
}

interface CodeLine {
  /** 1-based physical line number. */
  no: number;
  /** Significant code (sequence area stripped, uppercased for keywording). */
  code: string;
  /** Original-case code (for capturing identifier names as written). */
  raw: string;
}

export function parseCobolSource(
  path: string,
  module: string,
  isTest: boolean,
  text: string,
): ParsedFile {
  const lines = codeLines(text);
  const joined = lines.map((l) => l.code).join('\n');

  const programId = matchProgramId(joined);
  const usingParams = matchUsingParams(joined);
  const imports = matchCopybooks(lines, path);

  // Behaviour units live in (and after) the PROCEDURE DIVISION.
  const procStart = lines.findIndex((l) => /\bPROCEDURE\s+DIVISION\b/.test(l.code));
  const paragraphs = procStart >= 0 ? extractParagraphs(lines, procStart, path) : [];

  const exports: ExportedSymbol[] = [];
  const functions: FunctionRecord[] = [...paragraphs];

  if (programId) {
    exports.push({
      name: programId,
      kind: 'function',
      requiredParams: usingParams.length,
      totalParams: usingParams.length,
    });
    // A FunctionRecord for the program itself, so another program's
    // `CALL 'THISPROG'` resolves to a real call target. Its body spans the
    // procedure division; its calls are the union of every paragraph's calls
    // (the program's externally-visible behaviour surface).
    const procLines = procStart >= 0 ? lines.slice(procStart + 1) : [];
    const programSites = paragraphs.flatMap((p) => p.callSites ?? []);
    const { hash, tokens } = hashTokens(procLines.map((l) => l.code));
    functions.push({
      name: programId,
      file: path,
      startLine: procStart >= 0 ? lines[procStart]!.no : (lines[0]?.no ?? 1),
      endLine: lines[lines.length - 1]?.no ?? 1,
      exported: true,
      paramCount: usingParams.length,
      paramNames: usingParams,
      bodyHash: hash,
      bodyTokens: tokens,
      ...deriveCalls(programSites),
    });
  }

  return {
    path,
    module,
    isTest,
    isIndex: false,
    codeLines: lines.length,
    exports,
    internalFunctions: paragraphs.length,
    functions,
    imports,
    // COBOL has no class/type declarations in our model, so `symbols` stays
    // ABSENT rather than empty — the outline then reports that types are not
    // indexed for this language instead of implying the file has none.
    totalLines: text.split('\n').length,
  };
}

// ── line model ──

/** Physical lines reduced to significant code lines (comments/blanks dropped). */
function codeLines(text: string): CodeLine[] {
  const out: CodeLine[] = [];
  const physical = text.split('\n');
  for (let i = 0; i < physical.length; i++) {
    const line = physical[i]!.replace(/\r$/, '');
    if (isComment(line) || !line.trim()) continue;
    const raw = significant(line);
    if (!raw.trim()) continue;
    out.push({ no: i + 1, code: raw.toUpperCase(), raw });
  }
  return out;
}

/** Fixed-format comment (col 7 = `*`/`/`) or free-format `*`-leading line. */
function isComment(line: string): boolean {
  if (line.length >= 7 && (line[6] === '*' || line[6] === '/')) return true;
  const t = line.trimStart();
  return t.startsWith('*');
}

/**
 * Strip the fixed-format sequence area (cols 1-6) and identification area
 * (73+) when the line looks fixed-format; otherwise return the line as-is.
 * Heuristic: only strip cols 1-6 when they're blank or numeric (a real
 * sequence number), so free-format code starting in col 1 is left intact.
 */
function significant(line: string): string {
  if (line.length > 7 && /^[\d ]{6}/.test(line)) {
    const end = line.length > 72 ? 72 : line.length;
    return line.slice(7, end);
  }
  return line;
}

// ── program header ──

function matchProgramId(joined: string): string | null {
  const m = /\bPROGRAM-ID\s*\.\s*([A-Za-z0-9][A-Za-z0-9-]*)/i.exec(joined);
  return m ? m[1]!.toUpperCase() : null;
}

/** Names in `PROCEDURE DIVISION USING a b c.` — the program's call interface. */
function matchUsingParams(joined: string): string[] {
  const m = /\bPROCEDURE\s+DIVISION\b([^.]*)\./i.exec(joined);
  if (!m) return [];
  const usingMatch = /\bUSING\b([\s\S]*)$/i.exec(m[1] ?? '');
  if (!usingMatch) return [];
  return (usingMatch[1] ?? '')
    .split(/[\s,]+/)
    .map((s) => s.replace(/^BY\s+(REFERENCE|CONTENT|VALUE)$/i, '').trim())
    .filter((s) => s && !/^(BY|REFERENCE|CONTENT|VALUE)$/i.test(s));
}

// ── imports (COPY) ──

function matchCopybooks(lines: CodeLine[], fromFile: string): ImportRecord[] {
  const out: ImportRecord[] = [];
  const seen = new Set<string>();
  for (const l of lines) {
    const m = /\bCOPY\s+["']?([A-Za-z0-9][A-Za-z0-9-]*)["']?/i.exec(l.code);
    if (!m) continue;
    const name = m[1]!.toUpperCase();
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ fromFile, line: l.no, specifier: name, named: [name], isTypeOnly: false });
  }
  return out;
}

// ── paragraphs / sections ──

/**
 * A paragraph header is a lone name (optionally `name SECTION`) followed by a
 * period in Area A. In the PROCEDURE DIVISION there are no data items, so a line
 * that is just `identifier.` (or `identifier SECTION.`) is a behaviour unit
 * header. Each unit owns the lines up to the next header.
 */
function extractParagraphs(lines: CodeLine[], procStart: number, file: string): FunctionRecord[] {
  const headers: { name: string; idx: number }[] = [];
  for (let i = procStart + 1; i < lines.length; i++) {
    const name = paragraphHeader(lines[i]!.code);
    if (name) headers.push({ name, idx: i });
  }

  const records: FunctionRecord[] = [];
  for (let h = 0; h < headers.length; h++) {
    const { name, idx } = headers[h]!;
    const endIdx = h + 1 < headers.length ? headers[h + 1]!.idx : lines.length;
    const bodyLines = lines.slice(idx + 1, endIdx);
    const { hash, tokens } = hashTokens(bodyLines.map((l) => l.code));
    records.push({
      name,
      file,
      startLine: lines[idx]!.no,
      endLine: lines[Math.max(idx, endIdx - 1)]!.no,
      exported: false,
      paramCount: 0,
      paramNames: [],
      bodyHash: hash,
      bodyTokens: tokens,
      ...deriveCalls(collectCallSites(bodyLines)),
    });
  }
  return records;
}

/** Return the paragraph/section name if this line is a unit header, else null. */
function paragraphHeader(code: string): string | null {
  const section = /^([A-Za-z0-9][A-Za-z0-9-]*)\s+SECTION\s*\.\s*$/.exec(code);
  if (section) return section[1]!.toUpperCase();
  const para = /^([A-Za-z0-9][A-Za-z0-9-]*)\s*\.\s*$/.exec(code);
  if (!para) return null;
  const name = para[1]!.toUpperCase();
  // A bare division/keyword line is not a paragraph.
  if (/^(PROCEDURE|DATA|ENVIRONMENT|IDENTIFICATION|WORKING-STORAGE|LINKAGE|FILE)$/.test(name)) {
    return null;
  }
  return name;
}

/**
 * PERFORM/CALL/GO TO targets in a unit's body — the call-graph edges, each with
 * the physical line it was written on.
 *
 * Matched PER LINE rather than over the joined body: a COBOL statement is
 * line-scoped here, and a joined-buffer match index would have to be mapped
 * back to a line, which is exactly the kind of arithmetic that produces
 * confidently-wrong line numbers. `find_references` reports these, so a wrong
 * line is worse than no line.
 *
 * A target is never a member call — COBOL names its callee directly.
 */
function collectCallSites(bodyLines: CodeLine[]): CallSite[] {
  const sites: CallSite[] = [];
  const seen = new Set<string>();
  const add = (name: string, line: number): void => {
    // One site per (target, line): `PERFORM A THRU B` on one line is two
    // distinct targets, but the same target twice on a line is one reference.
    const key = `${name}@${line}`;
    if (seen.has(key)) return;
    seen.add(key);
    sites.push({ name, line, member: false });
  };

  for (const l of bodyLines) {
    // PERFORM para  /  PERFORM para THRU para2
    const perform = /\bPERFORM\s+([A-Za-z0-9][A-Za-z0-9-]*)(?:\s+(?:THRU|THROUGH)\s+([A-Za-z0-9][A-Za-z0-9-]*))?/gi;
    for (let m = perform.exec(l.code); m; m = perform.exec(l.code)) {
      const target = m[1]!.toUpperCase();
      // Skip `PERFORM n TIMES` / `PERFORM UNTIL ...` (loop forms, not paragraph refs).
      if (/^\d+$/.test(target) || target === 'UNTIL' || target === 'VARYING' || target === 'WITH') continue;
      add(target, l.no);
      if (m[2]) add(m[2].toUpperCase(), l.no);
    }
    // CALL 'PROG'  /  CALL "PROG"  /  CALL identifier
    const call = /\bCALL\s+["']?([A-Za-z0-9][A-Za-z0-9-]*)["']?/gi;
    for (let m = call.exec(l.code); m; m = call.exec(l.code)) {
      add(m[1]!.toUpperCase(), l.no);
    }
    // GO TO para
    const goto = /\bGO\s+TO\s+([A-Za-z0-9][A-Za-z0-9-]*)/gi;
    for (let m = goto.exec(l.code); m; m = goto.exec(l.code)) {
      add(m[1]!.toUpperCase(), l.no);
    }
  }
  return sites;
}

/**
 * COBOL call targets are always named directly, so no site is ever a member
 * call. Shaped here so every language hands the graph the same three fields.
 */
function deriveCalls(sites: CallSite[]): { calls: string[]; memberCalls: string[]; callSites: CallSite[] } {
  return { calls: [...new Set(sites.map((s) => s.name))], memberCalls: [], callSites: sites };
}

// ── normalized clone hash ──

/** COBOL verbs kept verbatim in the hash; everything else collapses to ID/LIT. */
const RESERVED = new Set([
  'ACCEPT', 'ADD', 'CALL', 'CANCEL', 'CLOSE', 'COMPUTE', 'CONTINUE', 'DELETE',
  'DISPLAY', 'DIVIDE', 'ELSE', 'END', 'END-IF', 'END-PERFORM', 'END-READ',
  'END-EVALUATE', 'END-CALL', 'END-ADD', 'END-COMPUTE', 'EVALUATE', 'EXIT',
  'GO', 'GOBACK', 'IF', 'INITIALIZE', 'INSPECT', 'MERGE', 'MOVE', 'MULTIPLY',
  'OPEN', 'PERFORM', 'READ', 'RELEASE', 'RETURN', 'REWRITE', 'SEARCH', 'SET',
  'SORT', 'START', 'STOP', 'STRING', 'SUBTRACT', 'UNSTRING', 'WRITE', 'WHEN',
  'TO', 'FROM', 'BY', 'GIVING', 'USING', 'INTO', 'VARYING', 'UNTIL', 'THRU',
  'THROUGH', 'TIMES', 'AND', 'OR', 'NOT', 'EQUAL', 'GREATER', 'LESS', 'THAN',
  'OF', 'IN', 'RUN', 'THEN', 'NEXT', 'SENTENCE', 'WITH', 'TEST', 'BEFORE', 'AFTER',
]);

/**
 * FNV-1a over a normalized token stream: COBOL verbs survive, data-names →
 * 'ID', literals → 'LIT'. Same spirit as the AST bodyHash in util.ts, so a
 * copy-pasted paragraph with renamed variables still collides (contamination).
 */
function hashTokens(codeLines: string[]): { hash: number; tokens: number } {
  let h = 0x811c9dc5;
  let count = 0;
  const mix = (s: string): void => {
    count++;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    h ^= 31;
    h = Math.imul(h, 0x01000193) >>> 0;
  };
  for (const line of codeLines) {
    // Tokenize on whitespace and COBOL punctuation, keeping quoted literals.
    const tokens = line.match(/'[^']*'|"[^"]*"|[A-Za-z0-9][A-Za-z0-9-]*|[().,;]/g) ?? [];
    for (const tok of tokens) {
      if (tok.startsWith("'") || tok.startsWith('"')) mix('LIT');
      else if (/^[0-9]/.test(tok)) mix('LIT');
      else if (RESERVED.has(tok)) mix(tok);
      else if (/^[().,;]$/.test(tok)) mix(tok);
      else mix('ID');
    }
  }
  return { hash: h >>> 0, tokens: count };
}
