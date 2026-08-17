import { describe, expect, it, beforeAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diffWorktree } from '../src/diff/engine.js';
import { parseSourceByLang } from '../src/parse/dispatch.js';
import { getIndex } from '../src/index/incremental.js';
import type { ParsedFile } from '../src/types.js';

/**
 * D0 — the diff engine, tested standalone BEFORE any tool consumes it
 * (PHASE6-COMPLETION-PLAN step 3). Covers the git edge cases the plan
 * names: modify/add/delete/rename/untracked, no-git, no-commits, detached
 * HEAD, CRLF, binary skip, containment, blob-cache, and the equivalence
 * pin (old-blob parse == disk parse for identical content).
 */

function g(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    encoding: 'utf8',
  });
}

function currentMap(root: string): Map<string, ParsedFile> {
  return new Map(getIndex(root).files.map((f) => [f.path, f]));
}

const V1_A =
  'export function keep(x: number): number {\n  return x + 1;\n}\n' +
  'export function gone(x: number): number {\n  return x - 1;\n}\n' +
  'export function evolves(x: number): number {\n  return x;\n}\n';
const V2_A =
  'export function keep(x: number): number {\n  return x + 1;\n}\n' +
  'export function evolves(x: number): number {\n  return x * 2 + 1;\n}\n' +
  'export function fresh(x: number): number {\n  return x / 2;\n}\n';

let repo: string;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'd0-'));
  mkdirSync(join(repo, 'src'));
  mkdirSync(join(repo, 'sub'));
  writeFileSync(join(repo, 'src', 'a.ts'), V1_A);
  writeFileSync(join(repo, 'src', 'b.ts'), 'export function dropMe(): number {\n  return 9;\n}\n');
  writeFileSync(join(repo, 'sub', 'c.ts'), 'export function moveMe(): number {\n  return 3;\n}\n');
  writeFileSync(join(repo, 'notes.md'), 'not code\n');
  execFileSync('git', ['init', '-q', repo]);
  g(repo, 'add', '-A');
  g(repo, 'commit', '-q', '-m', 'v1', '--no-gpg-sign');
  // Worktree changes: modify a.ts (change evolves, drop gone, add fresh),
  // delete b.ts, rename sub/c.ts -> sub/d.ts, add untracked e.ts + a
  // non-code untracked file.
  writeFileSync(join(repo, 'src', 'a.ts'), V2_A);
  rmSync(join(repo, 'src', 'b.ts'));
  g(repo, 'mv', 'sub/c.ts', 'sub/d.ts');
  writeFileSync(join(repo, 'src', 'e.ts'), 'export function newborn(): number {\n  return 1;\n}\n');
  writeFileSync(join(repo, 'todo.txt'), 'untracked non-code\n');
});

describe('D0 change detection', () => {
  it('reports modify/delete/rename/untracked with statuses, code files only for untracked', () => {
    const d = diffWorktree(repo, currentMap(repo));
    expect(d.gitAvailable).toBe(true);
    expect(d.head).toMatch(/^[0-9a-f]{12}$/);
    const by = Object.fromEntries(d.changedFiles.map((c) => [c.path, c]));
    expect(by['src/a.ts'].status).toBe('modified');
    expect(by['src/b.ts'].status).toBe('deleted');
    expect(by['sub/d.ts'].status).toBe('renamed');
    expect(by['sub/d.ts'].oldPath).toBe('sub/c.ts');
    expect(by['src/e.ts'].status).toBe('untracked');
    expect(by['todo.txt']).toBeUndefined();
    expect(by['notes.md']).toBeUndefined();
  });

  it('diffs symbols: added / removed / modified, with unchanged symbols silent', () => {
    const d = diffWorktree(repo, currentMap(repo));
    const sym = (f: string, n: string) => d.symbolChanges.find((s) => s.file === f && s.name === n);
    expect(sym('src/a.ts', 'fresh')?.kind).toBe('added');
    expect(sym('src/a.ts', 'gone')?.kind).toBe('removed');
    expect(sym('src/a.ts', 'gone')?.oldLine).toBeGreaterThan(0);
    expect(sym('src/a.ts', 'evolves')?.kind).toBe('modified');
    expect(sym('src/a.ts', 'keep')).toBeUndefined();
    expect(sym('src/b.ts', 'dropMe')?.kind).toBe('removed');
    expect(sym('src/e.ts', 'newborn')?.kind).toBe('added');
    // Pure rename: content identical -> no symbol changes for the file.
    expect(d.symbolChanges.filter((s) => s.file === 'sub/d.ts')).toEqual([]);
  });

  it('is deterministic', () => {
    const a = JSON.stringify(diffWorktree(repo, currentMap(repo)).symbolChanges);
    const b = JSON.stringify(diffWorktree(repo, currentMap(repo)).symbolChanges);
    expect(a).toBe(b);
  });
});

describe('D0 equivalence: old-blob parse == disk parse for identical content', () => {
  it('parses the committed blob to records deep-equal to the disk parse', () => {
    const d = diffWorktree(repo, currentMap(repo));
    // sub/c.ts at HEAD is byte-identical to sub/d.ts on disk (pure rename):
    const old = d.oldParsed.get('sub/c.ts');
    expect(old).toBeDefined();
    const disk = currentMap(repo).get('sub/d.ts')!;
    expect(old!.functions.map((f) => [f.name, f.bodyHash, f.startLine, f.endLine])).toEqual(
      disk.functions.map((f) => [f.name, f.bodyHash, f.startLine, f.endLine]),
    );
  });

  it('parseSourceByLang equals the index parse for the same bytes (TS)', () => {
    const disk = currentMap(repo).get('src/e.ts')!;
    const mem = parseSourceByLang('src/e.ts', disk.module, disk.isTest, 'ts', 'export function newborn(): number {\n  return 1;\n}\n');
    expect(mem.functions.map((f) => [f.name, f.bodyHash])).toEqual(disk.functions.map((f) => [f.name, f.bodyHash]));
  });
});

describe('D0 degradation and hardening', () => {
  it('no git -> honest unavailableReason, empty report', () => {
    const plain = mkdtempSync(join(tmpdir(), 'd0-nogit-'));
    writeFileSync(join(plain, 'x.ts'), 'export const x = 1;\n');
    const d = diffWorktree(plain, new Map());
    expect(d.gitAvailable).toBe(false);
    expect(d.unavailableReason).toContain('git history not available');
  });

  it('a repo with no commits is distinguished from no-git', () => {
    const fresh = mkdtempSync(join(tmpdir(), 'd0-empty-'));
    execFileSync('git', ['init', '-q', fresh]);
    writeFileSync(join(fresh, 'x.ts'), 'export const x = 1;\n');
    const d = diffWorktree(fresh, new Map());
    expect(d.gitAvailable).toBe(false);
    expect(d.unavailableReason).toContain('no commits yet');
  });

  it('detached HEAD works', () => {
    const sha = g(repo, 'rev-parse', 'HEAD').trim();
    const det = mkdtempSync(join(tmpdir(), 'd0-det-'));
    execFileSync('git', ['clone', '-q', repo, det]);
    g(det, 'checkout', '-q', sha);
    writeFileSync(join(det, 'src', 'a.ts'), V2_A + 'export function extra(): number {\n  return 7;\n}\n');
    const d = diffWorktree(det, currentMap(det));
    expect(d.gitAvailable).toBe(true);
    expect(d.symbolChanges.some((s) => s.name === 'extra' && s.kind === 'added')).toBe(true);
  });

  it('CRLF-committed content parses with stable symbol diffs', () => {
    const win = mkdtempSync(join(tmpdir(), 'd0-crlf-'));
    execFileSync('git', ['init', '-q', win]);
    writeFileSync(join(win, 'w.ts'), 'export function winfn(a: number): number {\r\n  return a + 2;\r\n}\r\n');
    g(win, 'add', '-A');
    g(win, '-c', 'core.autocrlf=false', 'commit', '-q', '-m', 'crlf', '--no-gpg-sign');
    writeFileSync(join(win, 'w.ts'), 'export function winfn(a: number): number {\r\n  return a + 3;\r\n}\r\n');
    const d = diffWorktree(win, currentMap(win));
    expect(d.symbolChanges).toEqual([
      expect.objectContaining({ file: 'w.ts', name: 'winfn', kind: 'modified' }),
    ]);
  });

  it('a pure line-ending flip is NOT a phantom modification (the gate finding: GIT_CONFIG_NOSYSTEM drops system autocrlf)', () => {
    const eol = mkdtempSync(join(tmpdir(), 'd0-eol-'));
    execFileSync('git', ['init', '-q', eol]);
    writeFileSync(join(eol, 'same.ts'), 'export function still(a: number): number {\n  return a + 1;\n}\n');
    g(eol, 'add', '-A');
    g(eol, '-c', 'core.autocrlf=false', 'commit', '-q', '-m', 'lf', '--no-gpg-sign');
    // Rewrite the SAME content with CRLF endings — the phantom-modification
    // shape a Windows autocrlf clone produces under the hardened runner.
    writeFileSync(join(eol, 'same.ts'), 'export function still(a: number): number {\r\n  return a + 1;\r\n}\r\n');
    const d = diffWorktree(eol, currentMap(eol));
    expect(d.changedFiles).toEqual([]);
    expect(d.symbolChanges).toEqual([]);
  });

  it('a binary-looking HEAD blob is SKIPPED with the reason recorded, never silent', () => {
    const bin = mkdtempSync(join(tmpdir(), 'd0-bin-'));
    execFileSync('git', ['init', '-q', bin]);
    writeFileSync(join(bin, 'blob.ts'), 'export const junk = "a\0b";\n');
    g(bin, 'add', '-A');
    g(bin, 'commit', '-q', '-m', 'bin', '--no-gpg-sign');
    writeFileSync(join(bin, 'blob.ts'), 'export const junk = "clean";\n');
    const d = diffWorktree(bin, currentMap(bin));
    expect(d.skipped.some((s) => s.path === 'blob.ts' && /binary/.test(s.reason))).toBe(true);
  });

  it('the blob cache hits: the second diff returns the same old-parse object', () => {
    const d1 = diffWorktree(repo, currentMap(repo));
    const d2 = diffWorktree(repo, currentMap(repo));
    expect(d2.oldParsed.get('src/a.ts')).toBe(d1.oldParsed.get('src/a.ts'));
  });
});
