import { readdirSync, statSync, type Dirent } from 'node:fs';
import { join, relative, sep } from 'node:path';

// Hardening: a scanned repo may be HOSTILE (the cloud SaaS clones untrusted
// code; even the local CLI can be aimed at a malicious repo). We never follow
// symlinks (which could escape the repo root to /etc, host secrets, or another
// tenant's workspace), skip oversized files, and cap total file count — so a
// crafted repo can't traverse out of the tree or OOM/DoS the scanner.
const MAX_FILE_BYTES = 4 * 1024 * 1024; // skip files > 4MB (minified bundles, vendored blobs, zip-bomb guard)
const MAX_FILES = 60_000; // hard ceiling on discovered code files (runaway monorepo / DoS guard)

const CODE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|go|java|rb|rs|php|c|h|cpp|cc|cxx|hpp|hh|hxx|cs|dart|kt|kts|swift|vue|cob|cbl|cpy)$/;
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage',
  '.next', '.nuxt', '.turbo', '.cache', 'vendor', '__pycache__',
  '.venv', 'venv', '__pypackages__', 'site-packages', 'target', 'bin', 'obj',
  '.dart_tool', '.gradle', '.build', 'Pods', 'DerivedData',
]);
const TEST_PATH = /(\.test\.|\.spec\.|__tests__|(^|\/)tests?\/|(^|\/)test_|_test\.(py|go|dart|c|cc|cpp)$|_spec\.rb$|Test\.java$|Tests?\.cs$|Tests?\.swift$|Test\.kt$)/;

/** Which parser handles a file. */
export type Lang =
  | 'ts' | 'py' | 'go' | 'java' | 'rb' | 'rs' | 'php'
  | 'c' | 'cpp' | 'cs' | 'dart' | 'kt' | 'swift' | 'vue' | 'cob';

export interface DiscoveredFile {
  abs: string;
  rel: string;
  module: string;
  isTest: boolean;
  lang: Lang;
  /** Size in bytes, from the stat the walk already performed. */
  size: number;
  /** Modification time, so the incremental index need not stat again. */
  mtimeMs: number;
}

export function langOf(rel: string): Lang {
  if (rel.endsWith('.py')) return 'py';
  if (rel.endsWith('.go')) return 'go';
  if (rel.endsWith('.java')) return 'java';
  if (rel.endsWith('.rb')) return 'rb';
  if (rel.endsWith('.rs')) return 'rs';
  if (rel.endsWith('.php')) return 'php';
  if (rel.endsWith('.c')) return 'c';
  if (/\.(cpp|cc|cxx|hpp|hh|hxx|h)$/.test(rel)) return 'cpp'; // C++ grammar is a superset; owns ambiguous .h
  if (rel.endsWith('.cs')) return 'cs';
  if (rel.endsWith('.dart')) return 'dart';
  if (/\.kts?$/.test(rel)) return 'kt';
  if (rel.endsWith('.swift')) return 'swift';
  if (rel.endsWith('.vue')) return 'vue';
  if (/\.(cob|cbl|cpy)$/.test(rel)) return 'cob';
  return 'ts';
}

/**
 * Minimal glob -> regex for ignore patterns: `**` spans path segments,
 * `*` stays within one segment, `?` is a single character. Anchored to the
 * FULL repo-relative path (forward slashes).
 */
export function globToRegex(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else {
      re += /[a-zA-Z0-9_\-/]/.test(ch) ? ch : `\\${ch}`;
    }
  }
  return new RegExp(`^(?:${re})$`);
}

/**
 * Walk the repo and assign each code file to a module.
 *
 * `meta.truncated` reports whether the walk STOPPED at the file cap — a
 * capped discovery that stayed silent let every downstream view present a
 * truncated repository as the whole one, which violates the house rule that
 * a capped list without its total is an exhaustiveness claim
 * (LAUNCH-READINESS-REVIEW §4.2). `opts.maxFiles` exists so tests and
 * operators can exercise the cap without a 60k-file fixture; detection
 * behavior is otherwise unchanged.
 */
export function discoverFiles(
  root: string,
  ignore: string[] = [],
  meta?: { truncated?: boolean },
  opts?: { maxFiles?: number; needsStat?: (rel: string) => boolean },
): DiscoveredFile[] {
  const cap = opts?.maxFiles ?? MAX_FILES;
  const files: DiscoveredFile[] = [];
  const ignoreRes = ignore.map(globToRegex);
  const ignored = (rel: string): boolean => ignoreRes.some((re) => re.test(rel));
  if (meta) meta.truncated = false;
  walk(root);
  return files;

  function walk(dir: string): void {
    if (files.length >= cap) {
      if (meta) meta.truncated = true;
      return; // hit the ceiling — stop discovering, but never silently
    }
    let entries: Dirent[];
    try {
      // withFileTypes carries kind AND symlink-ness, so traversal needs no
      // per-entry lstat: on a 1,500-file repo that removed thousands of
      // syscalls from every warm sweep.
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const name = entry.name;
      if (name.startsWith('.') && name !== '.') continue;
      if (entry.isSymbolicLink()) continue; // never follow symlinks (repo-escape guard)
      const abs = join(dir, name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!CODE_EXT.test(name) || name.endsWith('.d.ts')) continue;
      const rel = relative(root, abs).split(sep).join('/');
      if (ignored(rel)) continue; // user ignore globs (vendored/generated code)
      // Only CODE files are stat'ed — and the result travels with the
      // record so the index does not stat the same file again.
      //
      // The stat is 97% of a warm sweep (measured: 69 ms enumeration vs
      // 2,025 ms of statSync on 10,000 files). When the caller holds an
      // authority that already knows this file did not move — the change
      // oracle — it may waive the stat for that file. Waived records carry
      // size/mtimeMs = -1, which is meaningless to compare, so a caller
      // MUST have a prior state for the path before waiving. The size cap
      // still applied when that prior state was recorded.
      if (opts?.needsStat !== undefined && !opts.needsStat(rel)) {
        if (files.length >= cap) {
          if (meta) meta.truncated = true;
          return;
        }
        files.push({
          abs,
          rel,
          module: moduleOf(rel),
          isTest: TEST_PATH.test(rel),
          lang: langOf(rel),
          size: -1,
          mtimeMs: -1,
        });
        continue;
      }
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.size > MAX_FILE_BYTES) continue; // oversized — skip (perf + DoS guard)
      if (files.length >= cap) {
        if (meta) meta.truncated = true;
        return;
      }
      files.push({
        abs,
        rel,
        module: moduleOf(rel),
        isTest: TEST_PATH.test(rel),
        lang: langOf(rel),
        size: st.size,
        mtimeMs: st.mtimeMs,
      });
    }
  }
}

/**
 * Module assignment heuristic (per spec: "directory structure" inference).
 *   src/auth/token.ts        -> auth
 *   src/services/auth/x.ts   -> services/auth (two levels under src/ when grouped dirs)
 *   lib/payment/y.ts         -> payment
 *   index.ts (repo root)     -> (root)
 */
/** Whether a repo-relative path is a code file this engine indexes (D0). */
export function isCodeFile(rel: string): boolean {
  const name = rel.split('/').pop() ?? rel;
  return CODE_EXT.test(name) && !name.endsWith('.d.ts');
}

/** Whether a repo-relative path matches the test-file conventions (D0). */
export function isTestPath(rel: string): boolean {
  return TEST_PATH.test(rel);
}

export function moduleOf(rel: string): string {
  const parts = rel.split('/');
  const containers = new Set(['src', 'lib', 'packages', 'apps']);
  let i = 0;
  while (i < parts.length - 1 && containers.has(parts[i]!)) i++;
  // Group dirs like services/, modules/, features/ take one more level.
  const groupers = new Set(['services', 'modules', 'features', 'domains']);
  if (i < parts.length - 2 && groupers.has(parts[i]!)) {
    return `${parts[i]}/${parts[i + 1]}`;
  }
  if (i >= parts.length - 1) return '(root)';
  return parts[i]!;
}
