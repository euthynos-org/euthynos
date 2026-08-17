import { beforeAll, describe, expect, it } from 'vitest';
import { loadLanguages } from '../src/parse/treesitter/loader.js';
import { parseCSharpSource } from '../src/parse/csharp.js';

beforeAll(async () => {
  await loadLanguages(['c_sharp']);
});

const SRC = `using System;
using System.Collections.Generic;

namespace Shop
{
    public class PriceCalc
    {
        private int rate;

        public PriceCalc(int rate)
        {
            this.rate = rate;
        }

        public int Total(int qty, int tax = 0)
        {
            return Apply(qty) + tax;
        }

        private int Helper(int a) => a * rate;

        internal void Log()
        {
            Console.WriteLine("hi");
        }

        public static int Add(int a, int b)
        {
            return a + b;
        }
    }
}`;

const pf = () => parseCSharpSource('src/shop/PriceCalc.cs', 'shop', false, SRC);

describe('csharp parser → ParsedFile', () => {
  it('treats public members + types as the export surface', () => {
    const { exports } = pf();
    const byName = (n: string) => exports.find((e) => e.name === n);
    expect(byName('PriceCalc')?.kind).toBe('class');
    expect(byName('Total')?.kind).toBe('function');
    expect(byName('Add')?.kind).toBe('function');
  });

  it('hides private and internal methods from the export surface', () => {
    const { exports } = pf();
    expect(exports.find((e) => e.name === 'Helper')).toBeUndefined(); // private
    expect(exports.find((e) => e.name === 'Log')).toBeUndefined(); // internal
  });

  it('counts non-public methods as internal functions', () => {
    // Helper (private) + Log (internal). Public ctor/Total/Add are not internal.
    expect(pf().internalFunctions).toBe(2);
  });

  it('collects every method/constructor as a function with correct exported flags', () => {
    const fns = pf().functions;
    const total = fns.find((f) => f.name === 'Total')!;
    const helper = fns.find((f) => f.name === 'Helper')!;
    const log = fns.find((f) => f.name === 'Log')!;
    const ctor = fns.find((f) => f.name === 'PriceCalc')!; // constructor name == type name
    expect(total.exported).toBe(true);
    expect(helper.exported).toBe(false);
    expect(log.exported).toBe(false);
    expect(ctor.exported).toBe(true);
  });

  it('treats a defaulted parameter (int tax = 0) as optional', () => {
    const total = pf().exports.find((e) => e.name === 'Total')!;
    expect(total.requiredParams).toBe(1); // qty
    expect(total.totalParams).toBe(2); // qty, tax
    const totalFn = pf().functions.find((f) => f.name === 'Total')!;
    expect(totalFn.paramCount).toBe(2);
    expect(totalFn.paramNames).toEqual(['qty', 'tax']);
  });

  it('captures calls + a non-trivial body hash for an arrow-bodied method', () => {
    const helper = pf().functions.find((f) => f.name === 'Helper')!;
    // `=> a * rate;` has no invocations but must still produce a hash.
    expect(helper.bodyHash).toBeGreaterThan(0);
    expect(helper.bodyTokens).toBeGreaterThan(0);
    // An arrow method WITH a call still has it captured:
    const arrowSrc = `namespace N { class C { public int F(int a) => Compute(a); } }`;
    const f = parseCSharpSource('src/n/C.cs', 'n', false, arrowSrc).functions.find((x) => x.name === 'F')!;
    expect(f.calls).toContain('Compute');
  });

  it('exposes a class symbol whose params come from its constructor', () => {
    const cls = pf().exports.find((e) => e.name === 'PriceCalc')!;
    expect(cls.kind).toBe('class');
    expect(cls.requiredParams).toBe(1); // ctor(int rate)
    expect(cls.totalParams).toBe(1);
  });

  it('captures member-access invocations by their trailing method name', () => {
    const total = pf().functions.find((f) => f.name === 'Total')!;
    expect(total.calls).toContain('Apply'); // bare identifier call
    const log = pf().functions.find((f) => f.name === 'Log')!;
    expect(log.calls).toContain('WriteLine'); // Console.WriteLine → WriteLine
  });

  it('marks a public static (two-modifier) method as exported', () => {
    const add = pf().exports.find((e) => e.name === 'Add');
    expect(add).toBeDefined();
    expect(add!.kind).toBe('function');
    const addFn = pf().functions.find((f) => f.name === 'Add')!;
    expect(addFn.exported).toBe(true);
    expect(addFn.paramNames).toEqual(['a', 'b']);
  });

  it('captures using directives (simple + dotted) as specifier + last-segment named', () => {
    const imps = pf().imports;
    const sys = imps.find((i) => i.specifier === 'System')!;
    expect(sys).toBeDefined();
    expect(sys.named).toEqual(['System']);
    const gen = imps.find((i) => i.specifier === 'System.Collections.Generic')!;
    expect(gen).toBeDefined();
    expect(gen.named).toEqual(['Generic']);
    expect(gen.isTypeOnly).toBe(false);
  });

  it('hashes clones equal and different bodies unequal', () => {
    const a = `namespace N { class A { public int F(int x) { return x + 1; } } }`;
    // Same shape, renamed identifiers/literals → identical normalized hash.
    const b = `namespace N { class B { public int G(int y) { return y + 1; } } }`;
    // Different operation → different hash.
    const c = `namespace N { class C { public int H(int z) { return z * 2; } } }`;
    const fa = parseCSharpSource('a.cs', 'n', false, a).functions[0]!;
    const fb = parseCSharpSource('b.cs', 'n', false, b).functions[0]!;
    const fc = parseCSharpSource('c.cs', 'n', false, c).functions[0]!;
    expect(fa.bodyHash).toBe(fb.bodyHash);
    expect(fa.bodyHash).not.toBe(fc.bodyHash);
  });

  it('handles file-scoped namespaces and never marks a C# file as index', () => {
    const fileScoped = `namespace Shop.Models;

public class Item
{
    public string Name;
    public int Compute(int a, int b = 1) => a + b;
}`;
    const parsed = parseCSharpSource('src/shop/Item.cs', 'shop', false, fileScoped);
    expect(parsed.isIndex).toBe(false);
    expect(parsed.exports.find((e) => e.name === 'Item')?.kind).toBe('class');
    const compute = parsed.exports.find((e) => e.name === 'Compute')!;
    expect(compute.requiredParams).toBe(1);
    expect(compute.totalParams).toBe(2);
  });
});
