import type { ParsedFile } from '../types.js';
import { ALIAS_MIN_PREFIX, ALIAS_MIN_SUPPORT } from './weights.js';
import { acronymOf, splitIdentifier } from './tokenize.js';

/**
 * REPOSITORY VOCABULARY (plan §19).
 *
 * A user says "JWT authentication"; the repository says `verifyBearer` in
 * `src/auth/token.ts`. Bridging that WITHOUT an embedding model is the whole
 * point — the bridge has to be derived from this repository's own words, so it
 * is deterministic, explainable, and offline.
 *
 * Every association here is EVIDENCE FROM THE REPOSITORY, never a general
 * English assumption:
 *
 *  - `jwt` maps to `jsonWebToken` only because some symbol here is literally
 *    named with those three words.
 *  - `auth` maps to `authenticate` only because `authenticate` exists here.
 *
 * That rule is what stops the shaper inventing relationships. A hand-written
 * synonym list ("login" means "signin") would be a guess about a codebase we
 * have never seen, and a wrong guess routes an agent to the wrong file — the
 * failure mode the M0 benchmark showed is most expensive.
 */

export interface SymbolDoc {
  /** Addressable identity: `path#name`. */
  id: string;
  name: string;
  file: string;
  module: string;
  kind: 'function' | 'class' | 'interface' | 'type' | 'enum' | 'const' | 'module';
  line: number;
  exported: boolean;
  /** Declared in a test file — damped unless the question is about tests. */
  isTest: boolean;
  /** Name tokens, in order. */
  tokens: string[];
  /** Everything searchable about this symbol: name + path + module + comments. */
  terms: string[];
}

export interface Vocabulary {
  docs: SymbolDoc[];
  /** term -> number of docs containing it (IDF input). */
  df: Map<string, number>;
  /** alias/acronym -> canonical repository terms it stands for. */
  aliases: Map<string, string[]>;
  /** Every distinct term seen, with its total occurrence count. */
  termCount: Map<string, number>;
  /** Average doc length, for BM25 length normalization. */
  avgDocLen: number;
}

/**
 * Build the vocabulary from parsed files. Pure and deterministic: same files
 * in, byte-identical vocabulary out, which is what lets the golden tests pin
 * ranking behaviour.
 */
export function buildVocabulary(files: readonly ParsedFile[]): Vocabulary {
  const docs: SymbolDoc[] = [];
  const termCount = new Map<string, number>();
  const bump = (t: string): void => {
    termCount.set(t, (termCount.get(t) ?? 0) + 1);
  };

  for (const f of files) {
    const pathTokens = splitIdentifier(f.path);
    const moduleTokens = splitIdentifier(f.module);
    // Comments describe the FILE, so every symbol in it inherits them. That is
    // deliberately coarse: comment text is a ranking hint, and pinning a
    // comment to one symbol would imply a precision we have not earned.
    const fileComments = f.commentTokens ?? [];

    const add = (
      name: string,
      kind: SymbolDoc['kind'],
      line: number,
      exported: boolean,
    ): void => {
      if (!name || name.startsWith('(')) return; // '(anon)', '(constructor)'
      const tokens = splitIdentifier(name);
      if (tokens.length === 0) return;
      const terms = [...tokens, ...pathTokens, ...moduleTokens, ...fileComments];
      for (const t of terms) bump(t);
      docs.push({
        id: `${f.path}#${name}`,
        name,
        file: f.path,
        module: f.module,
        kind,
        line,
        exported,
        isTest: f.isTest,
        tokens,
        terms,
      });
    };

    for (const fn of f.functions) add(fn.name, 'function', fn.declLine ?? fn.startLine, fn.exported);
    for (const s of f.symbols ?? []) add(s.name, s.kind, s.startLine, s.exported);
  }

  // Document frequency, counted once per doc even if a term repeats in it.
  const df = new Map<string, number>();
  let totalLen = 0;
  for (const d of docs) {
    totalLen += d.terms.length;
    for (const t of new Set(d.terms)) df.set(t, (df.get(t) ?? 0) + 1);
  }

  return {
    docs,
    df,
    termCount,
    aliases: deriveAliases(docs, termCount),
    avgDocLen: docs.length === 0 ? 0 : totalLen / docs.length,
  };
}

/**
 * Aliases, derived two ways — both requiring the target to exist here.
 *
 *  1. ACRONYM: a symbol named with >=2 words contributes its initials.
 *     `JsonWebToken` -> `jwt`. This is the case that makes "JWT" findable
 *     when no identifier contains the letters j-w-t together.
 *  2. PREFIX: a term that is a strict prefix of a longer repository term, at
 *     least 3 characters. `auth` -> `authenticate`, `authorize`. Requiring
 *     BOTH ends to be real repository terms is what keeps this from
 *     manufacturing nonsense: `cat` will not map to `category` unless the
 *     repository actually uses `cat` somewhere as a word.
 *
 * Targets are sorted by descending repository frequency, so the most-used
 * meaning is offered first, then alphabetically for stable output.
 */
function deriveAliases(
  docs: readonly SymbolDoc[],
  termCount: ReadonlyMap<string, number>,
): Map<string, string[]> {
  const acc = new Map<string, Set<string>>();
  const link = (alias: string, target: string): void => {
    if (alias === target) return;
    let set = acc.get(alias);
    if (set === undefined) {
      set = new Set();
      acc.set(alias, set);
    }
    set.add(target);
  };

  for (const d of docs) {
    const acr = acronymOf(d.tokens);
    // The acronym stands for each word it was built from, so a query using it
    // reaches all of them.
    if (acr !== null && !termCount.has(acr)) {
      for (const t of d.tokens) link(acr, t);
    }
  }

  const terms = [...termCount.keys()].filter((t) => (termCount.get(t) ?? 0) >= ALIAS_MIN_SUPPORT);
  // Group by first letter: prefix candidates always share it, which turns an
  // O(n^2) scan over every term pair into something linear in practice.
  const byInitial = new Map<string, string[]>();
  for (const t of terms) {
    const k = t[0] ?? '';
    const list = byInitial.get(k);
    if (list === undefined) byInitial.set(k, [t]);
    else list.push(t);
  }
  for (const [, group] of byInitial) {
    for (const short of group) {
      if (short.length < ALIAS_MIN_PREFIX) continue;
      for (const long of group) {
        if (long.length > short.length && long.startsWith(short)) link(short, long);
      }
    }
  }

  const out = new Map<string, string[]>();
  for (const [alias, targets] of acc) {
    out.set(
      alias,
      [...targets].sort(
        (a, b) => (termCount.get(b) ?? 0) - (termCount.get(a) ?? 0) || a.localeCompare(b),
      ),
    );
  }
  return out;
}

/**
 * A query term plus whatever this repository says it stands for. Used to widen
 * a search WITHOUT widening what we claim: expansions score lower than the
 * literal term (see SCORE.alias), so a direct hit always outranks an aliased one.
 */
export function expandTerm(vocab: Vocabulary, term: string): string[] {
  const aliases = vocab.aliases.get(term);
  return aliases === undefined ? [term] : [term, ...aliases];
}
