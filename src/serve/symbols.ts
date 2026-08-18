import type { ParsedFile, SymbolSpan } from '../types.js';

/**
 * SYMBOL INDEX — resolve a name (or a human phrase) to exact declarations,
 * and find every place a symbol is referenced. Ranking is deterministic
 * lexical scoring only — no corpus statistics and no embeddings, so the
 * same index and query always yield the same order. Richer ranking (BM25,
 * repository vocabulary) is a planned addition that slots in behind this
 * same interface rather than changing it.
 */

export interface SymbolHit {
  name: string;
  kind: string;
  file: string;
  module: string;
  startLine: number;
  endLine: number;
  exported: boolean;
  /** 0-1 lexical confidence, with the reason it scored that way. */
  score: number;
  why: 'exact' | 'case-insensitive' | 'all-tokens' | 'some-tokens' | 'substring';
}

export interface SymbolRecord {
  name: string;
  kind: string;
  file: string;
  module: string;
  startLine: number;
  endLine: number;
  exported: boolean;
}

/**
 * Every declaration in the repo: functions plus (where indexed) types.
 *
 * A constructor is recorded by the parsers under its CLASS name, so a class
 * with a constructor would otherwise appear twice under one `file#name`
 * address — making that address unaddressable ("ambiguous") and inflating
 * reference counts. The class declaration wins (it spans the constructor),
 * and the duplicate is dropped.
 */
export function symbolIndex(files: ParsedFile[]): SymbolRecord[] {
  const out: SymbolRecord[] = [];
  for (const f of files) {
    const typeSpans = f.symbols ?? [];
    for (const s of typeSpans) {
      out.push({
        name: s.name,
        kind: s.kind,
        file: f.path,
        module: f.module,
        startLine: s.startLine,
        endLine: s.endLine,
        exported: s.exported,
      });
    }
    for (const fn of f.functions) {
      const start = fn.declLine ?? fn.startLine;
      const shadowedByType = typeSpans.some(
        (s) => s.name === fn.name && s.startLine <= start && s.endLine >= fn.endLine,
      );
      if (shadowedByType) continue; // constructor inside its own class
      out.push({
        name: fn.name,
        kind: 'function',
        file: f.path,
        module: f.module,
        startLine: start,
        endLine: fn.endLine,
        exported: fn.exported,
      });
    }
  }
  return out;
}

/** Split identifiers into lowercase tokens: `createWSContext` -> create, ws, context. */
export function tokenize(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((t) => t.toLowerCase());
}

/**
 * Rank declarations against a query. A query may be a symbol name
 * (`authenticate`) or a phrase (`authentication middleware`); both resolve
 * through the same token scoring, so a caller never has to guess which
 * shape the tool wants.
 */
export function findSymbols(index: SymbolRecord[], query: string, limit = 8): SymbolHit[] {
  const q = query.trim();
  const qLower = q.toLowerCase();
  const qTokens = tokenize(q);
  const hits: SymbolHit[] = [];

  for (const r of index) {
    const nameLower = r.name.toLowerCase();
    let score = 0;
    let why: SymbolHit['why'] | null = null;

    if (r.name === q) {
      score = 1;
      why = 'exact';
    } else if (nameLower === qLower) {
      score = 0.95;
      why = 'case-insensitive';
    } else {
      const nameTokens = tokenize(r.name);
      const matched = qTokens.filter((t) => nameTokens.includes(t)).length;
      if (qTokens.length > 0 && matched === qTokens.length) {
        // every query token present: strong, ranked by how little extra the
        // symbol carries (a tight match beats a sprawling one)
        score = 0.9 - Math.min(0.2, (nameTokens.length - matched) * 0.05);
        why = 'all-tokens';
      } else if (matched > 0) {
        score = 0.4 + 0.3 * (matched / qTokens.length);
        why = 'some-tokens';
      } else if (nameLower.includes(qLower) && qLower.length >= 3) {
        score = 0.35;
        why = 'substring';
      }
    }
    if (why === null) continue;
    // Exported declarations are the ones a caller usually means — but the
    // nudge must never lift a fuzzy hit to or past an exact one, so it is
    // applied below the exact tier and the result is capped.
    if (r.exported && why !== 'exact') score = Math.min(0.94, score + 0.03);
    hits.push({ ...r, score: Math.round(score * 100) / 100, why });
  }

  hits.sort(
    (a, b) =>
      b.score - a.score ||
      a.name.length - b.name.length ||
      a.file.localeCompare(b.file) ||
      a.startLine - b.startLine,
  );
  return hits.slice(0, limit);
}

// ── references ─────────────────────────────────────────────────────────────

export interface ReferenceHit {
  file: string;
  /** null when the parser for this language does not record the location. */
  line: number | null;
  kind: 'call' | 'member-call' | 'import' | 'definition';
  /** The enclosing function, when the reference is a call. */
  inFunction?: string;
}

/**
 * Every place a name is referenced: definitions, call sites (with exact
 * lines, from the parsers' callSites), and import statements naming it.
 *
 * Deliberately lexical on the NAME. A same-named symbol elsewhere is a real
 * reference to that name — the response says what kind each hit is and lets
 * the agent judge, rather than silently filtering to one definition.
 */
export function findReferences(files: ParsedFile[], name: string): ReferenceHit[] {
  const out: ReferenceHit[] = [];
  const seen = new Set<string>();
  const add = (hit: ReferenceHit): void => {
    const key = `${hit.file}|${hit.line ?? 'x'}|${hit.kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(hit);
  };
  for (const f of files) {
    const typeSpans = f.symbols ?? [];
    for (const s of typeSpans) {
      if (s.name === name) add({ file: f.path, line: s.startLine, kind: 'definition' });
    }
    for (const fn of f.functions) {
      const start = fn.declLine ?? fn.startLine;
      // A constructor shares its class's name and span — one declaration,
      // not two references.
      const shadowed = typeSpans.some((s) => s.name === fn.name && s.startLine <= start && s.endLine >= fn.endLine);
      if (fn.name === name && !shadowed) add({ file: f.path, line: start, kind: 'definition' });
      for (const site of fn.callSites ?? []) {
        if (site.name !== name) continue;
        add({
          file: f.path,
          line: site.line,
          kind: site.member ? 'member-call' : 'call',
          inFunction: fn.name,
        });
      }
    }
    for (const imp of f.imports) {
      if (!imp.named.includes(name)) continue;
      // No fabricated line 1: a parser that does not record import lines
      // says so rather than pointing at a line that has nothing to do with it.
      add({ file: f.path, line: imp.line ?? null, kind: 'import' });
    }
  }
  out.sort((a, b) => a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0));
  return out;
}

/** Whether any parser in this repo recorded call-site lines (Tier-1 languages). */
export function hasCallSites(files: ParsedFile[]): boolean {
  return files.some((f) => f.functions.some((fn) => fn.callSites !== undefined));
}

export type { SymbolSpan };
