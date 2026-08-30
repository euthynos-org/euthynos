import { beforeAll, describe, expect, it } from 'vitest';
import { loadLanguages } from '../src/parse/treesitter/loader.js';
import { parseGoSource } from '../src/parse/go.js';
import { buildGraph } from '../src/graph/imports.js';
import type { ParsedFile } from '../src/types.js';

/**
 * Wave 3: deep-import detection for non-index languages via the `internal/`
 * boundary — Go's rule (compiler-enforced), a convention in JVM/Rust trees. A
 * package under `internal/` may be imported only by code rooted at that
 * directory's parent; reaching it from outside is a seam bypass. Path-based, so
 * it never mis-reads visibility, and legal Go code cannot trigger it.
 */

beforeAll(async () => {
  await loadLanguages(['go']);
});

const SECRET = `package secret
func Do() {}`;

const importer = (pkg: string): string =>
  `package p\nimport "myrepo/a/internal/secret"\nfunc F(){ secret.Do() }`;

const bypasses = (files: ParsedFile[]): string[] =>
  buildGraph(files).deepImports.map((d) => d.fromFile);

describe('internal/ boundary deep imports (Wave 3)', () => {
  const secret = () => parseGoSource('a/internal/secret/secret.go', 'a/internal/secret', false, SECRET);

  it('an import from OUTSIDE the internal parent is a bypass', () => {
    const files = [secret(), parseGoSource('c/app/main.go', 'c/app', false, importer('app'))];
    expect(bypasses(files)).toContain('c/app/main.go');
  });

  it('an import from WITHIN the internal parent (a/**) is allowed', () => {
    const files = [secret(), parseGoSource('a/web/handler.go', 'a/web', false, importer('web'))];
    expect(bypasses(files)).not.toContain('a/web/handler.go');
  });

  it('a top-level internal/ is importable module-wide (never a bypass)', () => {
    const topSecret = parseGoSource('internal/secret/secret.go', 'internal/secret', false, SECRET);
    const caller = parseGoSource('c/app/main.go', 'c/app', false, `package p\nimport "myrepo/internal/secret"\nfunc F(){ secret.Do() }`);
    expect(bypasses([topSecret, caller])).toEqual([]);
  });

  it('a test file reaching into internal/ is not flagged (tests may reach in)', () => {
    const files = [secret(), parseGoSource('c/app/main_test.go', 'c/app', true, importer('app'))];
    expect(bypasses(files)).toEqual([]);
  });
});
