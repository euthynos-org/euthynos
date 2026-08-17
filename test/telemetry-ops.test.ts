import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callTool } from '../src/mcp/tools.js';
import { MAX_TELEMETRY_BYTES } from '../src/mcp/telemetry.js';
import { loadIndex, saveIndex } from '../src/index/store.js';

/**
 * Operational telemetry/index contracts (launch-readiness §4.10):
 *  - EVERY successful call persists telemetry, keyed by the RESOLVED root —
 *    the old explicit-`path`-only condition made "instruments EVERY tool
 *    call" false for the common pathless MCP configuration.
 *  - The on-disk log rotates instead of appending without bound.
 *  - A discarded persisted index states WHY (schema/engine mismatch), so
 *    the full rebuild is announced rather than silent.
 */

function freshRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tel-'));
  writeFileSync(join(dir, 'a.ts'), 'export function alpha(x: number): number {\n  return x + 1;\n}\n');
  return dir;
}

describe('telemetry persistence + rotation', () => {
  it('a pathless (cwd-defaulted) call persists telemetry in the resolved root', () => {
    const repo = freshRepo();
    const prev = process.cwd();
    try {
      process.chdir(repo);
      const r = callTool('architecture_health', {});
      expect(r.isError ?? false).toBe(false);
    } finally {
      process.chdir(prev);
    }
    const log = join(repo, '.euthynos', 'telemetry.jsonl');
    expect(existsSync(log)).toBe(true);
    const rec = JSON.parse(readFileSync(log, 'utf8').trim().split('\n')[0]);
    expect(rec.tool).toBe('architecture_health');
  });

  it('the log rotates at the cap: current -> .1, fresh file continues', () => {
    const repo = freshRepo();
    callTool('architecture_health', { path: repo }); // creates .euthynos + log
    const log = join(repo, '.euthynos', 'telemetry.jsonl');
    writeFileSync(log, 'x'.repeat(MAX_TELEMETRY_BYTES + 1024));
    callTool('module_metrics', { path: repo, module: 'nope' }); // isError -> no write
    callTool('architecture_health', { path: repo }); // success -> rotates then writes
    expect(existsSync(`${log}.1`)).toBe(true);
    expect(statSync(log).size).toBeLessThan(MAX_TELEMETRY_BYTES);
  });
});

describe('index-rebuild announcement', () => {
  it('loadIndex names WHY a persisted index was discarded', () => {
    const repo = freshRepo();
    expect(saveIndex(repo, 'engine-A', {}, new Map())).toBe(true);
    const meta: { rejected?: string } = {};
    expect(loadIndex(repo, 'engine-B', meta)).toBeNull();
    expect(meta.rejected).toBe('engine-mismatch');
    const meta2: { rejected?: string } = {};
    expect(loadIndex(mkdtempSync(join(tmpdir(), 'tel-none-')), 'engine-A', meta2)).toBeNull();
    expect(meta2.rejected).toBeUndefined(); // MISSING is not DISCARDED
  });
});
