import { beforeAll, describe, expect, it } from 'vitest';
import { loadLanguages } from '../src/parse/treesitter/loader.js';
import { parsePythonSource } from '../src/parse/python.js';

beforeAll(async () => {
  await loadLanguages(['python']);
});

const SRC = `import os
from .auth import login
from ..db import connect
from . import helpers

__all__ = ['process_order', 'OrderService']

def process_order(order, user):
    validate(order)
    return login(user)

def _internal(x):
    return x + 1

class OrderService:
    def __init__(self, db, cache):
        self.db = db

    def place(self, item):
        connect()
        return self.db.save(item)
`;

const pf = () => parsePythonSource('src/orders/service.py', 'orders', false, SRC);

describe('python parser → ParsedFile', () => {
  it('honors __all__ for the public surface', () => {
    const { exports } = pf();
    const names = exports.map((e) => e.name).sort();
    expect(names).toContain('process_order');
    expect(names).toContain('OrderService');
    expect(names).not.toContain('_internal');
  });

  it('classifies exported symbol kinds and class construction params', () => {
    const { exports } = pf();
    const svc = exports.find((e) => e.name === 'OrderService');
    expect(svc?.kind).toBe('class');
    expect(svc?.requiredParams).toBe(2); // db, cache (self excluded)
    const fn = exports.find((e) => e.name === 'process_order');
    expect(fn?.kind).toBe('function');
    expect(fn?.requiredParams).toBe(2); // order, user
  });

  it('counts private top-level defs as internal functions', () => {
    expect(pf().internalFunctions).toBe(1); // _internal
  });

  it('collects all functions including methods', () => {
    const names = pf().functions.map((f) => f.name).sort();
    expect(names).toEqual(['__init__', '_internal', 'place', 'process_order']);
  });

  it('extracts call edges per function (plain + attribute calls)', () => {
    const fns = pf().functions;
    const proc = fns.find((f) => f.name === 'process_order')!;
    expect(proc.calls).toContain('validate');
    expect(proc.calls).toContain('login');
    const place = fns.find((f) => f.name === 'place')!;
    expect(place.calls).toContain('connect');
    expect(place.calls).toContain('save'); // self.db.save → attribute
  });

  it('marks only exported top-level functions as exported', () => {
    const fns = pf().functions;
    expect(fns.find((f) => f.name === 'process_order')!.exported).toBe(true);
    expect(fns.find((f) => f.name === '_internal')!.exported).toBe(false);
    expect(fns.find((f) => f.name === 'place')!.exported).toBe(false); // a method
  });

  it('translates relative imports to resolvable specifiers', () => {
    const imps = pf().imports;
    const byNamed = (n: string) => imps.find((i) => i.named.includes(n));
    expect(byNamed('login')?.specifier).toBe('./auth');
    expect(byNamed('connect')?.specifier).toBe('../db');
    expect(byNamed('helpers')?.specifier).toBe('./helpers');
    expect(byNamed('os')?.specifier).toBe('os'); // absolute, captured as-is
  });

  it('produces a non-trivial body hash for clone detection', () => {
    const proc = pf().functions.find((f) => f.name === 'process_order')!;
    expect(proc.bodyHash).toBeGreaterThan(0);
    expect(proc.bodyTokens).toBeGreaterThan(3);
  });

  it('detects __init__.py as an interface file', () => {
    const init = parsePythonSource('src/orders/__init__.py', 'orders', false, 'from .service import OrderService\n');
    expect(init.isIndex).toBe(true);
  });
});
