import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLanguages } from '../src/parse/treesitter/loader.js';
import { TREE_SITTER_LANGS } from '../src/parse/dispatch.js';
import { resetIndex } from '../src/index/incremental.js';
import { callTool } from '../src/mcp/tools.js';
import { resetDedup } from '../src/mcp/dedup.js';
import { estTokens } from '../src/serve/render.js';
import { BUNDLE_BUDGET_TOKENS, BUNDLE_INTENTS, INTENT_PROFILES } from '../src/serve/bundle.js';
import { handleMessage } from '../src/mcp/server.js';

/**
 * Phase 5 surface: context_bundle, session dedup, and the resources/prompts
 * protocol additions — the pieces that attack M1's named residual (correct
 * answers followed by Read x26 / Grep x22 of re-assembly and re-verification).
 */

let REPO: string;

beforeAll(async () => {
  await loadLanguages([...TREE_SITTER_LANGS]);
  REPO = mkdtempSync(join(tmpdir(), 'euthynos-bundle-'));
  mkdirSync(join(REPO, 'src', 'pay'), { recursive: true });
  mkdirSync(join(REPO, 'src', 'api'), { recursive: true });
  mkdirSync(join(REPO, 'test'), { recursive: true });
  writeFileSync(
    join(REPO, 'src', 'pay', 'fees.ts'),
    `export interface FeePolicy {
  rate: number
}

/** Computes the fee for one order under the active policy. */
export function computeFee(amount: number, policy: FeePolicy): number {
  return roundMoney(amount * policy.rate)
}

export function roundMoney(v: number): number {
  return Math.round(v * 100) / 100
}
`,
  );
  writeFileSync(
    join(REPO, 'src', 'api', 'checkout.ts'),
    `import { computeFee } from '../pay/fees'

export function checkout(amount: number): number {
  return amount + computeFee(amount, { rate: 0.02 })
}
`,
  );
  writeFileSync(
    join(REPO, 'test', 'fees.test.ts'),
    `import { computeFee } from '../src/pay/fees'

export function itComputes(): void {
  computeFee(100, { rate: 0.02 })
}
`,
  );
  resetIndex();
  resetDedup();
});

beforeEach(() => resetDedup());

afterAll(() => {
  resetIndex();
  if (REPO !== undefined) rmSync(REPO, { recursive: true, force: true });
});

const bundle = (target: string, intent?: string) =>
  callTool('context_bundle', { path: REPO, target, ...(intent === undefined ? {} : { intent }) });

describe('context_bundle composition', () => {
  it('one call carries source, callers, types, tests, architecture and blast radius', () => {
    const out = bundle('computeFee', 'change');
    expect(out.isError).toBeFalsy();
    // source (with the doc comment's function line)
    expect(out.text).toContain('export function computeFee');
    // callers from the graph
    expect(out.text).toContain('checkout');
    // signature types resolved to their declarations
    expect(out.text).toMatch(/FeePolicy \(interface\).*src\/pay\/fees\.ts/);
    // importing test found by the heuristic, labeled as a heuristic
    expect(out.text).toContain('test/fees.test.ts');
    expect(out.text).toContain('heuristic');
    // blast radius via impactOf's own summary
    expect(out.text).toMatch(/blast radius/);
    // architecture is not in the 'change' profile — it IS in 'understand'
    expect(bundle('computeFee', 'understand').text).toMatch(/module 'pay'/);
  });

  it('every intent profile renders and leads with source', () => {
    for (const intent of BUNDLE_INTENTS) {
      const out = bundle('computeFee', intent);
      expect(out.isError, intent).toBeFalsy();
      expect(out.text, intent).toContain(`intent: ${intent}`);
      const firstHeading = out.text.split('\n').find((l) => l.startsWith('== '));
      expect(firstHeading, intent).toContain('computeFee');
    }
  });

  it('intent changes section ORDER (profiles are data, and they differ)', () => {
    const understand = bundle('computeFee', 'understand').text;
    const change = bundle('computeFee', 'change').text;
    // 'change' ranks callers ahead of callees; 'understand' the reverse.
    expect(change.indexOf('== called by ==')).toBeLessThan(
      change.indexOf('== blast radius ==') === -1 ? Infinity : change.indexOf('== blast radius =='),
    );
    expect(understand.indexOf('== calls ==')).toBeLessThan(understand.indexOf('== called by =='));
    expect(understand).not.toBe(change);
  });

  it('stays within the bundle budget', () => {
    for (const intent of BUNDLE_INTENTS) {
      const out = bundle('computeFee', intent);
      expect(estTokens(out.text), intent).toBeLessThanOrEqual(BUNDLE_BUDGET_TOKENS + 40); // + header
    }
  });

  it('a type target says call edges do not apply instead of showing empty callers', () => {
    const out = bundle('src/pay/fees.ts#FeePolicy', 'understand');
    expect(out.isError).toBeFalsy();
    expect(out.text).toMatch(/call edges exist for functions only/);
  });

  it('unknown intent is rejected with the supported list', () => {
    const out = bundle('computeFee', 'refactor');
    expect(out.isError).toBe(true);
    expect(out.text).toContain('understand');
  });

  it('an unknown target fails with a next step, never a lookalike', () => {
    const out = bundle('doesNotExistAnywhere');
    expect(out.isError).toBe(true);
    expect(out.text).toContain('find_symbol');
  });

  it('is deterministic and cached per generation, and an edit invalidates', () => {
    const a = bundle('computeFee', 'change').text;
    const b = bundle('computeFee', 'change').text;
    expect(b).toBe(a);
    // Edit the target: the cache must not serve the stale bundle.
    writeFileSync(
      join(REPO, 'src', 'pay', 'fees.ts'),
      `export interface FeePolicy {
  rate: number
}

/** Computes the fee for one order under the active policy. */
export function computeFee(amount: number, policy: FeePolicy): number {
  return roundMoney(amount * policy.rate + 1)
}

export function roundMoney(v: number): number {
  return Math.round(v * 100) / 100
}
`,
    );
    const c = bundle('computeFee', 'change').text;
    expect(c).toContain('policy.rate + 1');
    expect(c).not.toBe(a);
  });

  it('every profile only names sections that exist', () => {
    const known = new Set(['source', 'callers', 'callees', 'types', 'tests', 'architecture', 'recent-changes', 'blast-radius']);
    for (const [intent, sections] of Object.entries(INTENT_PROFILES)) {
      for (const s of sections) expect(known.has(s), `${intent}:${s}`).toBe(true);
      expect(sections[0], intent).toBe('source');
    }
  });
});

describe('session dedup on source tools', () => {
  it('an identical repeat gets a ~20-token receipt naming the escape hatch', () => {
    const first = callTool('read_function', { path: REPO, function: 'roundMoney' });
    expect(first.text).toContain('export function roundMoney');
    const second = callTool('read_function', { path: REPO, function: 'roundMoney' });
    expect(second.text).toContain('unchanged since served (sha ');
    expect(second.text).toContain('fresh: true');
    expect(estTokens(second.text)).toBeLessThan(45);
  });

  it('fresh: true forces a full re-send', () => {
    callTool('read_function', { path: REPO, function: 'roundMoney' });
    const forced = callTool('read_function', { path: REPO, function: 'roundMoney', fresh: true });
    expect(forced.text).toContain('export function roundMoney');
  });

  it('an EDIT always re-sends in full — dedup can never serve stale-content receipts', () => {
    callTool('read_function', { path: REPO, function: 'roundMoney' });
    writeFileSync(
      join(REPO, 'src', 'pay', 'fees.ts'),
      `export interface FeePolicy {
  rate: number
}

/** Computes the fee for one order under the active policy. */
export function computeFee(amount: number, policy: FeePolicy): number {
  return roundMoney(amount * policy.rate + 1)
}

export function roundMoney(v: number): number {
  return Math.round(v * 1000) / 1000
}
`,
    );
    const after = callTool('read_function', { path: REPO, function: 'roundMoney' });
    expect(after.text).toContain('* 1000');
    expect(after.text).not.toContain('unchanged since served');
  });

  it('read_span dedups by exact range', () => {
    callTool('read_span', { path: REPO, file: 'src/pay/fees.ts', startLine: 1, endLine: 3 });
    const repeat = callTool('read_span', { path: REPO, file: 'src/pay/fees.ts', startLine: 1, endLine: 3 });
    expect(repeat.text).toContain('unchanged since served');
    // A DIFFERENT range is not a repeat.
    const other = callTool('read_span', { path: REPO, file: 'src/pay/fees.ts', startLine: 1, endLine: 4 });
    expect(other.text).not.toContain('unchanged since served');
  });
});

describe('resources and prompts over the protocol', () => {
  const rpc = (method: string, params?: unknown) => {
    const raw = handleMessage(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }));
    return JSON.parse(raw!) as { result?: any; error?: { code: number; message: string } };
  };

  it('initialize announces resources and prompts capabilities', () => {
    const res = rpc('initialize', {});
    expect(res.result.capabilities.resources).toBeDefined();
    expect(res.result.capabilities.prompts).toBeDefined();
  });

  it('resources/list names the two orientation surfaces', () => {
    const res = rpc('resources/list');
    expect(res.result.resources.map((r: any) => r.uri).sort()).toEqual([
      'euthynos://health',
      'euthynos://repo-map',
    ]);
  });

  it('an unknown resource fails with -32002 and the available list', () => {
    const res = rpc('resources/read', { uri: 'euthynos://nope' });
    // MCP's resource-not-found code — distinct from -32602, which is
    // reserved for a malformed request (missing uri param).
    expect(res.error!.code).toBe(-32002);
    expect(res.error!.message).toContain('euthynos://repo-map');
    const malformed = rpc('resources/read', {});
    expect(malformed.error!.code).toBe(-32602);
  });

  it('prompts/get orient embeds the current repo map', () => {
    const res = rpc('prompts/get', { name: 'orient' });
    expect(res.result.messages[0].content.text).toContain('context_bundle');
    // The map itself is embedded, not referenced.
    expect(res.result.messages[0].content.text.length).toBeGreaterThan(300);
  });
});
