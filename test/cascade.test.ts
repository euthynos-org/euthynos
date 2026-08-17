import { describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { scan } from '../src/scan.js';
import { contaminationScore } from '../src/metrics/contamination.js';
import { confirmFindings } from '../src/ai/confirm.js';
import type { ContaminationFinding } from '../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, 'fixtures', 'sample');

const report = scan(FIXTURE, { months: 6 });
const findings = report.contamination.findings;

describe('cascade step 3 — import overlap', () => {
  it('boosts the validator clone (both files import payment/engine)', () => {
    const clone = findings.find((f) => f.kind === 'clone')!;
    expect(clone).toBeDefined();
    expect(clone.signals).toContain('ast-clone');
    expect(clone.signals).toContain('import-overlap');
    expect(clone.confidence).toBeGreaterThanOrEqual(95);
  });
});

describe('cascade step 4 — naming heuristics', () => {
  it('catches summarizeLedger vs summariseLedger across modules', () => {
    const naming = findings.find(
      (f) => f.kind === 'naming' && /summari[sz]eLedger/.test(f.a.name + f.b.name),
    );
    expect(naming).toBeDefined();
    expect(naming!.signals).toContain('naming');
    expect(naming!.confidence).toBeGreaterThanOrEqual(60);
    expect(naming!.confidence).toBeLessThan(80); // unconfirmed band
  });

  it('silently drops everything below confidence 60', () => {
    for (const f of findings) expect(f.confidence).toBeGreaterThanOrEqual(60);
  });
});

describe('contamination score', () => {
  it('weights clones over firm matches over unconfirmed ones', () => {
    const mk = (kind: ContaminationFinding['kind'], confidence: number): ContaminationFinding => ({
      kind,
      confidence,
      signals: [],
      a: { file: 'a', name: 'x', line: 1, endLine: 2 },
      b: { file: 'b', name: 'y', line: 1, endLine: 2 },
    });
    expect(contaminationScore([mk('clone', 99)], 0)).toBe(12);
    expect(contaminationScore([mk('signature', 85)], 0)).toBe(5);
    expect(contaminationScore([mk('naming', 61)], 0)).toBe(2);
    expect(contaminationScore([], 4)).toBe(12); // violations*3
    expect(contaminationScore([], 99)).toBe(15); // violation penalty caps
  });

  it('report carries the violations count for later re-scoring', () => {
    expect(report.contamination.violations).toBeGreaterThanOrEqual(0);
  });
});

describe('cascade step 5 — AI confirmation (mocked)', () => {
  const naming = findings.find((f) => f.kind === 'naming')!;

  function fakeFetch(sameIntent: boolean): typeof fetch {
    return vi.fn(async () =>
      new Response(
        JSON.stringify({
          content: [{ type: 'text', text: JSON.stringify({ same_intent: sameIntent, reason: 'test' }) }],
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
  }

  it('confirmed findings get boosted and tagged', async () => {
    const res = await confirmFindings([naming], FIXTURE, { apiKey: 'k', fetchFn: fakeFetch(true) });
    expect(res.confirmed).toBe(1);
    expect(res.findings).toHaveLength(1);
    expect(res.findings[0]!.aiVerdict).toBe('confirmed');
    expect(res.findings[0]!.confidence).toBe(naming.confidence + 10);
  });

  it('refuted findings are dropped', async () => {
    const res = await confirmFindings([naming], FIXTURE, { apiKey: 'k', fetchFn: fakeFetch(false) });
    expect(res.refuted).toBe(1);
    expect(res.findings).toHaveLength(0);
  });

  it('API failures leave the rule-engine verdict standing', async () => {
    const failing = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const res = await confirmFindings([naming], FIXTURE, { apiKey: 'k', fetchFn: failing });
    expect(res.findings).toHaveLength(1);
    expect(res.findings[0]!.aiVerdict).toBeUndefined();
    expect(res.skipped).toBe(1);
  });

  it('without an API key nothing is sent and nothing changes', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const spy = fakeFetch(true);
    const res = await confirmFindings([naming], FIXTURE, { fetchFn: spy });
    expect(spy).not.toHaveBeenCalled();
    expect(res.findings).toHaveLength(1);
    vi.unstubAllEnvs();
  });

  it('high-confidence clones are not sent to the model (out of band)', async () => {
    const clone = findings.find((f) => f.kind === 'clone')!;
    expect(clone.confidence).toBeGreaterThan(95);
    const spy = fakeFetch(true);
    const res = await confirmFindings([clone], FIXTURE, { apiKey: 'k', fetchFn: spy });
    expect(spy).not.toHaveBeenCalled();
    expect(res.findings[0]).toEqual(clone);
  });
});
