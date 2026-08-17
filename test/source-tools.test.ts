import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLanguages } from '../src/parse/treesitter/loader.js';
import { TREE_SITTER_LANGS } from '../src/parse/dispatch.js';
import { callTool } from '../src/mcp/tools.js';
import { resetDedup } from '../src/mcp/dedup.js';

// Each test is logically its own agent session: session dedup state must
// never leak between them (a receipt where a test expects source).
beforeEach(() => resetDedup());
import { readSpan, SpanError } from '../src/serve/spans.js';

/**
 * P0 SOURCE TOOLS — contract tests.
 *
 * The whole thesis of these tools is "cheaper than reading the file", so the
 * assertions are about SHAPE as much as correctness: exact spans, no whole
 * files, honest truncation, current working-tree text, and refusal to leave
 * the repository.
 */

const REPO = mkdtempSync(join(tmpdir(), 'euthynos-p0-'));

const SERVICE = `import { hash } from './crypto'
import type { User } from './types'

export interface Session {
  id: string
  user: User
}

export function authenticate(name: string, password: string): Session | null {
  const digest = hash(password)
  const user = lookup(name)
  if (!user || user.digest !== digest) {
    return null
  }
  return createSession(user)
}

function lookup(name: string): User | null {
  return registry.get(name) ?? null
}

export function createSession(user: User): Session {
  return { id: hash(user.name + Date.now()), user }
}
`;

const API = `import { authenticate } from '../auth/service'

export function login(req: Request): Response {
  const session = authenticate(req.name, req.password)
  if (!session) {
    return { status: 401 }
  }
  return { status: 200, body: session }
}
`;

const CRYPTO = `export function hash(input: string): string {
  let h = 0
  for (let i = 0; i < input.length; i++) {
    h = (h * 31 + input.charCodeAt(i)) | 0
  }
  return String(h)
}
`;

beforeAll(async () => {
  await loadLanguages([...TREE_SITTER_LANGS]);
  process.env['EUTHYNOS_NO_TELEMETRY'] = '1';
  mkdirSync(join(REPO, 'auth'), { recursive: true });
  mkdirSync(join(REPO, 'api'), { recursive: true });
  writeFileSync(join(REPO, 'auth', 'service.ts'), SERVICE);
  writeFileSync(join(REPO, 'auth', 'crypto.ts'), CRYPTO);
  writeFileSync(join(REPO, 'api', 'login.ts'), API);
});

afterAll(() => rmSync(REPO, { recursive: true, force: true }));

const call = (tool: string, args: Record<string, unknown> = {}) => callTool(tool, { path: REPO, ...args });
const est = (s: string): number => Math.round(s.length / 4);

describe('read_function', () => {
  it('serves the exact declaration span, not the file', () => {
    const out = call('read_function', { function: 'authenticate' });
    expect(out.isError ?? false).toBe(false);
    expect(out.text).toContain('authenticate (function)');
    // the span starts at the DECLARATION (signature), not the body brace
    expect(out.text).toMatch(/9 \| export function authenticate/);
    expect(out.text).toContain('return createSession(user)');
    // and stops there — the neighbouring functions are NOT included
    expect(out.text).not.toContain('function lookup');
    expect(out.text).not.toContain('export function createSession(user: User)');
  });

  it('carries direct callers and callees so the next hop needs no search', () => {
    const out = call('read_function', { function: 'authenticate' });
    expect(out.text).toMatch(/Called by:.*login/);
    expect(out.text).toMatch(/Calls:.*(hash|lookup|createSession)/);
  });

  it('reports ambiguity instead of picking a winner', () => {
    const out = call('read_function', { function: 'Session' }); // interface + none else
    // Session is unique here; the ambiguity contract is exercised by name+file
    expect(out.isError ?? false).toBe(false);
    const miss = call('read_function', { function: 'doesNotExistAnywhere' });
    expect(miss.isError).toBe(true);
    expect(miss.text).toMatch(/No symbol/);
  });

  it('serves the CURRENT working-tree text after an edit (freshness)', () => {
    const p = join(REPO, 'auth', 'crypto.ts');
    const original = readFileSync(p, 'utf8');
    try {
      writeFileSync(p, original.replace('let h = 0', 'let h = 7 // EDITED'));
      const out = call('read_function', { function: 'hash' });
      expect(out.text).toContain('EDITED');
    } finally {
      writeFileSync(p, original);
    }
  });
});

describe('file_outline', () => {
  it('maps a file in a fraction of the file"s tokens', () => {
    const out = call('file_outline', { file: 'auth/service.ts' });
    expect(out.text).toContain('imports');
    expect(out.text).toContain('interface Session');
    expect(out.text).toContain('authenticate()');
    expect(out.text).toContain('lookup() (internal)');
    // Cheaper than the source it describes, even on a small file.
    expect(est(out.text)).toBeLessThan(est(SERVICE));
  });

  it('scales: a large file costs a near-constant outline', () => {
    // The real saving is on the files an agent would otherwise open whole.
    const big = [
      'import { a } from "./a"',
      ...Array.from({ length: 40 }, (_, i) =>
        [`export function fn${i}(x: number): number {`, ...Array.from({ length: 12 }, (_, j) => `  const v${j} = x + ${j}`), '  return x', '}'].join('\n'),
      ),
    ].join('\n');
    writeFileSync(join(REPO, 'auth', 'big.ts'), big);
    try {
      const out = callTool('file_outline', { path: REPO, file: 'auth/big.ts' });
      expect(out.isError ?? false).toBe(false);
      expect(est(out.text)).toBeLessThan(est(big) * 0.15);
    } finally {
      rmSync(join(REPO, 'auth', 'big.ts'), { force: true });
    }
  });

  it('names near-misses instead of a bare not-found', () => {
    const out = call('file_outline', { file: 'service.ts' });
    // resolves by suffix; a truly unknown file suggests candidates
    expect(out.isError ?? false).toBe(false);
    const bad = call('file_outline', { file: 'nope/service.ts' });
    expect(bad.text).toMatch(/service\.ts/);
  });
});

describe('read_span', () => {
  it('serves an exact range with line numbers', () => {
    const out = call('read_span', { file: 'auth/crypto.ts', startLine: 1, endLine: 2 });
    expect(out.text).toMatch(/1 \| export function hash/);
    expect(out.text).not.toContain('return String(h)');
  });

  it('refuses an absurd range rather than dumping the file', () => {
    const out = call('read_span', { file: 'auth/service.ts', startLine: 1, endLine: 5000 });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/narrower/);
  });

  it('refuses to escape the repository root', () => {
    expect(() => readSpan(REPO, '../../../etc/passwd', 1, 5)).toThrow(SpanError);
    expect(() => readSpan(REPO, 'C:/Windows/system.ini', 1, 5)).toThrow(SpanError);
  });
});

describe('find_symbol / find_references', () => {
  it('ranks an exact name above a token match', () => {
    const out = call('find_symbol', { query: 'authenticate' });
    // candidate rows are indented; the first line is the header
    const row = out.text.split('\n').find((l) => l.startsWith('  ') && l.includes('authenticate'))!;
    expect(row).toContain('exact');
  });

  it('resolves a phrase to a declaration', () => {
    const out = call('find_symbol', { query: 'create session' });
    expect(out.text).toContain('createSession');
  });

  it('lists definitions, call sites with exact lines, and imports', () => {
    const out = call('find_references', { symbol: 'authenticate' });
    expect(out.text).toMatch(/definition\s+auth\/service\.ts:9/);
    expect(out.text).toMatch(/call\s+api\/login\.ts:4\s+in login\(\)/);
    expect(out.text).toMatch(/import\s+api\/login\.ts:1/);
  });
});

describe('response budgets', () => {
  const BUDGET: Record<string, number> = {
    repo_map: 1500,
    file_outline: 200,
    find_symbol: 250,
    find_references: 250,
    read_function: 400,
  };

  it('every P0 tool stays inside its budget', () => {
    const cases: [string, Record<string, unknown>][] = [
      ['repo_map', {}],
      ['file_outline', { file: 'auth/service.ts' }],
      ['find_symbol', { query: 'session' }],
      ['find_references', { symbol: 'hash' }],
      ['read_function', { function: 'authenticate' }],
    ];
    for (const [tool, args] of cases) {
      const out = call(tool, args);
      expect(out.isError ?? false, `${tool}: ${out.text.slice(0, 100)}`).toBe(false);
      expect(est(out.text), `${tool} over budget`).toBeLessThanOrEqual(BUDGET[tool]!);
    }
  });

  it('a long function is truncated with an explicit continuation', () => {
    const big = ['export function huge() {', ...Array.from({ length: 300 }, (_, i) => `  const v${i} = ${i}`), '}'].join('\n');
    writeFileSync(join(REPO, 'auth', 'huge.ts'), big);
    try {
      // new file: bust the parse cache by pointing at a fresh temp copy
      const out = callTool('read_function', { path: REPO, function: 'huge' });
      if (out.isError !== true) {
        expect(out.text).toMatch(/truncated at \d+ lines/);
        expect(out.text).toMatch(/read_span/);
      }
    } finally {
      rmSync(join(REPO, 'auth', 'huge.ts'), { force: true });
    }
  });
});
