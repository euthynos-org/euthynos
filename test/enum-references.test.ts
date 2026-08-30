import { beforeAll, describe, expect, it } from 'vitest';
import { loadLanguages } from '../src/parse/treesitter/loader.js';
import { parseJavaSource } from '../src/parse/java.js';
import { findReferences } from '../src/serve/symbols.js';
import type { ParsedFile } from '../src/types.js';

/**
 * Field-report #6: `find_references` on an enum CONSTANT returned nothing while
 * the enum TYPE resolved. The constant is now captured as a `const` symbol
 * (definition) and its `Type.CONST` member accesses are recorded as field-access
 * references — honestly labelled (a textual occurrence, not a resolved binding).
 */

beforeAll(async () => {
  await loadLanguages(['java']);
});

const ENUM = `package com.acme;
public enum DedupKeyMode { P8_DOC_ID, TITLE_HASH }`;

const USER = `package com.acme;
public class Svc {
  void go(DedupKeyMode mode) {
    if (mode == DedupKeyMode.P8_DOC_ID) { handle(DedupKeyMode.P8_DOC_ID); }
    switch (mode) { case P8_DOC_ID: log(); break; default: break; }
  }
  DedupKeyMode other() { return DedupKeyMode.TITLE_HASH; }
}`;

const files = (): ParsedFile[] => [
  parseJavaSource('DedupKeyMode.java', 'com/acme', false, ENUM),
  parseJavaSource('Svc.java', 'com/acme', false, USER),
];

describe('find_references on enum constants (field-report #6)', () => {
  it('finds the constant’s definition and its usages (was: no references)', () => {
    const refs = findReferences(files(), 'P8_DOC_ID');
    expect(refs.length).toBeGreaterThan(1);
    // The enum constant is now a definition symbol.
    expect(refs.some((r) => r.kind === 'definition' && r.file === 'DedupKeyMode.java')).toBe(true);
    // And its member-access usages are found, labelled as field accesses.
    expect(refs.some((r) => r.kind === 'field-access' && r.file === 'Svc.java')).toBe(true);
  });

  it('the enum TYPE still resolves to its definition (unchanged)', () => {
    const refs = findReferences(files(), 'DedupKeyMode');
    expect(refs.some((r) => r.kind === 'definition' && r.file === 'DedupKeyMode.java')).toBe(true);
  });

  it('a non-existent constant returns nothing (no false references)', () => {
    expect(findReferences(files(), 'NOPE_NOT_A_CONST')).toEqual([]);
  });
});
