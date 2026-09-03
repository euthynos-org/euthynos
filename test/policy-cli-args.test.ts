import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { POLICY_FILE, parsePolicyArgs, resolvePolicySource } from '../src/report/policy-cli.js';

/**
 * The CLI's argument contract. The regression this pins: a boolean flag
 * swallowing the repository path that follows it, so `policy --strict repo/`
 * scanned the CURRENT directory and gated the wrong tree without saying so.
 */
describe('parsePolicyArgs', () => {
  it('a boolean flag never consumes the path after it', () => {
    const { positional, flags } = parsePolicyArgs(['--strict', 'test/fixtures/sample']);
    expect(positional).toEqual(['test/fixtures/sample']);
    expect(flags.get('strict')).toBe('true');
  });

  it('every boolean flag behaves that way, in any position', () => {
    for (const b of ['strict', 'quiet', 'block', 'ratchet']) {
      const { positional, flags } = parsePolicyArgs([`--${b}`, 'repo', '--scope', 'diff']);
      expect(positional).toEqual(['repo']);
      expect(flags.get(b)).toBe('true');
      expect(flags.get('scope')).toBe('diff');
    }
  });

  it('value flags still take the next token, and a trailing value flag is "true"', () => {
    const { positional, flags } = parsePolicyArgs(['repo', '--base', 'base.json', '--json', 'out.json', '--md']);
    expect(positional).toEqual(['repo']);
    expect(flags.get('base')).toBe('base.json');
    expect(flags.get('json')).toBe('out.json');
    expect(flags.get('md')).toBe('true');
  });

  it('a value flag does not eat the next flag', () => {
    const { flags } = parsePolicyArgs(['--policy', '--strict']);
    expect(flags.get('policy')).toBe('true');
    expect(flags.get('strict')).toBe('true');
  });
});

/**
 * Policy-as-code discovery. The file lives at the repository ROOT because
 * `.euthynos/` gitignores itself — a policy in there never reaches CI.
 */
describe('resolvePolicySource', () => {
  const withFile = mkdtempSync(join(tmpdir(), 'eu-policy-'));
  const without = mkdtempSync(join(tmpdir(), 'eu-nopolicy-'));
  writeFileSync(join(withFile, POLICY_FILE), '{"rules":[]}');
  afterAll(() => { rmSync(withFile, { recursive: true, force: true }); rmSync(without, { recursive: true, force: true }); });

  const flags = (pairs: [string, string][] = []): Map<string, string> => new Map(pairs);

  it('the canonical file name is at the root, not inside .euthynos/', () => {
    expect(POLICY_FILE).toBe('euthynos.policy.json');
    expect(POLICY_FILE.includes('/')).toBe(false);
  });

  it('discovers the repository policy when no flag names one', () => {
    expect(resolvePolicySource(flags(), withFile)).toEqual({ kind: 'file', path: join(withFile, POLICY_FILE), discovered: true });
  });

  it('falls back to the built-in ratchet when there is no file', () => {
    expect(resolvePolicySource(flags(), without)).toEqual({ kind: 'ratchet' });
  });

  it('an explicit --policy wins over the discovered file; --ratchet wins over discovery', () => {
    expect(resolvePolicySource(flags([['policy', 'x.json']]), withFile)).toEqual({ kind: 'file', path: 'x.json', discovered: false });
    expect(resolvePolicySource(flags([['ratchet', 'true']]), withFile)).toEqual({ kind: 'ratchet' });
  });
});
