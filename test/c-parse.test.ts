import { beforeAll, describe, expect, it } from 'vitest';
import { loadLanguages } from '../src/parse/treesitter/loader.js';
import { parseCSource } from '../src/parse/c.js';

beforeAll(async () => {
  await loadLanguages(['c']);
});

const SRC = `#include <stdio.h>
#include "util/helpers.h"

static int helper(int x) {
  return x + 1;
}

int add(int a, int b) {
  int s = sum(a, b);
  return s;
}

int *make_node(char *name, int n) {
  return acquire(name);
}

int noargs(void) {
  return 0;
}

void use(Obj *o) {
  o->method();
  o.field();
  printf("hi");
  printf("hi");
}

struct Point { int x; int y; };
union Value { int i; float f; };
enum Color { RED, GREEN };
typedef struct Node { int v; } NodeT;
typedef int MyInt;
`;

const pf = () => parseCSource('src/core/service.c', 'core', false, SRC);

describe('c parser → ParsedFile', () => {
  it('treats non-static funcs as the public surface, static as internal', () => {
    const fnExports = pf().exports.filter((e) => e.kind === 'function').map((e) => e.name).sort();
    expect(fnExports).toContain('add');
    expect(fnExports).toContain('make_node');
    expect(fnExports).toContain('noargs');
    expect(fnExports).toContain('use');
    expect(fnExports).not.toContain('helper'); // static ⇒ internal linkage
  });

  it('counts top-level static functions as internal functions', () => {
    expect(pf().internalFunctions).toBe(1); // only helper()
  });

  it('collects ALL functions with correct exported flags', () => {
    const fns = pf().functions;
    const names = fns.map((f) => f.name).sort();
    expect(names).toEqual(['add', 'helper', 'make_node', 'noargs', 'use']);
    expect(fns.find((f) => f.name === 'helper')!.exported).toBe(false);
    expect(fns.find((f) => f.name === 'add')!.exported).toBe(true);
    expect(fns.find((f) => f.name === 'make_node')!.exported).toBe(true);
  });

  it('counts params; f(void) is zero and pointer-returning funcs still resolve', () => {
    const fns = pf().functions;
    expect(fns.find((f) => f.name === 'noargs')!.paramCount).toBe(0); // (void) → 0 params
    expect(fns.find((f) => f.name === 'noargs')!.paramNames).toEqual([]);

    const add = fns.find((f) => f.name === 'add')!;
    expect(add.paramCount).toBe(2);
    expect(add.paramNames).toEqual(['a', 'b']);

    // int *make_node(char *name, int n) — name resolved through pointer_declarator wrappers
    const mk = fns.find((f) => f.name === 'make_node')!;
    expect(mk.paramCount).toBe(2);
    expect(mk.paramNames).toEqual(['name', 'n']);
  });

  it('mirrors arity onto the exported function symbol (required === total, no C defaults)', () => {
    const sym = pf().exports.find((e) => e.kind === 'function' && e.name === 'add')!;
    expect(sym.requiredParams).toBe(2);
    expect(sym.totalParams).toBe(2);
    const no = pf().exports.find((e) => e.kind === 'function' && e.name === 'noargs')!;
    expect(no.requiredParams).toBe(0);
    expect(no.totalParams).toBe(0);
  });

  it('exposes named struct/union/enum and typedefs as exported types', () => {
    const types = pf().exports.filter((e) => e.kind === 'type').map((e) => e.name).sort();
    expect(types).toContain('Point');   // struct
    expect(types).toContain('Value');   // union
    expect(types).toContain('Color');   // enum
    expect(types).toContain('NodeT');   // typedef declarator (NOT the inner tag "Node")
    expect(types).toContain('MyInt');   // typedef int
    expect(types).not.toContain('Node'); // inner struct tag of the typedef is not surfaced
    for (const t of pf().exports.filter((e) => e.kind === 'type')) {
      expect(t.requiredParams).toBe(0);
      expect(t.totalParams).toBe(0);
    }
  });

  it('extracts call edges: plain idents and field/arrow member names, deduped', () => {
    const fns = pf().functions;
    expect(fns.find((f) => f.name === 'add')!.calls).toContain('sum'); // plain identifier
    expect(fns.find((f) => f.name === 'make_node')!.calls).toContain('acquire');

    const use = fns.find((f) => f.name === 'use')!;
    expect(use.calls).toContain('method'); // o->method() → field_expression field
    expect(use.calls).toContain('field');  // o.field()   → field_expression field
    expect(use.calls).toContain('printf');
    // printf called twice but deduped to a single edge
    expect(use.calls.filter((c) => c === 'printf')).toHaveLength(1);
  });

  it('captures #include as imports: system <> vs local "" with stripped paths', () => {
    const imps = pf().imports;
    const sys = imps.find((i) => i.specifier === 'stdio.h');
    expect(sys).toBeDefined();
    expect(sys!.named).toEqual(['stdio']); // basename without extension
    expect(sys!.isTypeOnly).toBe(false);

    const local = imps.find((i) => i.specifier === 'util/helpers.h');
    expect(local).toBeDefined();
    expect(local!.named).toEqual(['helpers']); // last segment, extension stripped
  });

  it('produces a non-trivial body hash for clone detection', () => {
    const add = pf().functions.find((f) => f.name === 'add')!;
    expect(add.bodyHash).toBeGreaterThan(0);
    expect(add.bodyTokens).toBeGreaterThan(3);
  });

  it('hashes identical bodies EQUAL and differing bodies UNEQUAL (rename-insensitive)', () => {
    // alpha and beta have token-identical bodies modulo identifier names → equal hash.
    const clones = parseCSource('src/m/clones.c', 'm', false, `
int alpha(int a, int b) {
  int t = a + b;
  return t;
}
int beta(int x, int y) {
  int q = x + y;
  return q;
}
int gamma(int a, int b) {
  return a * b - 7;
}
`);
    const byName = Object.fromEntries(clones.functions.map((f) => [f.name, f]));
    expect(byName.alpha!.bodyHash).toBe(byName.beta!.bodyHash);   // identical structure
    expect(byName.alpha!.bodyHash).not.toBe(byName.gamma!.bodyHash); // different structure
  });

  it('never marks a C file as an interface/index file and counts code lines', () => {
    expect(pf().isIndex).toBe(false);
    expect(pf().path).toBe('src/core/service.c');
    expect(pf().module).toBe('core');
    expect(pf().codeLines).toBeGreaterThan(0);
  });
});
