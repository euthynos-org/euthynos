import { beforeAll, describe, expect, it } from 'vitest';
import { loadLanguages } from '../src/parse/treesitter/loader.js';
import { parseJavaSource } from '../src/parse/java.js';
import { detectAllNearClones } from '../src/metrics/nearclone.js';
import type { ParsedFile } from '../src/types.js';

/**
 * Field-report #7: `similar_logic_exists` flooded a Java repo with ~1 useful of
 * 41 findings — every field-assignment constructor read as a "99% near-clone" of
 * every other. The low-information floor (distinct-4-gram DENSITY) drops those
 * repetitive bodies while keeping genuine near-clones. Language-agnostic: it
 * measures the normalized stream every parser produces.
 */

beforeAll(async () => {
  await loadLanguages(['java']);
});

const P = (path: string, src: string): ParsedFile => parseJavaSource(path, path.split('/')[0], false, src);

describe('near-clone low-information floor (field-report #7)', () => {
  it('field-assignment constructors of different arities do NOT pair as near-clones', () => {
    const files = [
      P('a/AppConfig.java', `class AppConfig { AppConfig(int a,int b,int c,int d){ this.a=a; this.b=b; this.c=c; this.d=d; } }`),
      P('b/StoredFile.java', `class StoredFile { StoredFile(int a,int b,int c,int d,int e){ this.a=a; this.b=b; this.c=c; this.d=d; this.e=e; } }`),
      P('c/Annotation.java', `class Annotation { Annotation(int a,int b,int c,int d,int e,int f){ this.a=a; this.b=b; this.c=c; this.d=d; this.e=e; this.f=f; } }`),
    ];
    const findings = detectAllNearClones(files);
    // None of these constructor pairs may appear — that flood was the whole bug.
    const ctorNames = new Set(['AppConfig', 'StoredFile', 'Annotation']);
    const bad = findings.filter((f) => ctorNames.has(f.a.name) && ctorNames.has(f.b.name));
    expect(bad).toEqual([]);
  });

  it('the floor is a no-op on an information-rich body (it saturates the sketch)', () => {
    // A genuine method with real logic saturates the distinct-gram sketch (24),
    // and the floor only applies when grams < 24 — so a rich body can never be
    // dropped by it. (Full near-clone detection on rich bodies is covered by
    // near-clone.test.ts, which stays green with this floor in place.)
    const f = P('x/Fee.java', `class Fee { int feeCalc(int amount){ if(amount < 0) throw new RuntimeException("neg"); int base = amount / 100; int cap = base > 10 ? base * 2 : base + 5; return cap + amount % 7; } }`)
      .functions.find((fn) => fn.name === 'feeCalc')!;
    expect(f.ngramSketch?.length).toBe(24); // saturated → grams < 24 guard is false → never dropped
    // And a degenerate 8-field constructor is well below the density floor.
    const c = P('y/C.java', `class C { C(int a,int b,int c,int d,int e,int f,int g,int h){ this.a=a;this.b=b;this.c=c;this.d=d;this.e=e;this.f=f;this.g=g;this.h=h; } }`)
      .functions.find((fn) => fn.name === 'C')!;
    expect((c.ngramSketch?.length ?? 0) / c.bodyTokens).toBeLessThan(0.35);
  });
});
