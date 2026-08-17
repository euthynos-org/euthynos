import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverFiles } from '../discover.js';
import { parseDiscovered } from '../parse/dispatch.js';
import { buildGraph } from '../graph/imports.js';
import type { ModuleGraph, ParsedFile } from '../types.js';
import {
  contentHash,
  loadConfig,
  loadIndex,
  saveIndex,
  INDEX_SCHEMA_VERSION,
  type FileState,
} from './store.js';
import { readChangeOracle, canSkipStat, ORACLE_MIN_FILES, type ChangeOracle } from './change-oracle.js';
import { resetGitRequestCache } from '../git/run.js';

/**
 * INCREMENTAL INDEX — the working-tree-accurate view every tool reads from.
 *
 * Two properties, in priority order:
 *
 *  1. CORRECT. Every call sweeps the tree (a directory walk plus one stat
 *     per file — no parsing) and reparses only what moved. An agent that
 *     writes a file and immediately asks about it gets the new file; an
 *     agent that edits a function never sees the old body. A time-based
 *     cache cannot promise either, which is why there is no TTL anywhere
 *     in this path.
 *  2. FAST. Unchanged files are reused from memory, and a cold process
 *     rehydrates from `.euthynos/` instead of re-parsing the repository.
 *
 * `generation` increments whenever the set of parsed files changes, so
 * every derived cache (scan report, knowledge graph) can invalidate off one
 * signal instead of guessing.
 */

export interface RepoIndex {
  files: ParsedFile[];
  moduleGraph: ModuleGraph;
  /** Bumps when anything changed; derived caches key off this. */
  generation: number;
  stats: IndexStats;
  /**
   * The EFFECTIVE ignore set (repo config + caller globs), computed once
   * here and published so every tier derives the same file universe.
   *
   * Launch blocker G2: the graph tier used to discover with `[]` while
   * this tier merged the repo's config, so `callers_of` resolved symbols
   * out of files the user had explicitly excluded and the two tiers
   * disagreed about what exists. Anything that discovers files for this
   * root MUST pass this set — it is the single authority.
   */
  ignore: string[];
}

export interface IndexStats {
  fileCount: number;
  /** Files parsed during the LAST sweep (0 = fully warm). */
  reparsed: number;
  /** Files rehydrated from the on-disk index at process start. */
  rehydrated: number;
  /** Files discovered but not parseable — invisible to every answer. */
  skipped: number;
  lastSweepMs: number;
  loadedFromDisk: boolean;
  persisted: boolean;
}

interface Entry {
  state: FileState;
  parsed: ParsedFile;
}

interface RepoState {
  byPath: Map<string, Entry>;
  parsedByHash: Map<string, ParsedFile>;
  files: ParsedFile[];
  moduleGraph: ModuleGraph;
  generation: number;
  stats: IndexStats;
  dirty: boolean;
  lastPersistMs: number;
  triedDiskLoad: boolean;
}

const repos = new Map<string, RepoState>();

/** How long a dirty index may wait before being written back. */
const PERSIST_DEBOUNCE_MS = 3_000;

/**
 * Request scoping. One tool call may consult several derived caches (files,
 * scan report, knowledge graph); each would otherwise re-sweep the tree.
 * Within a single request the working tree is fixed BY DEFINITION — the
 * agent cannot edit a file midway through our own function call — so the
 * sweep is memoized per request. This is scoping, not a TTL: the memo dies
 * with the request, and a caller that never opens one always sweeps.
 */
let requestId = 0;
const requestMemo = new Map<string, { req: number; index: RepoIndex }>();

export function beginRequest(): void {
  requestId++;
  requestMemo.clear();
  // Git results are valid only within one request, for the same reason the
  // index memo is: the tree cannot move during our own call.
  resetGitRequestCache();
}

/**
 * Drop all in-memory repo state. Tests only — it lets the differential
 * suite build the same repository twice, once per sweep strategy, from a
 * genuinely cold start.
 */
export function resetIndexForTests(): void {
  repos.clear();
  requestMemo.clear();
}

/**
 * Engine identity: a persisted artifact was produced by THIS build. Bump
 * INDEX_SCHEMA_VERSION (store.ts) when parse output changes MEANING; the
 * engine version separates BUILDS whose behavior may differ without a
 * schema change. It is derived, never hardcoded: a hardcoded string let two
 * different builds exchange `.euthynos` artifacts as though identical
 * (launch-readiness §4.9). Built engines carry package version + git
 * commit from `dist/build-info.json` (written by scripts/stamp-build.mjs);
 * source-mode runs (tsx/vitest, no stamp) get an explicit `-dev` identity
 * so dev artifacts never masquerade as a release build's. Known residual,
 * recorded: two different SOURCE states in dev mode share the dev identity
 * — acceptable because dev caches are local and cheap to clear, and the
 * release path is fully pinned.
 */
export const ENGINE_VERSION = deriveEngineVersion();

function deriveEngineVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  try {
    // dist layout: dist/index/incremental.js -> dist/build-info.json
    const info = JSON.parse(readFileSync(join(here, '..', 'build-info.json'), 'utf8')) as {
      name?: string;
      version?: string;
      commit?: string;
    };
    if (typeof info.version === 'string' && typeof info.commit === 'string') {
      return `${info.name ?? 'euthynos'}-${info.version}+${info.commit}`;
    }
  } catch {
    /* no stamp: source-mode run */
  }
  try {
    const pkg = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8')) as { version?: string };
    return `euthynos-${pkg.version ?? '0.0.0'}-dev`;
  } catch {
    return 'euthynos-unknown-dev';
  }
}

/** Oracle stand-in for the walk path: nothing is known, so nothing is waived. */
const UNKNOWN_ORACLE: ChangeOracle = { kind: 'none', changed: null, tracked: null, headSha: null };

export function getIndex(
  root: string,
  opts: {
    ignore?: string[];
    useChangeOracle?: boolean;
    /** Override the size gate. Tests set 0 so small fixtures exercise the oracle. */
    oracleMinFiles?: number;
  } = {},
): RepoIndex {
  // On by default; the differential tests drive both paths through the same
  // fixtures to prove they produce identical indexes.
  const useOracle = opts.useChangeOracle ?? true;
  const memo = requestMemo.get(root);
  if (requestId > 0 && memo !== undefined && memo.req === requestId) return memo.index;

  const started = Date.now();
  const config = loadConfig(root);
  const ignore = [...(config.ignore ?? []), ...(opts.ignore ?? [])];

  let state = repos.get(root);
  let rehydrated = 0;
  let loadedFromDisk = false;

  if (state === undefined) {
    const byPath = new Map<string, Entry>();
    const parsedByHash = new Map<string, ParsedFile>();
    // Cold start: rehydrate whatever the last process left behind. Nothing
    // here is trusted blindly — the sweep below re-stats every file.
    const loadMeta: {
      rejected?: 'schema-mismatch' | 'engine-mismatch' | 'malformed' | 'root-mismatch' | 'torn-pair';
    } = {};
    const disk = loadIndex(root, ENGINE_VERSION, loadMeta);
    if (disk === null && loadMeta.rejected !== undefined) {
      // Announced, never silent (§4.10): stderr is the server's log channel
      // (stdout carries only JSON-RPC), so this reaches the MCP client's
      // logs without corrupting the protocol stream.
      process.stderr.write(
        `euthynos: persisted index for ${root} discarded (${loadMeta.rejected}) — full rebuild. Expected schema v${INDEX_SCHEMA_VERSION}, engine ${ENGINE_VERSION}.\n`,
      );
    }
    if (disk !== null) {
      loadedFromDisk = true;
      for (const [path, fileState] of Object.entries(disk.manifest.files)) {
        const parsed = disk.parsedByHash.get(fileState.hash);
        if (parsed !== undefined) {
          byPath.set(path, { state: fileState, parsed });
          rehydrated++;
        }
      }
      for (const [hash, parsed] of disk.parsedByHash) parsedByHash.set(hash, parsed);
    }
    state = {
      byPath,
      parsedByHash,
      files: [],
      moduleGraph: buildGraph([]),
      generation: 0,
      stats: {
        fileCount: 0,
        reparsed: 0,
        rehydrated,
        skipped: 0,
        lastSweepMs: 0,
        loadedFromDisk,
        persisted: false,
      },
      dirty: false,
      lastPersistMs: 0,
      triedDiskLoad: true,
    };
    repos.set(root, state);
  }

  // ── sweep ────────────────────────────────────────────────────────────
  const nextByPath = new Map<string, Entry>();
  const files: ParsedFile[] = [];
  let reparsed = 0;
  let skipped = 0;
  let changed = false;

  // Ask git what moved before touching the filesystem. Files it tracks and
  // reports unchanged need no stat at all; everything else (untracked,
  // gitignored, unknown to git, or newly seen) is stat'ed exactly as before.
  // With no git this returns kind:'none' and every file is stat'ed — today's
  // behaviour, unchanged.
  // Only worth a subprocess once the stat storm exceeds it — measured
  // crossover near 3–4k files (see ORACLE_MIN_FILES). A cold index has no
  // prior file count, so the first sweep always walks and the oracle takes
  // over from the second sweep on.
  const bigEnough = state.byPath.size >= (opts.oracleMinFiles ?? ORACLE_MIN_FILES);
  const oracle = useOracle && bigEnough ? readChangeOracle(root) : UNKNOWN_ORACLE;
  const priorByPath = state.byPath;
  const needsStat = (rel: string): boolean => !canSkipStat(oracle, rel, priorByPath.has(rel));

  for (const f of discoverFiles(root, ignore, undefined, { needsStat })) {
    // Discovery already stat'ed this file; re-stating every path was the
    // single biggest cost in a warm sweep.
    const { size, mtimeMs } = f;

    const prev = state.byPath.get(f.rel);
    // size === -1 means the stat was waived because the oracle vouched for
    // this path; `prev` is guaranteed present (needsStat required it).
    if (prev !== undefined && size === -1) {
      nextByPath.set(f.rel, prev);
      files.push(prev.parsed);
      continue;
    }
    if (prev !== undefined && prev.state.size === size && prev.state.mtimeMs === mtimeMs) {
      nextByPath.set(f.rel, prev);
      files.push(prev.parsed);
      continue;
    }

    // size/mtime moved — but the CONTENT may not have (a touch, a checkout,
    // a save with no edit). Hash first and reuse the artifact if we have it.
    let text: string;
    try {
      text = readFileSync(f.abs, 'utf8');
    } catch {
      continue;
    }
    const hash = contentHash(text);
    const known = state.parsedByHash.get(hash);
    const state2: FileState = { size, mtimeMs, hash };
    if (known !== undefined && known.path === f.rel) {
      nextByPath.set(f.rel, { state: state2, parsed: known });
      files.push(known);
      changed = true; // stamp moved: the manifest must be rewritten
      continue;
    }

    try {
      // The bytes are already in hand from hashing — never read them twice.
      const parsed = parseDiscovered(f, { text });
      state.parsedByHash.set(hash, parsed);
      nextByPath.set(f.rel, { state: state2, parsed });
      files.push(parsed);
      reparsed++;
      changed = true;
    } catch {
      skipped++;
      changed = true;
    }
  }

  if (nextByPath.size !== state.byPath.size) changed = true;

  if (changed || state.generation === 0) {
    state.byPath = nextByPath;
    state.files = files;
    state.moduleGraph = buildGraph(files);
    state.generation++;
    state.dirty = true;
  }

  state.stats = {
    fileCount: state.files.length,
    reparsed,
    rehydrated,
    skipped,
    lastSweepMs: Date.now() - started,
    loadedFromDisk: loadedFromDisk || state.stats.loadedFromDisk,
    persisted: state.stats.persisted,
  };

  maybePersist(root, state);

  const result: RepoIndex = {
    files: state.files,
    moduleGraph: state.moduleGraph,
    generation: state.generation,
    stats: state.stats,
    ignore,
  };
  if (requestId > 0) requestMemo.set(root, { req: requestId, index: result });
  return result;
}

/**
 * Write-back is debounced and best-effort: a query is never delayed to
 * update a cache, and a repository we cannot write to still works.
 */
function maybePersist(root: string, state: RepoState): void {
  if (!state.dirty) return;
  const now = Date.now();
  if (state.lastPersistMs !== 0 && now - state.lastPersistMs < PERSIST_DEBOUNCE_MS) return;
  const manifestFiles: Record<string, FileState> = {};
  for (const [path, entry] of state.byPath) manifestFiles[path] = entry.state;
  const ok = saveIndex(root, ENGINE_VERSION, manifestFiles, state.parsedByHash);
  state.lastPersistMs = now;
  state.dirty = !ok;
  state.stats.persisted = ok;
}

/** Force a write-back now (process exit, `index --build`). */
export function flushIndex(root: string): void {
  const state = repos.get(root);
  if (state === undefined || !state.dirty) return;
  state.lastPersistMs = 0;
  maybePersist(root, state);
}

/** Drop in-memory state (tests, `--rebuild`). */
export function resetIndex(root?: string): void {
  if (root === undefined) repos.clear();
  else repos.delete(root);
}
