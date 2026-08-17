import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLanguages } from '../src/parse/treesitter/loader.js';
import { TREE_SITTER_LANGS } from '../src/parse/dispatch.js';
import { resetIndex } from '../src/index/incremental.js';
import { callTool, TOOLS } from '../src/mcp/tools.js';
import { resetVocabularyCache } from '../src/query/shape.js';

/**
 * `query_repository` end to end over the real MCP dispatcher.
 *
 * The gate test proves the shaper classifies correctly; this proves the ROUTER
 * built on it behaves — including, especially, when it does not know. Every
 * failure path has to be as good as the success path, because an agent decides
 * whether to trust us based on what we do when we are unsure.
 */

let REPO: string;

beforeAll(async () => {
  await loadLanguages([...TREE_SITTER_LANGS]);
  REPO = mkdtempSync(join(tmpdir(), 'euthynos-qr-'));
  mkdirSync(join(REPO, 'src', 'auth'), { recursive: true });
  mkdirSync(join(REPO, 'src', 'api'), { recursive: true });
  writeFileSync(
    join(REPO, 'src', 'auth', 'middleware.ts'),
    `import { verifyToken } from './token'

/** Express middleware performing JWT authentication on every request. */
export function authMiddleware(header: string): boolean {
  return verifyToken(header)
}
`,
  );
  writeFileSync(
    join(REPO, 'src', 'auth', 'token.ts'),
    `// Validates a JSON Web Token signature and expiry.
export function verifyToken(raw: string): boolean {
  return raw.length > 0
}
`,
  );
  writeFileSync(
    join(REPO, 'src', 'api', 'routes.ts'),
    `import { authMiddleware } from '../auth/middleware'

export function registerRoutes(): void {
  authMiddleware('bearer x')
}
`,
  );
  resetIndex();
  resetVocabularyCache();
});

afterAll(() => {
  resetIndex();
  if (REPO !== undefined) rmSync(REPO, { recursive: true, force: true });
});

const ask = (query: string) => callTool('query_repository', { path: REPO, query });

describe('the tool is registered and discoverable', () => {
  it('appears in tools/list with a required query argument', () => {
    const def = TOOLS.find((t) => t.name === 'query_repository');
    expect(def).toBeDefined();
    expect(def!.inputSchema.required).toEqual(['query']);
  });
});

describe('routing a resolved question', () => {
  it('"who calls X" reaches the call graph and names the real caller', () => {
    const out = ask('Who calls authMiddleware?');
    expect(out.isError).toBeFalsy();
    expect(out.text).toContain('intent: callers');
    expect(out.text).toContain('authMiddleware');
    expect(out.text).toContain('registerRoutes');
  });

  it('"what breaks if I change X" reaches impact analysis', () => {
    const out = ask('What breaks if I change verifyToken?');
    expect(out.text).toContain('intent: blast_radius');
    expect(out.text).toContain('verifyToken');
  });

  it('"show me the code for X" returns the source span, not the whole file', () => {
    const out = ask('Show me the code for verifyToken');
    expect(out.text).toContain('intent: source');
    expect(out.text).toContain('function verifyToken');
    // The other file's function must not be dragged along.
    expect(out.text).not.toContain('registerRoutes()');
  });

  it('an overview question routes to the repo map with no target', () => {
    const out = ask('Give me an overview of this repository');
    expect(out.text).toContain('intent: overview');
    expect(out.text.toLowerCase()).toContain('module');
  });

  it('always reports the target and the confidence it was resolved with', () => {
    const out = ask('Who calls authMiddleware?');
    expect(out.text).toMatch(/target: authMiddleware\s+src\/auth\/middleware\.ts:\d+\s+confidence \d\.\d\d/);
  });
});

describe('what it does when it does not know', () => {
  it('an unroutable question says so and lists what it can answer', () => {
    const out = ask('banana banana banana');
    expect(out.isError).toBe(true);
    expect(out.text).toContain('Could not route');
    expect(out.text).toContain('callers');
  });

  it('a symbol that does not exist is UNRESOLVED with a cheaper next step', () => {
    const out = ask('who calls totallyMadeUpFunction?');
    expect(out.isError).toBe(true);
    expect(out.text).toContain('UNRESOLVED');
    expect(out.text).toContain('find_symbol');
    // It must not hand back a lookalike from this repo.
    expect(out.text).not.toContain('authMiddleware');
  });

  it('an unimplemented intent names the gap instead of answering something else', () => {
    const out = ask('What tests cover verifyToken?');
    expect(out.isError).toBe(true);
    expect(out.text).toContain('not implemented');
    // And still points at what genuinely works for that target.
    expect(out.text).toContain('read_function');
  });

  it('a path question asks for the second endpoint rather than inventing it', () => {
    const out = ask('Show me the path from authMiddleware to somewhere');
    expect(out.text).toContain('two endpoints');
    expect(out.text).toContain('path_between');
  });
});

describe('freshness', () => {
  it('a function added after the first call is found without a restart', () => {
    expect(ask('who calls freshlyAdded?').text).toContain('UNRESOLVED');
    writeFileSync(
      join(REPO, 'src', 'api', 'later.ts'),
      'export function freshlyAdded(): void {}\n\nexport function usesIt(): void { freshlyAdded() }\n',
    );
    resetVocabularyCache();
    const out = ask('who calls freshlyAdded?');
    expect(out.text).toContain('freshlyAdded');
    expect(out.text).toContain('usesIt');
  });
});
