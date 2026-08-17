import { BM25_B, BM25_K1 } from './weights.js';
import type { SymbolDoc, Vocabulary } from './vocabulary.js';

/**
 * BM25 — zero dependencies, ~40 lines, fully deterministic (plan §18.2).
 *
 * Why not a vector database: an embedding model is a network call, a model
 * version, and a source of answers nobody can explain. BM25 over the
 * repository's own vocabulary is reproducible, runs offline in microseconds,
 * and every score can be traced to a term. The engine's promise is that the
 * same repository state always produces the same answer; a hosted embedding
 * cannot make that promise.
 *
 * BM25 is the TIE-BREAKER here, not the decider — structural evidence (an
 * exact name, a token-for-token match) outranks it by design in `weights.ts`.
 * Lexical search alone would happily rank a file whose path says "auth" above
 * the function actually named `authenticate`.
 */

/**
 * Inverse document frequency, in the standard BM25+ form. The +1 inside the
 * log keeps it non-negative, so a term present in most documents contributes
 * ~0 rather than pushing scores negative.
 */
function idf(df: number, total: number): number {
  return Math.log(1 + (total - df + 0.5) / (df + 0.5));
}

/** One document's BM25 score against a set of query terms. */
export function scoreDoc(vocab: Vocabulary, doc: SymbolDoc, terms: readonly string[]): number {
  if (terms.length === 0 || vocab.docs.length === 0) return 0;

  const tf = new Map<string, number>();
  for (const t of doc.terms) tf.set(t, (tf.get(t) ?? 0) + 1);

  const len = doc.terms.length;
  const norm = BM25_K1 * (1 - BM25_B + (BM25_B * len) / (vocab.avgDocLen || 1));

  let score = 0;
  for (const term of terms) {
    const f = tf.get(term);
    if (f === undefined) continue;
    score += idf(vocab.df.get(term) ?? 0, vocab.docs.length) * ((f * (BM25_K1 + 1)) / (f + norm));
  }
  return score;
}

/**
 * Scores for every document that contains at least one query term, highest
 * first. Documents with no matching term are absent rather than scored zero —
 * "no evidence" and "evidence that says nothing" are different, and a caller
 * deciding whether it resolved anything needs to tell them apart.
 */
export function rank(
  vocab: Vocabulary,
  terms: readonly string[],
): { doc: SymbolDoc; score: number }[] {
  const out: { doc: SymbolDoc; score: number }[] = [];
  for (const doc of vocab.docs) {
    const score = scoreDoc(vocab, doc, terms);
    if (score > 0) out.push({ doc, score });
  }
  // Ties break on id so the ordering is total — a ranking that reorders
  // between runs on equal scores would break every golden test downstream.
  out.sort((a, b) => b.score - a.score || a.doc.id.localeCompare(b.doc.id));
  return out;
}

/**
 * Squash a raw BM25 score into 0..1 so it can be blended with the structural
 * signals in `weights.ts`. Raw BM25 has no upper bound and its range depends
 * on corpus size, so mixing it in directly would let a big repository's scores
 * swamp the structural evidence that should dominate.
 */
export function normalizeScore(score: number, best: number): number {
  if (best <= 0) return 0;
  return Math.min(1, score / best);
}
