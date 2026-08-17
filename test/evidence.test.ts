import { describe, expect, it } from 'vitest';
import { moduleEvidence } from '../src/metrics/evidence.js';
import type { GitHistory, ModuleGraph, ModuleInfo, ParsedFile } from '../src/types.js';

const file = (over: Partial<ParsedFile>): ParsedFile => ({
  path: 'payment/core.ts',
  module: 'payment',
  isTest: false,
  isIndex: false,
  codeLines: 120,
  exports: [],
  internalFunctions: 3,
  functions: [],
  imports: [],
  ...over,
});

const modInfo = (over: Partial<ModuleInfo>): ModuleInfo => ({
  name: 'payment',
  files: [],
  exportedNames: new Set(),
  hasInterfaceFile: false,
  codeLines: 0,
  ...over,
});

const emptyGraph = (over: Partial<ModuleGraph> = {}): ModuleGraph => ({
  imports: new Map(),
  importedBy: new Map(),
  usedExports: new Map(),
  deepImports: [],
  cycles: [],
  ...over,
});

const noGit: GitHistory = { available: false, windowMonths: 6, totalCommits: 0, perModule: new Map() };

describe('moduleEvidence', () => {
  it('seams: every deep import becomes a file-level fact with the point cost stated', () => {
    const mod = modInfo({ files: [file({})], hasInterfaceFile: true });
    const graph = emptyGraph({
      deepImports: [
        { fromFile: 'billing/invoice.ts', toFile: 'payment/internal/ledger.ts', toModule: 'payment' },
        { fromFile: 'api/routes.ts', toFile: 'payment/internal/fees.ts', toModule: 'payment' },
      ],
    });
    const ev = moduleEvidence(mod, graph, noGit).seams;
    const deeps = ev.filter((e) => e.kind === 'deep-import');
    expect(deeps).toHaveLength(2);
    expect(deeps[0]!.file).toBe('billing/invoice.ts');
    expect(deeps[0]!.text).toContain('payment/internal/ledger.ts');
    expect(deeps[0]!.effect).toBe('penalty');
    expect(ev.find((e) => e.kind === 'deep-import-penalty')!.text).toContain('16 pts');
    expect(ev.find((e) => e.kind === 'interface-file')!.effect).toBe('credit');
  });

  it('seams: caps deep imports with an explicit overflow row, never silently', () => {
    const deepImports = Array.from({ length: 20 }, (_, i) => ({
      fromFile: `caller/f${i}.ts`,
      toFile: 'payment/x.ts',
      toModule: 'payment',
    }));
    const ev = moduleEvidence(modInfo({ files: [file({})] }), emptyGraph({ deepImports }), noGit).seams;
    expect(ev.filter((e) => e.kind === 'deep-import')).toHaveLength(12);
    expect(ev.find((e) => e.text.includes('and 8 more deep imports'))).toBeDefined();
  });

  it('leverage: names each unused export and resolves its file and line', () => {
    const f = file({
      exports: [
        { name: 'charge', kind: 'function', requiredParams: 1, totalParams: 1 },
        { name: 'refundLegacy', kind: 'function', requiredParams: 1, totalParams: 2 },
      ],
      functions: [
        { name: 'refundLegacy', file: 'payment/core.ts', startLine: 41, endLine: 60, exported: true, paramCount: 2, paramNames: ['id', 'opts'], bodyHash: 1, bodyTokens: 30 } as never,
      ],
    });
    const mod = modInfo({ files: [f], exportedNames: new Set(['charge', 'refundLegacy']) });
    const graph = emptyGraph({
      importedBy: new Map([['payment', new Set(['billing'])]]),
      usedExports: new Map([['payment', new Set(['charge'])]]),
    });
    const ev = moduleEvidence(mod, graph, noGit).leverage;
    const unused = ev.find((e) => e.kind === 'unused-export')!;
    expect(unused.text).toContain("'refundLegacy'");
    expect(unused.file).toBe('payment/core.ts');
    expect(unused.line).toBe(41);
    expect(ev.find((e) => e.kind === 'caller')!.text).toBe('imported by billing');
    expect(ev.find((e) => e.kind === 'usage-summary')!.text).toContain('1 of 2 exports');
  });

  it('locality: states plainly WHY it is not computable (n/a is a fact too)', () => {
    const ev = moduleEvidence(modInfo({ files: [file({})] }), emptyGraph(), noGit).locality;
    expect(ev).toHaveLength(1);
    expect(ev[0]!.kind).toBe('no-git');
  });

  it('depth: totals row + per-file surface rows + wide-export penalties with lines', () => {
    const f = file({
      path: 'payment/api.ts',
      exports: [{ name: 'processBatch', kind: 'function', requiredParams: 5, totalParams: 6 }],
      functions: [
        { name: 'processBatch', file: 'payment/api.ts', startLine: 12, endLine: 80, exported: true, paramCount: 6, paramNames: [], bodyHash: 2, bodyTokens: 90 } as never,
      ],
    });
    const ev = moduleEvidence(modInfo({ files: [f] }), emptyGraph(), noGit).depth;
    expect(ev[0]!.kind).toBe('totals');
    expect(ev.find((e) => e.kind === 'file-surface')!.file).toBe('payment/api.ts');
    const wide = ev.find((e) => e.kind === 'wide-export')!;
    expect(wide.text).toContain('processBatch takes 5 required params');
    expect(wide.line).toBe(12);
    expect(wide.effect).toBe('penalty');
  });
});
