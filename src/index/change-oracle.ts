import { runGitLog } from '../git/run.js';

/**
 * CHANGE ORACLE — answer "which files could possibly have changed?" without
 * asking the filesystem about every file.
 *
 * Measured on a 10,000-file repository (2026-08-15):
 *   directory enumeration (readdir withFileTypes)      69 ms
 *   one statSync per discovered file                2,025 ms   ← 97% of the sweep
 *   git status --porcelain                             73 ms
 *
 * So the engine keeps its OWN enumeration — the file set, ignore globs,
 * SKIP_DIRS, symlink rule, size cap and discovery cap all stay exactly as
 * they were — and uses git only to decide which of those files still need
 * a stat. Files git has not been told about (untracked or gitignored) are
 * never covered by its answer and are ALWAYS stat'ed.
 *
 * This is deliberately NOT a repository layer: nothing is mirrored, cached,
 * fetched or owned. It is one read-only process call replacing a stat storm.
 *
 * Trust level: identical to the existing size+mtime fast path. Both trust
 * stat metadata — git compares the working tree against its index using
 * cached stat data — so this introduces no new staleness class. When git is
 * absent, fails, or is not a repository, the oracle reports `kind: 'none'`
 * and the caller stats everything, which is exactly today's behaviour.
 */
export interface ChangeOracle {
  kind: 'git' | 'none';
  /**
   * Repo-relative paths (forward slashes) that git reports as differing
   * from HEAD: modified, added, deleted, renamed (BOTH sides) or untracked.
   * `null` means "unknown" — the caller must treat every file as changed.
   */
  changed: Set<string> | null;
  /**
   * Repo-relative paths git tracks. A file outside this set is invisible to
   * `changed`, so it must always be stat'ed. `null` when unknown.
   */
  tracked: Set<string> | null;
  /** HEAD commit, when resolvable. Recorded for provenance, never a cache key. */
  headSha: string | null;
}

const UNKNOWN: ChangeOracle = { kind: 'none', changed: null, tracked: null, headSha: null };

/**
 * Below this many known files the oracle COSTS more than it saves.
 *
 * Measured (Windows, 2026-08-15), warm sweep:
 *   1,500 files   with oracle 268 ms   walk 157 ms   git calls alone 237 ms
 *  10,000 files   with oracle 548 ms   walk 960 ms   git calls alone 415 ms
 *
 * Spawning git dominates on small repositories, so the walk wins there;
 * the stat storm dominates on large ones, so the oracle wins. The
 * crossover sits near 3–4k files. Chosen conservatively so small repos —
 * the common case, and the one already comfortably inside budget — never
 * pay a subprocess tax.
 */
export const ORACLE_MIN_FILES = 3000;

/**
 * `git ls-files` is stable between mutations of the index, so it is read
 * once per root and then maintained from the status deltas below. That
 * turns the steady state into ONE git call instead of three.
 */
const trackedCache = new Map<string, Set<string>>();

export function resetOracleCacheForTests(): void {
  trackedCache.clear();
}

/** `"a/b.ts"`, `"a b.ts"` or a rename entry — normalised to forward slashes. */
function normalize(p: string): string {
  let s = p.trim();
  // Porcelain v1 quotes paths containing unusual bytes.
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    s = s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return s.replaceAll('\\', '/');
}

export function readChangeOracle(root: string): ChangeOracle {
  let statusRaw: string;
  try {
    // Deliberately the SAME invocation the diff engine issues, so that
    // within one request the two share a single git process (see
    // git/run.ts request scoping). Measured: two separate status calls
    // cost 302 ms + 303 ms on a 10,000-file repository.
    statusRaw = runGitLog(root, ['status', '--porcelain', '-uall']);
  } catch {
    // Not a repo, git missing, or any failure at all: degrade to the walk.
    return UNKNOWN;
  }

  const changed = new Set<string>();
  // Porcelain v1 line format: "XY <path>", and for renames "XY <old> -> <new>".
  // This form quotes paths containing unusual bytes. A path we cannot read
  // with confidence must NOT be silently dropped — dropping it would waive a
  // stat we owe and serve pre-edit content — so anything ambiguous abandons
  // the oracle entirely and the caller falls back to the full stat sweep.
  for (const line of statusRaw.split('\n')) {
    if (line.trim() === '') continue;
    if (line.length < 4) return UNKNOWN;
    const rest = line.slice(3);
    if (rest.startsWith('"')) return UNKNOWN; // quoted/escaped path: give up safely
    const arrow = rest.indexOf(' -> ');
    if (arrow >= 0) {
      // Rename: BOTH sides changed as far as indexing is concerned.
      changed.add(normalize(rest.slice(0, arrow)));
      changed.add(normalize(rest.slice(arrow + 4)));
      continue;
    }
    changed.add(normalize(rest));
  }

  // The tracked set only moves when the git index moves — and every such
  // move (add, rm, checkout) shows up in the status above, so a cached set
  // plus this call's deltas stays correct without re-running ls-files.
  let tracked = trackedCache.get(root);
  if (tracked === undefined) {
    try {
      tracked = new Set<string>();
      for (const p of runGitLog(root, ['ls-files', '-z']).split('\0')) {
        if (p.length > 0) tracked.add(normalize(p));
      }
      trackedCache.set(root, tracked);
    } catch {
      return UNKNOWN;
    }
  } else if (changed.size > 0) {
    // Refresh only when something moved: a path reported as changed may
    // have just entered or left the index, and mis-classifying it would
    // waive a stat we owe.
    try {
      const fresh = new Set<string>();
      for (const p of runGitLog(root, ['ls-files', '-z']).split('\0')) {
        if (p.length > 0) fresh.add(normalize(p));
      }
      tracked = fresh;
      trackedCache.set(root, fresh);
    } catch {
      return UNKNOWN;
    }
  }

  // HEAD is provenance only, never a cache key — and resolving it costs a
  // whole subprocess, so it is not read on the hot path.
  return { kind: 'git', changed, tracked, headSha: null };
}

/**
 * Can this file's stat be skipped on a warm sweep?
 *
 * Only when ALL hold: the oracle actually answered, the file is one git
 * tracks (so a change WOULD have been reported), git reports it unchanged,
 * and we already hold a parsed artifact for it. Anything else stats.
 */
export function canSkipStat(oracle: ChangeOracle, rel: string, known: boolean): boolean {
  if (!known) return false;
  if (oracle.kind !== 'git' || oracle.changed === null || oracle.tracked === null) return false;
  if (!oracle.tracked.has(rel)) return false;
  return !oracle.changed.has(rel);
}
