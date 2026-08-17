import { beforeAll, describe, expect, it } from 'vitest';
import { loadLanguages } from '../src/parse/treesitter/loader.js';
import { parseKotlinSource } from '../src/parse/kotlin.js';

beforeAll(async () => {
  await loadLanguages(['kotlin']);
});

const SRC = `package pay

import kotlin.math.max
import kotlin.collections.List

fun computeFee(amount: Int, tax: Int = 0): Int {
    val total = max(amount, tax)
    return total
}

private fun helper(x: Int): Int = x * 2

internal fun shared(a: Int): Int = a

class Account(private val id: String, val balance: Int) {
    fun deposit(amount: Int): Int {
        return helper(amount)
    }
    private fun secret() {}
    internal fun open(): Int = 0
    fun member(): Int {
        return this.balance.toInt()
    }
}

object Singleton {
    fun ping(): Int = 1
}
`;

const pf = () => parseKotlinSource('src/pay/account.kt', 'pay', false, SRC);

describe('kotlin parser → ParsedFile', () => {
  it('treats a no-modifier top-level fun as part of the public surface', () => {
    const fn = pf().exports.find((e) => e.name === 'computeFee');
    expect(fn).toBeDefined();
    expect(fn?.kind).toBe('function');
  });

  it('hides a private top-level fun (counts it as internal)', () => {
    const { exports, internalFunctions } = pf();
    expect(exports.find((e) => e.name === 'helper')).toBeUndefined();
    // helper is the only private top-level declaration.
    expect(internalFunctions).toBe(1);
  });

  it('treats an internal fun as exported (internal is part of the module surface)', () => {
    const fn = pf().exports.find((e) => e.name === 'shared');
    expect(fn).toBeDefined();
    expect(fn?.kind).toBe('function');
  });

  it('counts a default param (tax: Int = 0) as optional: required 1, total 2', () => {
    const fn = pf().exports.find((e) => e.name === 'computeFee')!;
    expect(fn.totalParams).toBe(2);
    expect(fn.requiredParams).toBe(1);
  });

  it('emits a class as kind:class with its primary-constructor param count', () => {
    const cls = pf().exports.find((e) => e.name === 'Account');
    expect(cls?.kind).toBe('class');
    expect(cls?.totalParams).toBe(2); // id, balance
    expect(cls?.requiredParams).toBe(2); // no defaults in the constructor
  });

  it('emits an object declaration as kind:class', () => {
    const obj = pf().exports.find((e) => e.name === 'Singleton');
    expect(obj?.kind).toBe('class');
  });

  it('collects methods (incl. inside class/object bodies) into functions[]', () => {
    const names = pf().functions.map((f) => f.name).sort();
    expect(names).toEqual(
      ['computeFee', 'deposit', 'helper', 'member', 'open', 'ping', 'secret', 'shared'].sort(),
    );
    const deposit = pf().functions.find((f) => f.name === 'deposit')!;
    expect(deposit.exported).toBe(true);
    const secret = pf().functions.find((f) => f.name === 'secret')!;
    expect(secret.exported).toBe(false); // private method
  });

  it('records param names per function', () => {
    const fn = pf().functions.find((f) => f.name === 'computeFee')!;
    expect(fn.paramNames).toEqual(['amount', 'tax']);
    expect(fn.paramCount).toBe(2);
  });

  it('extracts call edges via the first-simple_identifier rule (plain + member)', () => {
    const fns = pf().functions;
    const computeFee = fns.find((f) => f.name === 'computeFee')!;
    expect(computeFee.calls).toContain('max'); // plain call_expression
    const deposit = fns.find((f) => f.name === 'deposit')!;
    expect(deposit.calls).toContain('helper');
    const member = fns.find((f) => f.name === 'member')!;
    expect(member.calls).toContain('toInt'); // navigation_expression trailing id
  });

  it('captures import_header dotted paths and skips the package_header', () => {
    const imps = pf().imports;
    const maxImp = imps.find((i) => i.specifier === 'kotlin.math.max');
    expect(maxImp).toBeDefined();
    expect(maxImp?.named).toEqual(['max']);
    expect(maxImp?.isTypeOnly).toBe(false);
    expect(imps.find((i) => i.specifier === 'kotlin.collections.List')).toBeDefined();
    // package_header ('pay') must never appear as an import.
    expect(imps.some((i) => i.specifier === 'pay')).toBe(false);
  });

  it('produces a non-trivial body hash for clone detection', () => {
    const fn = pf().functions.find((f) => f.name === 'computeFee')!;
    expect(fn.bodyHash).toBeGreaterThan(0);
    expect(fn.bodyTokens).toBeGreaterThan(3);
  });

  it('hashes renamed clones equal and structurally different bodies unequal', () => {
    const a = `fun a(x: Int): Int {
    val y = compute(x)
    return y + 1
}`;
    const clone = `fun b(z: Int): Int {
    val w = compute(z)
    return w + 1
}`;
    const different = `fun c(x: Int): Int {
    return x
}`;
    const h = (s: string) =>
      parseKotlinSource('t.kt', 't', false, s).functions[0]!.bodyHash;
    expect(h(a)).toBe(h(clone)); // identifier renames collapse to ID
    expect(h(a)).not.toBe(h(different));
  });

  it('never marks a Kotlin file as an index/interface file', () => {
    expect(pf().isIndex).toBe(false);
  });
});
