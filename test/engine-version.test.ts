import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENGINE_VERSION } from '../src/index/incremental.js';
import { loadIndex, saveIndex } from '../src/index/store.js';

/**
 * Build-derived engine versioning (launch-readiness §4.9): the hardcoded
 * 'contexthub-0.1.0' string let two different builds exchange `.euthynos`
 * artifacts as though they were identical. These tests pin the derivation
 * and the artifact-rejection contract.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const pkgVersion = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version;

describe('ENGINE_VERSION is derived, never the old hardcoded literal', () => {
  it('carries the package version', () => {
    expect(ENGINE_VERSION).toContain(pkgVersion);
  });

  it('is never the bare pre-fix literal (which identified every build identically)', () => {
    expect(ENGINE_VERSION).not.toBe('euthynos-0.1.0');
  });

  it('source-mode runs are explicitly -dev; built engines carry a commit stamp', () => {
    expect(ENGINE_VERSION).toMatch(/-dev$|\+[0-9a-f]{12}(-dirty)?$/);
  });
});

describe('the build stamp', () => {
  it('stamp-build.mjs writes name/version/commit', () => {
    const out = mkdtempSync(join(tmpdir(), 'stamp-'));
    execFileSync('node', [join(root, 'scripts', 'stamp-build.mjs'), out], { cwd: root });
    const info = JSON.parse(readFileSync(join(out, 'build-info.json'), 'utf8'));
    expect(info.version).toBe(pkgVersion);
    expect(typeof info.commit).toBe('string');
    expect(info.commit.length).toBeGreaterThan(0);
  });

  it('npm run build leaves a stamp in dist (when dist exists)', () => {
    const stamped = join(root, 'dist', 'build-info.json');
    if (existsSync(join(root, 'dist'))) {
      expect(existsSync(stamped)).toBe(true);
    }
  });
});

describe('artifacts from a different engine version are rejected', () => {
  it('an index saved under version A is not loaded under version B', () => {
    const repo = mkdtempSync(join(tmpdir(), 'ver-'));
    writeFileSync(join(repo, 'a.ts'), 'export const a = 1;\n');
    const ok = saveIndex(repo, 'engine-A', {}, new Map());
    expect(ok).toBe(true);
    expect(loadIndex(repo, 'engine-A')).not.toBeNull();
    expect(loadIndex(repo, 'engine-B')).toBeNull();
  });
});
