import { describe, expect, it, beforeAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callTool } from '../src/mcp/tools.js';

/**
 * The three diff-scoped composition tools — boundary_check, diff_context and
 * change_impact. Each is a thin projection of the git diff engine over the
 * existing index rather than fresh analysis, so what these tests pin is not the
 * analysis but the HONESTY shape of the answers: scoped negatives, named
 * omissions, stated boundaries, no safety claims.
 */

function g(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });
}

let repo: string;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'p6s5-'));
  mkdirSync(join(repo, 'src', 'core'), { recursive: true });
  mkdirSync(join(repo, 'src', 'api'), { recursive: true });
  mkdirSync(join(repo, 'test'), { recursive: true });
  writeFileSync(join(repo, 'src', 'core', 'index.ts'), "export { engine } from './internal';\n");
  writeFileSync(join(repo, 'src', 'core', 'internal.ts'), 'export function engine(load: number): number {\n  return load * 3;\n}\n');
  writeFileSync(
    join(repo, 'src', 'api', 'handler.ts'),
    "import { engine } from '../core/index';\n\nexport function handle(n: number): number {\n  return engine(n) + 1;\n}\n\nexport function audit(n: number): number {\n  return handle(n) * 2;\n}\n",
  );
  writeFileSync(
    join(repo, 'test', 'handler.test.ts'),
    "import { handle } from '../src/api/handler';\n\nexport function checkHandle(): void {\n  handle(2);\n}\n",
  );
  execFileSync('git', ['init', '-q', repo]);
  g(repo, 'add', '-A');
  g(repo, 'commit', '-q', '-m', 'v1', '--no-gpg-sign');
  // Worktree: modify handle; add a deep import.
  writeFileSync(
    join(repo, 'src', 'api', 'handler.ts'),
    "import { engine } from '../core/index';\n\nexport function handle(n: number): number {\n  return engine(n) + 5;\n}\n\nexport function audit(n: number): number {\n  return handle(n) * 2;\n}\n",
  );
  writeFileSync(join(repo, 'src', 'api', 'shortcut.ts'), "import { engine } from '../core/internal';\n\nexport function sneak(n: number): number {\n  return engine(n);\n}\n");
});

describe('boundary_check', () => {
  it('diff scope reports INTRODUCED-only with pre-existing count and the soundness disclaimer', () => {
    const t = callTool('boundary_check', { path: repo }).text;
    expect(t).toMatch(/diff scope, vs HEAD [0-9a-f]{12}/);
    expect(t).toMatch(/1 deep-import violation INTRODUCED \(pre-existing: 0\)/);
    expect(t).toContain('src/api/shortcut.ts → src/core/internal.ts');
    expect(t).toContain('Not a claim the architecture is sound');
  });

  it('module scope reports deep imports INTO the module and cycles, scoped', () => {
    const t = callTool('boundary_check', { path: repo, module: 'core' }).text;
    expect(t).toContain('Boundary check for module core');
    expect(t).toContain('Deep imports INTO core (1)');
    expect(t).toContain('No import cycles involving core detected');
    expect(t).toContain('Not a claim the architecture is sound');
  });

  it('module miss lists what exists', () => {
    const r = callTool('boundary_check', { path: repo, module: 'nope_xyz' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('core');
  });
});

describe('diff_context', () => {
  it('serves spans for changed symbols with callers, route-labeled tests, and NAMED omissions', () => {
    const t = callTool('diff_context', { path: repo }).text;
    expect(t).toMatch(/Context for \d+ of \d+ changed symbol/);
    expect(t).toContain('[modified] src/api/handler.ts#handle');
    expect(t).toContain('return engine(n) + 5'); // the actual span, current worktree
    expect(t).toMatch(/Direct callers: .*audit/);
    expect(t).toMatch(/Tests: .*handler\.test\.ts \[.*import-edge/);
  });

  it('degrades honestly without git', () => {
    const plain = mkdtempSync(join(tmpdir(), 'p6s5-nogit-'));
    writeFileSync(join(plain, 'a.ts'), 'export const a = 1;\n');
    const t = callTool('diff_context', { path: plain }).text;
    expect(t).toContain('Diff-based analysis unavailable');
    expect(t).toContain('context_bundle');
  });
});

describe('change_impact', () => {
  it('traces each modified symbol with the static-graph boundary and a union count', () => {
    const t = callTool('change_impact', { path: repo }).text;
    expect(t).toMatch(/Change impact vs HEAD [0-9a-f]{12}/);
    expect(t).toContain('static call graph — dynamic dispatch and unindexed files are invisible');
    expect(t).toMatch(/handle — /);
    expect(t).toMatch(/Union: \d+ distinct function/);
    expect(t.toLowerCase()).not.toMatch(/\bis safe\b|\bsafe to\b/);
  });

  it('a diff with no modified/removed symbols answers honestly', () => {
    const clean = mkdtempSync(join(tmpdir(), 'p6s5-clean-'));
    writeFileSync(join(clean, 'a.ts'), 'export const a = 1;\n');
    execFileSync('git', ['init', '-q', clean]);
    g(clean, 'add', '-A');
    g(clean, 'commit', '-q', '-m', 'v1', '--no-gpg-sign');
    writeFileSync(join(clean, 'b.ts'), 'export function fresh(): number {\n  return 1;\n}\n');
    const t = callTool('change_impact', { path: clean }).text;
    expect(t).toContain('No modified or removed symbols');
    expect(t).toContain('Added symbols have no callers yet by definition');
  });
});

describe('compositions are deterministic', () => {
  it('byte-identical on unchanged state', () => {
    for (const [tool, args] of [
      ['boundary_check', { path: repo }],
      ['diff_context', { path: repo }],
      ['change_impact', { path: repo }],
    ] as const) {
      const a = callTool(tool, args as Record<string, unknown>).text;
      const b = callTool(tool, args as Record<string, unknown>).text;
      expect(a).toBe(b);
    }
  });
});
