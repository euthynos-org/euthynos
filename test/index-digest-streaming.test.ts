import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getIndex, resetIndexForTests, beginRequest, ENGINE_VERSION } from '../src/index/incremental.js';
import { loadIndex, indexDir, contentHash, INDEX_SCHEMA_VERSION } from '../src/index/store.js';
import { callTool } from '../src/mcp/tools.js';

/**
 * G4 digest — STREAMED, not materialised.
 *
 * The integrity protocol is unchanged: the manifest is still the final
 * commit point, the payload digest is still authoritative, root binding,
 * torn-pair, orphan and root-mismatch detection all still hold, and the
 * announced rebuild reasons are the same strings.
 *
 * Only HOW the digest is produced changes. Writing used to build the whole
 * `parsed.json` as one string and hash it, so peak RSS carried the entire
 * payload (22 MB on a 10,000-file repository) plus the hasher's copy of
 * it. The payload is now serialised, hashed and written entry by entry, so
 * only one record is in flight at a time.
 *
 * The load path is deliberately NOT streamed: it must parse the whole
 * document into objects anyway, so the string is inherent there and hashing
 * it costs one extra pass over bytes already in memory.
 *
 * The bytes on disk must not move: a streamed digest has to equal the
 * digest of `JSON.stringify(payload)`, or every existing index in the world
 * would be invalidated by an implementation detail.
 */

let repo: string;

function w(rel: string, body: string): void {
  const abs = join(repo, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, body);
}

function build(): void {
  resetIndexForTests();
  beginRequest();
  getIndex(repo);
}

const manifestPath = (): string => join(indexDir(repo), 'manifest.json');
const parsedPath = (): string => join(indexDir(repo), 'parsed.json');
const manifest = (): Record<string, unknown> =>
  JSON.parse(readFileSync(manifestPath(), 'utf8')) as Record<string, unknown>;

beforeEach(() => {
  resetIndexForTests();
  repo = mkdtempSync(join(tmpdir(), 'digest-'));
  for (let i = 0; i < 6; i++) {
    w(`src/f${i}.ts`, `export function f${i}(): number {\n  return ${i};\n}\n`);
  }
  build();
});

describe('streamed digest is the SAME digest', () => {
  it('equals the digest of the whole serialised payload', () => {
    // The exact bytes on disk, hashed the old way, must match what the
    // streaming writer recorded.
    const onDisk = readFileSync(parsedPath(), 'utf8');
    expect(manifest()['parsedDigest']).toBe(contentHash(onDisk));
  });

  it('the payload is still valid JSON with every live artifact', () => {
    const parsed = JSON.parse(readFileSync(parsedPath(), 'utf8')) as Record<string, { path: string }>;
    const paths = Object.values(parsed).map((p) => p.path).sort();
    expect(paths).toContain('src/f0.ts');
    expect(paths).toContain('src/f5.ts');
  });

  it('a MODIFIED payload produces a different digest', () => {
    const before = manifest()['parsedDigest'] as string;
    const onDisk = readFileSync(parsedPath(), 'utf8');
    const tampered = onDisk.replace('src/f0.ts', 'src/CHANGED.ts');
    expect(contentHash(tampered)).not.toBe(before);
  });

  it('rebuilding identical content reproduces an identical digest', () => {
    const first = manifest()['parsedDigest'] as string;
    build();
    expect(manifest()['parsedDigest']).toBe(first);
  });
});

describe('the integrity protocol is unchanged', () => {
  it('a good pair still loads', () => {
    expect(loadIndex(repo, ENGINE_VERSION)).not.toBeNull();
  });

  it('TORN PAIR still rejected', () => {
    const parsed = JSON.parse(readFileSync(parsedPath(), 'utf8')) as Record<string, unknown>;
    delete parsed[Object.keys(parsed)[0]!];
    writeFileSync(parsedPath(), JSON.stringify(parsed));
    const meta: { rejected?: string } = {};
    expect(loadIndex(repo, ENGINE_VERSION, meta as never)).toBeNull();
    expect(meta.rejected).toBe('torn-pair');
  });

  it('ORPHAN payload (manifest gone) still handled', () => {
    rmSync(manifestPath());
    expect(loadIndex(repo, ENGINE_VERSION)).toBeNull();
  });

  it('missing payload (interrupted write) still handled', () => {
    rmSync(parsedPath());
    expect(loadIndex(repo, ENGINE_VERSION)).toBeNull();
  });

  it('ROOT MISMATCH still rejected', () => {
    const other = mkdtempSync(join(tmpdir(), 'digest-other-'));
    mkdirSync(join(other, 'src'), { recursive: true });
    writeFileSync(join(other, 'src', 'z.ts'), 'export function z(): number {\n  return 1;\n}\n');
    cpSync(indexDir(repo), indexDir(other), { recursive: true });
    const meta: { rejected?: string } = {};
    expect(loadIndex(other, ENGINE_VERSION, meta as never)).toBeNull();
    expect(meta.rejected).toBe('root-mismatch');
  });

  it('SCHEMA mismatch reason unchanged', () => {
    const m = manifest();
    m['schemaVersion'] = INDEX_SCHEMA_VERSION - 1;
    writeFileSync(manifestPath(), JSON.stringify(m));
    const meta: { rejected?: string } = {};
    expect(loadIndex(repo, ENGINE_VERSION, meta as never)).toBeNull();
    expect(meta.rejected).toBe('schema-mismatch');
  });

  it('ENGINE mismatch reason unchanged', () => {
    const meta: { rejected?: string } = {};
    expect(loadIndex(repo, 'different-engine', meta as never)).toBeNull();
    expect(meta.rejected).toBe('engine-mismatch');
  });

  it('the manifest is still the commit point (written with the payload digest)', () => {
    const m = manifest();
    expect(typeof m['parsedDigest']).toBe('string');
    expect((m['parsedDigest'] as string).length).toBeGreaterThan(0);
    expect(typeof m['root']).toBe('string');
  });
});

describe('save/load determinism and query path', () => {
  it('save → load → save reproduces the same digest', () => {
    const a = manifest()['parsedDigest'] as string;
    expect(loadIndex(repo, ENGINE_VERSION)).not.toBeNull();
    build();
    expect(manifest()['parsedDigest']).toBe(a);
  });

  it('recovery after corruption still returns the same file set', () => {
    const clean = getIndex(repo).files.map((f) => f.path).sort();
    writeFileSync(parsedPath(), '{ corrupted');
    resetIndexForTests();
    beginRequest();
    expect(getIndex(repo).files.map((f) => f.path).sort()).toEqual(clean);
  });

  it('no query-path behaviour change: tool output stays byte-identical', () => {
    const x = callTool('repo_map', { path: repo }).text;
    const y = callTool('repo_map', { path: repo }).text;
    expect(x).toBe(y);
    expect(callTool('find_references', { path: repo, symbol: 'f3' }).isError ?? false).toBe(false);
  });
});
