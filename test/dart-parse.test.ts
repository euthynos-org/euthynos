import { beforeAll, describe, expect, it } from 'vitest';
import { loadLanguages } from '../src/parse/treesitter/loader.js';
import { parseDartSource } from '../src/parse/dart.js';

beforeAll(async () => {
  await loadLanguages(['dart']);
});

const SRC = `import 'dart:async';
import 'package:flutter/material.dart';
import '../payment/engine.dart';

int computeFee(int amount, {int tax = 0}) {
  return _helper(amount) + tax;
}

int _helper(int a) {
  return a * 2;
}

abstract class Shape {
  double area();
}

class Engine {
  int rate;
  Engine(this.rate);
  int compute(int amount) => _scale(amount);
  int _scale(int v) => v * rate;
}
`;

const pf = () => parseDartSource('src/payment/fee.dart', 'payment', false, SRC);

describe('dart parser → ParsedFile', () => {
  it('treats non-underscore top-level fns as exported, `_`-prefixed as internal', () => {
    const { exports } = pf();
    const fnNames = exports.filter((e) => e.kind === 'function').map((e) => e.name).sort();
    expect(fnNames).toContain('computeFee');
    expect(fnNames).not.toContain('_helper');
    // _helper is the only internal top-level fn (Shape/Engine are exported classes).
    expect(pf().internalFunctions).toBe(1);
  });

  it('pairs a top-level signature with its SEPARATE function_body sibling', () => {
    const fee = pf().functions.find((f) => f.name === 'computeFee')!;
    // The signature ends on line 5; the paired body extends the record to line 7.
    expect(fee.startLine).toBe(5);
    expect(fee.endLine).toBeGreaterThan(fee.startLine); // body sibling extends past the signature
    expect(fee.endLine).toBe(7);
    // A real (paired) body yields a non-trivial hash + token count.
    expect(fee.bodyHash).toBeGreaterThan(0);
    expect(fee.bodyTokens).toBeGreaterThan(3);
  });

  it('counts a named-default param `{int tax = 0}` as required 1 / total 2', () => {
    const fee = pf().exports.find((e) => e.name === 'computeFee')!;
    expect(fee.kind).toBe('function');
    expect(fee.requiredParams).toBe(1); // amount
    expect(fee.totalParams).toBe(2);    // amount + tax
  });

  it('records param names across required + optional groups', () => {
    const fee = pf().functions.find((f) => f.name === 'computeFee')!;
    expect(fee.paramNames).toEqual(['amount', 'tax']);
    expect(fee.paramCount).toBe(2);
  });

  it('emits a class symbol whose arity is the constructor surface (this.rate)', () => {
    const eng = pf().exports.find((e) => e.name === 'Engine')!;
    expect(eng.kind).toBe('class');
    expect(eng.requiredParams).toBe(1); // Engine(this.rate)
    expect(eng.totalParams).toBe(1);
    const shape = pf().exports.find((e) => e.name === 'Shape');
    expect(shape?.kind).toBe('class');
  });

  it('collects methods (paired bodies) and the abstract method (no body)', () => {
    const names = pf().functions.map((f) => f.name).sort();
    // top-level: computeFee, _helper ; Shape: area ; Engine: compute, _scale
    expect(names).toEqual(['_helper', '_scale', 'area', 'compute', 'computeFee']);
    // compute/_scale are methods → not exported (methods aren't part of the surface here).
    expect(pf().functions.find((f) => f.name === 'compute')!.exported).toBe(true); // no underscore
    expect(pf().functions.find((f) => f.name === '_scale')!.exported).toBe(false);
  });

  it('gives an abstract method an empty body (hash 0) and no calls', () => {
    const area = pf().functions.find((f) => f.name === 'area')!;
    expect(area.bodyHash).toBe(0);
    expect(area.bodyTokens).toBe(0);
    expect(area.calls).toEqual([]);
  });

  it('extracts call edges from paired bodies: computeFee→_helper, compute→_scale', () => {
    const fee = pf().functions.find((f) => f.name === 'computeFee')!;
    expect(fee.calls).toContain('_helper');
    const compute = pf().functions.find((f) => f.name === 'compute')!;
    expect(compute.calls).toContain('_scale'); // arrow-body call
  });

  it('handles bare, nested, and navigation calls', () => {
    const src = `int run(int a) {
  doThing();
  return g(h(a)) + svc.load().save();
}`;
    const fn = parseDartSource('src/x/run.dart', 'x', false, src).functions[0]!;
    expect(fn.calls).toEqual(expect.arrayContaining(['doThing', 'g', 'h', 'load', 'save']));
  });

  it('captures dart:/package:/relative imports with basenames', () => {
    const imps = pf().imports;
    const bySpec = (s: string) => imps.find((i) => i.specifier === s);
    expect(bySpec('dart:async')?.named).toEqual(['async']);
    expect(bySpec('package:flutter/material.dart')?.named).toEqual(['material']);
    // relative path kept verbatim so the resolver can map it.
    expect(bySpec('../payment/engine.dart')?.named).toEqual(['engine']);
    expect(imps.every((i) => i.isTypeOnly === false)).toBe(true);
  });

  it('hashes clones equal and different bodies unequal', () => {
    const clone = `int twice(int a) {
  return _helper(a) + a;
}`;
    const different = `int twice(int a) {
  return a - a - a - a;
}`;
    const cloneHash = parseDartSource('a.dart', 'a', false,
      `int computeFee(int amount, {int tax = 0}) {\n  return _helper(amount) + tax;\n}`)
      .functions[0]!.bodyHash;
    // Same normalized token stream as computeFee's body? Not necessarily — assert
    // the rename-insensitive property directly with two structurally identical bodies.
    const h1 = parseDartSource('b.dart', 'b', false, clone).functions[0]!.bodyHash;
    const h2 = parseDartSource('c.dart', 'c', false,
      `int doubled(int z) {\n  return _helper(z) + z;\n}`).functions[0]!.bodyHash;
    const h3 = parseDartSource('d.dart', 'd', false, different).functions[0]!.bodyHash;
    expect(h1).toBe(h2);          // identifier renames collapse → equal
    expect(h1).not.toBe(h3);      // different structure → unequal
    expect(cloneHash).toBeGreaterThan(0);
  });

  it('never marks a Dart file as an interface/index file', () => {
    expect(pf().isIndex).toBe(false);
  });
});
