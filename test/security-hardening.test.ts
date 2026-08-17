import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverFiles } from '../src/discover.js';

// A scanned repo may be hostile (the cloud SaaS clones untrusted customer code).
// discoverFiles must never follow a symlink out of the root and must skip
// oversized files, so a crafted repo can't read host/cross-tenant files or
// OOM the scanner.
const root = mkdtempSync(join(tmpdir(), 'ctxhub-sec-'));
const outside = mkdtempSync(join(tmpdir(), 'ctxhub-secret-'));

writeFileSync(join(root, 'normal.ts'), 'export const x = 1;\n');
writeFileSync(join(root, 'huge.ts'), 'const blob = "' + 'a'.repeat(4.5 * 1024 * 1024) + '";\n'); // > 4MB cap
writeFileSync(join(outside, 'secret.ts'), 'export const SECRET = "leak";\n');

let symlinkMade = false;
try {
  symlinkSync(join(outside, 'secret.ts'), join(root, 'leak.ts')); // points OUT of the repo
  symlinkMade = true;
} catch {
  // symlink creation needs privilege on some hosts (Windows) — skip that assertion there
}

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('scanner hardening against hostile repos', () => {
  const files = discoverFiles(root).map((f) => f.rel);

  it('discovers normal code files', () => {
    expect(files).toContain('normal.ts');
  });

  it('skips oversized files (DoS / zip-bomb guard)', () => {
    expect(files).not.toContain('huge.ts');
  });

  it('never follows a symlink out of the repo root', () => {
    if (!symlinkMade) return; // symlink unavailable on this host
    expect(files).not.toContain('leak.ts');
  });
});
