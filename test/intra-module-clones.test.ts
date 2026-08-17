import { describe, expect, it } from 'vitest';
import { contamination } from '../src/metrics/contamination.js';
import { buildGraph } from '../src/graph/imports.js';
import { parseTsSource } from '../src/parse/ts.js';
import type { ParsedFile } from '../src/types.js';

/**
 * REGRESSION — found by a benchmark agent, in its own answer.
 *
 * Asked to audit hono's adapters for duplication, the agent called
 * `similar_logic_exists` FIRST (the adoption intervention worked), got
 * nothing back, and read 29 files by hand — then wrote: "the MCP index's
 * cross-module duplicate scan reports nothing because every adapter lives in
 * a single `adapter` module ... invisible to that check".
 *
 * It was right. All three cascade steps skipped same-module pairs. That rule
 * is CORRECT for the contamination SCORE — duplication inside one module is a
 * local refactor, not architectural contamination — but it silently narrowed
 * the TOOL, which answers a different question: "does this already exist?".
 * A developer about to write a helper cares most about a copy in the module
 * they are standing in.
 *
 * The second defect surfaced immediately after the first was fixed: N
 * identical functions emit N*(N-1)/2 pairs, so six copies of one helper filled
 * 15 of a 20-row budget and crowded out every real finding.
 */

/**
 * Bodies must clear the cascade's 30-normalized-token floor (trivial bodies
 * are skipped on purpose — two one-line getters are not a duplication
 * finding), so this fixture is deliberately substantial.
 */
const body = (n: string): string => `
export function ${n}(input: string, opts: { retries: number; sep: string }): string {
  const trimmed = input.trim();
  if (trimmed.length === 0) return '';
  const parts = trimmed.split(opts.sep);
  let out = '';
  for (let i = 0; i < opts.retries; i++) {
    for (const p of parts) {
      if (p.length > 2) {
        out = out + p.toUpperCase() + opts.sep + String(i);
      } else {
        out = out + p.toLowerCase();
      }
    }
  }
  if (out.endsWith(opts.sep)) {
    out = out.slice(0, out.length - opts.sep.length);
  }
  return out;
}
`;

function parse(files: { path: string; module: string; src: string }[]): ParsedFile[] {
  return files.map((f) => parseTsSource(f.path, f.module, false, f.src));
}

describe('same-module clones: served by the tool, absent from the score', () => {
  const files = parse([
    { path: 'src/adapter/aws/conn.ts', module: 'adapter', src: body('getConnInfo') },
    { path: 'src/adapter/cf/conn.ts', module: 'adapter', src: body('getConnInfo') },
  ]);
  const result = contamination(files, buildGraph(files));

  it('finds the clone the cross-module filter used to hide', () => {
    expect(result.intraModule.length).toBe(1);
    const f = result.intraModule[0]!;
    expect([f.a.file, f.b.file].sort()).toEqual(['src/adapter/aws/conn.ts', 'src/adapter/cf/conn.ts']);
    expect(f.signals).toContain('ast-clone');
  });

  it('does NOT put it in the score — the metric keeps its meaning', () => {
    expect(result.findings).toEqual([]);
    // Score is driven by cross-module contamination + deep imports only.
    expect(result.score).toBe(0);
  });
});

describe('clone GROUPS are one finding, not every pair', () => {
  const copies = ['a', 'b', 'c', 'd', 'e', 'f'].map((k) => ({
    path: `src/bench/page-${k}.ts`,
    module: 'bench',
    src: body('buildPage'),
  }));
  const files = parse(copies);
  const result = contamination(files, buildGraph(files));

  it('six identical copies produce ONE finding, not fifteen pairs', () => {
    expect(result.intraModule.length).toBe(1);
  });

  it('the finding carries the whole group', () => {
    const f = result.intraModule[0]!;
    expect(f.groupSize).toBe(6);
    // a + b are named directly; the rest are listed so one row shows the group.
    expect(f.alsoIn?.length).toBe(4);
    const all = [f.a.file, f.b.file, ...(f.alsoIn ?? []).map((x) => x.file)];
    expect(new Set(all).size).toBe(6);
  });

  it('bigger groups rank first — a helper copied six times outranks one copied twice', () => {
    // A genuinely DIFFERENT body: clone detection collapses identifiers, so
    // renaming the function alone would put it in the same group.
    const otherBody = `
export function tallyRecords(rows: number[], factor: number): number {
  let total = 0;
  const seen = new Set<number>();
  for (const r of rows) {
    if (seen.has(r)) continue;
    seen.add(r);
    if (r % 2 === 0) {
      total = total + r * factor;
    } else {
      total = total - r;
    }
  }
  while (total > 1000) {
    total = Math.floor(total / 2);
  }
  return total;
}
`;
    const mixed = parse([
      ...copies,
      { path: 'src/bench/pair-1.ts', module: 'bench', src: otherBody },
      { path: 'src/bench/pair-2.ts', module: 'bench', src: otherBody },
    ]);
    const r = contamination(mixed, buildGraph(mixed));
    expect(r.intraModule[0]!.groupSize).toBe(6);
    expect(r.intraModule[1]!.groupSize).toBe(2);
  });

  it('is deterministic', () => {
    const again = contamination(parse(copies), buildGraph(parse(copies)));
    expect(JSON.stringify(again.intraModule)).toBe(JSON.stringify(result.intraModule));
  });
});

describe('clones in DIFFERENT modules stay in the score, not the intra list', () => {
  const files = parse([
    { path: 'src/auth/a.ts', module: 'auth', src: body('validate') },
    { path: 'src/billing/b.ts', module: 'billing', src: body('validate') },
  ]);
  const result = contamination(files, buildGraph(files));

  it('is scored as contamination', () => {
    expect(result.findings.length).toBe(1);
    expect(result.score).toBeGreaterThan(0);
  });

  it('is not double-reported in the intra-module list', () => {
    expect(result.intraModule).toEqual([]);
  });
});

describe('tiny clones: only the same EXPORTED name implemented twice', () => {
  /**
   * REGRESSION, second layer of the same defect. After the same-module
   * filter was fixed, hono's real answer was STILL missing: its adapters
   * duplicate a 6-token `getConnInfo` across runtimes, below the 30-token
   * floor the contamination SCORE uses to ignore trivial bodies. Right for
   * the score, wrong for "does this exist?" — a developer writing the next
   * adapter needs precisely that helper.
   *
   * The admission rule has to be narrow or the output floods with one-line
   * wrappers: below the tool floor, a clone counts only when every copy is
   * EXPORTED under the SAME NAME.
   */
  const tiny = (n: string, exported: boolean): string =>
    `${exported ? 'export ' : ''}const ${n} = (c: any) => ({ remote: { address: c.req.header('x-ip') } })
`;

  it('finds a 6-token helper duplicated under one exported name', () => {
    const files = parse([
      { path: 'src/adapter/cf/conninfo.ts', module: 'adapter', src: tiny('getConnInfo', true) },
      { path: 'src/adapter/vercel/conninfo.ts', module: 'adapter', src: tiny('getConnInfo', true) },
    ]);
    const r = contamination(files, buildGraph(files));
    expect(r.intraModule.length).toBe(1);
    expect(r.intraModule[0]!.a.name).toBe('getConnInfo');
  });

  it('ignores an equally tiny clone under DIFFERENT names', () => {
    const files = parse([
      { path: 'src/adapter/a.ts', module: 'adapter', src: tiny('readIpA', true) },
      { path: 'src/adapter/b.ts', module: 'adapter', src: tiny('readIpB', true) },
    ]);
    expect(contamination(files, buildGraph(files)).intraModule).toEqual([]);
  });

  it('ignores tiny clones that are not exported', () => {
    const files = parse([
      { path: 'src/adapter/a.ts', module: 'adapter', src: tiny('readIp', false) },
      { path: 'src/adapter/b.ts', module: 'adapter', src: tiny('readIp', false) },
    ]);
    expect(contamination(files, buildGraph(files)).intraModule).toEqual([]);
  });

  it('tiny clones never reach the SCORE', () => {
    const files = parse([
      { path: 'src/auth/a.ts', module: 'auth', src: tiny('getConnInfo', true) },
      { path: 'src/billing/b.ts', module: 'billing', src: tiny('getConnInfo', true) },
    ]);
    const r = contamination(files, buildGraph(files));
    expect(r.findings).toEqual([]);
    expect(r.score).toBe(0);
  });
});

describe('tiny clones must agree on LITERALS, not just shape', () => {
  /**
   * REGRESSION, third layer. The tiny-clone rule above shipped unsound:
   * `bodyHash` erases literals so renamed copies collide — necessary for
   * clone detection, and fatal here, because a 6-token body is mostly ONE
   * literal. hono's vercel adapter shares the `getConnInfo` SHAPE while
   * reading 'x-real-ip' instead of 'cf-connecting-ip'. We reported it at
   * 90% confidence; the benchmark agent read the files, caught us, and
   * wrote "same shape, different semantics — do not fold it in".
   *
   * A confident false positive is the one failure this engine cannot
   * afford: it is precisely what makes an agent stop trusting every later
   * answer and go back to reading files.
   */
  const conn = (header: string): string =>
    `export const getConnInfo = (c: any) => ({ remote: { address: c.req.header('${header}') } })
`;

  it('reports the copies that share a literal', () => {
    const files = parse([
      { path: 'src/adapter/cf-workers/conninfo.ts', module: 'adapter', src: conn('cf-connecting-ip') },
      { path: 'src/adapter/cf-pages/conninfo.ts', module: 'adapter', src: conn('cf-connecting-ip') },
    ]);
    const r = contamination(files, buildGraph(files));
    expect(r.intraModule.length).toBe(1);
    expect(r.intraModule[0]!.groupSize ?? 2).toBe(2);
  });

  it('does NOT report same-shape copies whose literals differ', () => {
    const files = parse([
      { path: 'src/adapter/cf/conninfo.ts', module: 'adapter', src: conn('cf-connecting-ip') },
      { path: 'src/adapter/vercel/conninfo.ts', module: 'adapter', src: conn('x-real-ip') },
    ]);
    expect(contamination(files, buildGraph(files)).intraModule).toEqual([]);
  });

  it('PARTITIONS a mixed group rather than discarding it', () => {
    // Two copies agree, one dissents. Rejecting the whole group would trade
    // a false positive for a false negative — the true pair is still a fact.
    const files = parse([
      { path: 'src/adapter/cf-workers/conninfo.ts', module: 'adapter', src: conn('cf-connecting-ip') },
      { path: 'src/adapter/cf-pages/conninfo.ts', module: 'adapter', src: conn('cf-connecting-ip') },
      { path: 'src/adapter/vercel/conninfo.ts', module: 'adapter', src: conn('x-real-ip') },
    ]);
    const r = contamination(files, buildGraph(files));
    expect(r.intraModule.length).toBe(1);
    const named = [r.intraModule[0]!.a.file, r.intraModule[0]!.b.file, ...(r.intraModule[0]!.alsoIn ?? []).map((x) => x.file)];
    expect(named.some((f) => f.includes('vercel'))).toBe(false);
    expect(named.filter((f) => f.includes('cf-')).length).toBe(2);
  });

  it('large bodies are unaffected — literals may differ there', () => {
    // The literal gate applies ONLY below the tool floor; above it, erasing
    // literals is the whole point of rename-insensitive clone detection.
    const withLit = (v: string): string => body('process').replace("':'", `'${v}'`);
    const files = parse([
      { path: 'src/x/a.ts', module: 'x', src: withLit('AA') },
      { path: 'src/x/b.ts', module: 'x', src: withLit('BB') },
    ]);
    expect(contamination(files, buildGraph(files)).intraModule.length).toBe(1);
  });
});
