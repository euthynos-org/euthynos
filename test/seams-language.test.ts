import { beforeAll, describe, expect, it } from 'vitest';
import { loadLanguages } from '../src/parse/treesitter/loader.js';
import { moduleSeams } from '../src/metrics/seams.js';
import { parseJavaSource } from '../src/parse/java.js';
import { parseTsSource } from '../src/parse/ts.js';
import type { ModuleGraph, ModuleInfo, ParsedFile } from '../src/types.js';

/**
 * Wave 3 (start): the seam metric penalised every module lacking an index-FILE
 * (-35, "no interface file"). Java/Kotlin/C#/Go/... have no such convention —
 * their boundary is visibility-based — so the penalty branded every JVM/C-family
 * module "Weak". It now applies only to languages that HAVE the interface-file
 * convention (TS/JS/Python/Vue).
 */

beforeAll(async () => {
  await loadLanguages(['java']);
});

const emptyGraph = (): ModuleGraph => ({
  imports: new Map(),
  importedBy: new Map(),
  usedExports: new Map(),
  deepImports: [],
  cycles: [],
  fileImports: new Map(),
});

const mod = (name: string, files: ParsedFile[]): ModuleInfo => ({
  name,
  files,
  exportedNames: new Set(),
  hasInterfaceFile: false,
  codeLines: 10,
});

describe('seam interface-file penalty is language-aware', () => {
  it('a Java module without an index file is NOT penalised for it', () => {
    const jf = parseJavaSource('src/main/java/com/acme/UserService.java', 'com/acme', false,
      'package com.acme; public class UserService { public void go() {} }');
    const seam = moduleSeams(mod('com/acme', [jf]), emptyGraph(), true); // allTests → no untested penalty
    expect(seam.detail).not.toContain('no interface file');
    expect(seam.score).toBe(100);
  });

  it('a TypeScript module without an index file IS still penalised', () => {
    const tf = parseTsSource('src/utils/url.ts', 'utils', false, 'export function mergePath(a,b){ return a+b }');
    const seam = moduleSeams(mod('utils', [tf]), emptyGraph(), true);
    expect(seam.detail).toContain('no interface file');
    expect(seam.score).toBe(65); // 100 - 35
  });

  it('deep-import and cycle penalties still apply to Java modules', () => {
    const jf = parseJavaSource('src/main/java/com/acme/A.java', 'com/acme', false,
      'package com.acme; public class A {}');
    const graph = emptyGraph();
    graph.cycles = [['com/acme', 'com/other']];
    graph.deepImports = [{ fromFile: 'x', toFile: 'y', toModule: 'com/acme' }];
    const seam = moduleSeams(mod('com/acme', [jf]), graph, true);
    // No interface-file penalty, but -8 (deep import) and -25 (cycle) still bite.
    expect(seam.score).toBe(100 - 8 - 25);
    expect(seam.detail).toContain('circular dependency');
  });
});
