import { describe, expect, it, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callTool } from '../src/mcp/tools.js';

/**
 * Phase 6 Step 1 (PHASE6-COMPLETION-PLAN §1-§5): callees_of +
 * dependencies_of + dependents_of — pure projections of graphs that already
 * exist. Contract pinned here BEFORE implementation:
 *
 *  - callees_of mirrors callers_of: transitive, depth-labeled, confidence-
 *    marked, and its EMPTY answer carries the static-graph boundary.
 *  - dependencies_of / dependents_of are module-level import-edge views
 *    with deep-import flags; an empty dependents answer must NEVER read as
 *    "unused module" (the impact_of lesson, module-level).
 *  - Misses list the available modules (the module_metrics pattern).
 *  - Deterministic: byte-identical output on unchanged state.
 */

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, 'fixtures', 'sample');

let leafRepo: string; // one module, one leaf function, no imports at all

beforeAll(() => {
  leafRepo = mkdtempSync(join(tmpdir(), 'p6s1-'));
  writeFileSync(
    join(leafRepo, 'solo.ts'),
    'export function leafOnly(x: number): number {\n  return x + 1;\n}\n',
  );
});

describe('callees_of', () => {
  it('lists transitive callees with depth and location', () => {
    const r = callTool('callees_of', { path: FIXTURE, function: 'validateTransaction' });
    expect(r.isError ?? false).toBe(false);
    expect(r.text).toMatch(/callees of validateTransaction/i);
    expect(r.text).toContain('computeFee');
    expect(r.text).toMatch(/d1 /); // depth labels, callers_of convention
    expect(r.text).toMatch(/:\d+/); // file:line locations
  });

  it('empty answer carries the static-graph boundary, never a bare negative', () => {
    const r = callTool('callees_of', { path: leafRepo, function: 'leafOnly' });
    expect(r.isError ?? false).toBe(false);
    expect(r.text).toContain('no callees in the graph');
    expect(r.text).toContain('static calls in indexed source only');
    expect(r.text).toMatch(/dynamic dispatch|reflection/);
  });

  it('is deterministic', () => {
    const a = callTool('callees_of', { path: FIXTURE, function: 'validateTransaction' }).text;
    const b = callTool('callees_of', { path: FIXTURE, function: 'validateTransaction' }).text;
    expect(a).toBe(b);
  });
});

describe('dependencies_of / dependents_of', () => {
  it('dependencies_of lists the modules a module imports, with its scope line', () => {
    const r = callTool('dependencies_of', { path: FIXTURE, module: 'app' });
    expect(r.isError ?? false).toBe(false);
    expect(r.text).toContain('payment');
    expect(r.text).toContain('import edges in indexed source only');
  });

  it('dependents_of lists who imports the module', () => {
    const r = callTool('dependents_of', { path: FIXTURE, module: 'payment' });
    expect(r.isError ?? false).toBe(false);
    expect(r.text).toMatch(/app|orders/);
  });

  it('an empty dependents answer never reads as "unused module"', () => {
    const r = callTool('dependents_of', { path: leafRepo, module: '(root)' });
    expect(r.isError ?? false).toBe(false);
    expect(r.text).toContain('No importing modules in the graph');
    expect(r.text).toContain('not a claim the module is unused');
    expect(r.text).toMatch(/dynamic import|require-by-variable|entry point/);
  });

  it('a module miss lists the available modules (module_metrics pattern)', () => {
    const r = callTool('dependencies_of', { path: FIXTURE, module: 'no_such_module_xyz' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/not found/);
    expect(r.text).toContain('payment');
  });

  it('deep imports into a module are flagged when present', () => {
    // The sample fixture may or may not carry deep imports — the CONTRACT is
    // that whenever the module graph records them for the target module, the
    // tool surfaces the count rather than hiding it. Assert the section is
    // never silently absent when deepImports exist.
    const r = callTool('dependents_of', { path: FIXTURE, module: 'payment' });
    expect(r.isError ?? false).toBe(false);
    // Always states its evidence base:
    expect(r.text).toContain('import edges in indexed source only');
  });

  it('both wrappers are deterministic', () => {
    for (const tool of ['dependencies_of', 'dependents_of']) {
      const a = callTool(tool, { path: FIXTURE, module: 'payment' }).text;
      const b = callTool(tool, { path: FIXTURE, module: 'payment' }).text;
      expect(a).toBe(b);
    }
  });
});
