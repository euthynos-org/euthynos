import { describe, expect, it } from 'vitest';
import { parseAuthorLog } from '../src/git/authors.js';
import type { ModuleAuthorStats } from '../src/git/authors.js';
import { inferOwner, knowledgeRisk, riskLabel } from '../src/metrics/ownership.js';

/** Fake moduleOf: first path segment. */
const moduleOf = (rel: string) => rel.split('/')[0] ?? rel;

/**
 * Build raw `git log --name-only --pretty=format:__C__%an` output,
 * blank lines between marker and files like real git emits.
 */
function gitLog(commits: Array<[author: string, ...files: string[]]>): string {
  return commits.map(([author, ...files]) => `__C__${author}\n\n${files.join('\n')}`).join('\n\n');
}

function repeat(n: number, commit: [string, ...string[]]): Array<[string, ...string[]]> {
  return Array.from({ length: n }, () => commit);
}

function stats(raw: string, module: string): ModuleAuthorStats {
  const m = parseAuthorLog(raw, moduleOf).get(module);
  if (!m) throw new Error(`module ${module} not parsed`);
  return m;
}

const DUO_80_20 = gitLog([...repeat(8, ['Alice', 'duo/x.ts']), ...repeat(2, ['Bob', 'duo/y.ts'])]);
const TRIO_50_30_20 = gitLog([
  ...repeat(5, ['Alice', 'trio/x.ts']),
  ...repeat(3, ['Bob', 'trio/y.ts']),
  ...repeat(2, ['Cara', 'trio/z.ts']),
]);
const QUAD_EVEN = gitLog([
  ...repeat(2, ['Alice', 'quad/a.ts']),
  ...repeat(2, ['Bob', 'quad/b.ts']),
  ...repeat(2, ['Cara', 'quad/c.ts']),
  ...repeat(2, ['Dev', 'quad/d.ts']),
]);

describe('parseAuthorLog', () => {
  it('groups commits by module and counts per author', () => {
    const raw = gitLog([
      ['Alice', 'auth/token.ts'],
      ['Bob', 'auth/session.ts', 'payment/charge.ts'],
      ['Alice', 'payment/refund.ts'],
    ]);
    const per = parseAuthorLog(raw, moduleOf);
    expect([...per.keys()].sort()).toEqual(['auth', 'payment']);
    const auth = stats(raw, 'auth');
    expect(auth.commits).toBe(2);
    expect(auth.authors.get('Alice')).toBe(1);
    expect(auth.authors.get('Bob')).toBe(1);
    expect(stats(raw, 'payment').commits).toBe(2);
  });

  it('counts a commit once per module even when it touches many files there', () => {
    const raw = gitLog([['Alice', 'auth/a.ts', 'auth/b.ts', 'auth/c.ts']]);
    expect(stats(raw, 'auth').commits).toBe(1);
    expect(stats(raw, 'auth').authors.get('Alice')).toBe(1);
  });

  it('filters non-code files and normalizes backslashes', () => {
    const raw = gitLog([['Alice', 'auth\\token.ts', 'README.md', 'docs/spec.txt', 'assets/logo.png']]);
    const per = parseAuthorLog(raw, moduleOf);
    expect([...per.keys()]).toEqual(['auth']);
    expect(stats(raw, 'auth').commits).toBe(1);
  });

  it('ignores commits that touch no code files', () => {
    const raw = gitLog([
      ['Alice', 'README.md'],
      ['Bob', 'auth/a.ts'],
    ]);
    const per = parseAuthorLog(raw, moduleOf);
    expect(per.size).toBe(1);
    expect(stats(raw, 'auth').authors.has('Alice')).toBe(false);
  });

  it('returns an empty map for empty input', () => {
    expect(parseAuthorLog('', moduleOf).size).toBe(0);
  });
});

describe('bus factor (min authors covering >=80% of commits)', () => {
  it('single author = bus factor 1', () => {
    const s = stats(gitLog(repeat(5, ['Alice', 'solo/x.ts'])), 'solo');
    expect(s.busFactor).toBe(1);
    expect(s.topAuthor).toBe('Alice');
    expect(s.topShare).toBe(1);
  });

  it('80/20 split over 10 commits = bus factor 1 (top author alone covers 80%)', () => {
    const s = stats(DUO_80_20, 'duo');
    expect(s.commits).toBe(10);
    expect(s.busFactor).toBe(1);
    expect(s.topAuthor).toBe('Alice');
    expect(s.topShare).toBeCloseTo(0.8, 10);
  });

  it('50/30/20 across three authors = bus factor 2', () => {
    const s = stats(TRIO_50_30_20, 'trio');
    expect(s.busFactor).toBe(2);
    expect(s.topAuthor).toBe('Alice');
    expect(s.topShare).toBe(0.5);
  });

  it('even 4-way split = bus factor 4 (ceil to cover 80%)', () => {
    const s = stats(QUAD_EVEN, 'quad');
    expect(s.commits).toBe(8);
    expect(s.busFactor).toBe(4);
    expect(s.topShare).toBe(0.25);
  });
});

describe('knowledgeRisk', () => {
  it('single-author module scores below 40 (Bus Factor 1 band)', () => {
    const r = knowledgeRisk(stats(gitLog(repeat(6, ['Alice', 'solo/x.ts'])), 'solo'));
    expect(r.score).not.toBeNull();
    expect(r.score!).toBeLessThan(40);
    expect(r.label).toBe('Bus Factor 1');
    expect(r.detail).toBe('Alice 100% of 6 commits · bus factor 1');
  });

  it('dominant 80% author also lands in the lowest band', () => {
    const r = knowledgeRisk(stats(DUO_80_20, 'duo'));
    expect(r.score!).toBeLessThan(40);
    expect(r.detail).toBe('Alice 80% of 10 commits · bus factor 1');
  });

  it('even 4-author module scores >= 80 (Distributed)', () => {
    const r = knowledgeRisk(stats(QUAD_EVEN, 'quad'));
    expect(r.score!).toBeGreaterThanOrEqual(80);
    expect(r.label).toBe('Distributed');
  });

  it('fewer than 3 commits -> null score', () => {
    const s = stats(gitLog(repeat(2, ['Alice', 'tiny/x.ts'])), 'tiny');
    expect(knowledgeRisk(s)).toEqual({ score: null, label: 'n/a', detail: 'too few commits' });
  });

  it('missing stats (module absent from git window) -> null score', () => {
    expect(knowledgeRisk(undefined)).toEqual({ score: null, label: 'n/a', detail: 'too few commits' });
  });

  it('riskLabel band edges', () => {
    expect(riskLabel(80)).toBe('Distributed');
    expect(riskLabel(79)).toBe('Shared');
    expect(riskLabel(60)).toBe('Shared');
    expect(riskLabel(59)).toBe('Concentrated');
    expect(riskLabel(40)).toBe('Concentrated');
    expect(riskLabel(39)).toBe('Bus Factor 1');
  });
});

describe('inferOwner', () => {
  it('returns the dominant author at >= 50% share', () => {
    expect(inferOwner(stats(DUO_80_20, 'duo'))).toBe('Alice');
    // exactly 50% is inclusive
    expect(inferOwner(stats(TRIO_50_30_20, 'trio'))).toBe('Alice');
  });

  it('returns null below 50% share', () => {
    expect(inferOwner(stats(QUAD_EVEN, 'quad'))).toBeNull();
  });

  it('returns null with thin history or missing stats', () => {
    expect(inferOwner(stats(gitLog(repeat(2, ['Alice', 'tiny/x.ts'])), 'tiny'))).toBeNull();
    expect(inferOwner(undefined)).toBeNull();
  });
});
