import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callTool } from '../src/mcp/tools.js';
import { beginRequest, resetIndexForTests, getIndex } from '../src/index/incremental.js';
import { runGitLog, disableGitRequestCacheForTests, gitCallCountForTests } from '../src/git/run.js';
import { diffWorktree } from '../src/diff/engine.js';
import { readChangeOracle } from '../src/index/change-oracle.js';

/**
 * REQUEST-SCOPED GIT SHARING.
 *
 * Measured (10,000 files): a single diff-tool call spent
 *   rev-parse 56ms · diff --numstat 292ms · diff --name-status 284ms ·
 *   status --porcelain -uall 302ms   … and the change oracle ran its OWN
 *   status --porcelain for 303ms in the same tool call.
 *
 * Two processes answering the same question inside one request. The fix is
 * scope, not architecture: git results are memoised for the lifetime of ONE
 * request (the scope `beginRequest()` already defines), and the oracle now
 * issues the SAME invocation the diff engine does so they share it.
 *
 * The `rev-parse --short=12 HEAD` call is NOT removed: `d.head` is printed
 * in tool output ("Changes vs HEAD <sha>"), so it is load-bearing for a
 * frozen output contract, and it doubles as the has-commits probe.
 *
 * Safety contract pinned here:
 *  - within a request, identical invocations run once;
 *  - across requests, nothing is reused (a tool call never sees another
 *    call's git state);
 *  - different roots never share an entry;
 *  - any status output the oracle cannot parse with confidence degrades to
 *    "unknown", which forces a full stat sweep — never a waived stat.
 */

function git(root: string, ...args: string[]): void {
  execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { stdio: 'pipe' });
}

let repo: string;
let repoB: string;

function w(root: string, rel: string, body: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, body);
}

beforeEach(() => {
  resetIndexForTests();
  disableGitRequestCacheForTests();
  repo = mkdtempSync(join(tmpdir(), 'gitreq-'));
  w(repo, 'src/a.ts', 'export function a(): number {\n  return 1;\n}\n');
  w(repo, 'src/b.ts', "import { a } from './a';\nexport function b(): number {\n  return a();\n}\n");
  w(repo, 'src/gone.ts', 'export function gone(): number {\n  return 9;\n}\n');
  execFileSync('git', ['init', '-q', repo], { stdio: 'pipe' });
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init', '--no-gpg-sign');

});

/** Built on demand: only the cross-root test needs a second repository, and
 *  every extra git process is real cost. */
function makeRepoB(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gitreqB-'));
  w(dir, 'src/other.ts', 'export function other(): number {\n  return 2;\n}\n');
  execFileSync('git', ['init', '-q', dir], { stdio: 'pipe' });
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init', '--no-gpg-sign');
  return dir;
}

describe('request-scoped git cache — correctness', () => {
  it('identical invocations inside one request run git ONCE', () => {
    beginRequest();
    const before = gitCallCountForTests();
    const a = runGitLog(repo, ['status', '--porcelain', '-uall']);
    const b = runGitLog(repo, ['status', '--porcelain', '-uall']);
    expect(b).toBe(a);
    expect(gitCallCountForTests() - before).toBe(1);
  });

  it('a NEW request never reuses the previous request state (no stale leak)', () => {
    beginRequest();
    const first = runGitLog(repo, ['status', '--porcelain', '-uall']);
    expect(first.includes('new.ts')).toBe(false);

    w(repo, 'src/new.ts', 'export function fresh(): number {\n  return 5;\n}\n');
    beginRequest(); // a second tool call
    const second = runGitLog(repo, ['status', '--porcelain', '-uall']);
    expect(second).toContain('new.ts');
  });

  it('different roots never share a cache entry', () => {
    // Make the two repos genuinely distinguishable first: two CLEAN repos
    // both report an empty status, which would prove nothing.
    repoB = makeRepoB();
    w(repo, 'src/onlyA.ts', 'export function onlyA(): number {\n  return 1;\n}\n');
    w(repoB, 'src/onlyB.ts', 'export function onlyB(): number {\n  return 1;\n}\n');
    beginRequest();
    const fromA = runGitLog(repo, ['status', '--porcelain', '-uall']);
    const fromB = runGitLog(repoB, ['status', '--porcelain', '-uall']);
    expect(fromA).toContain('onlyA.ts');
    expect(fromA).not.toContain('onlyB.ts');
    expect(fromB).toContain('onlyB.ts');
    expect(fromB).not.toContain('onlyA.ts');
  });

  it('different argument lists are cached separately', () => {
    beginRequest();
    const status = runGitLog(repo, ['status', '--porcelain', '-uall']);
    const head = runGitLog(repo, ['rev-parse', '--short=12', 'HEAD']);
    expect(status).not.toBe(head);
  });
});

describe('diff engine results are unchanged by sharing', () => {
  function snapshot(root: string) {
    // diffWorktree needs the CURRENT parsed files to pair old vs new; the
    // index is the single authority for that set (G2/G5).
    const idx = getIndex(root);
    const currentByPath = new Map(idx.files.map((f) => [f.path, f]));
    const d = diffWorktree(root, currentByPath);
    return {
      available: d.gitAvailable,
      head: d.head,
      files: d.changedFiles.map((f) => `${f.status}:${f.path}${f.oldPath ? `<-${f.oldPath}` : ''}`).sort(),
      symbols: d.symbolChanges.map((s) => `${s.kind}:${s.name}`).sort(),
      oldBlobs: [...d.oldParsed.keys()].sort(),
      skipped: d.skipped.map((s) => s.path).sort(),
    };
  }

  it('clean repository: no changes, and that is stable', () => {
    beginRequest();
    const s = snapshot(repo);
    expect(s.available).toBe(true);
    expect(s.files).toEqual([]);
    beginRequest();
    expect(snapshot(repo)).toEqual(s);
  });

  it('classifies added / modified / deleted / untracked identically', () => {
    w(repo, 'src/a.ts', 'export function a(): number {\n  return 111;\n}\n'); // modified
    w(repo, 'src/added.ts', 'export function added(): number {\n  return 2;\n}\n');
    git(repo, 'add', 'src/added.ts'); // staged add
    rmSync(join(repo, 'src', 'gone.ts')); // deleted
    w(repo, 'src/untracked.ts', 'export function untracked(): number {\n  return 3;\n}\n');

    beginRequest();
    const s = snapshot(repo);
    expect(s.files).toContain('modified:src/a.ts');
    expect(s.files).toContain('added:src/added.ts');
    expect(s.files).toContain('deleted:src/gone.ts');
    expect(s.files).toContain('untracked:src/untracked.ts');
  });

  it('selects the same OLD BLOBS for the symbol diff', () => {
    w(repo, 'src/a.ts', 'export function a(): number {\n  return 222;\n}\n');
    beginRequest();
    const s1 = snapshot(repo);
    beginRequest();
    const s2 = snapshot(repo);
    expect(s1.oldBlobs).toEqual(s2.oldBlobs);
    expect(s1.oldBlobs).toContain('src/a.ts');
  });

  it('tool output stays deterministic and byte-identical', () => {
    w(repo, 'src/a.ts', 'export function a(): number {\n  return 333;\n}\n');
    const x = callTool('check_my_changes', { path: repo }).text;
    const y = callTool('check_my_changes', { path: repo }).text;
    expect(x).toBe(y);
    expect(x).toContain('src/a.ts');
  });
});

describe('oracle shares the diff engine invocation without losing safety', () => {
  it('still reports modified and untracked files', () => {
    w(repo, 'src/a.ts', 'export function a(): number {\n  return 444;\n}\n');
    w(repo, 'src/brand.ts', 'export function brand(): number {\n  return 1;\n}\n');
    beginRequest();
    const o = readChangeOracle(repo);
    expect(o.kind).toBe('git');
    expect(o.changed!.has('src/a.ts')).toBe(true);
    expect(o.changed!.has('src/brand.ts')).toBe(true);
    expect(o.tracked!.has('src/brand.ts')).toBe(false);
  });

  it('reports BOTH sides of a rename', () => {
    execFileSync('git', ['-C', repo, 'mv', 'src/gone.ts', 'src/moved.ts'], { stdio: 'pipe' });
    beginRequest();
    const o = readChangeOracle(repo);
    expect(o.changed!.has('src/gone.ts')).toBe(true);
    expect(o.changed!.has('src/moved.ts')).toBe(true);
  });

  it('a path it cannot parse confidently degrades to unknown, never a waived stat', () => {
    // A quoted path (git quotes unusual bytes) must not be silently
    // mis-attributed: the oracle gives up rather than waive a stat.
    w(repo, 'src/we irdé.ts', 'export function weird(): number {\n  return 1;\n}\n');
    beginRequest();
    const o = readChangeOracle(repo);
    if (o.kind === 'git') {
      // If it parsed it, it must be present — not silently dropped.
      expect([...o.changed!].some((p) => p.includes('ird'))).toBe(true);
    } else {
      expect(o.changed).toBeNull(); // fail-safe: caller stats everything
    }
  });
});
