import { describe, expect, it, beforeAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callTool } from '../src/mcp/tools.js';

/**
 * tests_for — which tests exercise a file or symbol, as route-labeled evidence.
 *
 * These cases pin the contract the tool answers under: three discovery routes,
 * each hit tagged with the route that found it — (1) import-edge, (2)
 * name-convention, (3) test-call — an ambiguous target answered with the list
 * of candidate declarations instead of a guess, and an empty result that names
 * the three routes it searched rather than claiming the code is untested.
 */

let repo: string;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'testsfor-'));
  mkdirSync(join(repo, 'src'));
  mkdirSync(join(repo, 'test'));
  writeFileSync(
    join(repo, 'src', 'pay.ts'),
    'export function charge(amount: number): number {\n  return amount * 100;\n}\n',
  );
  // Route 1+3: imports the target file AND statically calls the symbol.
  writeFileSync(
    join(repo, 'test', 'pay.test.ts'),
    "import { charge } from '../src/pay';\n\nexport function checkCharge(): void {\n  charge(5);\n}\n",
  );
  // Route 2 only: name convention, no import, no call.
  writeFileSync(
    join(repo, 'src', 'util.ts'),
    'export function fold(xs: number[]): number {\n  return xs.length;\n}\n',
  );
  writeFileSync(
    join(repo, 'test', 'util.spec.ts'),
    'export function unrelated(): number {\n  return 1;\n}\n',
  );
  // Route 3 only: calls the symbol without an import that resolves to it.
  writeFileSync(
    join(repo, 'src', 'ledger.ts'),
    'export function post(entry: number): number {\n  return entry;\n}\n',
  );
  writeFileSync(
    join(repo, 'test', 'integration.test.ts'),
    'declare const post: (n: number) => number;\nexport function scenario(): void {\n  post(1);\n}\n',
  );
  // No tests at all.
  writeFileSync(
    join(repo, 'src', 'lonely.ts'),
    'export function forgotten(): number {\n  return 0;\n}\n',
  );
});

describe('tests_for routes', () => {
  it('import-edge + test-call both fire for a directly-tested symbol, each labeled', () => {
    const r = callTool('tests_for', { path: repo, target: 'src/pay.ts#charge' });
    expect(r.isError ?? false).toBe(false);
    expect(r.text).toContain('test/pay.test.ts');
    expect(r.text).toContain('[import-edge]');
    expect(r.text).toContain('[test-call]');
    expect(r.text).toContain('evidence, never a coverage claim');
  });

  it('name-convention fires alone when only the filename matches', () => {
    const r = callTool('tests_for', { path: repo, target: 'src/util.ts' });
    expect(r.text).toContain('test/util.spec.ts');
    expect(r.text).toContain('[name-convention]');
    expect(r.text).not.toContain('[import-edge]');
  });

  it('test-call fires without an import edge (name-level, labeled as such)', () => {
    const r = callTool('tests_for', { path: repo, target: 'src/ledger.ts#post' });
    expect(r.text).toContain('test/integration.test.ts');
    expect(r.text).toContain('[test-call]');
    expect(r.text).toContain('name-level');
  });

  it('the empty answer names all three routes and never claims untested', () => {
    const r = callTool('tests_for', { path: repo, target: 'src/lonely.ts#forgotten' });
    expect(r.isError ?? false).toBe(false);
    expect(r.text).toContain('none found');
    expect(r.text).toContain('import edges, name conventions, or static calls');
    expect(r.text).toContain('not a claim that the code is untested');
  });

  it('a bare ambiguous name is answered with the choices, never guessed', () => {
    writeFileSync(join(repo, 'src', 'dupA.ts'), 'export function twice(): number {\n  return 2;\n}\n');
    writeFileSync(join(repo, 'src', 'dupB.ts'), 'export function twice(): number {\n  return 4;\n}\n');
    const r = callTool('tests_for', { path: repo, target: 'twice' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('declared in 2 files');
    expect(r.text).toContain('src/dupA.ts');
  });

  it('is deterministic', () => {
    const a = callTool('tests_for', { path: repo, target: 'src/pay.ts#charge' }).text;
    const b = callTool('tests_for', { path: repo, target: 'src/pay.ts#charge' }).text;
    expect(a).toBe(b);
  });
});
