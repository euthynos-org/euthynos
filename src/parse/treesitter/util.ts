import type { Node } from 'web-tree-sitter';
import type { CallSite, SymbolSpan } from '../../types.js';

/**
 * Shared tree-sitter extraction helpers used by every language parser.
 * Keeps per-language parsers thin and consistent — each supplies only its
 * language-specific node types and visibility/import rules.
 */

/** 1-based line of a node's first character — every location we ever report. */
export const lineOf = (n: Node): number => n.startPosition.row + 1;

/** 1-based line of a node's last character. */
export const endLineOf = (n: Node): number => n.endPosition.row + 1;

/**
 * Physical line count. `file_outline` reports how much of a file its symbols
 * actually cover, so it needs the true total — not the code-line count, which
 * excludes blanks and comments and would overstate coverage.
 */
export const totalLinesOf = (text: string): number => text.split('\n').length;

/** Non-null named children (web-tree-sitter types children as possibly-null). */
export const nkids = (n: Node): Node[] => n.namedChildren.filter((c): c is Node => c != null);

/** Non-null children including anonymous nodes (operators, keywords, punctuation). */
export const ckids = (n: Node): Node[] => n.children.filter((c): c is Node => c != null);

/** Field text or a stable placeholder. */
export const fieldText = (n: Node, field: string): string => n.childForFieldName(field)?.text ?? '(anon)';

export interface HashTypes {
  /** Node types treated as identifiers → collapsed to 'ID' (rename-insensitive clones). */
  idTypes: ReadonlySet<string>;
  /** Node types treated as literals → collapsed to 'LIT'. */
  litTypes: ReadonlySet<string>;
}

/**
 * FNV-1a over the normalized token stream of a function body. Identifiers and
 * literals collapse to 'ID'/'LIT' so renamed copies collide; all other leaf
 * tokens (keywords, operators, punctuation) hash by their node type. Same
 * algorithm across languages — but the idTypes/litTypes differ, so clones are
 * detected within a language, never spuriously across languages.
 */
/**
 * FNV-1a over the body's LITERAL leaf texts, in source order. Companion to
 * `bodyHash`, which erases literals so renamed copies collide — necessary for
 * clone detection, fatal for tiny bodies where the literal carries the whole
 * meaning. See FunctionRecord.literalHash.
 */
export function literalHashOf(body: Node, t: HashTypes): number {
  let h = 0x811c9dc5;
  const mix = (s: string): void => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    h ^= 31;
    h = Math.imul(h, 0x01000193) >>> 0;
  };
  const visit = (n: Node): void => {
    if (t.litTypes.has(n.type)) mix(n.text);
    for (const c of ckids(n)) visit(c);
  };
  visit(body);
  return h >>> 0;
}

export interface BodyHashResult {
  /** Rename-insensitive structural hash (identifiers/literals collapsed). */
  hash: number;
  tokens: number;
  /**
   * Rename-SENSITIVE definition hash: the same token walk as `hash`, but
   * identifier and literal LEAVES contribute their TEXT, not a collapsed
   * placeholder. So it changes when a body's identifiers, property names, or
   * literals change — the signal `check_my_changes` needs to report an edited
   * BODY, not just an added/removed name. Comments collapse to their node type
   * and whitespace is not a token, so a comment- or whitespace-only edit leaves
   * it unchanged (matching bodyHash's posture). Undefined only when there is no
   * body.
   */
  defHash?: number;
  /**
   * FNV-1a over literal VALUES in source order. `hash` deliberately erases
   * literals so renamed copies collide — but in a tiny body the literal IS
   * the semantics (A1's getConnInfo false positive), and in a diverged copy
   * the literal is often the ONLY thing that drifted (hono's
   * isContentTypeBinary regexes). Undefined only when there is no body.
   */
  literals?: number;
  /**
   * Bottom-K sketch of hashed 4-grams over the SAME normalized stream as
   * `hash` — the near-clone tier's structural-similarity signal. Jaccard on
   * two sketches approximates token-stream similarity; when a body has <= K
   * distinct 4-grams the sketch is the full set and the estimate is exact.
   * Undefined for bodies too small to sketch meaningfully.
   */
  sketch?: number[];
}

/** 4-gram window size and sketch capacity for near-clone similarity. */
const NGRAM = 4;
const SKETCH_K = 24;
/** Bodies below this many normalized tokens carry no sketch (too little signal). */
export const SKETCH_MIN_TOKENS = 12;

export const EMPTY_BODY: BodyHashResult = { hash: 0, tokens: 0 };

export function bodyHash(body: Node, t: HashTypes): BodyHashResult {
  let h = 0x811c9dc5;
  let lit = 0x811c9dc5;
  let def = 0x811c9dc5;
  let count = 0;
  const window: string[] = [];
  const grams = new Set<number>();
  const fnv = (seed: number, s: string): number => {
    let x = seed;
    for (let i = 0; i < s.length; i++) {
      x ^= s.charCodeAt(i);
      x = Math.imul(x, 0x01000193) >>> 0;
    }
    x ^= 31;
    return Math.imul(x, 0x01000193) >>> 0;
  };
  const mix = (s: string): void => {
    count++;
    h = fnv(h, s);
    window.push(s);
    if (window.length > NGRAM) window.shift();
    if (window.length === NGRAM) grams.add(fnv(0x811c9dc5, window.join('|')));
  };
  const visit = (n: Node): void => {
    if (t.idTypes.has(n.type)) {
      mix('ID');
      def = fnv(def, n.text); // rename-sensitive: identifier text
    } else if (t.litTypes.has(n.type)) {
      mix('LIT');
      lit = fnv(lit, n.text);
      def = fnv(def, n.text); // rename-sensitive: literal text
    } else if (n.childCount === 0) {
      mix(n.type);
      def = fnv(def, n.type); // structural leaf (comment nodes collapse here)
    }
    for (const c of ckids(n)) visit(c);
  };
  visit(body);
  const out: BodyHashResult = { hash: h >>> 0, tokens: count, literals: lit >>> 0, defHash: def >>> 0 };
  if (count >= SKETCH_MIN_TOKENS && grams.size > 0) {
    out.sketch = [...grams].sort((a, b) => a - b).slice(0, SKETCH_K);
  }
  return out;
}

/** Count non-blank, non-comment lines. `lineComment` is the single-line comment prefix. */
export function countCodeLines(text: string, lineComment: string): number {
  let n = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith(lineComment)) continue;
    n++;
  }
  return n;
}

/** Depth-first walk over named descendants, invoking `fn` on each node. */
export function walkNamed(node: Node, fn: (n: Node) => void): void {
  fn(node);
  for (const c of nkids(node)) walkNamed(c, fn);
}

/**
 * Last segment of a delimited path or qualified name — the separator differs by
 * language (`/` for Go/Ruby/PHP, `.` for Python/Java/C#/Kotlin, `::` for Rust).
 *   lastSegment('foo/bar', '/')    -> 'bar'
 *   lastSegment('a.b.c', '.')      -> 'c'
 *   lastSegment('std::io::Read', '::') -> 'Read'
 */
export function lastSegment(s: string, sep: string): string {
  const parts = s.split(sep);
  return parts[parts.length - 1] ?? s;
}

/**
 * Strip surrounding string-quote delimiters: single, double, or backtick,
 * including repeated quotes (Python's `'''`) and Python string prefixes
 * (`r"..."`, `b'...'`, `f"..."`). A superset of every language parser's quote
 * rule — import specifiers always open with a quote, so the prefix class only
 * matches Python's letter prefixes and never eats real path content.
 * (C/C++ `#include` delimiters `<...>` are stripped locally in those parsers,
 * since `<>` are not string quotes.)
 */
export function stripQuotes(s: string): string {
  return s.replace(/^[rbuf]*['"`]+|['"`]+$/gi, '');
}

/**
 * Basename of a slash path with its final extension removed.
 *   basenameNoExt('a/b/util.h') -> 'util'
 *   basenameNoExt('engine')     -> 'engine'
 */
export function basenameNoExt(path: string): string {
  const last = path.split('/').pop() ?? path;
  const dot = last.lastIndexOf('.');
  return dot > 0 ? last.slice(0, dot) : last;
}

// ── declaration spans ──

export interface SpanSpec {
  /**
   * Declaration node type → the SymbolSpan kind it represents. A function is
   * allowed where one node type covers several kinds (Go's `type_spec` is a
   * struct, an interface, or an alias depending on its child).
   */
  kinds: Readonly<Record<string, SymbolSpan['kind'] | ((n: Node) => SymbolSpan['kind'])>>;
  /** Name extractor. Default: the `name` field's text. */
  name?: (n: Node) => string | undefined;
  /** Visibility rule for this language. */
  exported: (name: string, n: Node) => boolean;
}

/**
 * Every type-ish declaration in a file, with its exact span.
 *
 * Walks the WHOLE tree rather than only top-level statements, so nested and
 * namespaced declarations (Java inner classes, PHP classes inside a namespace
 * block, Rust items in a `mod`) are found too — an outline that silently
 * omitted them would be the "quiet cap" this codebase forbids.
 *
 * A declaration whose name cannot be read is skipped rather than emitted as
 * `(anon)`: a symbol nobody can address is noise in an outline and a false
 * hit in symbol search.
 */
export function collectSymbolSpans(root: Node, spec: SpanSpec): SymbolSpan[] {
  const out: SymbolSpan[] = [];
  const readName = spec.name ?? ((n: Node): string | undefined => n.childForFieldName('name')?.text);
  walkNamed(root, (n) => {
    const entry = spec.kinds[n.type];
    if (entry === undefined) return;
    const name = readName(n);
    if (!name) return;
    const kind = typeof entry === 'function' ? entry(n) : entry;
    out.push({ name, kind, startLine: lineOf(n), endLine: endLineOf(n), exported: spec.exported(name, n) });
  });
  return out;
}

// ── call sites ──

/**
 * Split raw call sites into the three shapes a FunctionRecord carries.
 *
 * `calls` stays the deduped name set every existing metric reads. `memberCalls`
 * marks the names written through a receiver (`x.every()`), which resolution
 * refuses to wire by name alone — a member name is very often a built-in that
 * happens to match a repo function. `callSites` keeps every occurrence with its
 * line, which is what `find_references` reports.
 *
 * Mirrors the TypeScript parser exactly (a name written both ways stays in
 * `memberCalls`), so a call edge means the same thing in all 16 languages.
 */
export function deriveCalls(sites: readonly CallSite[]): {
  calls: string[];
  memberCalls: string[];
  callSites: CallSite[];
} {
  const bare = new Set<string>();
  const member = new Set<string>();
  for (const s of sites) (s.member ? member : bare).add(s.name);
  return {
    calls: [...new Set([...bare, ...member])],
    memberCalls: [...member],
    callSites: [...sites],
  };
}
