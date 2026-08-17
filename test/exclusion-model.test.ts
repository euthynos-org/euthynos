import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callTool } from '../src/mcp/tools.js';
import { getIndex, resetIndexForTests, beginRequest } from '../src/index/incremental.js';
import { buildRepoGraph } from '../src/graph/repo.js';
import { scan } from '../src/scan.js';
import { diffWorktree } from '../src/diff/engine.js';

/**
 * G3 — ONE CANONICAL EXCLUSION MODEL.
 *
 * The effective ignore set published on `RepoIndex.ignore` (G2) is the
 * single authority for which files exist. This suite pins that EVERY tier
 * derives its universe from it — including the tiers that reach the
 * filesystem by a different route than discovery.
 *
 * The adversarial case: the diff engine learns about changed files from
 * GIT, not from discovery, so an excluded file can enter through that door
 * even though the index, graph and scan all correctly exclude it. A file
 * the user told us to ignore must not reappear as a "changed file" in the
 * evidence tools.
 *
 * The honesty rule is unchanged and load-bearing: excluding a file narrows
 * the SCOPE of an answer, so the scope must say so. Silence would turn a
 * narrowed answer into an unbounded claim.
 */

function git(root: string, ...args: string[]): void {
  execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { stdio: 'pipe' });
}

let repo: string;

function w(rel: string, body: string): void {
  const abs = join(repo, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, body);
}

function setIgnore(globs: string[] | null): void {
  mkdirSync(join(repo, '.euthynos'), { recursive: true });
  if (globs === null) rmSync(join(repo, '.euthynos', 'config.json'), { force: true });
  else writeFileSync(join(repo, '.euthynos', 'config.json'), JSON.stringify({ ignore: globs }));
  resetIndexForTests(); // config is read per sweep; drop derived state deliberately
}

beforeEach(() => {
  resetIndexForTests();
  repo = mkdtempSync(join(tmpdir(), 'excl-'));
  w('src/app.ts', "import { gen } from '../generated/big';\nexport function app(): number {\n  return gen();\n}\n");
  w('generated/big.ts', 'export function gen(): number {\n  return 42;\n}\n');
  w('thirdparty/lib.ts', 'export function vendored(): number {\n  return 7;\n}\n');
  w('src/keep.ts', 'export function keep(): number {\n  return 1;\n}\n');
  execFileSync('git', ['init', '-q', repo], { stdio: 'pipe' });
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init', '--no-gpg-sign');
});

describe('G3 — one universe across every tier', () => {
  it('the configured globs apply identically to index, graph and scan', () => {
    setIgnore(['generated/**']);
    const idx = getIndex(repo);
    const paths = idx.files.map((f) => f.path);
    expect(paths).not.toContain('generated/big.ts');

    const graph = buildRepoGraph(repo, { ignore: idx.ignore, files: idx.files, moduleGraph: idx.moduleGraph });
    expect([...graph.nodes.keys()].some((k) => k.includes('generated/big.ts'))).toBe(false);

    const report = scan(repo, { ignore: idx.ignore, files: idx.files });
    expect(report.modules.some((m) => m.name === 'generated')).toBe(false);
  });

  it('the regression case: callers_of cannot resolve a symbol from an ignored file', () => {
    setIgnore(['generated/**']);
    const r = callTool('callers_of', { path: repo, function: 'gen' });
    expect(r.text).not.toMatch(/d1 app/);
  });

  it('ADVERSARIAL: an ignored file changed on disk does not enter via the diff tier', () => {
    setIgnore(['generated/**']);
    w('generated/big.ts', 'export function gen(): number {\n  return 999;\n}\n');
    w('src/keep.ts', 'export function keep(): number {\n  return 2;\n}\n');

    beginRequest();
    const idx = getIndex(repo);
    const d = diffWorktree(repo, new Map(idx.files.map((f) => [f.path, f])), idx.ignore);
    const changed = d.changedFiles.map((f) => f.path);
    expect(changed).toContain('src/keep.ts');
    expect(changed).not.toContain('generated/big.ts');
  });

  it('ADVERSARIAL: the same file cannot reappear through check_my_changes', () => {
    setIgnore(['generated/**']);
    w('generated/big.ts', 'export function gen(): number {\n  return 1234;\n}\n');
    const r = callTool('check_my_changes', { path: repo });
    expect(r.text).not.toContain('generated/big.ts');
  });

  it('ADVERSARIAL: a RENAME within the ignored tree stays excluded', () => {
    setIgnore(['generated/**']);
    execFileSync('git', ['-C', repo, 'mv', 'generated/big.ts', 'generated/renamed.ts'], { stdio: 'pipe' });
    beginRequest();
    const idx = getIndex(repo);
    const d = diffWorktree(repo, new Map(idx.files.map((f) => [f.path, f])), idx.ignore);
    const paths = d.changedFiles.flatMap((f) => [f.path, f.oldPath ?? '']);
    expect(paths).not.toContain('generated/big.ts');
    expect(paths).not.toContain('generated/renamed.ts');
  });

  it('a rename OUT of an ignored tree is still reported (exclusion is not a black hole)', () => {
    setIgnore(['generated/**']);
    execFileSync('git', ['-C', repo, 'mv', 'generated/big.ts', 'src/promoted.ts'], { stdio: 'pipe' });
    beginRequest();
    const idx = getIndex(repo);
    const d = diffWorktree(repo, new Map(idx.files.map((f) => [f.path, f])), idx.ignore);
    // The destination is inside the universe, so the change is visible.
    expect(d.changedFiles.map((f) => f.path)).toContain('src/promoted.ts');
  });

  it('ADVERSARIAL: nor as an UNTRACKED addition inside an ignored tree', () => {
    setIgnore(['generated/**']);
    w('generated/brand-new.ts', 'export function brandNew(): number {\n  return 5;\n}\n');
    const r = callTool('check_my_changes', { path: repo });
    expect(r.text).not.toContain('generated/brand-new.ts');
  });
});

describe('G3 — default exclusions unchanged', () => {
  it('built-in skips still apply with no config at all', () => {
    setIgnore(null);
    mkdirSync(join(repo, 'node_modules'), { recursive: true });
    writeFileSync(join(repo, 'node_modules', 'dep.ts'), 'export function dep(): number {\n  return 1;\n}\n');
    const paths = getIndex(repo).files.map((f) => f.path);
    expect(paths.some((p) => p.startsWith('node_modules/'))).toBe(false);
    expect(paths).toContain('src/app.ts');
  });

  it('with no config, nothing is excluded beyond the built-ins', () => {
    setIgnore(null);
    const paths = getIndex(repo).files.map((f) => f.path);
    expect(paths).toContain('generated/big.ts');
    expect(paths).toContain('thirdparty/lib.ts');
  });
});

describe('G3 — rule changes rebuild derived state', () => {
  it('adding a rule removes the file from every tier', () => {
    setIgnore(null);
    expect(getIndex(repo).files.map((f) => f.path)).toContain('generated/big.ts');
    setIgnore(['generated/**']);
    expect(getIndex(repo).files.map((f) => f.path)).not.toContain('generated/big.ts');
    expect(callTool('repo_map', { path: repo }).text).not.toContain('generated');
  });

  it('removing a rule brings it back', () => {
    setIgnore(['generated/**']);
    expect(getIndex(repo).files.map((f) => f.path)).not.toContain('generated/big.ts');
    setIgnore(null);
    expect(getIndex(repo).files.map((f) => f.path)).toContain('generated/big.ts');
  });
});

describe('G3 — glob semantics are deterministic', () => {
  it('overlapping globs are stable and order-independent', () => {
    setIgnore(['generated/**', '**/big.ts', 'generated/big.ts']);
    const a = getIndex(repo).files.map((f) => f.path).sort();
    setIgnore(['generated/big.ts', '**/big.ts', 'generated/**']);
    const b = getIndex(repo).files.map((f) => f.path).sort();
    expect(a).toEqual(b);
    expect(a).not.toContain('generated/big.ts');
  });

  it('a glob matching nothing changes nothing', () => {
    setIgnore(['nonexistent/**']);
    const withRule = getIndex(repo).files.map((f) => f.path).sort();
    setIgnore(null);
    const without = getIndex(repo).files.map((f) => f.path).sort();
    expect(withRule).toEqual(without);
  });

  it('multiple distinct trees can be excluded together', () => {
    setIgnore(['generated/**', 'thirdparty/**']);
    const paths = getIndex(repo).files.map((f) => f.path);
    expect(paths).not.toContain('generated/big.ts');
    expect(paths).not.toContain('thirdparty/lib.ts');
    expect(paths).toContain('src/keep.ts');
  });
});

describe('G3 — exclusions are represented honestly', () => {
  it('an answer narrowed by exclusions still states its scope', () => {
    setIgnore(['generated/**']);
    const r = callTool('callers_of', { path: repo, function: 'app' });
    // Whatever the result, the boundary language survives: a negative is
    // never emitted bare.
    expect(r.text.toLowerCase()).toMatch(/static|indexed|graph|boundary|not found/);
  });

  it('no negative claim expands beyond the excluded universe', () => {
    setIgnore(['generated/**']);
    const r = callTool('find_references', { path: repo, symbol: 'gen' });
    // Guard the guard: an errored call would satisfy the negative assertion
    // below vacuously, which is how a test stops testing anything.
    expect(r.isError ?? false).toBe(false);
    // It must not assert repo-wide absence while a whole tree is excluded.
    expect(r.text).not.toMatch(/no (other )?references (exist|anywhere)/i);
  });
});
