import { beforeAll, describe, expect, it } from 'vitest';
import { loadLanguages } from '../src/parse/treesitter/loader.js';
import { parseRustSource } from '../src/parse/rust.js';

beforeAll(async () => {
  await loadLanguages(['rust']);
});

const SRC = `use std::collections::HashMap;
use crate::auth::login;
pub fn exported(a: i32, b: &str) -> i32 { helper(a) }
fn private_fn() {}
pub struct User { name: String }
impl User { pub fn method(&self) -> i32 { self.compute() } }
`;

const pf = () => parseRustSource('src/auth/user.rs', 'auth', false, SRC);

describe('rust parser → ParsedFile', () => {
  it('exports pub functions and pub types, not private items', () => {
    const names = pf().exports.map((e) => e.name).sort();
    expect(names).toContain('exported'); // pub fn
    expect(names).toContain('User'); // pub struct
    expect(names).toContain('method'); // pub fn inside impl
    expect(names).not.toContain('private_fn');
  });

  it('classifies exported symbol kinds', () => {
    const { exports } = pf();
    expect(exports.find((e) => e.name === 'exported')?.kind).toBe('function');
    expect(exports.find((e) => e.name === 'method')?.kind).toBe('function');
    expect(exports.find((e) => e.name === 'User')?.kind).toBe('type');
  });

  it('counts non-pub functions as internal', () => {
    expect(pf().internalFunctions).toBe(1); // private_fn
  });

  it('collects all functions incl. impl methods with exported flags', () => {
    const fns = pf().functions;
    const names = fns.map((f) => f.name).sort();
    expect(names).toEqual(['exported', 'method', 'private_fn']);
    expect(fns.find((f) => f.name === 'exported')!.exported).toBe(true);
    expect(fns.find((f) => f.name === 'private_fn')!.exported).toBe(false);
    expect(fns.find((f) => f.name === 'method')!.exported).toBe(true); // pub method
  });

  it('counts params, skipping self (Rust has no default params)', () => {
    const { exports, functions } = pf();
    const exp = exports.find((e) => e.name === 'exported')!;
    expect(exp.requiredParams).toBe(2); // a, b
    expect(exp.totalParams).toBe(2);
    const method = functions.find((f) => f.name === 'method')!;
    expect(method.paramCount).toBe(0); // self skipped
    const exportedFn = functions.find((f) => f.name === 'exported')!;
    expect(exportedFn.paramNames).toEqual(['a', 'b']);
  });

  it('extracts call edges (plain calls + method calls)', () => {
    const fns = pf().functions;
    expect(fns.find((f) => f.name === 'exported')!.calls).toContain('helper');
    expect(fns.find((f) => f.name === 'method')!.calls).toContain('compute'); // self.compute()
  });

  it('captures use-declarations with slash specifiers and last-segment names', () => {
    const imps = pf().imports;
    const byNamed = (n: string) => imps.find((i) => i.named.includes(n));
    expect(byNamed('login')?.specifier).toBe('crate/auth/login');
    expect(byNamed('HashMap')?.specifier).toBe('std/collections/HashMap');
  });

  it('produces a non-trivial body hash for clone detection', () => {
    const exp = pf().functions.find((f) => f.name === 'exported')!;
    expect(exp.bodyHash).toBeGreaterThan(0);
  });

  it('detects mod.rs / lib.rs / main.rs as interface files', () => {
    expect(parseRustSource('src/auth/mod.rs', 'auth', false, '').isIndex).toBe(true);
    expect(parseRustSource('src/lib.rs', '(root)', false, '').isIndex).toBe(true);
    expect(parseRustSource('src/main.rs', '(root)', false, '').isIndex).toBe(true);
    expect(parseRustSource('src/auth/user.rs', 'auth', false, '').isIndex).toBe(false);
  });
});
