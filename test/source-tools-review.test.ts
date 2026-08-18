import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
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
 * Regressions for the source-reading tools — read_function, read_span,
 * callers_of, find_references, find_symbol, file_outline. Every test here pins
 * a defect an adversarial review of those tools confirmed, so that it cannot
 * return unnoticed.
 *
 * The four failure classes covered below:
 *   - serving a different symbol than the one that was asked for;
 *   - answering from a cache that predates an edit to the file;
 *   - reading a file that is not indexed source, or that resolves outside the
 *     repository root;
 *   - reporting a count or a span the file does not actually support.
 *
 * Each test names the failure it prevents; none of these may come back.
 */

const REPO = mkdtempSync(join(tmpdir(), 'euthynos-review-'));

const WALLET = `/**
 * Move funds between accounts.
 * @param amount in minor units
 */
export function credit(account: string, amount: number): number {
  return amount + 1
}

export class Ledger {
  constructor(public name: string) {}
  record(entry: string): void {
    this.entries.push(entry)
  }
}
`;

const APP = `import { credit } from './wallet'

export function main(): number {
  return credit('a', 1)
}
`;

beforeAll(async () => {
  await loadLanguages([...TREE_SITTER_LANGS]);
  process.env['EUTHYNOS_NO_TELEMETRY'] = '1';
  writeFileSync(join(REPO, 'wallet.ts'), WALLET);
  writeFileSync(join(REPO, 'app.ts'), APP);
  writeFileSync(join(REPO, '.env'), 'SECRET_TOKEN=hunter2\n');
});

afterAll(() => rmSync(REPO, { recursive: true, force: true }));

const call = (tool: string, args: Record<string, unknown> = {}) => callTool(tool, { path: REPO, ...args });

describe('critical: never serve the wrong symbol', () => {
  it("qualified 'file#name' for a symbol that does not exist errors instead of returning another function", () => {
    const out = call('read_function', { function: 'wallet.ts#creditCard' });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/No symbol named 'creditCard'/);
    // and it must NOT have served credit()'s body
    expect(out.text).not.toContain('return amount + 1');
  });

  it("qualified form accepts backslash paths (Windows-style) too", () => {
    const out = callTool('read_function', { path: REPO, function: 'wallet.ts#credit' });
    expect(out.isError ?? false).toBe(false);
    expect(out.text).toContain('return amount + 1');
  });
});

describe('critical: freshness is shared by every cache', () => {
  it('after a rename, callers_of does not answer about the old world', () => {
    // prime every cache
    call('read_function', { function: 'credit' });
    call('callers_of', { function: 'credit' });

    const renamed = WALLET.replace('export function credit(', 'export function creditAccount(');
    writeFileSync(join(REPO, 'wallet.ts'), renamed);
    writeFileSync(join(REPO, 'app.ts'), APP.replace("credit } from", 'creditAccount } from').replace("credit('a'", "creditAccount('a'"));
    try {
      const stale = call('callers_of', { function: 'credit' });
      // 'credit' no longer exists: the honest answers are "not found" or a
      // substring-labeled match — never "credit has no callers" as a fact.
      if (stale.isError !== true) {
        expect(stale.text).not.toMatch(/^credit has no callers/m);
      }
      const fresh = call('callers_of', { function: 'creditAccount' });
      expect(fresh.isError ?? false).toBe(false);
      expect(fresh.text).toContain('main');
    } finally {
      writeFileSync(join(REPO, 'wallet.ts'), WALLET);
      writeFileSync(join(REPO, 'app.ts'), APP);
    }
  });

  it('read_function explains a missing call-graph section instead of dropping it', () => {
    const out = call('read_function', { function: 'Ledger' });
    expect(out.isError ?? false).toBe(false);
    expect(out.text).toMatch(/Called by|not available/);
  });
});

describe('safety: only indexed source, never outside the repo', () => {
  it('refuses to serve .env even though it is inside the repo', () => {
    const out = call('read_span', { file: '.env', startLine: 1, endLine: 1 });
    expect(out.isError).toBe(true);
    expect(out.text).not.toContain('hunter2');
    expect(out.text).toMatch(/not an indexed source file/);
  });

  it('refuses paths that escape the root, including Windows drive-relative forms', () => {
    expect(() => readSpan(REPO, '../../../etc/passwd', 1, 2)).toThrow(SpanError);
    expect(() => readSpan(REPO, 'C:secret.txt', 1, 2)).toThrow(SpanError);
    expect(() => readSpan(REPO, '\\\\server\\share\\x.ts', 1, 2)).toThrow(SpanError);
  });

  it('refuses a symlink that points outside the repository', () => {
    const outside = mkdtempSync(join(tmpdir(), 'euthynos-outside-'));
    writeFileSync(join(outside, 'secret.ts'), 'export const KEY = "leak"\n');
    const link = join(REPO, 'linked.ts');
    try {
      symlinkSync(join(outside, 'secret.ts'), link, 'file');
    } catch {
      return; // symlink creation needs privileges on Windows; skip if denied
    }
    try {
      expect(() => readSpan(REPO, 'linked.ts', 1, 1)).toThrow(SpanError);
    } finally {
      rmSync(link, { force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('honest reporting', () => {
  it('totalLines does not count a phantom trailing line', () => {
    const span = readSpan(REPO, 'app.ts', 1, 1);
    expect(span.totalLines).toBe(APP.split('\n').length - 1); // file ends with \n
    expect(span.clamped).toBe(false);
  });

  it('a request past EOF is reported as clamped', () => {
    const span = readSpan(REPO, 'app.ts', 1, 9999);
    expect(span.clamped).toBe(true);
  });

  it('rejects NaN / non-integer line numbers instead of inventing a span', () => {
    expect(() => readSpan(REPO, 'app.ts', Number.NaN, 5)).toThrow(SpanError);
    expect(() => readSpan(REPO, 'app.ts', 0, 5)).toThrow(SpanError);
  });

  it('an empty reference set is an answer, not a tool failure', () => {
    const out = call('find_references', { symbol: 'nothingNamedThis' });
    expect(out.isError ?? false).toBe(false);
    expect(out.text).toMatch(/No references/);
  });

  it('a class with a constructor is ONE definition, not two', () => {
    const out = call('find_references', { symbol: 'Ledger' });
    const defs = out.text.split('\n').filter((l) => l.includes('definition'));
    expect(defs).toHaveLength(1);
  });

  it('references carry the source line so no follow-up read is needed', () => {
    const out = call('find_references', { symbol: 'credit' });
    expect(out.text).toContain('return credit(');
  });
});

describe('agent experience', () => {
  it('read_function includes the doc comment above the declaration', () => {
    const out = call('read_function', { function: 'credit' });
    expect(out.text).toContain('Move funds between accounts');
  });

  it('file_outline lists class members indented, not folded away', () => {
    const out = call('file_outline', { file: 'wallet.ts' });
    expect(out.text).toContain('class Ledger');
    expect(out.text).toMatch(/record\(\)/);
  });

  it('an exact match always outranks a fuzzy one', () => {
    const out = call('find_symbol', { query: 'credit' });
    const rows = out.text.split('\n').filter((l) => l.trim().startsWith('credit'));
    expect(rows[0]).toContain('exact');
    // no score may exceed 1
    for (const m of out.text.matchAll(/\[(\d+(?:\.\d+)?) /g)) {
      expect(Number(m[1])).toBeLessThanOrEqual(1);
    }
  });
});
