import { appendFileSync, existsSync, statSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ensureIndexDir } from '../index/store.js';

/** On-disk telemetry rotation cap: current log rotates to `.1` past this. */
export const MAX_TELEMETRY_BYTES = 5 * 1024 * 1024;

/**
 * Local, private per-call instrumentation.
 *
 * Purpose (benchmark cost policy): most tool regressions — a response that
 * suddenly returns 3x the bytes, a cache that stopped hitting, a span serve
 * that got slow — are catchable deterministically, without spending a real
 * Claude Code session. Every tool call records its shape here; the CI
 * tool-metrics suite asserts against these records.
 *
 * Discipline: append-only JSONL under `.euthynos/`, LOCAL ONLY — no network
 * egress, ever. Records carry no source code and no argument VALUES beyond a
 * stable hash, so a telemetry file is safe to read and safe to delete.
 */

export interface ToolCallRecord {
  tool: string;
  argsHash: string;
  /** chars/4 estimate of the response text (labeled: an estimate, not exact). */
  estTokens: number;
  outputBytes: number;
  linesReturned: number;
  latencyMs: number;
  filesTouched: number;
  cache: 'hit' | 'miss' | 'n/a';
  dedup: boolean;
  isError: boolean;
  at: string;
}

const records: ToolCallRecord[] = [];

/** In-memory records for the current process (the CI suite reads these). */
export function callRecords(): readonly ToolCallRecord[] {
  return records;
}

export function resetCallRecords(): void {
  records.length = 0;
}

/** FNV-1a over the argument JSON — identifies repeat calls without storing values. */
export function hashArgs(args: Record<string, unknown>): string {
  const s = JSON.stringify(args, Object.keys(args).sort());
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16);
}

export interface RecordInput {
  tool: string;
  args: Record<string, unknown>;
  text: string;
  latencyMs: number;
  filesTouched?: number;
  cache?: 'hit' | 'miss' | 'n/a';
  dedup?: boolean;
  isError?: boolean;
  /** Repo root: when set, the record is also appended to <root>/.euthynos/. */
  root?: string;
}

export function recordCall(input: RecordInput): ToolCallRecord {
  const rec: ToolCallRecord = {
    tool: input.tool,
    argsHash: hashArgs(input.args),
    estTokens: Math.round(input.text.length / 4),
    outputBytes: Buffer.byteLength(input.text, 'utf8'),
    linesReturned: input.text === '' ? 0 : input.text.split('\n').length,
    latencyMs: input.latencyMs,
    filesTouched: input.filesTouched ?? 0,
    cache: input.cache ?? 'n/a',
    dedup: input.dedup ?? false,
    isError: input.isError ?? false,
    at: new Date().toISOString(),
  };
  records.push(rec);
  if (records.length > 5000) records.splice(0, records.length - 5000);

  // Disk write is best-effort and opt-out: a read-only checkout, a CI box, or
  // EUTHYNOS_NO_TELEMETRY=1 must never break a tool call.
  //
  // Only ever writes into a directory that ALREADY EXISTS and only for a
  // successful call: telemetry must never conjure `.euthynos/` inside a path
  // the user mistyped (that once made a "nonexistent path" error succeed on
  // the next run — a measurement layer must not alter what it measures).
  const canWrite =
    input.root !== undefined &&
    !rec.isError &&
    process.env['EUTHYNOS_NO_TELEMETRY'] !== '1' &&
    existsSync(input.root);
  if (canWrite) {
    try {
      // ensureIndexDir, never a bare mkdir: it writes the .gitignore in the
      // same step. Creating the directory without it once put a local
      // telemetry log into a user's next commit.
      const dir = ensureIndexDir(input.root!);
      const file = join(dir, 'telemetry.jsonl');
      // Rotation (launch-readiness §4.10): the on-disk log was an unbounded
      // append. One generation is kept: at the cap, current -> .1 (replacing
      // the previous .1), then start fresh. Still strictly best-effort.
      try {
        if (existsSync(file) && statSync(file).size > MAX_TELEMETRY_BYTES) {
          rmSync(`${file}.1`, { force: true });
          renameSync(file, `${file}.1`);
        }
      } catch {
        /* rotation is never worth failing a call over */
      }
      appendFileSync(file, JSON.stringify(rec) + '\n');
    } catch {
      // never fail a query because telemetry could not be written
    }
  }
  return rec;
}
