import { MAX_COMMENT_TOKENS_PER_FILE } from './weights.js';
import { acronymOf, splitIdentifier, STOPWORDS } from './tokenize.js';

/**
 * COMMENT VOCABULARY — the words developers used to describe their own code.
 *
 * "Where is JWT authentication implemented?" often matches a comment before it
 * matches an identifier, because the identifier is `verifyBearer` and the
 * comment is the only place the phrase "JWT authentication" appears.
 *
 * Two deliberate constraints:
 *
 *  1. Extracted at PARSE time and stored on ParsedFile, so it persists in the
 *     index and costs nothing on a warm sweep. Harvesting comments by re-reading
 *     files per query would put file I/O back on the query path and give back
 *     the speedup that serving queries from a warm index exists to provide.
 *  2. Used ONLY for lexical ranking. A comment never creates a symbol, never
 *     resolves a target on its own, and never produces a line number. So the
 *     scanner below is allowed to be approximate — a `#` inside a C string
 *     misread as a comment costs a slightly worse ranking, never a wrong
 *     answer. Anything load-bearing comes from the AST.
 */

interface CommentSyntax {
  /** Line-comment markers, e.g. `//`, `#`, `--`. */
  line: readonly string[];
  /** Block-comment delimiter pairs, e.g. `/*` ... `*​/`. */
  block: readonly (readonly [string, string])[];
}

/**
 * Two to five consecutive Capitalized or ALL-CAPS words — a proper-noun phrase
 * ("JSON Web Token", "Cross Site Request Forgery"). Sentence-initial words are
 * capitalized too, so this over-matches slightly; harmless, because the result
 * only ever adds a lexical ranking term.
 */
const PROPER_PHRASE = /\b(?:[A-Z][a-zA-Z]+|[A-Z]{2,})(?:\s+(?:[A-Z][a-zA-Z]+|[A-Z]{2,})){1,4}\b/g;

const SLASH: CommentSyntax = { line: ['//'], block: [['/*', '*/']] };
const HASH: CommentSyntax = { line: ['#'], block: [['"""', '"""'], ["'''", "'''"]] };

/**
 * Comment syntax by our internal language tag. A language absent from this
 * table simply contributes no comment vocabulary — its symbols still index.
 */
const BY_LANG: Readonly<Record<string, CommentSyntax>> = {
  ts: SLASH, js: SLASH, vue: SLASH, go: SLASH, java: SLASH, cs: SLASH,
  c: SLASH, cpp: SLASH, rs: SLASH, kt: SLASH, swift: SLASH, dart: SLASH,
  php: { line: ['//', '#'], block: [['/*', '*/']] },
  py: HASH,
  rb: { line: ['#'], block: [['=begin', '=end']] },
  // COBOL comments are column-positional, handled by its own parser; the
  // generic scanner would misread ordinary code, so it opts out.
};

/**
 * Distinct, meaningful comment tokens for a file, capped.
 *
 * Returns undefined when the language has no entry — an ABSENT field means
 * "not indexed for this language", which downstream reports honestly, whereas
 * an empty array would claim the file has no comments.
 */
export function commentTokens(lang: string, text: string): string[] | undefined {
  const syntax = BY_LANG[lang];
  if (syntax === undefined) return undefined;

  const out: string[] = [];
  const seen = new Set<string>();
  const emit = (tok: string): void => {
    if (out.length >= MAX_COMMENT_TOKENS_PER_FILE || seen.has(tok)) return;
    seen.add(tok);
    out.push(tok);
  };
  const push = (raw: string): void => {
    // The acronym a reader would use for a proper-noun phrase. This is what
    // bridges query wording to code wording: a comment saying "JSON Web Token"
    // is why a query for "JWT" can find code whose identifiers never contain
    // those three letters. It is evidence from THIS repository's prose, not a
    // general abbreviation dictionary — we never invent an expansion nobody
    // here wrote.
    for (const phrase of raw.matchAll(PROPER_PHRASE)) {
      const acr = acronymOf(splitIdentifier(phrase[0]));
      if (acr !== null && acr.length >= 2) emit(acr);
    }
    for (const tok of splitIdentifier(raw)) {
      // Pure digits are line numbers, years and magic values — never a concept.
      if (tok.length < 3 || STOPWORDS.has(tok) || /^\d+$/.test(tok)) continue;
      emit(tok);
    }
  };

  for (const line of text.split('\n')) {
    if (out.length >= MAX_COMMENT_TOKENS_PER_FILE) break;
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Block-comment interiors: `* text` continuation lines and `/* text */`.
    const blockOpen = syntax.block.find(([open]) => trimmed.startsWith(open));
    if (blockOpen !== undefined) {
      push(trimmed.slice(blockOpen[0].length));
      continue;
    }
    if (trimmed.startsWith('*') && syntax.block.some(([open]) => open === '/*')) {
      push(trimmed.slice(1));
      continue;
    }

    const marker = syntax.line.find((m) => trimmed.startsWith(m));
    if (marker !== undefined) {
      push(trimmed.slice(marker.length));
      continue;
    }

    // A trailing comment on a code line. Only `//` and `#` are considered, and
    // only with whitespace in front, which keeps `https://` and `#{...}` out.
    const trailing = /\s(\/\/|#)\s(.+)$/.exec(line);
    if (trailing !== null && syntax.line.includes(trailing[1]!)) push(trailing[2]!);
  }
  return out;
}
