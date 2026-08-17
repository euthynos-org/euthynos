import { beforeAll, describe, expect, it } from 'vitest';
import { loadLanguages } from '../src/parse/treesitter/loader.js';
import { parseRubySource } from '../src/parse/ruby.js';

beforeAll(async () => {
  await loadLanguages(['ruby']);
});

const SRC = `require 'json'
require_relative './helper'
def public_fn(a, b)
  helper(a)
end
class Service
  def place(item)
    obj.save(item)
  end
  private
  def secret
    1
  end
end
`;

const pf = () => parseRubySource('src/orders/service.rb', 'orders', false, SRC);

describe('ruby parser → ParsedFile', () => {
  it('exports top-level public methods, classes, and public instance methods', () => {
    const names = pf().exports.map((e) => e.name).sort();
    expect(names).toContain('public_fn');
    expect(names).toContain('Service');
    expect(names).toContain('place');
    expect(names).not.toContain('secret'); // private
  });

  it('classifies exported symbol kinds', () => {
    const { exports } = pf();
    expect(exports.find((e) => e.name === 'public_fn')?.kind).toBe('function');
    expect(exports.find((e) => e.name === 'Service')?.kind).toBe('class');
    expect(exports.find((e) => e.name === 'place')?.kind).toBe('function');
  });

  it('counts private/protected methods as internal functions', () => {
    expect(pf().internalFunctions).toBe(1); // secret
  });

  it('collects all methods (top-level + in classes) with exported flags', () => {
    const fns = pf().functions;
    const names = fns.map((f) => f.name).sort();
    expect(names).toEqual(['place', 'public_fn', 'secret']);
    expect(fns.find((f) => f.name === 'public_fn')!.exported).toBe(true);
    expect(fns.find((f) => f.name === 'place')!.exported).toBe(true);
    expect(fns.find((f) => f.name === 'secret')!.exported).toBe(false);
  });

  it('counts required params (plain identifiers)', () => {
    const fn = pf().exports.find((e) => e.name === 'public_fn');
    expect(fn?.requiredParams).toBe(2); // a, b
    const place = pf().functions.find((f) => f.name === 'place')!;
    expect(place.paramNames).toEqual(['item']);
  });

  it('extracts call edges per method (bare + receiver calls)', () => {
    const fns = pf().functions;
    expect(fns.find((f) => f.name === 'public_fn')!.calls).toContain('helper');
    expect(fns.find((f) => f.name === 'place')!.calls).toContain('save'); // obj.save → method field
  });

  it('translates require_relative to a relative specifier and require to external', () => {
    const imps = pf().imports;
    const rel = imps.find((i) => i.named.includes('helper'));
    expect(rel?.specifier).toBe('./helper');
    expect(rel?.isTypeOnly).toBe(false);
    const ext = imps.find((i) => i.named.includes('json'));
    expect(ext?.specifier).toBe('json');
  });

  it('produces a non-trivial body hash for clone detection', () => {
    const place = pf().functions.find((f) => f.name === 'place')!;
    expect(place.bodyHash).toBeGreaterThan(0);
  });

  it('never marks Ruby files as index files', () => {
    expect(pf().isIndex).toBe(false);
  });
});
