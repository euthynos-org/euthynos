/**
 * EVERY TUNING CONSTANT THE QUERY SHAPER USES, IN ONE FILE.
 *
 * Ranking that is scattered across the code is ranking nobody can review: a
 * weight nudged in a helper looks like a refactor in a diff. Here, changing
 * how results are ordered is a one-file change that a reviewer can see, and
 * `test/shaper-weights.test.ts` pins the values so a change is deliberate.
 */

/** Classic BM25 term-saturation and length-normalization parameters. */
export const BM25_K1 = 1.2;
export const BM25_B = 0.75;

/**
 * How the final target score is composed (plan §18.2). Lexical relevance
 * alone would rank a file path mentioning "auth" above the function actually
 * named `authenticate`, so structural evidence dominates and BM25 breaks ties.
 */
export const SCORE = {
  /** The query names the symbol exactly (case-insensitive). */
  exactName: 1.0,
  /** Every token of the symbol's name appears in the query, and vice versa. */
  allTokens: 0.72,
  /** The symbol's tokens are a subset of the query's. */
  tokenSubset: 0.5,
  /** Matched through a repo-derived alias/acronym (`jwt` -> `jsonWebToken`). */
  alias: 0.45,
  /** Normalized BM25 contribution (0..1 after scaling) — the tie-breaker. */
  lexical: 0.35,
  /** Query terms that hit the symbol's file path or module name. */
  pathMatch: 0.15,
  /** Exported symbols are likelier to be what a question is about. */
  exportedNudge: 0.05,
} as const;

/**
 * Multiplier applied to symbols declared in TEST files when the question is
 * not about tests. "Where is X implemented" means the implementation; a test
 * helper that happens to share the vocabulary is almost never the answer, and
 * offering one as a candidate is the kind of near-miss that makes an agent
 * stop trusting the ranking. Damped rather than excluded, because sometimes
 * the test IS the only place a symbol appears.
 */
export const TEST_FILE_DAMPING = 0.55;

/**
 * A score above this may be reported as a resolved target. Below it, the
 * shaper says it could not resolve rather than picking the best of a bad set —
 * the M0 benchmark showed a confidently wrong answer costs more than no answer.
 */
export const RESOLVE_MIN = 0.4;

/**
 * A top candidate must beat the runner-up by this much to be called resolved.
 * Closer than that is genuinely ambiguous and is reported as AMBIGUOUS with
 * both candidates (plan §42).
 */
export const AMBIGUITY_GAP = 0.12;

/** Candidates ever shown to a caller. Beyond this the tail is noise. */
export const MAX_CANDIDATES = 5;

/**
 * Comment tokens kept per file. Comments help a concept query find the right
 * code, but an unbounded comment index would dwarf the symbol index (license
 * headers, commented-out code) and drown real signal.
 */
export const MAX_COMMENT_TOKENS_PER_FILE = 120;

/**
 * A term must appear this many times in the repository before it can act as an
 * alias target. A one-off typo should not become vocabulary.
 */
export const ALIAS_MIN_SUPPORT = 1;

/** Shortest string allowed to be a prefix alias (`au` is not a word). */
export const ALIAS_MIN_PREFIX = 3;
