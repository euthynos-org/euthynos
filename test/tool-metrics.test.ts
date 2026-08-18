import { beforeAll, describe, expect, it } from 'vitest';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLanguages } from '../src/parse/treesitter/loader.js';
import { TREE_SITTER_LANGS } from '../src/parse/dispatch.js';
import { callTool } from '../src/mcp/tools.js';
import { callRecords, resetCallRecords } from '../src/mcp/telemetry.js';

/**
 * TOOL-METRICS GOLDEN SUITE — the no-model tier of the cost benchmarks.
 *
 * Replays scripted tool-call sequences over a fixture repo and asserts the
 * SHAPE of every response — token budget, byte size, latency ceiling, cache
 * behavior, determinism. This catches the regressions that would otherwise
 * only surface in a paid Claude Code session: a tool that suddenly returns
 * 3x the bytes, a cache that stopped hitting, a span serve that got slow.
 *
 * Zero LLM calls. Runs in CI on every commit.
 */

const FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sample');

/**
 * Per-tool response budgets (estimated tokens = chars/4). Deliberately
 * generous vs. today's output so the test catches BLOWUPS, not drift; the
 * source-reading tools are meant to land with much tighter budgets of their own.
 */
const BUDGETS: Record<string, number> = {
  architecture_health: 900,
  module_metrics: 400,
  similar_logic_exists: 700,
  impact_of: 700,
  callers_of: 700,
  path_between: 400,
  // Source-reading tools — budgets sized to stay cheaper than opening the file.
  repo_map: 1500,
  file_outline: 250,
  read_function: 500,
  read_span: 400,
  find_symbol: 300,
  find_references: 300,
  // Composite answer — source, callers, callees, types, tests, blast radius —
  // so ONE budget covers every section (+ header allowance).
  context_bundle: 950,
  // Returns BOTH implementation spans plus the differing evidence, under one budget.
  compare_implementations: 950,
  // Single-question graph projections: outbound call edges, module imports in
  // each direction, and the tests that exercise a target.
  callees_of: 500,
  dependencies_of: 400,
  dependents_of: 400,
  tests_for: 500,
  // Widest response of any tool here — changed files and symbols vs HEAD,
  // boundary violations the diff introduced, blast radius, tests — hence the
  // largest budget. It reports observed evidence, never a verdict on the change.
  check_my_changes: 1200,
  boundary_check: 500,
  diff_context: 950,
  change_impact: 700,
};

/** Warm-call latency ceiling. Cold builds are excluded (first call warms). */
const WARM_LATENCY_MS = 400;

beforeAll(async () => {
  await loadLanguages([...TREE_SITTER_LANGS]);
  // Telemetry must never write into a test fixture checkout.
  process.env['EUTHYNOS_NO_TELEMETRY'] = '1';
});

describe('tool metrics: budgets and shape', () => {
  it('every tool answers within its token budget, with telemetry recorded', () => {
    resetCallRecords();
    const calls: [string, Record<string, unknown>][] = [
      ['architecture_health', { path: FIXTURE }],
      ['module_metrics', { path: FIXTURE, module: 'payment' }],
      ['similar_logic_exists', { path: FIXTURE }],
      ['impact_of', { path: FIXTURE, function: 'computeFee' }],
      ['callers_of', { path: FIXTURE, function: 'computeFee' }],
      ['repo_map', { path: FIXTURE }],
      ['file_outline', { path: FIXTURE, file: 'src/payment/engine.ts' }],
      ['read_function', { path: FIXTURE, function: 'computeFee' }],
      ['find_symbol', { path: FIXTURE, query: 'compute fee' }],
      ['find_references', { path: FIXTURE, symbol: 'computeFee' }],
      ['context_bundle', { path: FIXTURE, target: 'computeFee', intent: 'change' }],
      ['compare_implementations', { path: FIXTURE, a: 'src/payment/engine.ts#computeFee', b: 'src/payment/engine.ts#capture' }],
      ['callees_of', { path: FIXTURE, function: 'validateTransaction' }],
      ['dependencies_of', { path: FIXTURE, module: 'app' }],
      ['dependents_of', { path: FIXTURE, module: 'payment' }],
      ['tests_for', { path: FIXTURE, target: 'src/payment/engine.ts#computeFee' }],
      ['boundary_check', { path: FIXTURE, module: 'payment' }],
    ];
    for (const [tool, args] of calls) {
      const out = callTool(tool, args);
      expect(out.isError ?? false, `${tool} errored: ${out.text.slice(0, 120)}`).toBe(false);
      const rec = callRecords().at(-1)!;
      expect(rec.tool).toBe(tool);
      expect(rec.estTokens, `${tool} exceeded its token budget`).toBeLessThanOrEqual(BUDGETS[tool]!);
      expect(rec.outputBytes).toBeGreaterThan(0);
      expect(rec.linesReturned).toBeGreaterThan(0);
    }
  });

  it('repeated calls hit the cache and are fast', () => {
    resetCallRecords();
    callTool('architecture_health', { path: FIXTURE }); // warm
    callTool('architecture_health', { path: FIXTURE });
    callTool('callers_of', { path: FIXTURE, function: 'computeFee' });
    const recs = callRecords();
    expect(recs[1]!.cache).toBe('hit');
    for (const r of recs.slice(1)) {
      expect(r.latencyMs, `${r.tool} warm call took ${r.latencyMs}ms`).toBeLessThanOrEqual(WARM_LATENCY_MS);
    }
  });

  it('responses are deterministic — identical input, identical bytes', () => {
    const a = callTool('architecture_health', { path: FIXTURE }).text;
    const b = callTool('architecture_health', { path: FIXTURE }).text;
    expect(a).toBe(b);
    const c = callTool('similar_logic_exists', { path: FIXTURE }).text;
    const d = callTool('similar_logic_exists', { path: FIXTURE }).text;
    expect(c).toBe(d);
  });

  it('no tool response embeds a whole source file', () => {
    // The failure mode the layer exists to end: responses carry facts and
    // spans, never file dumps.
    for (const [tool, args] of [
      ['architecture_health', { path: FIXTURE }],
      ['similar_logic_exists', { path: FIXTURE }],
      ['impact_of', { path: FIXTURE, function: 'computeFee' }],
    ] as [string, Record<string, unknown>][]) {
      const text = callTool(tool, args).text;
      expect(text, `${tool} looks like it dumped source`).not.toMatch(/^\s*(import|export function|class)\s/m);
    }
  });

  it('an ambiguous target reports candidates instead of guessing', () => {
    const out = callTool('callers_of', { path: FIXTURE, function: 'validate' });
    // Either an honest ambiguity report or an honest miss — never a silent pick.
    if (out.isError === true) {
      expect(out.text).toMatch(/ambiguous|not found|matches/i);
    }
  });

  it('telemetry records carry no argument values (privacy contract)', () => {
    resetCallRecords();
    callTool('module_metrics', { path: FIXTURE, module: 'payment' });
    const rec = callRecords().at(-1)!;
    const json = JSON.stringify(rec);
    expect(json).not.toContain(FIXTURE);
    expect(json).not.toContain('payment');
    expect(rec.argsHash).toMatch(/^[0-9a-f]+$/);
  });
});
