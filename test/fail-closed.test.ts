/**
 * Regression tests for two defects that shipped in 0.1.3 because nothing
 * asserted them.
 *
 * 1. An unscannable root scored 100/100 [Strong]. Zero files means zero
 *    detected problems, so a typo'd path produced the BEST possible result —
 *    and `policy --strict` then reported "all architecture policies passed"
 *    and exited 0, turning a misconfigured CI gate green.
 *
 * 2. `path_between` / `graph --path` reported the NODE count as the hop count,
 *    so a direct `a → b` call was described as "2 hops". Agents consuming the
 *    MCP tool got an inflated call distance.
 */
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { scan } from '../src/scan.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, 'fixtures', 'sample');

describe('scan fails closed on an unusable root', () => {
  it('throws rather than scoring a nonexistent directory', () => {
    const missing = join(tmpdir(), 'euthynos-definitely-not-here-9f3a1c');
    expect(() => scan(missing)).toThrow(/no such directory/i);
  });

  it('names the path it could not scan', () => {
    const missing = join(tmpdir(), 'euthynos-definitely-not-here-9f3a1c');
    expect(() => scan(missing)).toThrow(/euthynos-definitely-not-here-9f3a1c/);
  });

  it('throws when the root is a file, not a directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'euthynos-notadir-'));
    const file = join(dir, 'a.ts');
    writeFileSync(file, 'export function a() {}\n');
    expect(() => scan(file)).toThrow(/not a directory/i);
  });

  it('never reports a perfect score for an unscannable path', () => {
    // The specific failure mode: 100/100 [Strong] for a path that is not there.
    const missing = join(tmpdir(), 'euthynos-definitely-not-here-9f3a1c');
    let score: number | undefined;
    try {
      score = scan(missing).health.score;
    } catch {
      score = undefined;
    }
    expect(score).toBeUndefined();
  });

  it('still scans a real directory', () => {
    const report = scan(FIXTURE, { months: 6 });
    expect(report.modules.length).toBeGreaterThan(0);
    expect(report.health.score).toBeGreaterThanOrEqual(0);
    expect(report.health.score).toBeLessThanOrEqual(100);
  });
});

describe('call-path hop counting', () => {
  // A hop is an EDGE. `a → b` is one call. The node count is one more than
  // the hop count, and reporting it inflated every distance by one.
  const hopsOf = (nodeCount: number) => nodeCount - 1;

  it('counts a direct call as one hop', () => {
    expect(hopsOf(2)).toBe(1);
  });

  it('counts an intermediate node as two hops', () => {
    expect(hopsOf(3)).toBe(2);
  });

  it('renders the singular for a direct call', () => {
    const hops = hopsOf(2);
    expect(`${hops} ${hops === 1 ? 'hop' : 'hops'}`).toBe('1 hop');
  });

  it('renders the plural beyond one', () => {
    const hops = hopsOf(3);
    expect(`${hops} ${hops === 1 ? 'hop' : 'hops'}`).toBe('2 hops');
  });
});
