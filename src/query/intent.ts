/**
 * DETERMINISTIC INTENT REGISTRY (plan §18.3).
 *
 * A rule table, not a model. Every classification is traceable to a named
 * rule, which means a misroute is a bug with an address rather than a
 * behaviour to re-prompt around. The gate for exposing `query_repository` at
 * all is >=90% accuracy on the golden set, because a router that sends
 * "who calls X" to the similarity engine destroys trust faster than having no
 * router — and the M0 benchmark showed trust is what buys the token savings.
 *
 * Ordering is significant and load-bearing. Rules are tried top to bottom, so
 * the MORE SPECIFIC phrasing must come first: "what breaks if I change X" is
 * blast_radius, and it must be tested before the generic "what ... change"
 * history rule can claim it.
 */

export type Intent =
  | 'locate'
  | 'source'
  | 'explain'
  | 'callers'
  | 'callees'
  | 'references'
  | 'dependencies'
  | 'dependents'
  | 'blast_radius'
  | 'similar_logic'
  | 'tests'
  | 'architecture'
  | 'history'
  | 'find_path'
  | 'overview';

export interface IntentRule {
  /** Stable identifier — appears in responses and in the golden set. */
  id: string;
  intent: Intent;
  pattern: RegExp;
}

/**
 * Seeded from the plan's examples plus the phrasings real agents used in the
 * archived benchmark transcripts. Grows only with a golden-set case attached,
 * so the accuracy number always reflects every rule.
 */
export const INTENT_RULES: readonly IntentRule[] = [
  // ── blast radius ── before history and before dependents: "what breaks if
  // I change X" contains both "change" and a dependency sense.
  { id: 'blast.breaks-if', intent: 'blast_radius', pattern: /\bwhat\b.*\bbreaks?\b|\bbreaks?\b.*\bif i\b/ },
  { id: 'blast.impact', intent: 'blast_radius', pattern: /\b(blast radius|impact of|affected by|ripple)\b/ },
  { id: 'blast.safe-to', intent: 'blast_radius', pattern: /\b(safe to (change|remove|delete|rename)|what happens if i (change|remove|delete))\b/ },

  // ── call direction ── "who calls X" vs "what does X call" is the pair
  // agents get wrong most often, so both directions are explicit AND the
  // outward one is tested first: "what does authMiddleware call?" contains
  // both a wh-word and "call", so a callers rule placed above it would
  // swallow it and answer the opposite question. Order is the disambiguator
  // here — clearer than a lookahead, and it cannot be defeated by phrasing.
  { id: 'callees.what-does-call', intent: 'callees', pattern: /\bwhat (does|do)\b.*\bcalls?\b|\bcallees? of\b|\bcalls? what\b/ },
  { id: 'callers.who-calls', intent: 'callers', pattern: /\b(who|what|which)\b[^?]*\bcalls?\b/ },
  { id: 'callers.called-by', intent: 'callers', pattern: /\b(called by|callers? of|invoked by|used by)\b/ },
  { id: 'callers.who-uses', intent: 'callers', pattern: /\bwho (uses|is using|invokes)\b/ },

  // ── references ──
  { id: 'refs.where-used', intent: 'references', pattern: /\b(where is .* (used|referenced)|references? to|usages? of|all uses of)\b/ },

  // ── dependencies (both directions) ──
  // Direction is everything, and the two phrasings are one word apart:
  //   "what depends on X"      -> dependents  (who points AT X)
  //   "what does X depend on"  -> dependencies (what X points at)
  // The outward form is tested FIRST because "what does the api module depend
  // on" also contains "depends on", and being routed to the opposite direction
  // is the same class of error as answering callers with callees.
  { id: 'deps.depends-on', intent: 'dependencies', pattern: /\b(what (does|do) .*\bdepends? on\b|depends? on what|dependencies of|imports? of)\b/ },
  { id: 'dependents.what-depends', intent: 'dependents', pattern: /\bwhat\b.*\bdepends? on\b|\bdependents? of\b|\bimported by\b/ },

  // ── similarity ──
  { id: 'similar.find', intent: 'similar_logic', pattern: /\b(similar|duplicate[ds]?|duplication|same logic|copy of|clones?)\b/ },

  // ── tests ──
  { id: 'tests.what-tests', intent: 'tests', pattern: /\b(what tests?|tests? for|tested by|test coverage (of|for)|which tests?)\b/ },

  // ── architecture ──
  { id: 'arch.violations', intent: 'architecture', pattern: /\b(violations?|architecture|layering|boundar(y|ies)|coupling|circular)\b/ },

  // ── history ──
  { id: 'history.changed', intent: 'history', pattern: /\b(what changed|recent(ly)? (changed|modified)|last (changed|modified)|churn|who (wrote|changed))\b/ },

  // ── relational path ── "X before Y", "from X to Y".
  { id: 'path.between', intent: 'find_path', pattern: /\b(path (from|between)|how does .* reach|before creating|after .* calls)\b/ },

  // ── source ── an explicit request for the code itself.
  { id: 'source.show-code', intent: 'source', pattern: /\b(show|give|print|display)\b[^?]*\b(code|source|body|implementation)\b/ },
  { id: 'source.read', intent: 'source', pattern: /\bread\b.*\b(function|method|class)\b/ },

  // ── explain ──
  { id: 'explain.what-does', intent: 'explain', pattern: /\b(what does .* do|explain|how does .* work|purpose of)\b/ },

  // ── overview ── whole-repo orientation, no target.
  { id: 'overview.orient', intent: 'overview', pattern: /\b(overview|orient|what is this (repo|repository|project)|structure of the (repo|project)|get me up to speed|lay of the land)\b/ },

  // ── locate ── the general fallback for "where".
  { id: 'locate.where', intent: 'locate', pattern: /\b(where is|where are|where does|find|locate|which file)\b/ },
  { id: 'locate.implemented', intent: 'locate', pattern: /\b(implemented|defined|declared|lives?)\b/ },
];

export interface IntentMatch {
  intent: Intent;
  /** The rule that fired — so a wrong route can be fixed at its source. */
  rule: string;
}

/**
 * Classify a normalized query. Returns null when NO rule matches: an
 * unrecognized question is reported as unrecognized, with the intents we do
 * support, rather than being forced into the nearest bucket. Guessing here is
 * exactly how a router poisons trust.
 */
export function classifyIntent(normalized: string): IntentMatch | null {
  for (const rule of INTENT_RULES) {
    if (rule.pattern.test(normalized)) return { intent: rule.intent, rule: rule.id };
  }
  return null;
}

/** Every intent the router can serve — used in the "unrecognized" response. */
export const SUPPORTED_INTENTS: readonly Intent[] = [
  'locate', 'source', 'explain', 'callers', 'callees', 'references',
  'dependencies', 'dependents', 'blast_radius', 'similar_logic', 'tests',
  'architecture', 'history', 'find_path', 'overview',
];

/** Intents that answer about the repository as a whole, with no target. */
export const TARGETLESS: ReadonlySet<Intent> = new Set<Intent>(['overview', 'architecture']);
