import { INTENT_RULES } from './intent.js';
import { queryTokens, splitIdentifier, STOPWORDS } from './tokenize.js';

/**
 * ENTITY AND RELATION EXTRACTION (plan §18.4).
 *
 * The plan is explicit that "do not simply take the first three nouns" — so
 * this pulls out what a repository question actually points at, ranked by how
 * much evidence there is that a phrase names code:
 *
 *   1. quoted text      — the user told us it is a literal
 *   2. `code spans`     — backticks, same thing
 *   3. code-shaped      — camelCase, snake_case, foo(), a.b, path/to/file.ts
 *   4. remaining words  — a concept phrase, only after the above
 *
 * Relations are preserved rather than flattened, because "validates JWT
 * BEFORE creating a session" is a different question from "validates JWT and
 * creates a session", and collapsing the two would answer neither.
 */

export type Relation =
  | 'before' | 'after' | 'calls' | 'called-by' | 'depends-on'
  | 'imported-by' | 'similar-to' | 'changed-by' | 'tested-by';

export interface Entities {
  /** Ranked: strongest evidence of naming code first. */
  entities: string[];
  /** Entities that arrived quoted or code-shaped — safe to match exactly. */
  literal: string[];
  relation: Relation | null;
  /** Content tokens of the whole query, for lexical fallback. */
  tokens: string[];
}

const RELATIONS: readonly { relation: Relation; pattern: RegExp }[] = [
  { relation: 'before', pattern: /\bbefore\b/ },
  { relation: 'after', pattern: /\bafter\b/ },
  { relation: 'called-by', pattern: /\b(called by|invoked by)\b/ },
  { relation: 'imported-by', pattern: /\bimported by\b/ },
  { relation: 'depends-on', pattern: /\bdepends? on\b/ },
  { relation: 'similar-to', pattern: /\bsimilar to\b/ },
  { relation: 'changed-by', pattern: /\bchanged by\b/ },
  { relation: 'tested-by', pattern: /\btested by\b/ },
  { relation: 'calls', pattern: /\bcalls?\b/ },
];

/** Quoted or backticked spans — the user marked these as literal. */
const QUOTED = /["'`]([^"'`]{2,})["'`]/g;

/**
 * Text shaped like code: an identifier with internal case or underscores, a
 * call with parens, a dotted or slashed path, or a file with an extension.
 * A single all-lowercase word is deliberately NOT code-shaped — `session` is
 * a concept until something else says otherwise.
 */
const CODE_SHAPED =
  /\b(?:[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+|[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+|[A-Za-z_$][A-Za-z0-9_$]*_[A-Za-z0-9_$]+|[A-Z][A-Za-z0-9_$]{2,}|[\w./-]+\.[a-z]{1,4}|[A-Za-z_$][A-Za-z0-9_$]*(?=\s*\())\b/g;

/**
 * Words that belong to the QUESTION rather than to the code being asked
 * about. Built from the intent rules' own vocabulary so a phrasing can never
 * be both a routing trigger and an entity — "who calls authMiddleware" must
 * yield `authMiddleware`, not `calls`.
 */
const QUESTION_WORDS: ReadonlySet<string> = new Set([
  ...STOPWORDS,
  'call', 'calls', 'called', 'caller', 'callers', 'callee', 'callees',
  'depend', 'depends', 'dependency', 'dependencies', 'dependent', 'dependents',
  'import', 'imports', 'imported', 'use', 'used', 'uses', 'usage', 'usages',
  'break', 'breaks', 'broken', 'change', 'changes', 'changed', 'modify',
  'modified', 'impact', 'blast', 'radius', 'affected', 'safe', 'remove',
  'delete', 'rename', 'happens', 'ripple',
  'show', 'give', 'print', 'display', 'read', 'find', 'locate', 'explain',
  'code', 'source', 'body', 'implementation', 'implemented', 'defined',
  'declared', 'lives', 'file', 'files', 'function', 'functions', 'method',
  'methods', 'class', 'classes', 'module', 'modules', 'repo', 'repository',
  'project', 'similar', 'duplicate', 'duplicates', 'duplicated',
  'duplication', 'clone', 'clones', 'same', 'logic', 'copy',
  'test', 'tests', 'tested', 'testing', 'coverage',
  'violation', 'violations', 'architecture', 'layering', 'boundary',
  'boundaries', 'coupling', 'circular', 'overview', 'orient', 'structure',
  'recent', 'recently', 'last', 'churn', 'wrote', 'does', 'do', 'done',
  'work', 'works', 'working', 'purpose', 'about', 'me', 'all', 'get',
  'speed', 'lay', 'land', 'path', 'between', 'reach', 'references',
  'referenced', 'reference', 'which', 'here', 'somewhere', 'anywhere',
]);

export function extractEntities(raw: string, normalized: string): Entities {
  const literal: string[] = [];
  const seen = new Set<string>();
  const push = (into: string[], value: string): void => {
    const v = value.trim().replace(/\(\)$/, '');
    if (v.length < 2) return;
    const key = v.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    into.push(v);
  };

  // 1-2. Quoted / backticked spans, from the RAW text so case survives.
  for (const m of raw.matchAll(QUOTED)) push(literal, m[1] ?? '');

  // 3. Code-shaped tokens, also from raw text (case is the evidence).
  for (const m of raw.matchAll(CODE_SHAPED)) {
    const value = m[0];
    // A capitalized ordinary word at the start of a sentence is not a symbol.
    if (/^[A-Z][a-z]+$/.test(value) && !raw.includes(`${value}(`)) continue;
    push(literal, value);
  }

  // 4. Whatever content words remain — the concept phrase. Only reached when
  // the query names nothing code-shaped, e.g. "where is jwt authentication".
  const concepts: string[] = [];
  const literalTokens = new Set(literal.flatMap((l) => splitIdentifier(l)));
  for (const tok of queryTokens(normalized)) {
    if (QUESTION_WORDS.has(tok) || literalTokens.has(tok)) continue;
    push(concepts, tok);
  }

  return {
    entities: [...literal, ...concepts],
    literal,
    relation: RELATIONS.find((r) => r.pattern.test(normalized))?.relation ?? null,
    tokens: queryTokens(normalized).filter((t) => !QUESTION_WORDS.has(t)),
  };
}

/** Rule ids, for tests that assert the registry and extractor stay in step. */
export const INTENT_RULE_IDS: readonly string[] = INTENT_RULES.map((r) => r.id);
