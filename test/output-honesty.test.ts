import { describe, expect, it, beforeAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callTool } from '../src/mcp/tools.js';
import { discoverFiles } from '../src/discover.js';
import { scan } from '../src/scan.js';
import { getIndex } from '../src/index/incremental.js';

/**
 * THE OUTPUT-HONESTY SURFACE, PINNED.
 *
 * These statements are the product's differentiator: every negative or
 * capped answer names its evidence boundary, every count states its
 * truncation, every flag says what level it describes. Before this suite
 * existed, a refactor could delete all of it and 557 tests stayed green.
 * Do not weaken any assertion here to make a change pass — the text IS the
 * contract. Additions are welcome; removals are a launch blocker.
 */

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, 'fixtures', 'sample');

/** A tiny repo with NO duplicate logic — exercises the empty branch. */
let cleanRepo: string;
/** A repo with 21 distinct intra-module clone groups — exercises truncation. */
let truncRepo: string;
/** A repo with a renamed literal-drift near-clone pair — exercises the near-clone section. */
let nearRepo: string;

beforeAll(() => {
  cleanRepo = mkdtempSync(join(tmpdir(), 'honesty-clean-'));
  writeFileSync(
    join(cleanRepo, 'a.ts'),
    'export function alpha(x: number): number {\n  return x + 1;\n}\n',
  );
  writeFileSync(
    join(cleanRepo, 'b.ts'),
    'export function beta(s: string): string {\n  return s.toUpperCase().trim().concat("!");\n}\n',
  );

  truncRepo = mkdtempSync(join(tmpdir(), 'honesty-trunc-'));
  mkdirSync(join(truncRepo, 'src'));
  // 21 clone GROUPS (one finding each), all within one module: each group is
  // one function body >=30 normalized tokens duplicated across two files.
  for (let g = 0; g < 21; g++) {
    // Each group gets a structurally DISTINCT body (g extra statements) —
    // bodyHash erases names and literals, so structure must differ or all
    // 21 groups collapse into a single finding.
    const extra = Array.from({ length: g + 1 }, () => `  total = total + a * b - c;\n`).join('');
    const body =
      `export function worker${g}(a: number, b: number, c: number): number {\n` +
      `  let total = a + b + c;\n` +
      `  for (let i = 0; i < a; i++) {\n` +
      `    total = total + i * b - c + a + i + b + c + total;\n` +
      `  }\n` +
      extra +
      `  if (total > b + c + a) {\n` +
      `    total = total - a - b - c;\n` +
      `  }\n` +
      `  return total;\n` +
      `}\n`;
    writeFileSync(join(truncRepo, 'src', `g${g}a.ts`), body);
    writeFileSync(join(truncRepo, 'src', `g${g}b.ts`), body);
  }

  nearRepo = mkdtempSync(join(tmpdir(), 'honesty-near-'));
  mkdirSync(join(nearRepo, 'src'));
  writeFileSync(
    join(nearRepo, 'src', 'edge.ts'),
    `export const isContentTypeBinary = (contentType: string): boolean => {\n  return !/^(text\\/(plain|html).*)$/.test(contentType)\n}\n`,
  );
  writeFileSync(
    join(nearRepo, 'src', 'lambda.ts'),
    `export const defaultIsContentTypeBinary = (contentType: string): boolean => {\n  return !/^text\\/(?:plain|html)$/.test(contentType)\n}\n`,
  );
});

// ── A. Tools state their search surface on every answer ─────────────────────

describe('similar_logic_exists states its search surface on EVERY answer', () => {
  it('non-empty branch: surface + NOT-searched + the reading rule', () => {
    const t = callTool('similar_logic_exists', { path: FIXTURE }).text;
    expect(t).toMatch(/Search surface: \d+ function declarations across \d+ non-test files/);
    expect(t).toContain('NOT searched: inline expressions, statement blocks, argument literals, test files');
    expect(t).toContain('duplication below declaration granularity is invisible here');
    expect(t).toContain('never "no duplicates exist in the repository"');
  });

  it('empty branch: the negative is scoped to declarations, with the same surface', () => {
    const t = callTool('similar_logic_exists', { path: cleanRepo }).text;
    expect(t).toMatch(/^no duplicate logic detected within indexed FUNCTION DECLARATIONS/);
    expect(t).toMatch(/Search surface: \d+ function declarations/);
    expect(t).toContain('never "no duplicates exist in the repository"');
  });

  it('truncation states the deterministic pre-cap total, never a bare cap', () => {
    const t = callTool('similar_logic_exists', { path: truncRepo }).text;
    expect(t).toMatch(/20 shown of 21 total — TRUNCATED at 20/);
  });

  it('near-clones report under their own label with the compare_implementations pointer', () => {
    const t = callTool('similar_logic_exists', { path: nearRepo }).text;
    expect(t).toMatch(/NEAR-CLONES \(\d+\)/);
    expect(t).toContain('compare_implementations({ a, b })');
    expect(t).toContain('identical structure; the literal values differ');
  });
});

describe('graph negatives carry their boundary', () => {
  it('callers_of zero-callers names the static-graph boundary', () => {
    const t = callTool('callers_of', { path: FIXTURE, function: 'checkout' }).text;
    expect(t).toContain('no callers in the graph');
    expect(t).toContain('static calls in indexed source only');
    expect(t).toContain('verify with a text search');
  });

  it('impact_of never asserts isolation as a fact', () => {
    const t = callTool('impact_of', { path: FIXTURE, function: 'checkout' }).text;
    expect(t).toContain('No callers found in the static call graph');
    expect(t).toContain('confirm with a text search for the name before treating a change as isolated');
    expect(t).not.toMatch(/changing this is isolated\./);
  });

  it('path_between no-path does not claim runtime independence', () => {
    const t = callTool('path_between', { path: cleanRepo, from: 'alpha', to: 'beta' }).text;
    expect(t).toContain('static call graph');
    expect(t).toContain('does not prove the two never interact at runtime');
  });

  it('find_references empty names what is invisible to it', () => {
    const t = callTool('find_references', { path: cleanRepo, symbol: 'gammaNeverDeclared' }).text;
    expect(t).toContain('INDEXED SOURCE');
    expect(t).toMatch(/string-built names|dynamic dispatch/);
  });
});

describe('Phase 6 step 1 projections carry their boundaries from birth', () => {
  it('callees_of empty mirrors the callers_of boundary', () => {
    const t = callTool('callees_of', { path: cleanRepo, function: 'alpha' }).text;
    expect(t).toContain('no callees in the graph');
    expect(t).toContain('static calls in indexed source only');
  });

  it('dependency wrappers state their evidence base on every answer', () => {
    const t = callTool('dependencies_of', { path: FIXTURE, module: 'payment' }).text;
    expect(t).toContain('import edges in indexed source only');
    expect(t).toMatch(/dynamic imports|require-by-variable/);
  });

  it('empty dependents is never an "unused" claim', () => {
    const t = callTool('dependents_of', { path: cleanRepo, module: '(root)' }).text;
    expect(t).toContain('not a claim the module is unused');
  });
});

describe('export flags say what level they describe', () => {
  it('read_function header says "declared export", never bare "exported"', () => {
    const t = callTool('read_function', { path: FIXTURE, function: 'src/payment/engine.ts#computeFee' }).text;
    expect(t).toContain('· declared export');
  });

  it('find_symbol candidates say "declared export"', () => {
    const t = callTool('find_symbol', { path: FIXTURE, query: 'computeFee' }).text;
    expect(t).toContain('declared export');
  });

  it('compare_implementations states that package-surface reachability is NOT computed', () => {
    const t = callTool('compare_implementations', {
      path: FIXTURE,
      a: 'src/payment/engine.ts#computeFee',
      b: 'src/payment/engine.ts#capture',
    }).text;
    expect(t).toContain('declared exported:');
    expect(t).toContain('package-surface reachability is NOT computed here');
  });
});

// ── B. Negatives that used to be stated without a bound ─────────────────────

describe('residual negatives are now bounded', () => {
  it('find_symbol empty answer states its search surface', () => {
    const t = callTool('find_symbol', { path: cleanRepo, query: 'zeppelin' }).text;
    expect(t).toContain('No declaration matching');
    expect(t).toContain('Only indexed declarations are searched');
    expect(t).toMatch(/unindexed files|sub-declaration/);
  });

  it('query_repository UNRESOLVED is scoped to the index, not the repository', () => {
    const r = callTool('query_repository', { path: cleanRepo, query: 'what breaks if I change frobnicateWidget' });
    expect(r.text).toContain('UNRESOLVED');
    expect(r.text).toContain('no indexed declaration matches');
    expect(r.text).not.toMatch(/nothing in this repository matches/);
  });

  it('architecture_health "none flagged" is scoped to the computed metrics', () => {
    const t = callTool('architecture_health', { path: cleanRepo }).text;
    if (t.includes('none flagged')) {
      expect(t).toContain('within the six computed metrics');
      expect(t).not.toMatch(/none flagged\.$/m);
    }
  });

  it('read_function empty caller/callee footers carry the graph caveat', () => {
    const t = callTool('read_function', { path: cleanRepo, function: 'a.ts#alpha' }).text;
    expect(t).toContain('(none in the static graph');
    expect(t).not.toMatch(/\(none in graph\)/);
  });

  it('compare_implementations labels its test count as a heuristic', () => {
    const t = callTool('compare_implementations', {
      path: FIXTURE,
      a: 'src/payment/engine.ts#computeFee',
      b: 'src/payment/engine.ts#capture',
    }).text;
    expect(t).toMatch(/tests importing its file \(heuristic/);
  });
});

// ── C. The discovery file cap is reported, never silently applied ───────────

describe('the 60k discovery cap surfaces instead of truncating silently', () => {
  it('discoverFiles reports truncation through its meta out-param', () => {
    const meta: { truncated?: boolean } = {};
    const files = discoverFiles(truncRepo, [], meta, { maxFiles: 5 });
    expect(files.length).toBeLessThanOrEqual(5);
    expect(meta.truncated).toBe(true);
    const meta2: { truncated?: boolean } = {};
    discoverFiles(cleanRepo, [], meta2);
    expect(meta2.truncated).toBe(false);
  });

  it('the scan report carries discoveryTruncated', () => {
    const r = scan(truncRepo, { months: 1, maxFiles: 5 });
    expect(r.discoveryTruncated).toBe(true);
    const r2 = scan(cleanRepo, { months: 1 });
    expect(r2.discoveryTruncated ?? false).toBe(false);
  });

  it('a truncated report renders the warning in repo_map', async () => {
    const { renderRepoMap } = await import('../src/serve/repo-map.js');
    const idx = getIndex(truncRepo);
    const report = { ...scan(truncRepo, { months: 1 }), discoveryTruncated: true };
    const map = renderRepoMap({ root: truncRepo, report, files: idx.files, moduleGraph: idx.moduleGraph });
    expect(map).toContain('discovery stopped at the file cap');
    expect(map).toContain('TRUNCATED view');
  });
});
