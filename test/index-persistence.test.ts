import { beforeAll, afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLanguages } from '../src/parse/treesitter/loader.js';
import { TREE_SITTER_LANGS } from '../src/parse/dispatch.js';
import { flushIndex, getIndex, resetIndex } from '../src/index/incremental.js';
import { clearIndex, indexDir, INDEX_SCHEMA_VERSION } from '../src/index/store.js';

/**
 * The persistent index is an OPTIMIZATION with a hard constraint: it may
 * never change an answer. These tests hold it to that — correctness first
 * (freshness, version safety, graceful failure), speed second.
 */

let REPO: string;

const A = 'export function alpha(): number {\n  return 1\n}\n';
const B = 'import { alpha } from "./a"\n\nexport function beta(): number {\n  return alpha() + 1\n}\n';

beforeAll(async () => {
  await loadLanguages([...TREE_SITTER_LANGS]);
});

function freshRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'euthynos-idx-'));
  writeFileSync(join(dir, 'a.ts'), A);
  writeFileSync(join(dir, 'b.ts'), B);
  resetIndex();
  return dir;
}

afterEach(() => {
  resetIndex();
  if (REPO !== undefined) rmSync(REPO, { recursive: true, force: true });
});

describe('persistence', () => {
  it('a second process rehydrates instead of re-parsing', () => {
    REPO = freshRepo();
    const first = getIndex(REPO);
    expect(first.stats.reparsed).toBe(2);
    expect(first.stats.loadedFromDisk).toBe(false);
    flushIndex(REPO);

    resetIndex(); // simulate a new process
    const second = getIndex(REPO);
    expect(second.stats.loadedFromDisk).toBe(true);
    expect(second.stats.rehydrated).toBe(2);
    expect(second.stats.reparsed).toBe(0);
    expect(second.files.map((f) => f.path).sort()).toEqual(['a.ts', 'b.ts']);
  });

  it('writes a .gitignore so the index never lands in a commit', () => {
    REPO = freshRepo();
    getIndex(REPO);
    flushIndex(REPO);
    const ignore = readFileSync(join(indexDir(REPO), '.gitignore'), 'utf8');
    expect(ignore).toContain('*');
  });

  it('telemetry cannot create .euthynos without the .gitignore', async () => {
    /**
     * Regression: telemetry used to `mkdir` the directory bare, so a repo that
     * had only ever been QUERIED (never indexed) got a `.euthynos/` with no
     * ignore rule — and the next `git add -A` committed our local telemetry
     * log into the user's project. Writing a file into someone's repository
     * that they then ship is not a cosmetic bug.
     */
    REPO = freshRepo();
    const { recordCall } = await import('../src/mcp/telemetry.js');
    recordCall({
      tool: 'repo_map',
      args: {},
      text: 'ok',
      latencyMs: 1,
      filesTouched: 1,
      cache: 'miss',
      isError: false,
      root: REPO,
    });
    expect(existsSync(join(indexDir(REPO), 'telemetry.jsonl'))).toBe(true);
    expect(readFileSync(join(indexDir(REPO), '.gitignore'), 'utf8')).toContain('*');
  });

  it('the index directory is never itself indexed', () => {
    REPO = freshRepo();
    getIndex(REPO);
    flushIndex(REPO);
    resetIndex();
    const idx = getIndex(REPO);
    expect(idx.files.some((f) => f.path.includes('.euthynos'))).toBe(false);
  });

  it('EUTHYNOS_NO_INDEX=1 keeps everything in memory', () => {
    REPO = freshRepo();
    process.env['EUTHYNOS_NO_INDEX'] = '1';
    try {
      getIndex(REPO);
      flushIndex(REPO);
      expect(existsSync(join(indexDir(REPO), 'manifest.json'))).toBe(false);
    } finally {
      delete process.env['EUTHYNOS_NO_INDEX'];
    }
  });
});

describe('incremental correctness', () => {
  it('an edit reparses ONLY the edited file', () => {
    REPO = freshRepo();
    getIndex(REPO);
    writeFileSync(join(REPO, 'a.ts'), A.replace('return 1', 'return 42'));
    const after = getIndex(REPO);
    expect(after.stats.reparsed).toBe(1);
  });

  it('a NEW file appears immediately — no waiting for a cache to expire', () => {
    REPO = freshRepo();
    const before = getIndex(REPO);
    writeFileSync(join(REPO, 'c.ts'), 'export function gamma(): void {}\n');
    const after = getIndex(REPO);
    expect(after.files.length).toBe(before.files.length + 1);
    expect(after.generation).toBeGreaterThan(before.generation);
  });

  it('a deleted file disappears immediately', () => {
    REPO = freshRepo();
    getIndex(REPO);
    rmSync(join(REPO, 'b.ts'));
    const after = getIndex(REPO);
    expect(after.files.map((f) => f.path)).toEqual(['a.ts']);
  });

  it('a touched-but-unchanged file is NOT reparsed (content-addressed)', () => {
    REPO = freshRepo();
    getIndex(REPO);
    const future = new Date(Date.now() + 10_000);
    utimesSync(join(REPO, 'a.ts'), future, future);
    const after = getIndex(REPO);
    expect(after.stats.reparsed).toBe(0);
    expect(after.files.length).toBe(2);
  });

  it('reverting a file reuses the artifact parsed before the change', () => {
    REPO = freshRepo();
    getIndex(REPO);
    writeFileSync(join(REPO, 'a.ts'), A.replace('return 1', 'return 42'));
    expect(getIndex(REPO).stats.reparsed).toBe(1);
    writeFileSync(join(REPO, 'a.ts'), A); // back to the original content
    expect(getIndex(REPO).stats.reparsed).toBe(0);
  });

  it('generation is stable when nothing changed', () => {
    REPO = freshRepo();
    const g1 = getIndex(REPO).generation;
    const g2 = getIndex(REPO).generation;
    expect(g2).toBe(g1);
  });
});

describe('version safety and graceful failure', () => {
  it('an index from a different schema version is discarded, not trusted', () => {
    REPO = freshRepo();
    getIndex(REPO);
    flushIndex(REPO);

    const manifestPath = join(indexDir(REPO), 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { schemaVersion: number };
    manifest.schemaVersion = INDEX_SCHEMA_VERSION + 99;
    writeFileSync(manifestPath, JSON.stringify(manifest));

    resetIndex();
    const idx = getIndex(REPO);
    expect(idx.stats.loadedFromDisk).toBe(false);
    expect(idx.stats.reparsed).toBe(2); // rebuilt from source
  });

  it('a corrupt index rebuilds instead of throwing', () => {
    REPO = freshRepo();
    getIndex(REPO);
    flushIndex(REPO);
    writeFileSync(join(indexDir(REPO), 'parsed.json'), '{ not json');
    resetIndex();
    const idx = getIndex(REPO);
    expect(idx.files.length).toBe(2);
  });

  it('an unwritable index directory does not break queries', () => {
    REPO = freshRepo();
    // A FILE where the index directory should be: mkdir will fail.
    writeFileSync(indexDir(REPO), 'not a directory');
    const idx = getIndex(REPO);
    flushIndex(REPO);
    expect(idx.files.length).toBe(2);
  });
});

describe('per-repo config', () => {
  it('.euthynos/config.json ignore globs are honored', () => {
    REPO = freshRepo();
    mkdirSync(indexDir(REPO), { recursive: true });
    writeFileSync(join(indexDir(REPO), 'config.json'), JSON.stringify({ ignore: ['b.ts'] }));
    resetIndex();
    const idx = getIndex(REPO);
    expect(idx.files.map((f) => f.path)).toEqual(['a.ts']);
  });

  it('a malformed config is ignored rather than fatal', () => {
    REPO = freshRepo();
    mkdirSync(indexDir(REPO), { recursive: true });
    writeFileSync(join(indexDir(REPO), 'config.json'), 'nonsense');
    resetIndex();
    expect(getIndex(REPO).files.length).toBe(2);
  });
});

describe('two processes writing at once', () => {
  /**
   * The blueprint called for a single-writer lockfile. Content addressing
   * makes one unnecessary, and these tests are the evidence: a manifest and a
   * parsed-artifact file from DIFFERENT writers can only ever produce a cache
   * MISS, never a wrong answer, because an artifact is looked up by the hash
   * of the content actually on disk. A lockfile would add its own failure
   * modes (stale locks after a crash, Windows handle contention) to buy a
   * property we already have.
   */
  it('a manifest paired with another writer\'s artifacts still answers correctly', () => {
    REPO = freshRepo();
    getIndex(REPO);
    flushIndex(REPO);

    // Writer B's manifest (path→hash rows it alone knows) landing on writer
    // A's parsed.json.
    const manifestPath = join(indexDir(REPO), 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      files: Record<string, { size: number; mtimeMs: number; hash: string }>;
    };
    for (const state of Object.values(manifest.files)) state.hash = 'deadbeef'.repeat(4);
    writeFileSync(manifestPath, JSON.stringify(manifest));

    resetIndex();
    const idx = getIndex(REPO);
    expect(idx.files.map((f) => f.path).sort()).toEqual(['a.ts', 'b.ts']);
    expect(idx.files.find((f) => f.path === 'a.ts')?.functions[0]?.name).toBe('alpha');
    // The artifacts survive the broken manifest: they are addressed by the
    // hash of the content ON DISK, which we recompute, not by the manifest's
    // claim about it. So a torn write costs nothing at all here — the reason
    // a lockfile buys us nothing.
    expect(idx.stats.reparsed).toBe(0);
  });

  it('an artifact set from another writer is still safe to reuse', () => {
    REPO = freshRepo();
    getIndex(REPO);
    flushIndex(REPO);

    // Writer B's parsed.json carrying an EXTRA artifact under a hash that
    // matches nothing on disk. It must never be served for a file.
    const parsedPath = join(indexDir(REPO), 'parsed.json');
    const parsed = JSON.parse(readFileSync(parsedPath, 'utf8')) as Record<string, unknown>;
    parsed['0'.repeat(32)] = { path: 'a.ts', module: '.', functions: [{ name: 'IMPOSTOR' }] };
    writeFileSync(parsedPath, JSON.stringify(parsed));

    resetIndex();
    const names = getIndex(REPO).files.flatMap((f) => f.functions.map((fn) => fn.name));
    expect(names).not.toContain('IMPOSTOR');
    expect(names.sort()).toEqual(['alpha', 'beta']);
  });

  it('an artifact recorded under one path is never served for another', () => {
    REPO = freshRepo();
    const first = getIndex(REPO);
    flushIndex(REPO);
    expect(first.stats.reparsed).toBe(2);

    // b.ts now holds a.ts's exact content. The artifact for that content
    // exists in the store, but it belongs to a.ts — reusing it would report
    // `alpha` as living in b.ts.
    writeFileSync(join(REPO, 'b.ts'), A);
    resetIndex();
    const idx = getIndex(REPO);
    const b = idx.files.find((f) => f.path === 'b.ts');
    expect(b?.path).toBe('b.ts');
    expect(b?.functions.map((f) => f.name)).toEqual(['alpha']);
  });
});

describe('the index never changes an answer', () => {
  it('rehydrated parses are identical to freshly parsed ones', () => {
    REPO = freshRepo();
    const fresh = getIndex(REPO).files.slice().sort((a, b) => a.path.localeCompare(b.path));
    flushIndex(REPO);
    resetIndex();
    const rehydrated = getIndex(REPO).files.slice().sort((a, b) => a.path.localeCompare(b.path));
    expect(JSON.stringify(rehydrated)).toBe(JSON.stringify(fresh));
  });
});
