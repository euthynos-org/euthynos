import { describe, expect, it } from 'vitest';
import { detectNearClones } from '../src/metrics/nearclone.js';
import { contamination } from '../src/metrics/contamination.js';
import { buildGraph } from '../src/graph/imports.js';
import { parseTsSource } from '../src/parse/ts.js';
import type { ParsedFile } from '../src/types.js';

/**
 * What the near-clone tier is required to do, checked below:
 *
 *   1. Both hono cases found — the diverged renamed copy
 *      (isContentTypeBinary ↔ defaultIsContentTypeBinary) and the
 *      canonical-decision evidence path.
 *   2. Reported as NEAR-clones, never as exact clones.
 *   3. The pre-existing exact-clone fixtures stay green UNCHANGED (they run
 *      in this same suite run), and the literal-sensitive tiny-clone cases
 *      gain ZERO findings.
 *
 * The near-clone tier is ADDITIVE: it must never loosen exact matching.
 */

function parse(files: { path: string; module: string; src: string }[]): ParsedFile[] {
  return files.map((f) => parseTsSource(f.path, f.module, false, f.src));
}

describe('gate case 1: the diverged renamed copy (hono, verbatim)', () => {
  // The REAL code from hono, copied exactly — the fixture must
  // not be friendlier than reality.
  const files = parse([
    {
      path: 'src/adapter/lambda-edge/handler.ts',
      module: 'adapter',
      src: `export const isContentTypeBinary = (contentType: string): boolean => {
  return !/^(text\\/(plain|html|css|javascript|csv).*|application\\/(.*json|.*xml).*|image\\/svg\\+xml.*)$/.test(
    contentType
  )
}
`,
    },
    {
      path: 'src/adapter/aws-lambda/handler.ts',
      module: 'adapter',
      src: `export const defaultIsContentTypeBinary = (contentType: string): boolean => {
  return !/^text\\/(?:plain|html|css|javascript|csv)|(?:\\/|\\+)(?:json|xml)\\s*(?:;|\\$)/.test(
    contentType
  )
}
`,
    },
  ]);

  it('is found, as a literal-drift near-clone', () => {
    const found = detectNearClones(files);
    expect(found.length).toBe(1);
    const f = found[0]!;
    expect(f.kind).toBe('literal-drift');
    expect([f.a.name, f.b.name].sort()).toEqual(['defaultIsContentTypeBinary', 'isContentTypeBinary']);
  });

  it('names WHAT diverged, and is never labelled exact', () => {
    const f = detectNearClones(files)[0]!;
    expect(f.divergence).toContain('literal values differ');
    expect(f.signals).toContain('identical-structure');
    expect(f.signals).not.toContain('exact');
  });

  it('does NOT appear in the exact tier — in either list, at any confidence', () => {
    const r = contamination(files, buildGraph(files));
    expect(r.findings).toEqual([]);
    expect(r.intraModule).toEqual([]);
  });
});

describe('gate case 2: structural drift (a body that grew a branch)', () => {
  const base = `export function persistRecord(row: { id: number; kind: string }, retries: number): string {
  let out = '';
  for (let i = 0; i < retries; i++) {
    if (row.kind === 'primary') {
      out = out + serialize(row.id) + ':' + String(i);
    } else {
      out = out + normalize(row.kind);
    }
  }
  if (out.length > 200) {
    out = out.slice(0, 200);
  }
  return out;
}
`;
  // The copy gained an extra guard clause — drifted, not identical.
  const drifted = base
    .replace('persistRecord', 'persistRecordLegacy')
    .replace("let out = '';", "let out = '';\n  if (retries < 0) {\n    return '';\n  }");

  const files = parse([
    { path: 'src/store/write.ts', module: 'store', src: base },
    { path: 'src/store/legacy.ts', module: 'store', src: drifted },
  ]);

  it('is found as a structural near-clone with sub-identity similarity', () => {
    const found = detectNearClones(files).filter((f) => f.kind === 'structural');
    expect(found.length).toBe(1);
    const f = found[0]!;
    expect(f.similarity).toBeGreaterThanOrEqual(0.72);
    expect(f.similarity).toBeLessThan(1);
    expect(f.divergence).toContain('diverged');
  });

  it('is absent from the exact tier', () => {
    const r = contamination(files, buildGraph(files));
    expect(r.findings).toEqual([]);
    expect(r.intraModule).toEqual([]);
  });
});

describe('the frozen boundaries hold', () => {
  const conn = (header: string, name = 'getConnInfo'): string =>
    `export const ${name} = (c: any) => ({ remote: { address: c.req.header('${header}') } })\n`;

  it('same-name literal variants (interface pattern) are NOT near-clones', () => {
    // Same verdict as the exact tier: getConnInfo implemented per-runtime
    // with different headers is an interface, not a drift.
    const files = parse([
      { path: 'src/adapter/cf/conninfo.ts', module: 'adapter', src: conn('cf-connecting-ip') },
      { path: 'src/adapter/vercel/conninfo.ts', module: 'adapter', src: conn('x-real-ip') },
    ]);
    expect(detectNearClones(files)).toEqual([]);
  });

  it('unrelated same-shape tiny bodies are NOT near-clones (name gate)', () => {
    const files = parse([
      { path: 'src/a/x.ts', module: 'a', src: conn('h-one', 'readIp') },
      { path: 'src/a/y.ts', module: 'a', src: conn('h-two', 'fetchZone') },
    ]);
    expect(detectNearClones(files)).toEqual([]);
  });

  it('EXACT copies belong to the exact tier and never appear here', () => {
    const files = parse([
      { path: 'src/adapter/cf/conninfo.ts', module: 'adapter', src: conn('cf-connecting-ip') },
      { path: 'src/adapter/pages/conninfo.ts', module: 'adapter', src: conn('cf-connecting-ip') },
    ]);
    expect(detectNearClones(files)).toEqual([]);
    expect(contamination(files, buildGraph(files)).intraModule.length).toBe(1);
  });

  it('N same-shape variants cluster into ONE finding', () => {
    const eff = (name: string, tag: string): string =>
      `export const ${name} = (fn: () => void): void => { schedule('${tag}', fn) }\n`;
    const files = parse([
      { path: 'src/h/a.ts', module: 'h', src: eff('useEffect', 'effect') },
      { path: 'src/h/b.ts', module: 'h', src: eff('useLayoutEffect', 'layout') },
      { path: 'src/h/c.ts', module: 'h', src: eff('useInsertionEffect', 'insertion') },
    ]);
    const found = detectNearClones(files);
    expect(found.length).toBe(1);
    expect(found[0]!.divergence).toContain('3 variants');
  });

  it('is deterministic', () => {
    const files = parse([
      { path: 'src/adapter/lambda-edge/handler.ts', module: 'adapter', src: conn('x', 'isThingBinary') },
      { path: 'src/adapter/aws/handler.ts', module: 'adapter', src: conn('y', 'defaultIsThingBinary') },
    ]);
    expect(JSON.stringify(detectNearClones(files))).toBe(JSON.stringify(detectNearClones(files)));
  });
});
