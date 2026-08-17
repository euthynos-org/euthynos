import { beforeAll, describe, expect, it } from 'vitest';
import { loadLanguages } from '../src/parse/treesitter/loader.js';
import { parseJavaSource } from '../src/parse/java.js';

beforeAll(async () => {
  await loadLanguages(['java']);
});

const SRC =
  `package com.app; import java.util.List; public class Service { private int x; public int doWork(int a, String b){ return helper(a);} private void hidden(){} }`;

const pf = () => parseJavaSource('src/app/Service.java', 'app', false, SRC);

describe('java parser → ParsedFile', () => {
  it('treats public members + types as the export surface, hides non-public', () => {
    const { exports } = pf();
    const byName = (n: string) => exports.find((e) => e.name === n);
    const doWork = byName('doWork');
    expect(doWork?.kind).toBe('function');
    const svc = byName('Service');
    expect(svc?.kind).toBe('class');
    expect(byName('hidden')).toBeUndefined(); // private → not exported
  });

  it('counts non-public methods as internal functions', () => {
    expect(pf().internalFunctions).toBe(1); // hidden()
  });

  it('collects all methods as functions with correct exported flags', () => {
    const fns = pf().functions;
    const doWork = fns.find((f) => f.name === 'doWork');
    const hidden = fns.find((f) => f.name === 'hidden');
    expect(doWork).toBeDefined();
    expect(hidden).toBeDefined();
    expect(doWork!.exported).toBe(true);
    expect(hidden!.exported).toBe(false);
  });

  it('counts method parameters (no default params in Java)', () => {
    const doWork = pf().functions.find((f) => f.name === 'doWork')!;
    expect(doWork.paramCount).toBe(2); // a, b
    expect(doWork.paramNames).toEqual(['a', 'b']);
    const sym = pf().exports.find((e) => e.name === 'doWork')!;
    expect(sym.requiredParams).toBe(2);
    expect(sym.totalParams).toBe(2);
  });

  it('extracts method-invocation call edges', () => {
    const doWork = pf().functions.find((f) => f.name === 'doWork')!;
    expect(doWork.calls).toContain('helper');
  });

  it('captures dotted imports as FQN specifier + last-segment named binding', () => {
    const imps = pf().imports;
    const list = imps.find((i) => i.named.includes('List'));
    expect(list).toBeDefined();
    expect(list!.specifier).toBe('java.util.List');
  });

  it('produces a non-trivial body hash for clone detection', () => {
    const doWork = pf().functions.find((f) => f.name === 'doWork')!;
    expect(doWork.bodyHash).toBeGreaterThan(0);
  });

  it('never marks a Java file as an index/interface file', () => {
    expect(pf().isIndex).toBe(false);
  });
});
