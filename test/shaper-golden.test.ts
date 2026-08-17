import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ParsedFile } from '../src/types.js';
import { parseTsSource } from '../src/parse/ts.js';
import { attachCommentTokens } from '../src/parse/dispatch.js';
import { INTENT_RULES } from '../src/query/intent.js';
import { resetVocabularyCache, shapeQuery } from '../src/query/shape.js';

/**
 * THE PHASE 4 GATE.
 *
 * The blueprint is explicit: `query_repository` is not exposed over MCP at all
 * until the shaper clears 90% intent accuracy on this set, "a wrong router
 * poisons trust — the bench proved trust is the whole game". This file IS that
 * gate, and it keeps holding after the tool ships.
 *
 * The golden set lives in JSON so it can grow from real transcripts without
 * touching code, and `scripts/shaper-bench.mjs` prints the full §41 metric
 * table from the same file — one source of truth for the number.
 */

interface GoldenCase {
  q: string;
  intent: string | null;
  expectTarget?: string;
  relation?: string;
}

const GOLDEN = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures', 'shaper-golden.json'), 'utf8'),
) as { cases: GoldenCase[] };

/** A small auth-shaped repository — the domain every golden query talks about. */
const FIXTURE: { path: string; module: string; src: string }[] = [
  {
    path: 'src/auth/middleware.ts',
    module: 'auth',
    src: `import { verifyToken } from './token'
import { createSession } from '../session/session'

/** Express middleware performing JWT authentication on every request. */
export function authMiddleware(req: Request): boolean {
  if (!verifyToken(req.headers.authorization)) return false
  createSession(req)
  return true
}
`,
  },
  {
    path: 'src/auth/token.ts',
    module: 'auth',
    src: `// Validates a JSON Web Token signature and expiry.
export function verifyToken(raw: string): boolean {
  return raw.length > 0
}

export interface TokenClaims {
  sub: string
}
`,
  },
  {
    path: 'src/session/session.ts',
    module: 'session',
    src: `// Session handling: creates and stores a user session.
export function createSession(req: Request): string {
  return 'session-id'
}
`,
  },
  {
    path: 'src/api/routes.ts',
    module: 'api',
    src: `import { authMiddleware } from '../auth/middleware'

export function registerRoutes(): void {
  authMiddleware({} as Request)
}
`,
  },
];

// Built through the same comment-attach step the real pipeline uses, so the
// fixture cannot prove behaviour production does not have.
const FILES: ParsedFile[] = FIXTURE.map((f) =>
  attachCommentTokens(parseTsSource(f.path, f.module, false, f.src), 'ts', f.src),
);
let gen = 1;
const shape = (q: string) => {
  resetVocabularyCache();
  return shapeQuery(q, FILES, gen++);
};

describe('intent accuracy gate (>=90%)', () => {
  it('classifies the golden set correctly', () => {
    const misses: string[] = [];
    for (const c of GOLDEN.cases) {
      const got = shape(c.q).intent;
      if (got !== c.intent) misses.push(`${JSON.stringify(c.q)}: want ${c.intent}, got ${got}`);
    }
    const accuracy = (GOLDEN.cases.length - misses.length) / GOLDEN.cases.length;
    // Reported in the failure message so a regression says HOW far it fell,
    // not just that it fell.
    expect(
      accuracy,
      `intent accuracy ${(accuracy * 100).toFixed(1)}% — misses:\n  ${misses.join('\n  ')}`,
    ).toBeGreaterThanOrEqual(0.9);
  });

  it('every intent rule is covered by at least one case', () => {
    // A rule with no case is a rule whose accuracy nobody measures.
    const fired = new Set<string>();
    for (const c of GOLDEN.cases) {
      const rule = shape(c.q).rule;
      if (rule !== null) fired.add(rule);
    }
    const uncovered = INTENT_RULES.map((r) => r.id).filter((id) => !fired.has(id));
    expect(uncovered, `intent rules with no golden case: ${uncovered.join(', ')}`).toEqual([]);
  });

  it('resolves the target where the golden set names one', () => {
    const misses: string[] = [];
    let checked = 0;
    for (const c of GOLDEN.cases) {
      if (c.expectTarget === undefined) continue;
      checked++;
      const r = shape(c.q).resolution;
      const got =
        r.status === 'resolved' ? r.target.name
        : r.status === 'ambiguous' ? `AMBIGUOUS(${r.candidates.map((x) => x.name).join('|')})`
        : r.status;
      if (got !== c.expectTarget) misses.push(`${JSON.stringify(c.q)}: want ${c.expectTarget}, got ${got}`);
    }
    const accuracy = (checked - misses.length) / checked;
    expect(
      accuracy,
      `target resolution ${(accuracy * 100).toFixed(1)}% — misses:\n  ${misses.join('\n  ')}`,
    ).toBeGreaterThanOrEqual(0.9);
  });

  it('preserves the relation when the golden set names one', () => {
    for (const c of GOLDEN.cases) {
      if (c.relation === undefined) continue;
      expect(shape(c.q).relation, c.q).toBe(c.relation);
    }
  });
});

describe('the contract for not knowing', () => {
  it('an unrecognized phrasing is reported, never guessed into an intent', () => {
    const s = shape('banana banana banana');
    expect(s.intent).toBeNull();
    expect(s.rule).toBeNull();
    expect(s.fallback?.supported).toContain('callers');
    expect(s.resolution.status).toBe('unresolved');
  });

  it('a target that does not exist is unresolved, not the nearest symbol', () => {
    const r = shape('who calls thisFunctionDoesNotExistAnywhere?').resolution;
    expect(r.status).toBe('unresolved');
  });

  it('a named symbol that does not exist never resolves to a lookalike', () => {
    /**
     * Found by running the golden set against an unrelated repository: asking
     * for `verifyToken` in a codebase that has none answered `queryTokens`,
     * confidently, because `token` is a prefix of `tokens`. Half a name is not
     * the name. This is the phantom-resolution guard.
     */
    const src = `export function queryTokens(q: string): string[] { return [q] }
export function splitIdentifier(n: string): string[] { return [n] }
`;
    const files = [attachCommentTokens(parseTsSource('src/q/tok.ts', 'q', false, src), 'ts', src)];
    resetVocabularyCache();
    const r = shapeQuery('who calls verifyToken?', files, 4242).resolution;
    expect(r.status).toBe('unresolved');
  });

  it('a partial name match is not offered even as an ambiguous candidate', () => {
    // Being "honestly ambiguous" about candidates that are all wrong is still
    // an answer about code that does not exist.
    const src = 'export function authorAnalysis(): void {}\nexport function moduleAuthorStats(): void {}\n';
    const files = [attachCommentTokens(parseTsSource('src/a/authors.ts', 'a', false, src), 'ts', src)];
    resetVocabularyCache();
    const r = shapeQuery('is it safe to remove authMiddleware?', files, 4243).resolution;
    expect(r.status).toBe('unresolved');
  });

  it('genuinely close candidates come back as AMBIGUOUS with confidences', () => {
    // Two symbols whose names both fully match the query tokens.
    const files = [
      parseTsSource('src/a/handler.ts', 'a', false, 'export function handleAuth(): void {}\n'),
      parseTsSource('src/b/handler.ts', 'b', false, 'export function handleAuth(): void {}\n'),
    ];
    resetVocabularyCache();
    const r = shapeQuery('who calls handleAuth?', files, 99).resolution;
    expect(r.status).toBe('ambiguous');
    if (r.status !== 'ambiguous') return;
    expect(r.candidates.length).toBe(2);
    expect(r.candidates.map((c) => c.file).sort()).toEqual(['src/a/handler.ts', 'src/b/handler.ts']);
    for (const c of r.candidates) expect(c.confidence).toBeGreaterThan(0);
  });

  it('targetless intents do not pretend to resolve one', () => {
    expect(shape('give me an overview of this repository').resolution.status).toBe('not-needed');
    expect(shape('are there any architecture violations?').resolution.status).toBe('not-needed');
  });
});

describe('repository vocabulary does the bridging', () => {
  it('an acronym reaches the words it was built from', () => {
    const s = shape('Where is JWT authentication implemented?');
    expect(s.intent).toBe('locate');
    expect(s.resolution.status).not.toBe('unresolved');
  });

  it('a query acronym finds code whose words are only spelled out in prose', () => {
    // The sharp version: the letters j-w-t appear NOWHERE in this repo —
    // not in an identifier, not in a comment. Only the phrase "JSON Web
    // Token" does. Resolving this is the §19 bridge doing real work, not a
    // substring match getting lucky.
    const src = `// Checks a JSON Web Token against the signing key.
export function checkSignature(raw: string): boolean {
  return raw.length > 0
}
`;
    expect(src.toLowerCase()).not.toContain('jwt');
    const files = [attachCommentTokens(parseTsSource('src/sec/sign.ts', 'sec', false, src), 'ts', src)];
    resetVocabularyCache();
    const r = shapeQuery('where is JWT checked?', files, 1234).resolution;
    expect(r.status).toBe('resolved');
    if (r.status !== 'resolved') return;
    expect(r.target.name).toBe('checkSignature');
  });

  it('a concept phrase resolves through comments, not just identifiers', () => {
    const r = shape('where does session handling live?').resolution;
    expect(r.status).not.toBe('unresolved');
    const file =
      r.status === 'resolved' ? r.target.file
      : r.status === 'ambiguous' ? r.candidates[0]?.file
      : '';
    expect(file).toContain('session');
  });

  it('is deterministic — the same repository state shapes identically', () => {
    const a = shape('who calls authMiddleware?');
    const b = shape('who calls authMiddleware?');
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('entity extraction does not take the first three nouns', () => {
  it('question words never become the target', () => {
    const s = shape('who calls authMiddleware?');
    expect(s.entities).toContain('authMiddleware');
    expect(s.entities).not.toContain('calls');
    expect(s.entities).not.toContain('who');
  });

  it('quoted text is treated as literal', () => {
    expect(shape('where is "createSession" defined?').entities).toContain('createSession');
  });

  it('a relationship survives extraction', () => {
    const s = shape('functions that validate tokens before creating a session');
    expect(s.relation).toBe('before');
  });
});
