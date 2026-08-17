import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { discoverFiles, globToRegex } from '../src/discover.js';

describe('globToRegex', () => {
  it('** spans segments, * stays inside one, ? is a single char', () => {
    expect(globToRegex('**/*.generated.ts').test('a/b/c.generated.ts')).toBe(true);
    expect(globToRegex('**/*.generated.ts').test('c.generated.ts')).toBe(true);
    expect(globToRegex('src/*.ts').test('src/a.ts')).toBe(true);
    expect(globToRegex('src/*.ts').test('src/deep/a.ts')).toBe(false);
    expect(globToRegex('file?.cs').test('file1.cs')).toBe(true);
    expect(globToRegex('file?.cs').test('file12.cs')).toBe(false);
    expect(globToRegex('legacy/**').test('legacy/x/y.ts')).toBe(true);
    expect(globToRegex('legacy/**').test('modern/x.ts')).toBe(false);
    // regex metacharacters in paths are literals, not patterns
    expect(globToRegex('a+b/c.ts').test('a+b/c.ts')).toBe(true);
    expect(globToRegex('a+b/c.ts').test('aab/c.ts')).toBe(false);
  });
});

const dir = mkdtempSync(join(tmpdir(), 'euthynos-ignore-'));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('discoverFiles ignore globs', () => {
  it('filters ignored paths out of discovery', () => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, 'legacy'), { recursive: true });
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(dir, 'src', 'b.generated.ts'), 'export const b = 1;\n');
    writeFileSync(join(dir, 'legacy', 'old.ts'), 'export const old = 1;\n');

    const all = discoverFiles(dir).map((f) => f.rel).sort();
    expect(all).toEqual(['legacy/old.ts', 'src/a.ts', 'src/b.generated.ts']);

    const filtered = discoverFiles(dir, ['**/*.generated.ts', 'legacy/**']).map((f) => f.rel);
    expect(filtered).toEqual(['src/a.ts']);
  });
});
