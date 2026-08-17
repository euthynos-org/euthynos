import { beforeAll, describe, expect, it } from 'vitest';
import { loadLanguages } from '../src/parse/treesitter/loader.js';
import { parsePhpSource } from '../src/parse/php.js';

beforeAll(async () => {
  await loadLanguages(['php']);
});

// Note the opening tag. The `\\` in this template literal collapses to a single
// backslash, so the parser receives real PHP `use App\Auth\Login;`.
const SRC = `<?php
namespace App;
use App\\Auth\\Login;
function exported($a, $b) { return helper($a); }
class Service {
  public function doWork($a) { return $this->helper($a); }
  private function hidden() {}
}
`;

const pf = () => parsePhpSource('src/App/Service.php', 'App', false, SRC);

describe('php parser → ParsedFile', () => {
  it('exports top-level functions, public methods, and the class — but not private methods', () => {
    const names = pf().exports.map((e) => e.name).sort();
    expect(names).toContain('exported'); // top-level function
    expect(names).toContain('doWork'); // public method
    expect(names).toContain('Service'); // class
    expect(names).not.toContain('hidden'); // private method
  });

  it('classifies exported symbol kinds', () => {
    const { exports } = pf();
    expect(exports.find((e) => e.name === 'exported')?.kind).toBe('function');
    expect(exports.find((e) => e.name === 'doWork')?.kind).toBe('function');
    expect(exports.find((e) => e.name === 'Service')?.kind).toBe('class');
  });

  it('counts private/protected methods as internal functions', () => {
    expect(pf().internalFunctions).toBe(1); // hidden
  });

  it('collects all functions and methods with correct exported flags', () => {
    const fns = pf().functions;
    const names = fns.map((f) => f.name).sort();
    expect(names).toEqual(['doWork', 'exported', 'hidden']);
    expect(fns.find((f) => f.name === 'exported')!.exported).toBe(true);
    expect(fns.find((f) => f.name === 'doWork')!.exported).toBe(true); // public method
    expect(fns.find((f) => f.name === 'hidden')!.exported).toBe(false); // private method
  });

  it('counts parameters and strips the leading $ from param names', () => {
    const exp = pf().exports.find((e) => e.name === 'exported')!;
    expect(exp.totalParams).toBe(2);
    expect(exp.requiredParams).toBe(2);
    const fn = pf().functions.find((f) => f.name === 'exported')!;
    expect(fn.paramCount).toBe(2);
    expect(fn.paramNames).toEqual(['a', 'b']);
  });

  it('extracts call edges (plain function calls + $this method calls)', () => {
    const fns = pf().functions;
    expect(fns.find((f) => f.name === 'exported')!.calls).toContain('helper');
    // $this->helper(...) is a member_call_expression; the method name is captured.
    expect(fns.find((f) => f.name === 'doWork')!.calls).toContain('helper');
  });

  it('captures namespace use imports with a slash-joined specifier', () => {
    const imps = pf().imports;
    const login = imps.find((i) => i.named.includes('Login'));
    expect(login).toBeDefined();
    expect(login!.specifier).toBe('App/Auth/Login');
    expect(login!.isTypeOnly).toBe(false);
  });

  it('produces a non-trivial body hash for clone detection', () => {
    const exp = pf().functions.find((f) => f.name === 'exported')!;
    expect(exp.bodyHash).toBeGreaterThan(0);
  });

  it('marks PHP files as non-index', () => {
    expect(pf().isIndex).toBe(false);
  });
});
