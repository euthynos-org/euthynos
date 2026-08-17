import type { ParsedFile } from '../types.js';
import { normalizeQuery, splitIdentifier } from './tokenize.js';
import { classifyIntent, SUPPORTED_INTENTS, TARGETLESS, type Intent } from './intent.js';
import { extractEntities, type Entities, type Relation } from './entities.js';
import { buildVocabulary, expandTerm, type SymbolDoc, type Vocabulary } from './vocabulary.js';
import { normalizeScore, rank } from './bm25.js';
import { AMBIGUITY_GAP, MAX_CANDIDATES, RESOLVE_MIN, SCORE, TEST_FILE_DAMPING } from './weights.js';

/**
 * THE QUERY SHAPER (plan §17-20).
 *
 * Natural language in, a STRUCTURED QUERY out — and nothing else. It does not
 * answer questions; it decides what was asked and what it was asked about, and
 * hands that to the tools that already exist. Keeping it that narrow is what
 * makes it testable without an LLM in the loop.
 *
 * The contract that matters most is the one for NOT knowing. Three distinct
 * outcomes, never blurred:
 *
 *   resolved   — one candidate, clearly ahead
 *   ambiguous  — several plausible, all returned with confidences (§42)
 *   unresolved — nothing crossed the bar; say so, suggest the next call
 *
 * A router that quietly picks the best of a bad set is worse than no router:
 * the M0 benchmark showed an agent that catches us being wrong stops trusting
 * every later answer, and the token savings evaporate with the trust.
 */

export interface Candidate {
  id: string;
  name: string;
  file: string;
  line: number;
  kind: SymbolDoc['kind'];
  /** 0..1, comparable across candidates of the same query only. */
  confidence: number;
  /** Which signals fired — so a ranking can be argued with. */
  why: string[];
}

export type Resolution =
  | { status: 'resolved'; target: Candidate; alternatives: Candidate[] }
  | { status: 'ambiguous'; candidates: Candidate[] }
  | { status: 'unresolved'; tried: string[] }
  | { status: 'not-needed' };

export interface StructuredQuery {
  query: string;
  intent: Intent | null;
  /** Rule id that classified it, or null when nothing matched. */
  rule: string | null;
  entities: string[];
  relation: Relation | null;
  scope: 'repository';
  resolution: Resolution;
  /** Present only when the query could not be routed at all. */
  fallback?: { reason: string; supported: readonly Intent[] };
}

/**
 * Vocabulary is derived from the file set, so it is cached against the index
 * generation rather than a clock: a new generation means the files changed,
 * which is the only thing that can change the vocabulary.
 */
let cache: { generation: number; vocab: Vocabulary } | null = null;

export function vocabularyFor(files: readonly ParsedFile[], generation: number): Vocabulary {
  if (cache !== null && cache.generation === generation) return cache.vocab;
  const vocab = buildVocabulary(files);
  cache = { generation, vocab };
  return vocab;
}

/** Drop the memo (tests, and any caller that rebuilt an index out of band). */
export function resetVocabularyCache(): void {
  cache = null;
}

export function shapeQuery(
  raw: string,
  files: readonly ParsedFile[],
  generation: number,
): StructuredQuery {
  const normalized = normalizeQuery(raw);
  const match = classifyIntent(normalized);
  const entities = extractEntities(raw, normalized);

  if (match === null) {
    return {
      query: raw,
      intent: null,
      rule: null,
      entities: entities.entities,
      relation: entities.relation,
      scope: 'repository',
      resolution: { status: 'unresolved', tried: entities.entities },
      fallback: {
        reason:
          'No intent rule matched this phrasing. Rephrase using one of the supported ' +
          'question shapes, or call the specific tool directly.',
        supported: SUPPORTED_INTENTS,
      },
    };
  }

  const vocab = vocabularyFor(files, generation);
  const resolution = TARGETLESS.has(match.intent)
    ? ({ status: 'not-needed' } as const)
    : resolveTarget(vocab, entities, match.intent === 'tests');

  return {
    query: raw,
    intent: match.intent,
    rule: match.rule,
    entities: entities.entities,
    relation: entities.relation,
    scope: 'repository',
    resolution,
  };
}

/**
 * Score every symbol against the query and decide whether the winner is
 * actually a winner.
 *
 * Structural evidence dominates and BM25 breaks ties (weights.ts). The
 * ordering of the signals is the whole design: an exact name beats a
 * full-token match, which beats a token subset, which beats an alias hop,
 * which beats pure lexical similarity. That is descending order of "how sure
 * are we this is the thing" — and each level is recorded in `why` so the
 * ranking can be inspected instead of trusted.
 */
function resolveTarget(vocab: Vocabulary, entities: Entities, wantTests: boolean): Resolution {
  const probes = entities.entities.length > 0 ? entities.entities : entities.tokens;
  if (probes.length === 0 || vocab.docs.length === 0) {
    return { status: 'unresolved', tried: probes };
  }

  // Query terms, plus whatever this repository says they stand for. The
  // expansions are kept PER TERM, not merged into one bag: knowing that
  // `tokens` only stands in for `token` is what lets us tell a candidate that
  // explains the whole query from one that explains half of it.
  const queryTerms = new Set<string>();
  const expansions = new Map<string, Set<string>>();
  const aliasTerms = new Set<string>();
  for (const probe of probes) {
    for (const tok of splitIdentifier(probe)) {
      queryTerms.add(tok);
      const exp = new Set(expandTerm(vocab, tok).filter((e) => e !== tok));
      expansions.set(tok, exp);
      for (const e of exp) aliasTerms.add(e);
    }
  }

  /**
   * When the user writes a code-shaped name (`verifyToken`, `auth_handler`)
   * they are NAMING A SYMBOL, and a candidate that accounts for only part of
   * that name is not it. Without this, `verifyToken` resolves to `queryTokens`
   * on a repository that has no `verifyToken` at all — because `token` is a
   * prefix of `tokens` — which is a confidently wrong answer about code that
   * does not exist. That is the most expensive thing this engine can do.
   */
  const required = entities.literal
    .map((lit) => splitIdentifier(lit))
    // Only a MULTI-WORD identifier is a symbol name. A bare acronym ("JWT") is
    // a concept the user wants us to look up, and gating on it would break the
    // §19 bridge that finds `checkSignature` from a comment saying
    // "JSON Web Token". Naming and describing are different questions.
    .filter((toks) => toks.length >= 2);

  /** Query terms this doc's own name accounts for, directly or via alias. */
  const coveredBy = (nameTokens: ReadonlySet<string>): Set<string> => {
    const hit = new Set<string>();
    for (const qt of queryTerms) {
      if (nameTokens.has(qt)) hit.add(qt);
      else {
        for (const alt of expansions.get(qt) ?? []) {
          if (nameTokens.has(alt)) {
            hit.add(qt);
            break;
          }
        }
      }
    }
    return hit;
  };

  const lexical = rank(vocab, [...queryTerms, ...aliasTerms]);
  const bestLexical = lexical[0]?.score ?? 0;
  const lexicalById = new Map(lexical.map((l) => [l.doc.id, l.score]));

  const exactNames = new Set(probes.map((p) => p.toLowerCase()));

  const scored: Candidate[] = [];
  for (const doc of vocab.docs) {
    const why: string[] = [];
    let score = 0;

    const nameTokens = new Set(doc.tokens);
    if (exactNames.has(doc.name.toLowerCase())) {
      score += SCORE.exactName;
      why.push('exact name');
    } else if (
      required.length > 0 &&
      !required.some((toks) => {
        const covered = coveredBy(nameTokens);
        return toks.every((t) => covered.has(t));
      })
    ) {
      // The query NAMED a symbol and this is not it. Dropped outright rather
      // than left to compete on lexical similarity: a file that merely talks
      // about tokens is not the function `verifyToken`, and offering it as a
      // candidate — even an ambiguous one — is answering about code that does
      // not exist. Saying "unresolved" costs one follow-up call; a phantom
      // costs the agent's trust in every later answer.
      continue;
    } else {
      const covered = coveredBy(nameTokens);
      const coverage = queryTerms.size === 0 ? 0 : covered.size / queryTerms.size;
      const nameFullyUsed = [...nameTokens].every((t) => queryTerms.has(t));
      const exactTokens = [...nameTokens].every((t) => covered.has(t) && queryTerms.has(t));

      if (coverage === 1 && nameFullyUsed && exactTokens) {
        score += SCORE.allTokens;
        why.push('all name tokens match');
      } else if (nameFullyUsed && coverage > 0) {
        score += SCORE.tokenSubset * coverage;
        why.push('name tokens are a subset of the query');
      } else if (coverage > 0) {
        // Partial or alias-mediated. Scaled by how much of the question this
        // candidate actually explains, so half an answer never scores like a
        // whole one.
        score += SCORE.alias * coverage;
        why.push('matched through repository vocabulary');
      }
    }

    const lex = lexicalById.get(doc.id);
    if (lex !== undefined) {
      const n = normalizeScore(lex, bestLexical);
      if (n > 0) {
        score += SCORE.lexical * n;
        why.push('lexical relevance');
      }
    }

    const pathTokens = new Set([...splitIdentifier(doc.file), ...splitIdentifier(doc.module)]);
    if ([...queryTerms].some((t) => pathTokens.has(t))) {
      score += SCORE.pathMatch;
      why.push('path or module match');
    }
    if (doc.exported) score += SCORE.exportedNudge;
    if (doc.isTest && !wantTests) score *= TEST_FILE_DAMPING;

    if (score > 0) {
      scored.push({
        id: doc.id,
        name: doc.name,
        file: doc.file,
        line: doc.line,
        kind: doc.kind,
        confidence: Math.min(1, Number(score.toFixed(4))),
        why,
      });
    }
  }

  scored.sort((a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id));
  const top = scored.slice(0, MAX_CANDIDATES);
  const best = top[0];
  if (best === undefined || best.confidence < RESOLVE_MIN) {
    return { status: 'unresolved', tried: probes };
  }

  const runnerUp = top[1];
  if (runnerUp !== undefined && best.confidence - runnerUp.confidence < AMBIGUITY_GAP) {
    // Genuinely close. Report every plausible candidate rather than picking —
    // the agent can disambiguate with one cheap follow-up call, which is far
    // less costly than acting on the wrong one.
    return {
      status: 'ambiguous',
      candidates: top.filter((c) => best.confidence - c.confidence < AMBIGUITY_GAP * 2),
    };
  }
  return { status: 'resolved', target: best, alternatives: top.slice(1) };
}
