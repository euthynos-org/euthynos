import { beforeAll, describe, expect, it } from 'vitest';
import { loadLanguages } from '../src/parse/treesitter/loader.js';
import { parseCppSource } from '../src/parse/cpp.js';

beforeAll(async () => {
  await loadLanguages(['cpp']);
});

const SRC = `#include <vector>
#include "engine.h"

namespace billing {

class Engine {
public:
  Engine(int rate) : rate_(rate) {}
  int compute(int amount, int tax = 0) {
    return helper(amount) + tax;
  }
private:
  int secret() {
    return rate_;
  }
  int rate_;
};

struct Point {
  int dist(int x) {
    return x;
  }
private:
  int hidden() {
    return 0;
  }
};

int freeFn(int a, int b) {
  return obj.method(a) + b;
}

}  // namespace billing

int topLevel(void) {
  return 1;
}

template<typename T>
T identity(T v) {
  return v;
}
`;

const pf = () => parseCppSource('src/billing/engine.cpp', 'billing', false, SRC);

describe('cpp parser → ParsedFile', () => {
  it('treats free functions (TU-level + namespace) as exported', () => {
    const fnExports = pf().exports.filter((e) => e.kind === 'function').map((e) => e.name);
    expect(fnExports).toContain('topLevel'); // translation_unit level
    expect(fnExports).toContain('freeFn');   // inside namespace billing
  });

  it('exposes a class as kind:class with its constructor params as the surface', () => {
    const engine = pf().exports.find((e) => e.name === 'Engine');
    expect(engine?.kind).toBe('class');
    // Engine(int rate) — one required, no defaults.
    expect(engine?.requiredParams).toBe(1);
    expect(engine?.totalParams).toBe(1);
  });

  it('marks a public method exported but a private method NOT (access-specifier tracking)', () => {
    const fns = pf().functions;
    const compute = fns.find((f) => f.name === 'compute')!;
    const secret = fns.find((f) => f.name === 'secret')!;
    expect(compute.exported).toBe(true);  // under public:
    expect(secret.exported).toBe(false);  // under private:
  });

  it('counts an optional param (int tax = 0) as required 1, total 2', () => {
    const compute = pf().functions.find((f) => f.name === 'compute')!;
    // parameter_declaration (amount) + optional_parameter_declaration (tax = 0)
    expect(compute.paramCount).toBe(2);
    expect(compute.paramNames).toEqual(['amount', 'tax']);
    // The same arity split is reflected on a free-fn export symbol with a default.
    const opt = parseCppSource('a.cpp', 'm', false, 'int g(int a, int b = 3) { return a; }');
    const sym = opt.exports.find((e) => e.name === 'g')!;
    expect(sym.requiredParams).toBe(1);
    expect(sym.totalParams).toBe(2);
  });

  it('treats struct members as public by default (no access_specifier needed)', () => {
    const fns = pf().functions;
    const dist = fns.find((f) => f.name === 'dist')!;   // struct Point, before any private:
    const hidden = fns.find((f) => f.name === 'hidden')!; // after private:
    expect(dist.exported).toBe(true);   // struct default = public
    expect(hidden.exported).toBe(false); // flipped to private
  });

  it('recurses into namespace bodies to find the free function', () => {
    // freeFn lives in `namespace billing { ... }` and must be discovered + exported.
    const free = pf().functions.find((f) => f.name === 'freeFn')!;
    expect(free).toBeDefined();
    expect(free.exported).toBe(true);
    expect(free.paramNames).toEqual(['a', 'b']);
  });

  it('extracts call edges: plain idents and field-expression method names', () => {
    const fns = pf().functions;
    const compute = fns.find((f) => f.name === 'compute')!;
    expect(compute.calls).toContain('helper'); // plain identifier call
    const free = fns.find((f) => f.name === 'freeFn')!;
    expect(free.calls).toContain('method'); // obj.method(a) → field_expression field
  });

  it('unwraps a template function and exports it', () => {
    const identity = pf().exports.find((e) => e.name === 'identity');
    expect(identity?.kind).toBe('function');
    expect(identity?.requiredParams).toBe(1); // identity(T v)
    const fn = pf().functions.find((f) => f.name === 'identity')!;
    expect(fn.exported).toBe(true);
    expect(fn.paramNames).toEqual(['v']);
  });

  it('captures #include directives (system <> and local "")', () => {
    const imps = pf().imports;
    const vec = imps.find((i) => i.specifier === 'vector');
    expect(vec?.named).toEqual(['vector']);
    expect(vec?.isTypeOnly).toBe(false);
    const eng = imps.find((i) => i.specifier === 'engine.h');
    expect(eng?.named).toEqual(['engine']); // basename without extension
  });

  it('treats void-only params as arity 0', () => {
    const top = pf().functions.find((f) => f.name === 'topLevel')!;
    expect(top.paramCount).toBe(0);
    expect(top.paramNames).toEqual([]);
    const sym = pf().exports.find((e) => e.name === 'topLevel')!;
    expect(sym.requiredParams).toBe(0);
    expect(sym.totalParams).toBe(0);
  });

  it('produces equal body hashes for clones and different for edits', () => {
    const a = parseCppSource('a.cpp', 'm', false, 'int f(int x) { return x + 1; }');
    const clone = parseCppSource('b.cpp', 'm', false, 'int g(int y) { return y + 1; }'); // renamed → same hash
    const edited = parseCppSource('c.cpp', 'm', false, 'int h(int x) { return x - 9; }'); // different op/lit
    const ha = a.functions[0]!.bodyHash;
    const hc = clone.functions[0]!.bodyHash;
    const he = edited.functions[0]!.bodyHash;
    expect(ha).toBeGreaterThan(0);
    expect(hc).toBe(ha);     // identifier/literal-insensitive clone
    expect(he).not.toBe(ha); // operator + literal change → different
  });

  it('never marks a C++ file as an index/interface file', () => {
    expect(pf().isIndex).toBe(false);
    expect(pf().codeLines).toBeGreaterThan(0);
  });
});
