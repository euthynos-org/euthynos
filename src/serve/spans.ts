import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';

/**
 * SOURCE SPAN SERVER — the piece that makes Euthynos the cheapest way to SEE
 * code, not only to reason about it.
 *
 * Contract:
 *  - Serves an exact LINE RANGE, never a whole file. The failure mode this
 *    layer exists to end is "read 500 lines to see 20".
 *  - Reads from DISK at serve time, so what an agent gets is the current
 *    working-tree text — an index that lagged behind an edit would feed the
 *    agent stale source, which is worse than no answer (freshness contract).
 *  - Refuses to leave the repository root, INCLUDING through symlinks: a
 *    path from an agent is untrusted input, and a lexical check alone is
 *    satisfied by `repo/link -> /etc`.
 *  - Caps bytes as well as lines: one minified line can be megabytes.
 */

export interface SourceSpan {
  file: string;
  startLine: number;
  endLine: number;
  /** The source text of those lines, newline-joined, no trailing newline. */
  text: string;
  /** Lines in the file — lets a caller see how much was NOT returned. */
  totalLines: number;
  /** True when the requested range was clamped to the file's bounds. */
  clamped: boolean;
  /** True when the text was cut to satisfy the byte cap. */
  byteTruncated: boolean;
}

export class SpanError extends Error {}

/** Hard ceilings. A response is a fact, not a file transfer. */
export const MAX_SPAN_BYTES = 64 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024;

/**
 * Absolute path of a repo-relative file, refusing escapes.
 * Both the lexical path AND its realpath must stay inside the root, so a
 * symlink pointing outside the repository cannot be served.
 */
export function resolveInRepo(root: string, relPath: string): string {
  if (typeof relPath !== 'string' || relPath.length === 0 || relPath.includes('\0')) {
    throw new SpanError('file path is required');
  }
  // Absolute paths, UNC shares and Windows drive-relative forms (`C:foo`)
  // are all rejected: the contract is repository-relative.
  if (isAbsolute(relPath) || /^[A-Za-z]:/.test(relPath) || relPath.startsWith('\\\\')) {
    throw new SpanError(`path must be repository-relative: ${relPath}`);
  }
  const rootAbs = resolve(root);
  const abs = resolve(join(rootAbs, relPath));
  if (!contains(rootAbs, abs)) throw new SpanError(`path escapes the repository: ${relPath}`);

  // Symlink check: compare REAL paths. A missing file is reported by the
  // caller's stat, not here.
  try {
    const realRoot = realpathSync(rootAbs);
    const realAbs = realpathSync(abs);
    if (!contains(realRoot, realAbs)) throw new SpanError(`path escapes the repository via a link: ${relPath}`);
  } catch (e) {
    if (e instanceof SpanError) throw e;
    // ENOENT etc: let the caller's stat produce the "file not found" message.
  }
  return abs;
}

/** Case-insensitive on Windows, where `C:\Repo` and `c:\repo` are one path. */
function contains(root: string, child: string): boolean {
  const [r, c] = process.platform === 'win32' ? [root.toLowerCase(), child.toLowerCase()] : [root, child];
  return c === r || c.startsWith(r.endsWith(sep) ? r : r + sep);
}

/**
 * Read a line range (1-based, inclusive). `context` adds lines on both sides.
 * A range beyond the file's end is clamped and REPORTED, never invented.
 */
export function readSpan(
  root: string,
  relPath: string,
  startLine: number,
  endLine: number,
  context = 0,
): SourceSpan {
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) {
    throw new SpanError(`invalid line range ${String(startLine)}-${String(endLine)}`);
  }
  const ctx = Number.isInteger(context) && context > 0 ? Math.min(context, 50) : 0;
  const abs = resolveInRepo(root, relPath);
  let stat;
  try {
    stat = statSync(abs);
  } catch {
    throw new SpanError(`file not found: ${relPath}`);
  }
  if (!stat.isFile()) throw new SpanError(`not a file: ${relPath}`);
  if (stat.size > MAX_FILE_BYTES) throw new SpanError(`file too large to serve: ${relPath}`);

  const raw = readFileSync(abs, 'utf8');
  const lines = raw.split('\n');
  // A file ending in a newline splits to a trailing "" that is not a line.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const total = lines.length;

  const clamped = startLine > total || endLine > total;
  const from = Math.max(1, Math.min(startLine, total) - ctx);
  const to = Math.min(total, Math.max(endLine, startLine) + ctx);

  let text = lines
    .slice(from - 1, to)
    .map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l)) // CRLF-stable spans
    .join('\n');
  let byteTruncated = false;
  if (Buffer.byteLength(text, 'utf8') > MAX_SPAN_BYTES) {
    text = text.slice(0, MAX_SPAN_BYTES);
    byteTruncated = true;
  }

  return { file: relPath, startLine: from, endLine: to, text, totalLines: total, clamped, byteTruncated };
}

/** Render a span with line numbers — the shape an agent can act on directly. */
export function renderSpan(span: SourceSpan): string {
  const width = String(span.endLine).length;
  const body = span.text
    .split('\n')
    .map((line, i) => `${String(span.startLine + i).padStart(width)} | ${line}`)
    .join('\n');
  return span.byteTruncated
    ? `${body}\n... [cut: span exceeded ${MAX_SPAN_BYTES / 1024}KB — request a narrower range]`
    : body;
}
