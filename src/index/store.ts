import { createHash } from 'node:crypto';
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import type { ParsedFile } from '../types.js';

/**
 * PERSISTENT INDEX STORE — `.euthynos/` on disk.
 *
 * Purpose: a new process must not re-parse a repository it already knows.
 * The in-memory sweep keeps answers fresh WITHIN a session; this store makes
 * the FIRST query of the next session fast.
 *
 * Shape:
 *   .euthynos/
 *     manifest.json    schema + engine version, per-file {size, mtimeMs, hash}
 *     parsed.json      { hash -> ParsedFile }, content-addressed
 *     config.json      per-repo settings (ignore globs, written by the user)
 *     telemetry.jsonl  local tool-call measurements
 *
 * Discipline:
 *  - Artifacts are keyed by CONTENT HASH, so a revert or a rename reuses
 *    what we already parsed instead of re-parsing it.
 *  - Writes are atomic (temp file + rename): a killed process leaves the
 *    previous good index, never a half-written one.
 *  - A version mismatch (schema or engine) discards the cache silently and
 *    rebuilds. A stale index that "loads" would serve answers from parser
 *    logic that no longer exists.
 *  - Every failure path degrades to "no cache", never to an error: the
 *    index is an optimization, and an optimization must not break a query.
 */

/**
 * Bump when the on-disk shape or the parse output changes meaning.
 * v8: the TypeScript parser now marks an import whose named bindings are ALL
 *   inline `type` (`import { type A, type B } from 'x'`) as `isTypeOnly` —
 *   it is erased at compile time exactly like `import type`. `ImportRecord`
 *   is persisted per file, so a v7 artifact would serve those imports as
 *   runtime crossings and a `forbidden-dependency` rule could fire on an
 *   import that does not exist at runtime — a WRONG verdict, until a rebuild.
 *   The bump forces the rebuild.
 * v7: FunctionRecord gained `fieldRefs` (non-call member/field accesses, feeding
 *   find_references), and the Java parser now records enum constants as `const`
 *   symbols and field accesses. A v6 artifact carries neither, so a stale index
 *   would return empty references for an enum constant or field that 0.2.1 finds —
 *   silently wrong until a rebuild, which the bump forces.
 * v6: FunctionRecord gained `defHash` (rename-sensitive body hash, all parsers).
 *   A v5 artifact carries no defHash, so its persisted current records would use
 *   the fallback signature while freshly-parsed HEAD blobs use defHash — the two
 *   signatures never match and check_my_changes reports every function modified.
 *   Rebuilding on the bump keeps both sides on the same scheme.
 * v5: the manifest gained `root` and `parsedDigest`, making the artifact
 *   PAIR self-verifying (G4). parsed.json and manifest.json are written
 *   separately, so an interrupted write, an interleaved concurrent writer,
 *   or a half-copied directory could pair one with another build's twin —
 *   and nothing linked them, so a torn pair was indistinguishable from a
 *   good one. A v4 artifact carries neither field and is rebuilt.
 * v4: FunctionRecord gained `literalHash` (all parsers, was TS-only) and
 * `ngramSketch` — a v3 artifact would make every function invisible to the
 * near-clone tier and every non-TS tiny clone unguarded by the literal gate.
 * v3: FunctionRecord gained `typeRefs` (bundle types-touched); a v2
 * artifact would make every TS function look like it touches no types.
 * v2: ParsedFile gained `commentTokens` (query-shaper vocabulary) and the
 * non-TS parsers gained symbols/callSites/totalLines — a v1 artifact would
 * make a Go repo look like it had no types.
 */
export const INDEX_SCHEMA_VERSION = 8;

export interface FileState {
  size: number;
  mtimeMs: number;
  hash: string;
}

export interface IndexManifest {
  schemaVersion: number;
  engineVersion: string;
  /**
   * The absolute root this index describes. An index copied or moved from
   * another checkout describes files that are not these files, so it is
   * rejected rather than reused (G4: no cross-root artifact reuse).
   */
  root: string;
  /**
   * Digest of the exact `parsed.json` bytes this manifest was written
   * with. The manifest is written LAST, so it is the commit point: if the
   * payload beside it does not hash to this, the pair is torn and neither
   * half is trustworthy.
   */
  parsedDigest: string;
  /** repo-relative path -> state */
  files: Record<string, FileState>;
  builtAt: string;
}

export interface LoadedIndex {
  manifest: IndexManifest;
  parsedByHash: Map<string, ParsedFile>;
}

export interface RepoConfig {
  /** Ignore globs applied at discovery, merged with any CLI/API value. */
  ignore?: string[];
}

export function indexDir(root: string): string {
  return join(root, '.euthynos');
}

export function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 32);
}

/** Read the per-repo config; absent or malformed config is simply empty. */
export function loadConfig(root: string): RepoConfig {
  try {
    const raw = readFileSync(join(indexDir(root), 'config.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const ignore = (parsed as RepoConfig).ignore;
    return Array.isArray(ignore) ? { ignore: ignore.filter((g) => typeof g === 'string') } : {};
  } catch {
    return {};
  }
}

/**
 * Load a previously written index. Returns null when there is none, when it
 * was written by a different schema/engine, or when it is unreadable —
 * every one of which means "parse from scratch", not "fail".
 */
export function loadIndex(
  root: string,
  engineVersion: string,
  meta?: { rejected?: 'schema-mismatch' | 'engine-mismatch' | 'malformed' | 'root-mismatch' | 'torn-pair' },
): LoadedIndex | null {
  try {
    const dir = indexDir(root);
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as IndexManifest;
    if (
      manifest.schemaVersion !== INDEX_SCHEMA_VERSION ||
      manifest.engineVersion !== engineVersion ||
      typeof manifest.files !== 'object' ||
      manifest.files === null
    ) {
      // A discarded index and a MISSING index are different events: the
      // blueprint promised the silent full rebuild would be announced
      // (launch-readiness §4.10). The caller surfaces this on stderr.
      if (meta) {
        meta.rejected =
          manifest.schemaVersion !== INDEX_SCHEMA_VERSION
            ? 'schema-mismatch'
            : manifest.engineVersion !== engineVersion
              ? 'engine-mismatch'
              : 'malformed';
      }
      return null;
    }
    // The manifest must describe THIS root: a copied or moved index
    // describes other files entirely (G4).
    if (typeof manifest.root !== 'string' || manifest.root !== resolve(root)) {
      if (meta) meta.rejected = 'root-mismatch';
      return null;
    }
    // The payload must be the one this manifest was committed against.
    // Anything else is a torn pair: interrupted write, interleaved
    // concurrent writer, or hand-edited artifacts.
    const parsedText = readFileSync(join(dir, 'parsed.json'), 'utf8');
    if (typeof manifest.parsedDigest !== 'string' || manifest.parsedDigest !== contentHash(parsedText)) {
      if (meta) meta.rejected = 'torn-pair';
      return null;
    }
    const parsedRaw = JSON.parse(parsedText) as Record<string, ParsedFile>;
    const parsedByHash = new Map<string, ParsedFile>();
    for (const [hash, file] of Object.entries(parsedRaw)) {
      if (file && typeof file.path === 'string') parsedByHash.set(hash, file);
    }
    return { manifest, parsedByHash };
  } catch {
    return null;
  }
}

/**
 * Persist the index atomically. Best-effort: a read-only checkout, a full
 * disk or a permission error must never surface to the caller.
 * Returns true when the write landed.
 */
export function saveIndex(
  root: string,
  engineVersion: string,
  files: Record<string, FileState>,
  parsedByHash: Map<string, ParsedFile>,
): boolean {
  if (process.env['EUTHYNOS_NO_INDEX'] === '1') return false;
  try {
    const dir = ensureIndexDir(root);

    const manifest: IndexManifest = {
      schemaVersion: INDEX_SCHEMA_VERSION,
      engineVersion,
      root: resolve(root),
      parsedDigest: '', // filled in below, once the payload bytes exist
      files,
      builtAt: new Date().toISOString(),
    };
    // Only artifacts the manifest still references are kept — otherwise the
    // store grows by one entry per edit, forever.
    const live = new Set(Object.values(files).map((f) => f.hash));
    const payload: Record<string, ParsedFile> = {};
    for (const [hash, parsed] of parsedByHash) {
      if (live.has(hash)) payload[hash] = parsed;
    }

    // Order matters and is the whole integrity story: the payload lands
    // first, then the manifest that vouches for it. A crash between the two
    // leaves a manifest that does not match — which the loader detects —
    // never a manifest that silently describes content that is not there.
    manifest.parsedDigest = writeParsedStreaming(join(dir, 'parsed.json'), payload);
    atomicWrite(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 1));
    writeGitignore(dir);
    return true;
  } catch {
    return false;
  }
}

/**
 * Serialise, hash and write the payload ONE ENTRY AT A TIME.
 *
 * The whole document used to be built as a single string and then hashed,
 * so peak RSS during a save carried the entire payload (22 MB on a
 * 10,000-file repository) plus the hasher's own copy of it. Only one record
 * is in flight now.
 *
 * The bytes are byte-identical to `JSON.stringify(payload)` — same key
 * order (insertion order, which is what JSON.stringify uses for a plain
 * object), same escaping, same separators — so the digest is the SAME
 * digest and no existing index is invalidated by this change.
 *
 * Returns the digest, which the manifest then commits.
 */
function writeParsedStreaming(path: string, payload: Record<string, ParsedFile>): string {
  const tmp = `${path}.${process.pid}.tmp`;
  const hash = createHash('sha256');
  const fd = openSync(tmp, 'w');
  try {
    const push = (text: string): void => {
      const buf = Buffer.from(text, 'utf8');
      hash.update(buf);
      writeSync(fd, buf);
    };
    push('{');
    let first = true;
    for (const [key, value] of Object.entries(payload)) {
      push(`${first ? '' : ','}${JSON.stringify(key)}:${JSON.stringify(value)}`);
      first = false;
    }
    push('}');
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  return hash.digest('hex').slice(0, 32);
}

/** Temp file + rename: a reader never observes a partial index. */
function atomicWrite(path: string, contents: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, contents);
  renameSync(tmp, path);
}

/**
 * Create `.euthynos/` AND its .gitignore together.
 *
 * Never mkdir this directory any other way. Telemetry created it bare once,
 * and the very next `git add -A` in that repository committed a local
 * telemetry log — we wrote a file into someone's project that they then
 * shipped. The directory and the rule that hides it are one operation.
 */
export function ensureIndexDir(root: string): string {
  const dir = indexDir(root);
  mkdirSync(dir, { recursive: true });
  writeGitignore(dir);
  return dir;
}

/**
 * The index is a local cache — it should not land in anyone's commits.
 * Written once, never overwritten if the user edited it.
 */
function writeGitignore(dir: string): void {
  const path = join(dir, '.gitignore');
  try {
    statSync(path);
  } catch {
    writeFileSync(path, '# Euthynos local index — not source, do not commit\n*\n');
  }
}

/** Remove the whole index (used by `--rebuild` and by tests). */
export function clearIndex(root: string): void {
  try {
    rmSync(indexDir(root), { recursive: true, force: true });
  } catch {
    // nothing to clear
  }
}

/** Size on disk, for `index --status`. */
export function indexSizeBytes(root: string): number {
  try {
    const dir = indexDir(root);
    let total = 0;
    for (const name of readdirSync(dir)) {
      try {
        total += statSync(join(dir, name)).size;
      } catch {
        // entry vanished mid-listing
      }
    }
    return total;
  } catch {
    return 0;
  }
}
