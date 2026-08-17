import { beforeAll, describe, expect, it } from 'vitest';
import { loadLanguages } from '../src/parse/treesitter/loader.js';
import { parseGoSource } from '../src/parse/go.js';

beforeAll(async () => {
  await loadLanguages(['go']);
});

const SRC = `package orders

import (
	"fmt"
	"strings"
)

import h "github.com/acme/helpers"

func Exported(a int, b string) int {
	helper(a)
	return helper(a)
}

func multiName(a, b int, c string) int {
	return a + b
}

func unexported() {
	strings.TrimSpace("x")
}

type User struct {
	Name string
}

type lowerType struct {
	id int
}

func (u *User) Method() {
	fmt.Println(u.Name)
	helper(0)
}
`;

const pf = () => parseGoSource('src/orders/service.go', 'orders', false, SRC);

describe('go parser → ParsedFile', () => {
  it('treats Capitalized funcs/types as the public surface, lowercase as internal', () => {
    const { exports } = pf();
    const byKind = (k: string) => exports.filter((e) => e.kind === k).map((e) => e.name).sort();
    expect(byKind('function')).toContain('Exported');
    expect(byKind('function')).not.toContain('unexported');
    expect(byKind('function')).not.toContain('multiName');
    expect(byKind('type')).toContain('User');
    expect(byKind('type')).not.toContain('lowerType');
  });

  it('counts lowercase top-level funcs/methods as internal functions', () => {
    // unexported() + multiName() — both top-level, both lowercase.
    expect(pf().internalFunctions).toBe(2);
  });

  it('classifies the exported function symbol and its arity (no Go defaults)', () => {
    const exp = pf().exports.find((e) => e.name === 'Exported');
    expect(exp?.kind).toBe('function');
    expect(exp?.requiredParams).toBe(2);
    expect(exp?.totalParams).toBe(2);
    const usr = pf().exports.find((e) => e.name === 'User');
    expect(usr?.kind).toBe('type');
  });

  it('collects all functions and methods with correct exported flags', () => {
    const fns = pf().functions;
    const names = fns.map((f) => f.name).sort();
    expect(names).toEqual(['Exported', 'Method', 'multiName', 'unexported']);
    expect(fns.find((f) => f.name === 'Exported')!.exported).toBe(true);
    expect(fns.find((f) => f.name === 'Method')!.exported).toBe(true); // Capitalized method
    expect(fns.find((f) => f.name === 'unexported')!.exported).toBe(false);
    expect(fns.find((f) => f.name === 'multiName')!.exported).toBe(false);
  });

  it('counts grouped same-type params (a, b int) individually', () => {
    const mn = pf().functions.find((f) => f.name === 'multiName')!;
    expect(mn.paramCount).toBe(3);
    expect(mn.paramNames).toEqual(['a', 'b', 'c']);
    const exp = pf().functions.find((f) => f.name === 'Exported')!;
    expect(exp.paramNames).toEqual(['a', 'b']);
  });

  it('extracts call edges: plain idents and selector method names', () => {
    const fns = pf().functions;
    const exp = fns.find((f) => f.name === 'Exported')!;
    expect(exp.calls).toContain('helper'); // plain identifier call, deduped
    const method = fns.find((f) => f.name === 'Method')!;
    expect(method.calls).toContain('Println'); // fmt.Println → selector field
    expect(method.calls).toContain('helper');
  });

  it('captures imports with quotes stripped and alias/last-segment names', () => {
    const imps = pf().imports;
    const fmtImp = imps.find((i) => i.specifier === 'fmt');
    expect(fmtImp?.named).toEqual(['fmt']);
    const stringsImp = imps.find((i) => i.specifier === 'strings');
    expect(stringsImp).toBeDefined();
    const aliased = imps.find((i) => i.specifier === 'github.com/acme/helpers');
    expect(aliased?.named).toEqual(['h']); // alias wins over last segment
  });

  it('produces a non-trivial body hash for clone detection', () => {
    const exp = pf().functions.find((f) => f.name === 'Exported')!;
    expect(exp.bodyHash).toBeGreaterThan(0);
    expect(exp.bodyTokens).toBeGreaterThan(3);
  });

  it('never marks a Go file as an interface/index file', () => {
    expect(pf().isIndex).toBe(false);
  });
});
