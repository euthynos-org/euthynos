import { beforeAll, describe, expect, it } from 'vitest';
import { loadLanguages } from '../src/parse/treesitter/loader.js';
import { parseTsSource } from '../src/parse/ts.js';
import { parseJavaSource } from '../src/parse/java.js';
import { parsePythonSource } from '../src/parse/python.js';

/**
 * Regression for the headline check_my_changes defect: an edited function BODY
 * read as "no modified symbols" because the diff signature used bodyHash, which
 * collapses identifiers/literals for clone detection. defHash keeps identifier
 * and literal TEXT, so a body edit is detected — while whitespace-only edits and
 * edits to an EXISTING comment's wording stay silent (a comment leaf collapses to
 * its node type, not its text; whitespace is not a token). Proven across the three
 * hasher implementations: the TS compiler-API path, the shared tree-sitter util
 * (Java), and Python's own walker.
 *
 * Note: ADDING or REMOVING a comment adds/removes an AST node in tree-sitter
 * grammars, so it changes the stream — same as bodyHash has always behaved. The
 * invariant here is about editing an existing comment's wording.
 */

beforeAll(async () => {
  await loadLanguages(['java', 'python']);
});

type Parse = (path: string, text: string) => { defHash?: number };

function makeChecker(parse: (p: string, m: string, t: string, x: string) => { functions: { defHash?: number }[] }, wrap: (body: string) => string) {
  const def = (body: string) => parse('f.x', 'm', false, wrap(body)).functions[0]!.defHash;
  return def;
}

describe('defHash detects meaningful body edits, ignores cosmetic ones', () => {
  it('TypeScript (compiler-API hasher)', () => {
    const def = makeChecker(parseTsSource as any, (b) => `export function getPath(req, opts) {\n${b}\n}\n`);
    const base = def(`  const url = req.url; return url.slice(0, 8); // pick`);
    expect(base).toBeDefined();
    // meaningful edits — must differ
    expect(def(`  const u = req.url; return u.slice(0, 8); // pick`)).not.toBe(base);   // local rename
    expect(def(`  const url = req.path; return url.slice(0, 8); // pick`)).not.toBe(base); // property
    expect(def(`  const url = req.url; return url.slice(0, 9); // pick`)).not.toBe(base);  // literal
    expect(def(`  const url = req.url; return trimPath(url); // pick`)).not.toBe(base);    // call target
    // cosmetic edits — must match
    expect(def(`  const url = req.url;    return url.slice(0, 8); // pick`)).toBe(base);   // whitespace
    expect(def(`  const url = req.url; return url.slice(0, 8); // different words`)).toBe(base); // comment text
  });

  it('TypeScript regex-literal body edit is detected (not lost like a structural-only hash)', () => {
    const def = makeChecker(parseTsSource as any, (b) => `export function isBin(ct) {\n${b}\n}\n`);
    const base = def(`  return /^image\\//.test(ct);`);
    expect(base).toBeDefined();
    // Editing only the regex pattern must change defHash — a structural hash that
    // treats the regex as one opaque token would miss it (the reviewed regression).
    expect(def(`  return /^video\\//.test(ct);`)).not.toBe(base);
  });

  it('Java (shared tree-sitter hasher)', () => {
    const wrap = (b: string) => `class C {\n  String getPath(String req) {\n${b}\n  }\n}\n`;
    const def = makeChecker(parseJavaSource as any, wrap);
    const base = def(`    String url = req; return url.substring(0, 8); // pick`);
    expect(base).toBeDefined();
    expect(def(`    String u = req; return u.substring(0, 8); // pick`)).not.toBe(base);      // rename
    expect(def(`    String url = req; return url.substring(0, 9); // pick`)).not.toBe(base);   // literal
    expect(def(`    String url = req;    return url.substring(0, 8); // pick`)).toBe(base);     // whitespace
    expect(def(`    String url = req; return url.substring(0, 8); // other`)).toBe(base);       // comment text
  });

  it('Python (its own hasher)', () => {
    const wrap = (b: string) => `def get_path(req):\n${b}\n`;
    const def = makeChecker(parsePythonSource as any, wrap);
    const base = def(`    url = req.url  # pick\n    return url[:8]`);
    expect(base).toBeDefined();
    expect(def(`    u = req.url  # pick\n    return u[:8]`)).not.toBe(base);        // rename
    expect(def(`    url = req.path  # pick\n    return url[:8]`)).not.toBe(base);   // property
    expect(def(`    url = req.url  # pick\n    return url[:9]`)).not.toBe(base);    // literal
    expect(def(`    url = req.url  # different words\n    return url[:8]`)).toBe(base); // comment text
  });
});
