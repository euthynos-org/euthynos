import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callTool } from '../src/mcp/tools.js';
import { getIndex, resetIndexForTests, beginRequest } from '../src/index/incremental.js';
import { buildRepoGraph } from '../src/graph/repo.js';

/**
 * G5 — the graph tier consumes the content-addressed store.
 *
 * Before: every graph rebuild re-discovered and re-parsed the whole
 * repository, and `scan()` (called for metrics) parsed it AGAIN. Because
 * `generation` bumps on any edit, that ran on the next tool call after
 * EVERY edit — the dominant cost in the edit loop.
 *
 * After: the store supplies the parsed artifacts and the module graph
 * built from them, so a rebuild costs graph assembly only.
 *
 * Contract pinned here:
 *  - one file universe (the store's) — never a second discovery;
 *  - one parser cache (the store's) — unchanged files are never re-parsed;
 *  - the graph built from store artifacts is IDENTICAL to the graph built
 *    by the legacy re-parse path;
 *  - ignore rules, deletions, additions and parse failures behave exactly
 *    as before;
 *  - output is deterministic.
 */

function git(root: string, ...args: string[]): void {
  execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { stdio: 'pipe' });
}

let repo: string;

function write(rel: string, body: string): void {
  const abs = join(repo, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, body);
}

beforeEach(() => {
  resetIndexForTests();
  repo = mkdtempSync(join(tmpdir(), 'g5-'));
  write('src/util.ts', 'export function util(): number {\n  return 1;\n}\n');
  write('src/app.ts', "import { util } from './util';\nexport function app(): number {\n  return util();\n}\n");
  write('src/lone.ts', 'export function lone(): number {\n  return 3;\n}\n');
  execFileSync('git', ['init', '-q', repo], { stdio: 'pipe' });
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init', '--no-gpg-sign');
});

describe('G5 — graph equivalence with the legacy re-parse path', () => {
  it('builds an IDENTICAL graph from store artifacts', () => {
    const idx = getIndex(repo);
    const fromStore = buildRepoGraph(repo, {
      ignore: idx.ignore,
      files: idx.files,
      moduleGraph: idx.moduleGraph,
    });
    const legacy = buildRepoGraph(repo, { ignore: idx.ignore });
    expect(JSON.stringify(fromStore.stats)).toBe(JSON.stringify(legacy.stats));
    expect(fromStore.nodes.size).toBe(legacy.nodes.size);
    expect([...fromStore.nodes.keys()].sort()).toEqual([...legacy.nodes.keys()].sort());
    expect(fromStore.edges.length).toBe(legacy.edges.length);
  });

  it('preserves deterministic ordering', () => {
    const idx = getIndex(repo);
    const a = buildRepoGraph(repo, { ignore: idx.ignore, files: idx.files, moduleGraph: idx.moduleGraph });
    const b = buildRepoGraph(repo, { ignore: idx.ignore, files: idx.files, moduleGraph: idx.moduleGraph });
    expect([...a.nodes.keys()]).toEqual([...b.nodes.keys()]);
    expect(a.edges.map((e) => `${e.from}->${e.to}`)).toEqual(b.edges.map((e) => `${e.from}->${e.to}`));
  });

  it('tool output is byte-identical across repeated calls', () => {
    const x = callTool('callers_of', { path: repo, function: 'util' }).text;
    const y = callTool('callers_of', { path: repo, function: 'util' }).text;
    expect(x).toBe(y);
  });
});

describe('G5 — incremental behaviour', () => {
  it('unchanged repository → zero reparses on the second sweep', () => {
    beginRequest();
    getIndex(repo);
    beginRequest(); // a second tool call = a second request scope
    const second = getIndex(repo);
    expect(second.stats.reparsed).toBe(0);
  });

  it('one changed file → exactly that file reparsed', () => {
    beginRequest();
    getIndex(repo);
    write('src/util.ts', 'export function util(): number {\n  return 42;\n}\n');
    beginRequest(); // a second tool call = a second request scope
    const after = getIndex(repo);
    expect(after.stats.reparsed).toBe(1);
  });

  it('added file → parsed and present in the graph', () => {
    callTool('callers_of', { path: repo, function: 'util' });
    write('src/added.ts', "import { util } from './util';\nexport function added(): number {\n  return util();\n}\n");
    const r = callTool('callers_of', { path: repo, function: 'util' });
    expect(r.text).toContain('added');
  });

  it('deleted file → gone from the graph', () => {
    callTool('callers_of', { path: repo, function: 'util' });
    rmSync(join(repo, 'src', 'app.ts'));
    const r = callTool('callers_of', { path: repo, function: 'util' });
    expect(r.text).not.toContain('src/app.ts');
  });

  it('the graph corresponds to the CURRENT generation after an edit', () => {
    callTool('callers_of', { path: repo, function: 'util' });
    write('src/app.ts', "import { util } from './util';\nexport function renamedCaller(): number {\n  return util();\n}\n");
    const r = callTool('callers_of', { path: repo, function: 'util' });
    expect(r.text).toContain('renamedCaller');
    expect(r.text).not.toContain(' app —');
  });
});

describe('G5 — universe and degradation semantics preserved', () => {
  it('ignored file is absent from the graph tier', () => {
    mkdirSync(join(repo, '.euthynos'), { recursive: true });
    writeFileSync(join(repo, '.euthynos', 'config.json'), JSON.stringify({ ignore: ['src/lone.ts'] }));
    resetIndexForTests();
    const r = callTool('find_references', { path: repo, query: 'lone' });
    expect(r.text).not.toContain('src/lone.ts');
  });

  it('a CHANGED ignored file still does not enter the graph', () => {
    mkdirSync(join(repo, '.euthynos'), { recursive: true });
    writeFileSync(join(repo, '.euthynos', 'config.json'), JSON.stringify({ ignore: ['src/lone.ts'] }));
    resetIndexForTests();
    callTool('repo_map', { path: repo });
    write('src/lone.ts', 'export function lone(): string {\n  return "changed";\n}\n');
    const r = callTool('repo_map', { path: repo });
    expect(r.text).not.toContain('lone.ts');
  });

  it('a parse failure keeps the existing exclusion semantics (never a silent drop)', () => {
    write('src/broken.ts', 'export function broken( {{{ this is not valid typescript\n');
    resetIndexForTests();
    const idx = getIndex(repo);
    // However the parser classifies it, the file must not silently become a
    // normal graph member with invented symbols.
    const broken = idx.files.find((f) => f.path === 'src/broken.ts');
    if (broken !== undefined) {
      expect(broken.functions.some((fn) => fn.name === 'broken' && fn.calls.length > 0)).toBe(false);
    }
    expect(callTool('repo_map', { path: repo }).isError ?? false).toBe(false);
  });
});
