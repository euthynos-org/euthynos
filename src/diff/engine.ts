import { resolve, join, sep } from 'node:path';
import type { ParsedFile, FunctionRecord } from '../types.js';
import { runGitLog } from '../git/run.js';
import { langOf, moduleOf, isCodeFile, isTestPath, globToRegex } from '../discover.js';
import { parseSourceByLang } from '../parse/dispatch.js';

/**
 * D0 — the diff engine (PHASE6-COMPLETION-PLAN, recorded deviation D8):
 * instead of a cached full per-commit HEAD snapshot, D0 parses only the
 * CHANGED files' old blobs, in memory, cached by blob sha. Identical
 * answers for every question the Phase 6 tools ask, at a fraction of the
 * cost, and ZERO writes anywhere — the old content never touches disk.
 *
 * Security posture (inherits the whole model):
 *  - git runs exclusively through the hardened runner (no hooks, no
 *    filters, no exotic transports, LFS smudge off);
 *  - every path git reports is containment-checked against the repo root
 *    before use (a crafted filename cannot traverse out);
 *  - blobs over the size cap or containing NUL bytes are SKIPPED with the
 *    reason recorded — skips are reported, never silent.
 *
 * Honesty posture: the report distinguishes "git unavailable", "no commits
 * yet", and a real diff; the symbol diff covers FUNCTION declarations
 * (type-only edits surface as file-level changes) — consumers state this.
 */

const MAX_BLOB_BYTES = 4 * 1024 * 1024; // discovery's own cap, mirrored

export interface ChangedFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';
  /** For renames: where the content lived at HEAD. */
  oldPath?: string;
}

export interface SymbolChange {
  file: string;
  name: string;
  kind: 'added' | 'removed' | 'modified';
  /** Declaration line in the CURRENT worktree (added/modified). */
  line?: number;
  /** Declaration line at HEAD (removed). */
  oldLine?: number;
}

export interface DiffReport {
  gitAvailable: boolean;
  /** Why the diff could not be computed (git missing / no commits). */
  unavailableReason?: string;
  head?: string;
  changedFiles: ChangedFile[];
  symbolChanges: SymbolChange[];
  /** HEAD-state parse of changed code files, keyed by OLD path. */
  oldParsed: Map<string, ParsedFile>;
  /** Files excluded from the symbol diff, with reasons — never silent. */
  skipped: { path: string; reason: string }[];
}

// Old-blob parse cache. Content-addressed by blob sha, so it is valid across
// commits, branches and processes' lifetimes alike; FIFO-capped.
const blobCache = new Map<string, ParsedFile>();
const BLOB_CACHE_MAX = 500;

/** Containment check: a git-reported relative path must stay inside root. */
function safeRel(root: string, rel: string): string | null {
  if (rel.includes('\0') || rel.trim() === '') return null;
  const norm = rel.replaceAll('\\', '/');
  const abs = resolve(join(root, norm));
  const r = resolve(root);
  const [a, b] = process.platform === 'win32' ? [abs.toLowerCase(), r.toLowerCase()] : [abs, r];
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep) ? norm : null;
}

function parseOldBlob(root: string, headRef: string, path: string): ParsedFile | { skip: string } {
  let blobSha: string;
  try {
    blobSha = runGitLog(root, ['rev-parse', `${headRef}:${path}`]).trim();
  } catch {
    return { skip: 'no blob at HEAD (path did not exist)' };
  }
  const hit = blobCache.get(blobSha);
  if (hit !== undefined) return hit;
  let text: string;
  try {
    text = runGitLog(root, ['show', `${headRef}:${path}`]);
  } catch {
    return { skip: 'git show failed for the HEAD blob' };
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_BLOB_BYTES) return { skip: `HEAD blob exceeds ${MAX_BLOB_BYTES / (1024 * 1024)}MB` };
  if (text.includes('\0')) return { skip: 'HEAD blob is binary' };
  const parsed = parseSourceByLang(path, moduleOf(path), isTestPath(path), langOf(path), text);
  if (blobCache.size >= BLOB_CACHE_MAX) {
    const first = blobCache.keys().next().value;
    if (first !== undefined) blobCache.delete(first);
  }
  blobCache.set(blobSha, parsed);
  return parsed;
}

/**
 * Multiset of content signatures per function name — same-name overloads
 * compare correctly. The signature is bodyHash PLUS literalHash: bodyHash
 * alone erases literals by design, which made a literal-only edit
 * (`return a + 2` -> `return a + 3`) invisible to the symbol diff — caught
 * by the D0 CRLF test before any tool consumed the engine.
 */
function hashesByName(fns: readonly FunctionRecord[]): Map<string, string> {
  const m = new Map<string, string[]>();
  for (const fn of fns) {
    if (fn.name.startsWith('(')) continue;
    const list = m.get(fn.name) ?? [];
    list.push(`${fn.bodyHash}:${fn.literalHash ?? ''}`);
    m.set(fn.name, list);
  }
  return new Map([...m.entries()].map(([k, v]) => [k, v.sort().join(',')]));
}

function firstDecl(fns: readonly FunctionRecord[], name: string): FunctionRecord | undefined {
  return fns.find((f) => f.name === name);
}

/**
 * The D8 hybrid: the repository's HEAD-state file set, assembled from the
 * CURRENT parses with changed files swapped for their HEAD parses
 * (added/untracked absent, deleted restored). Shared by check_my_changes
 * and boundary_check so the two can never diverge on what "old" means.
 */
export function hybridOldFiles(files: readonly ParsedFile[], d: DiffReport): ParsedFile[] {
  const changedByPath = new Map(d.changedFiles.map((c) => [c.path, c]));
  const out: ParsedFile[] = [];
  for (const f of files) {
    const c = changedByPath.get(f.path);
    if (c === undefined) {
      out.push(f);
      continue;
    }
    if (c.status === 'added' || c.status === 'untracked') continue;
    const old = d.oldParsed.get(c.status === 'renamed' ? c.oldPath! : f.path);
    if (old !== undefined) out.push(old);
  }
  for (const c of d.changedFiles) {
    if (c.status === 'deleted') {
      const old = d.oldParsed.get(c.path);
      if (old !== undefined) out.push(old);
    }
  }
  return out;
}

/**
 * Diff the worktree against HEAD. `currentByPath` supplies the CURRENT
 * parse of files (from the index) so nothing is parsed twice.
 *
 * `ignore` is the EFFECTIVE exclusion set published by the index
 * (`RepoIndex.ignore`) and must be passed by every caller that has one.
 * This tier learns about files from GIT rather than from discovery, so
 * without it an excluded file re-enters the evidence surface through a
 * different door than the one the user closed: `generated/**` was absent
 * from the index, the graph and the scan, yet still appeared as a
 * "changed file" in check_my_changes (launch blocker G3). One universe
 * means one universe on every route into the answer.
 */
export function diffWorktree(
  root: string,
  currentByPath: Map<string, ParsedFile>,
  ignore: string[] = [],
): DiffReport {
  const ignoreRes = ignore.map(globToRegex);
  const excluded = (rel: string): boolean => ignoreRes.some((re) => re.test(rel));
  const empty: DiffReport = {
    gitAvailable: false,
    changedFiles: [],
    symbolChanges: [],
    oldParsed: new Map(),
    skipped: [],
  };
  let head: string;
  try {
    head = runGitLog(root, ['rev-parse', '--short=12', 'HEAD']).trim();
  } catch {
    // Distinguish "not a repo / git absent" from "repo with no commits":
    try {
      runGitLog(root, ['rev-parse', '--git-dir']);
      return { ...empty, unavailableReason: 'repository has no commits yet — nothing to diff against' };
    } catch {
      return { ...empty, unavailableReason: 'git history not available for this directory' };
    }
  }

  const changedFiles: ChangedFile[] = [];
  const skipped: { path: string; reason: string }[] = [];

  // Tracked changes vs HEAD (staged + unstaged in one view), rename-aware.
  //
  // EOL-phantom filter (found by the Phase 6 gate on a CLEAN clone): the
  // hardened runner sets GIT_CONFIG_NOSYSTEM, which drops the SYSTEM
  // core.autocrlf on Windows — so a repo cloned with autocrlf=true shows
  // every text file as modified (CRLF worktree vs LF blobs) while the
  // user's own `git diff` is empty. `--name-status` lists such files even
  // under --ignore-cr-at-eol, but `--numstat --ignore-cr-at-eol` OMITS
  // them entirely — that is the discriminator: a MODIFIED file absent from
  // the EOL-ignoring numstat changed nothing but line endings and is
  // dropped. Stated in the consumers' scope line: a change that ONLY
  // alters line endings is not reported. (Binary files show "-\t-" in the
  // ignoring numstat and are therefore KEPT; renames carry their own
  // status and never consult this filter.)
  const realChange = new Set<string>();
  for (const line of runGitLog(root, ['diff', '--numstat', '--ignore-cr-at-eol', '-M', 'HEAD']).split('\n')) {
    const m = line.match(/^(?:\d+|-)\t(?:\d+|-)\t(.+)$/);
    if (m && !m[1]!.includes('=>')) realChange.add(m[1]!.replaceAll('\\', '/'));
  }
  const nameStatus = runGitLog(root, ['diff', '--name-status', '-M', 'HEAD']);
  for (const line of nameStatus.split('\n')) {
    if (line.trim() === '') continue;
    const parts = line.split('\t');
    const code = parts[0]!;
    if (code.startsWith('R')) {
      const oldRel = safeRel(root, parts[1] ?? '');
      const newRel = safeRel(root, parts[2] ?? '');
      if (oldRel === null || newRel === null) {
        skipped.push({ path: line.slice(0, 120), reason: 'path failed containment check' });
        continue;
      }
      if (excluded(newRel) && excluded(oldRel)) continue; // G3
      changedFiles.push({ path: newRel, status: 'renamed', oldPath: oldRel });
    } else {
      const rel = safeRel(root, parts[1] ?? '');
      if (rel === null) {
        skipped.push({ path: line.slice(0, 120), reason: 'path failed containment check' });
        continue;
      }
      const status = code.startsWith('A') ? 'added' : code.startsWith('D') ? 'deleted' : 'modified';
      if (excluded(rel)) continue; // outside the authoritative universe (G3)
      if (status === 'modified' && !realChange.has(rel)) continue; // EOL-only phantom (see above)
      changedFiles.push({ path: rel, status });
    }
  }

  // Untracked files (worktree-only additions).
  const porcelain = runGitLog(root, ['status', '--porcelain', '-uall']);
  for (const line of porcelain.split('\n')) {
    if (!line.startsWith('?? ')) continue;
    const rel = safeRel(root, line.slice(3).trim().replace(/^"|"$/g, ''));
    if (rel === null) continue;
    if (!isCodeFile(rel)) continue; // non-code untracked files are out of scope
    if (excluded(rel)) continue; // excluded tree — same universe as every other tier (G3)
    changedFiles.push({ path: rel, status: 'untracked' });
  }
  changedFiles.sort((a, b) => a.path.localeCompare(b.path));

  // Symbol diff over CODE files only.
  const symbolChanges: SymbolChange[] = [];
  const oldParsed = new Map<string, ParsedFile>();
  for (const cf of changedFiles) {
    const headPath = cf.status === 'renamed' ? cf.oldPath! : cf.path;
    const codeAtHead = cf.status !== 'untracked' && cf.status !== 'added' && isCodeFile(headPath);
    const codeNow = cf.status !== 'deleted' && isCodeFile(cf.path);
    if (!codeAtHead && !codeNow) continue;

    const oldFile = codeAtHead ? parseOldBlob(root, 'HEAD', headPath) : null;
    if (oldFile !== null && 'skip' in oldFile) {
      skipped.push({ path: headPath, reason: oldFile.skip });
      continue;
    }
    if (oldFile !== null) oldParsed.set(headPath, oldFile);

    const cur = codeNow ? currentByPath.get(cf.path) : undefined;
    if (codeNow && cur === undefined && cf.status !== 'deleted') {
      skipped.push({ path: cf.path, reason: 'current version not in the index (unparsed or skipped language)' });
      continue;
    }

    const oldFns = oldFile?.functions ?? [];
    const newFns = cur?.functions ?? [];
    const oldH = hashesByName(oldFns);
    const newH = hashesByName(newFns);
    for (const [name, sig] of newH) {
      if (!oldH.has(name)) {
        symbolChanges.push({ file: cf.path, name, kind: 'added', line: firstDecl(newFns, name)?.declLine ?? firstDecl(newFns, name)?.startLine });
      } else if (oldH.get(name) !== sig) {
        symbolChanges.push({ file: cf.path, name, kind: 'modified', line: firstDecl(newFns, name)?.declLine ?? firstDecl(newFns, name)?.startLine });
      }
    }
    for (const [name] of oldH) {
      if (!newH.has(name)) {
        symbolChanges.push({ file: cf.path, name, kind: 'removed', oldLine: firstDecl(oldFns, name)?.declLine ?? firstDecl(oldFns, name)?.startLine });
      }
    }
  }
  symbolChanges.sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name));

  return { gitAvailable: true, head, changedFiles, symbolChanges, oldParsed, skipped };
}
