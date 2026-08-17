import { beforeAll, describe, expect, it } from 'vitest';
import { loadLanguages } from '../src/parse/treesitter/loader.js';
import { parseSwiftSource } from '../src/parse/swift.js';

beforeAll(async () => {
  await loadLanguages(['swift']);
});

const SRC = `import Foundation

public func computeFee(_ amount: Int, tax: Int = 0) -> Int {
    return add(x: amount) + tax
}

private func helper(a: Int) -> Int {
    return a
}

func defaulted(b: Int) -> Int {
    return b
}

class Calculator {
    private var rate: Int
    init(rate: Int) {
        self.rate = rate
    }
    public func apply(amount: Int) -> Int {
        return compute(amount: amount) * rate
    }
    private func secret() -> Int {
        return rate
    }
}

struct Point {
    var x: Int
    var y: Int
}
`;

const pf = () => parseSwiftSource('src/billing/fee.swift', 'billing', false, SRC);

describe('swift parser → ParsedFile', () => {
  it('treats public and modifier-less (internal default) funcs as the surface, private as internal', () => {
    const fnExports = pf().exports.filter((e) => e.kind === 'function').map((e) => e.name).sort();
    expect(fnExports).toContain('computeFee'); // public
    expect(fnExports).toContain('defaulted'); // no modifier → internal → exported
    expect(fnExports).not.toContain('helper'); // private → not exported
  });

  it('counts only private/fileprivate top-level decls as internal functions', () => {
    // Only `helper` (private) is a top-level internal func.
    expect(pf().internalFunctions).toBe(1);
  });

  it('counts FLAT parameter children correctly (no parameter_list wrapper)', () => {
    const fn = pf().functions.find((f) => f.name === 'computeFee')!;
    expect(fn.paramCount).toBe(2);
    expect(fn.paramNames).toEqual(['amount', 'tax']);
  });

  it('detects default_value siblings: tax: Int = 0 → required 1, total 2', () => {
    const exp = pf().exports.find((e) => e.name === 'computeFee')!;
    expect(exp.kind).toBe('function');
    expect(exp.totalParams).toBe(2);
    expect(exp.requiredParams).toBe(1); // one default_value present
  });

  it('treats a func with no defaults as all-required', () => {
    const exp = pf().exports.find((e) => e.name === 'defaulted')!;
    expect(exp.totalParams).toBe(1);
    expect(exp.requiredParams).toBe(1);
  });

  it('exposes a class with kind:class and its init params as the construction surface', () => {
    const cls = pf().exports.find((e) => e.name === 'Calculator')!;
    expect(cls.kind).toBe('class');
    expect(cls.totalParams).toBe(1); // init(rate: Int)
    expect(cls.requiredParams).toBe(1);
  });

  it('treats a struct (no modifiers) as exported with kind:class', () => {
    const pt = pf().exports.find((e) => e.name === 'Point')!;
    expect(pt).toBeDefined();
    expect(pt.kind).toBe('class'); // struct parses as class_declaration
    expect(pt.totalParams).toBe(0); // no explicit init
  });

  it('collects methods and the init recursively, with non-top-level methods not exported', () => {
    const names = pf().functions.map((f) => f.name).sort();
    expect(names).toEqual(['apply', 'computeFee', 'defaulted', 'helper', 'init', 'secret']);
    const apply = pf().functions.find((f) => f.name === 'apply')!;
    expect(apply.exported).toBe(false); // method, never the file's top-level surface
    expect(apply.paramNames).toEqual(['amount']);
    const init = pf().functions.find((f) => f.name === 'init')!;
    expect(init.paramNames).toEqual(['rate']);
    const top = pf().functions.find((f) => f.name === 'computeFee')!;
    expect(top.exported).toBe(true); // top-level public func
  });

  it('extracts call edges: plain calls and navigation (a.b()) trailing names', () => {
    const fee = pf().functions.find((f) => f.name === 'computeFee')!;
    expect(fee.calls).toContain('add'); // plain call_expression
    const apply = pf().functions.find((f) => f.name === 'apply')!;
    expect(apply.calls).toContain('compute'); // navigation/plain call name
  });

  it('captures import_declaration module names', () => {
    const imps = pf().imports;
    const foundation = imps.find((i) => i.specifier === 'Foundation');
    expect(foundation).toBeDefined();
    expect(foundation?.named).toEqual(['Foundation']);
    expect(foundation?.isTypeOnly).toBe(false);
  });

  it('hashes identical bodies equal and different bodies unequal (clone detection)', () => {
    const clone = `func a(n: Int) -> Int {
    return mul(x: n) + n
}
func b(m: Int) -> Int {
    return mul(x: m) + m
}
func c(p: Int) -> Int {
    return p
}`;
    const fns = parseSwiftSource('src/x.swift', 'x', false, clone).functions;
    const a = fns.find((f) => f.name === 'a')!;
    const b = fns.find((f) => f.name === 'b')!;
    const c = fns.find((f) => f.name === 'c')!;
    expect(a.bodyHash).toBeGreaterThan(0);
    expect(a.bodyHash).toBe(b.bodyHash); // identical up to identifier renames
    expect(a.bodyHash).not.toBe(c.bodyHash);
  });

  it('never marks a Swift file as an interface/index file', () => {
    expect(pf().isIndex).toBe(false);
    expect(pf().codeLines).toBeGreaterThan(0);
  });
});
