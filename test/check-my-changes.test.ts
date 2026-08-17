import { describe, expect, it, beforeAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callTool } from '../src/mcp/tools.js';
import { resetDedup } from '../src/mcp/dedup.js';

/**
 * Phase 6 Step 4 — check_my_changes (plan C5). The two non-negotiables,
 * pinned harder than anything else here:
 *  1. It NEVER asserts safety — no "safe", no "isolated" as facts; the
 *     closing line hands the judgment to the agent.
 *  2. Boundary findings are NEWLY-INTRODUCED only, with the pre-existing
 *     count stated in the same sentence.
 */

function g(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });
}

let repo: string;

beforeAll(() => {
  resetDedup();
  repo = mkdtempSync(join(tmpdir(), 'cmc-'));
  mkdirSync(join(repo, 'src', 'core'), { recursive: true });
  mkdirSync(join(repo, 'src', 'api'), { recursive: true });
  mkdirSync(join(repo, 'test'), { recursive: true });
  // core: an index (public surface) + an internal file.
  writeFileSync(join(repo, 'src', 'core', 'index.ts'), "export { engine } from './internal';\n");
  writeFileSync(
    join(repo, 'src', 'core', 'internal.ts'),
    'export function engine(load: number): number {\n  return load * 3;\n}\n',
  );
  // api: imports core PROPERLY (via index) at HEAD.
  writeFileSync(
    join(repo, 'src', 'api', 'handler.ts'),
    "import { engine } from '../core/index';\n\nexport function handle(n: number): number {\n  return engine(n) + 1;\n}\n",
  );
  writeFileSync(
    join(repo, 'test', 'handler.test.ts'),
    "import { handle } from '../src/api/handler';\n\nexport function checkHandle(): void {\n  handle(2);\n}\n",
  );
  execFileSync('git', ['init', '-q', repo]);
  g(repo, 'add', '-A');
  g(repo, 'commit', '-q', '-m', 'v1', '--no-gpg-sign');
  // Worktree: modify handle (literal change), ADD a deep import into core
  // internals from a NEW file, remove nothing yet.
  writeFileSync(
    join(repo, 'src', 'api', 'handler.ts'),
    "import { engine } from '../core/index';\n\nexport function handle(n: number): number {\n  return engine(n) + 2;\n}\n",
  );
  writeFileSync(
    join(repo, 'src', 'api', 'shortcut.ts'),
    "import { engine } from '../core/internal';\n\nexport function sneak(n: number): number {\n  return engine(n);\n}\n",
  );
});

describe('check_my_changes', () => {
  it('reports header, scope, changed files and symbols', () => {
    const t = callTool('check_my_changes', { path: repo }).text;
    expect(t).toMatch(/Changes vs HEAD [0-9a-f]{12}/);
    expect(t).toContain('Symbol diff covers FUNCTION declarations');
    expect(t).toContain('[modified] src/api/handler.ts');
    expect(t).toContain('[untracked] src/api/shortcut.ts');
    expect(t).toMatch(/\[modified\] handle — src\/api\/handler\.ts:\d+/);
    expect(t).toMatch(/\[added\] sneak/);
  });

  it('boundary findings are NEWLY-INTRODUCED only, pre-existing count stated', () => {
    const t = callTool('check_my_changes', { path: repo }).text;
    expect(t).toMatch(/1 deep-import violation INTRODUCED by this diff \(pre-existing, unchanged: 0\)/);
    expect(t).toContain('src/api/shortcut.ts → src/core/internal.ts');
  });

  it('NEVER asserts safety; the judgment line closes every answer', () => {
    const t = callTool('check_my_changes', { path: repo }).text;
    expect(t.toLowerCase()).not.toMatch(/\bis safe\b|\bsafe to\b|\bno impact\b/);
    expect(t).toContain('evidence, not a verdict');
    expect(t).toContain('stays with you');
  });

  it('blast radius states the static-graph boundary; tests are route-labeled', () => {
    const t = callTool('check_my_changes', { path: repo }).text;
    expect(t).toContain('static call graph — dynamic dispatch and unindexed files are invisible');
    expect(t).toContain('test/handler.test.ts');
    expect(t).toMatch(/\[import-edge|\[test-call/);
  });

  it('policy section evaluates duplication deltas vs real HEAD and names the health-delta gap', () => {
    const t = callTool('check_my_changes', { path: repo }).text;
    expect(t).toMatch(/Policy \(default ratchet/);
    expect(t).toContain('health-delta vs HEAD');
    expect(t).toMatch(/NOT evaluated by this tool|not evaluated by this tool/);
  });

  it('stale-assumption warning fires only for files this session was served', () => {
    resetDedup();
    let t = callTool('check_my_changes', { path: repo }).text;
    expect(t).not.toContain('Stale-assumption warning');
    // Serve a span from the modified file, then re-check.
    const served = callTool('read_function', { path: repo, function: 'src/api/handler.ts#handle' });
    expect(served.isError ?? false).toBe(false);
    t = callTool('check_my_changes', { path: repo }).text;
    expect(t).toContain('Stale-assumption warning');
    expect(t).toContain('src/api/handler.ts');
    resetDedup();
  });

  it('a clean worktree answers honestly with its scope', () => {
    const clean = mkdtempSync(join(tmpdir(), 'cmc-clean-'));
    writeFileSync(join(clean, 'a.ts'), 'export const a = 1;\n');
    execFileSync('git', ['init', '-q', clean]);
    g(clean, 'add', '-A');
    g(clean, 'commit', '-q', '-m', 'v1', '--no-gpg-sign');
    const t = callTool('check_my_changes', { path: clean }).text;
    expect(t).toMatch(/No changes vs HEAD [0-9a-f]{12}/);
    expect(t).toContain('Scope: tracked changes vs HEAD');
  });

  it('degrades honestly without git', () => {
    const plain = mkdtempSync(join(tmpdir(), 'cmc-nogit-'));
    writeFileSync(join(plain, 'a.ts'), 'export const a = 1;\n');
    const t = callTool('check_my_changes', { path: plain }).text;
    expect(t).toContain('Diff-based analysis unavailable');
    expect(t).toContain('Worktree-only views still work');
  });

  it('a removed symbol is reported with the broken-callers note', () => {
    const rm = mkdtempSync(join(tmpdir(), 'cmc-rm-'));
    writeFileSync(join(rm, 'lib.ts'), 'export function keeper(): number {\n  return 1;\n}\nexport function victim(): number {\n  return 2;\n}\n');
    writeFileSync(join(rm, 'use.ts'), "import { victim } from './lib';\nexport function caller(): number {\n  return victim();\n}\n");
    execFileSync('git', ['init', '-q', rm]);
    g(rm, 'add', '-A');
    g(rm, 'commit', '-q', '-m', 'v1', '--no-gpg-sign');
    writeFileSync(join(rm, 'lib.ts'), 'export function keeper(): number {\n  return 1;\n}\n');
    const t = callTool('check_my_changes', { path: rm }).text;
    expect(t).toMatch(/\[removed\] victim — was lib\.ts:\d+/);
    expect(t).toContain('callers now reference a missing symbol');
    expect(t).toContain('find_references');
  });

  it('is deterministic on unchanged state', () => {
    resetDedup();
    const a = callTool('check_my_changes', { path: repo }).text;
    const b = callTool('check_my_changes', { path: repo }).text;
    expect(a).toBe(b);
  });
});
