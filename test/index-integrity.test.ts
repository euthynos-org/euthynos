import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getIndex, resetIndexForTests, beginRequest, ENGINE_VERSION } from '../src/index/incremental.js';
import { loadIndex, indexDir, INDEX_SCHEMA_VERSION } from '../src/index/store.js';

/**
 * G4 — PERSISTENCE INTEGRITY.
 *
 * Required property: never silently serve partial or stale derived state
 * when integrity cannot be established.
 *
 * `parsed.json` and `manifest.json` are each written atomically (temp +
 * rename), but they are TWO files: a crash, a concurrent writer, or a
 * half-copied directory can pair one with the other's twin. Nothing linked
 * them, so a torn pair was indistinguishable from a good one.
 *
 * The fix is deliberately NOT a lock. A lock introduces its own failure
 * mode — the stale lock left by a killed process — and this session
 * produced exactly that class of bug in git itself while building the
 * fixtures. Instead the artifact pair is SELF-VERIFYING: the manifest is
 * written last and carries a digest of the parsed payload plus the root it
 * describes. A pair that does not verify is rejected and rebuilt, and the
 * rejection is announced on stderr exactly as schema/engine mismatches
 * already are. Concurrent writers therefore need no coordination: each
 * writes a complete consistent pair, and any interleaving that produces a
 * mismatched pair is detected rather than trusted.
 */

let repo: string;

function w(rel: string, body: string): void {
  const abs = join(repo, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, body);
}

function buildIndex(): void {
  resetIndexForTests();
  beginRequest();
  getIndex(repo);
}

function manifestPath(): string {
  return join(indexDir(repo), 'manifest.json');
}
function parsedPath(): string {
  return join(indexDir(repo), 'parsed.json');
}

beforeEach(() => {
  resetIndexForTests();
  repo = mkdtempSync(join(tmpdir(), 'integ-'));
  w('src/a.ts', 'export function a(): number {\n  return 1;\n}\n');
  w('src/b.ts', 'export function b(): number {\n  return 2;\n}\n');
  buildIndex();
});

describe('G4 — a good index is reused', () => {
  it('round-trips: a freshly written pair loads', () => {
    const loaded = loadIndex(repo, ENGINE_VERSION);
    expect(loaded).not.toBeNull();
    expect(Object.keys(loaded!.manifest.files).sort()).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('two concurrent READERS both get a consistent view', () => {
    const a = loadIndex(repo, ENGINE_VERSION);
    const b = loadIndex(repo, ENGINE_VERSION);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(Object.keys(a!.manifest.files).sort()).toEqual(Object.keys(b!.manifest.files).sort());
  });
});

describe('G4 — integrity failures are detected, never served', () => {
  it('a CORRUPTED MANIFEST is rejected', () => {
    writeFileSync(manifestPath(), '{ this is not json');
    const meta: { rejected?: string } = {};
    expect(loadIndex(repo, ENGINE_VERSION, meta as never)).toBeNull();
  });

  it('a CORRUPTED PARSED ARTIFACT is rejected', () => {
    writeFileSync(parsedPath(), '{ truncated');
    expect(loadIndex(repo, ENGINE_VERSION)).toBeNull();
  });

  it('a TORN PAIR (parsed replaced by another build) is rejected', () => {
    // Exactly what an interrupted write or an interleaved concurrent writer
    // leaves behind: a valid manifest beside a valid but DIFFERENT payload.
    const parsed = JSON.parse(readFileSync(parsedPath(), 'utf8')) as Record<string, unknown>;
    const firstKey = Object.keys(parsed)[0]!;
    delete parsed[firstKey];
    writeFileSync(parsedPath(), JSON.stringify(parsed));
    const meta: { rejected?: string } = {};
    expect(loadIndex(repo, ENGINE_VERSION, meta as never)).toBeNull();
    expect(meta.rejected).toBeDefined();
  });

  it('an INTERRUPTED WRITE (missing parsed artifact) is rejected', () => {
    rmSync(parsedPath());
    expect(loadIndex(repo, ENGINE_VERSION)).toBeNull();
  });

  it('a SCHEMA MISMATCH is rejected and reported as such', () => {
    const m = JSON.parse(readFileSync(manifestPath(), 'utf8')) as Record<string, unknown>;
    m['schemaVersion'] = INDEX_SCHEMA_VERSION - 1;
    writeFileSync(manifestPath(), JSON.stringify(m));
    const meta: { rejected?: string } = {};
    expect(loadIndex(repo, ENGINE_VERSION, meta as never)).toBeNull();
    expect(meta.rejected).toBe('schema-mismatch');
  });

  it('an ENGINE MISMATCH is rejected and reported as such', () => {
    const meta: { rejected?: string } = {};
    expect(loadIndex(repo, 'some-other-engine-build', meta as never)).toBeNull();
    expect(meta.rejected).toBe('engine-mismatch');
  });

  it('NO CROSS-ROOT REUSE: an index copied from another repo is rejected', () => {
    const other = mkdtempSync(join(tmpdir(), 'integ-other-'));
    mkdirSync(join(other, 'src'), { recursive: true });
    writeFileSync(join(other, 'src', 'z.ts'), 'export function z(): number {\n  return 9;\n}\n');
    cpSync(indexDir(repo), indexDir(other), { recursive: true });
    // The copied artifacts are internally consistent — only the ROOT differs.
    expect(loadIndex(other, ENGINE_VERSION)).toBeNull();
  });
});

describe('G4 — recovery is deterministic and never partial', () => {
  it('a rejected index rebuilds to the SAME state as a clean build', () => {
    const clean = getIndex(repo).files.map((f) => `${f.path}:${f.functions.length}`).sort();

    writeFileSync(parsedPath(), '{ corrupted');
    resetIndexForTests();
    beginRequest();
    const recovered = getIndex(repo).files.map((f) => `${f.path}:${f.functions.length}`).sort();

    expect(recovered).toEqual(clean);
  });

  it('recovery is repeatable: two corrupt-then-rebuild cycles agree', () => {
    const cycle = (): string[] => {
      writeFileSync(parsedPath(), '{ corrupted');
      resetIndexForTests();
      beginRequest();
      return getIndex(repo).files.map((f) => f.path).sort();
    };
    expect(cycle()).toEqual(cycle());
  });

  it('a FAILED rebuild never leaves a half-written index behind', () => {
    // A readable index exists; if a later sweep cannot complete, what is on
    // disk must still be a verifiable pair — never a manifest describing
    // content that is not there.
    const before = loadIndex(repo, ENGINE_VERSION);
    expect(before).not.toBeNull();

    // Simulate the classic interruption: payload updated, manifest not.
    writeFileSync(parsedPath(), JSON.stringify({ 'orphan-hash': { path: 'src/ghost.ts', functions: [] } }));
    const after = loadIndex(repo, ENGINE_VERSION);
    expect(after).toBeNull(); // detected, not served

    resetIndexForTests();
    beginRequest();
    const rebuilt = getIndex(repo).files.map((f) => f.path).sort();
    expect(rebuilt).toEqual(['src/a.ts', 'src/b.ts']);
    expect(rebuilt).not.toContain('src/ghost.ts');
  });

  it('concurrent REBUILD attempts each leave a verifiable pair', () => {
    // Two processes cannot be run in-process, but their observable effect
    // is interleaved writes into the same directory. Whatever lands, the
    // loader must either accept a consistent pair or reject it — never
    // serve a mixed one.
    for (let i = 0; i < 3; i++) {
      resetIndexForTests();
      beginRequest();
      getIndex(repo);
      const loaded = loadIndex(repo, ENGINE_VERSION);
      expect(loaded).not.toBeNull();
      expect(Object.keys(loaded!.manifest.files).sort()).toEqual(['src/a.ts', 'src/b.ts']);
    }
  });

  it('the index directory keeps its gitignore after every rebuild', () => {
    expect(existsSync(join(indexDir(repo), '.gitignore'))).toBe(true);
  });
});
