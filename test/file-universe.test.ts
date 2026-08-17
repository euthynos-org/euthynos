import { describe, expect, it, beforeAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callTool } from '../src/mcp/tools.js';
import { getIndex } from '../src/index/incremental.js';

/**
 * ONE AUTHORITATIVE FILE UNIVERSE (launch blocker G2).
 *
 * Reproduced defect, 2026-08-15: `.euthynos/config.json` declaring
 * `ignore: ["generated/**"]` was honoured by the INDEX tier (getIndex
 * merges config + caller globs) and ignored by the GRAPH tier —
 * `cachedGraph` called `buildRepoGraph(root, { withMetrics: true })` with
 * no ignore option at all, so `buildRepoGraph` discovered with `[]`.
 * Result: `callers_of` resolved symbols that live in files the user had
 * explicitly excluded, and the two tiers disagreed about what exists.
 *
 * Contract pinned here BEFORE the fix:
 *  - the effective ignore set is computed ONCE and exposed on the index;
 *  - every tier derives its file universe from that same set;
 *  - a symbol whose only definition sits in an excluded file is NOT
 *    resolvable by the graph tools, and the exclusion is honest (the
 *    empty answer keeps its boundary statement — silence is never a
 *    claim that the symbol does not exist).
 */

let repo: string;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'universe-'));
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(join(repo, 'generated'), { recursive: true });
  mkdirSync(join(repo, '.euthynos'), { recursive: true });

  writeFileSync(
    join(repo, 'src', 'app.ts'),
    "import { gen } from '../generated/big';\nexport function useIt(): number {\n  return gen();\n}\n",
  );
  writeFileSync(join(repo, 'generated', 'big.ts'), 'export function gen(): number {\n  return 42;\n}\n');
  writeFileSync(join(repo, '.euthynos', 'config.json'), JSON.stringify({ ignore: ['generated/**'] }));
});

describe('G2 — one authoritative file universe', () => {
  it('the index tier honours the repo ignore config', () => {
    const idx = getIndex(repo);
    const paths = idx.files.map((f) => f.path).sort();
    expect(paths).toContain('src/app.ts');
    expect(paths).not.toContain('generated/big.ts');
  });

  it('the graph tier sees the SAME universe (the reproduced defect)', () => {
    // Pre-fix this reported "1 transitive callers of gen: d1 useIt", i.e.
    // it resolved a symbol defined in an excluded file.
    const r = callTool('callers_of', { path: repo, function: 'gen' });
    expect(r.text).not.toMatch(/d1 useIt/);
  });

  it('an excluded symbol is not resolvable, and the answer stays honest', () => {
    const r = callTool('callers_of', { path: repo, function: 'gen' });
    // Whatever shape the miss takes, it must never read as a bare negative:
    // the tool states its boundary (the established honesty contract).
    expect(r.text.toLowerCase()).toMatch(/not found|no callers|indexed|boundary|static/);
  });

  it('module-level views agree with the index universe', () => {
    const r = callTool('repo_map', { path: repo });
    expect(r.text).not.toMatch(/\bgenerated\b/);
  });

  it('non-excluded symbols still resolve normally (no over-correction)', () => {
    const r = callTool('callers_of', { path: repo, function: 'useIt' });
    expect(r.isError ?? false).toBe(false);
  });

  it('the scan-report tier (metrics/health) shares the universe too', () => {
    // Second instance of the same defect class: cachedReport called
    // scan(root, {months}) with no ignore set, so module metrics counted
    // excluded files.
    const r = callTool('architecture_health', { path: repo });
    expect(r.isError ?? false).toBe(false);
    expect(r.text).not.toMatch(/\bgenerated\b/);
  });

  it('every tier reports the same file count', () => {
    const idx = getIndex(repo);
    const health = callTool('architecture_health', { path: repo }).text;
    const m = health.match(/(\d+)\s+files/i);
    if (m) expect(Number(m[1])).toBe(idx.files.length);
  });
});
