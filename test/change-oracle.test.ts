import { describe, expect, it, beforeAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getIndex, resetIndexForTests } from '../src/index/incremental.js';
import { readChangeOracle } from '../src/index/change-oracle.js';

/**
 * CHANGE ORACLE (launch blocker G0) — O(changed), not O(all files).
 *
 * Measured 2026-08-15 on a 10,000-file repo: directory enumeration costs
 * 69 ms while one statSync per file costs 2,025 ms — 97% of the sweep.
 * `git status --porcelain` answers "what moved?" in 73 ms because git
 * keeps cached stat data of its own.
 *
 * So the engine keeps its OWN enumeration (file-set semantics, ignore
 * globs, SKIP_DIRS, symlink and cap rules stay byte-identical) and uses
 * git only to decide WHICH files still need a stat.
 *
 * Correctness contract pinned here BEFORE implementation:
 *  - the index produced with the oracle is IDENTICAL to the index
 *    produced by the full-stat walk — same files, same hashes;
 *  - a file git does not track (untracked OR gitignored) is ALWAYS
 *    stat'ed, because git would not report a change to it;
 *  - no git (or a git failure) degrades to the full walk, silently
 *    correct and never wrong;
 *  - the oracle's trust level is exactly the existing size+mtime fast
 *    path's: both trust stat metadata, so this adds no new staleness
 *    class.
 */

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

let repo: string;
let noGitRepo: string;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'oracle-'));
  mkdirSync(join(repo, 'src'), { recursive: true });
  for (let i = 0; i < 12; i++) {
    writeFileSync(join(repo, 'src', `f${i}.ts`), `export function f${i}(): number {\n  return ${i};\n}\n`);
  }
  execFileSync('git', ['init', '-q', repo], { stdio: 'pipe' });
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init', '--no-gpg-sign');

  noGitRepo = mkdtempSync(join(tmpdir(), 'oracle-nogit-'));
  mkdirSync(join(noGitRepo, 'src'), { recursive: true });
  writeFileSync(join(noGitRepo, 'src', 'a.ts'), 'export function a(): number {\n  return 1;\n}\n');
});

describe('change oracle', () => {
  it('reports a git-backed oracle on a git repo', () => {
    const o = readChangeOracle(repo);
    expect(o.kind).toBe('git');
    expect(o.tracked).not.toBeNull();
    expect(o.tracked!.has('src/f0.ts')).toBe(true);
    expect(o.changed!.size).toBe(0); // clean tree
  });

  it('degrades to no-oracle without git, never guessing', () => {
    const o = readChangeOracle(noGitRepo);
    expect(o.kind).toBe('none');
    expect(o.changed).toBeNull(); // null = "unknown", caller must stat everything
  });

  it('sees a modified tracked file', () => {
    writeFileSync(join(repo, 'src', 'f3.ts'), 'export function f3(): number {\n  return 999;\n}\n');
    const o = readChangeOracle(repo);
    expect(o.changed!.has('src/f3.ts')).toBe(true);
  });

  it('sees an untracked file and does not claim it is tracked', () => {
    writeFileSync(join(repo, 'src', 'brand-new.ts'), 'export function brandNew(): number {\n  return 1;\n}\n');
    const o = readChangeOracle(repo);
    expect(o.changed!.has('src/brand-new.ts')).toBe(true);
    expect(o.tracked!.has('src/brand-new.ts')).toBe(false);
  });

  it('sees a deleted tracked file', () => {
    rmSync(join(repo, 'src', 'f9.ts'));
    const o = readChangeOracle(repo);
    expect(o.changed!.has('src/f9.ts')).toBe(true);
  });

  it('sees a rename as both sides', () => {
    renameSync(join(repo, 'src', 'f8.ts'), join(repo, 'src', 'f8-renamed.ts'));
    const o = readChangeOracle(repo);
    expect(o.changed!.has('src/f8.ts')).toBe(true);
    expect(o.changed!.has('src/f8-renamed.ts')).toBe(true);
  });

  it('uses forward slashes on every platform', () => {
    const o = readChangeOracle(repo);
    for (const p of o.tracked!) expect(p).not.toContain('\\');
  });
});

describe('index equivalence: oracle path vs full-stat walk', () => {
  function snapshot(root: string, useOracle: boolean) {
    resetIndexForTests();
    const idx = getIndex(root, { useChangeOracle: useOracle, oracleMinFiles: 0 });
    return idx.files
      .map((f) => `${f.path}|${f.functions.map((fn) => `${fn.name}:${fn.bodyHash}`).sort().join(',')}`)
      .sort();
  }

  it('produces an IDENTICAL index either way (clean tree)', () => {
    expect(snapshot(repo, true)).toEqual(snapshot(repo, false));
  });

  it('produces an IDENTICAL index either way (dirty tree)', () => {
    writeFileSync(join(repo, 'src', 'f5.ts'), 'export function f5(): string {\n  return "edited";\n}\n');
    writeFileSync(join(repo, 'src', 'untracked2.ts'), 'export function untracked2(): number {\n  return 7;\n}\n');
    expect(snapshot(repo, true)).toEqual(snapshot(repo, false));
  });

  it('picks up an edit made AFTER a warm oracle sweep (staleness guard)', () => {
    // The safety-critical case: warm the index, then edit. A waived stat
    // here would serve pre-edit content — the exact failure this oracle
    // must never introduce.
    //
    // Graded on literalHash, NOT bodyHash: bodyHash is structurally
    // normalised and literal-blind by design (deviation D9), so
    // `return 1` and `return "x"` share a bodyHash. literalHash is the
    // field that moves when only literals change.
    resetIndexForTests();
    const before = getIndex(repo, { useChangeOracle: true, oracleMinFiles: 0 });
    const beforeFn = before.files.find((f) => f.path === 'src/f1.ts')?.functions[0];

    writeFileSync(join(repo, 'src', 'f1.ts'), 'export function f1(): string {\n  return "changed-after-warm";\n}\n');

    const after = getIndex(repo, { useChangeOracle: true, oracleMinFiles: 0 });
    const afterFn = after.files.find((f) => f.path === 'src/f1.ts')?.functions[0];

    expect(afterFn).toBeDefined();
    expect(afterFn!.literalHash).not.toBe(beforeFn!.literalHash);
    expect(after.stats.reparsed).toBeGreaterThan(0);
    expect(after.generation).toBeGreaterThan(before.generation);
  });

  it('a file edited twice in a row is re-read both times', () => {
    resetIndexForTests();
    getIndex(repo, { useChangeOracle: true, oracleMinFiles: 0 });
    writeFileSync(join(repo, 'src', 'f2.ts'), 'export function f2(): number {\n  return 111;\n}\n');
    const a = getIndex(repo, { useChangeOracle: true, oracleMinFiles: 0 }).files.find((f) => f.path === 'src/f2.ts')!.functions[0]!;
    writeFileSync(join(repo, 'src', 'f2.ts'), 'export function f2(): number {\n  return 222;\n}\n');
    const b = getIndex(repo, { useChangeOracle: true, oracleMinFiles: 0 }).files.find((f) => f.path === 'src/f2.ts')!.functions[0]!;
    expect(b.literalHash).not.toBe(a.literalHash);
  });

  it('works with no git at all', () => {
    expect(snapshot(noGitRepo, true)).toEqual(snapshot(noGitRepo, false));
  });
});
