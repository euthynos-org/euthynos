import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { scan } from '../src/scan.js';
import { moduleOf } from '../src/discover.js';
import { renderMarkdown } from '../src/report/markdown.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, 'fixtures', 'sample');

const report = scan(FIXTURE, { months: 6 });

function mod(name: string) {
  const m = report.modules.find((m) => m.name === name);
  if (!m) throw new Error(`module ${name} not in report: ${report.modules.map((x) => x.name).join(', ')}`);
  return m;
}

describe('module discovery', () => {
  it('groups files into directory modules', () => {
    const names = report.modules.map((m) => m.name).sort();
    expect(names).toContain('payment');
    expect(names).toContain('auth');
    expect(names).toContain('orders');
    expect(names).toContain('app');
  });

  it('moduleOf handles containers and groupers', () => {
    expect(moduleOf('src/auth/token.ts')).toBe('auth');
    expect(moduleOf('src/services/auth/x.ts')).toBe('services/auth');
    expect(moduleOf('lib/payment/y.ts')).toBe('payment');
    expect(moduleOf('index.ts')).toBe('(root)');
  });
});

describe('module depth (spec §1)', () => {
  it('scores the rich payment module deeper than the one-liner auth module', () => {
    expect(mod('payment').depth.score!).toBeGreaterThan(mod('auth').depth.score!);
  });

  it('flags auth as Shallow or Very Shallow', () => {
    expect(mod('auth').depth.score!).toBeLessThan(60);
  });
});

describe('seam health (spec §2)', () => {
  it('detects the deep import bypassing payment/index.ts', () => {
    expect(mod('payment').seams.detail).toMatch(/deep import/);
  });

  it('penalizes auth for having no interface file', () => {
    expect(mod('auth').seams.detail).toMatch(/no interface file/);
    expect(mod('auth').seams.score!).toBeLessThanOrEqual(65);
  });
});

describe('leverage (spec §4)', () => {
  it('payment has multiple caller modules', () => {
    expect(mod('payment').callerCount).toBeGreaterThanOrEqual(2);
  });

  it('tracks export utilization', () => {
    expect(mod('payment').utilizationPct).not.toBeNull();
    expect(mod('payment').utilizationPct!).toBeGreaterThan(0);
  });
});

describe('contamination cascade (spec §5)', () => {
  it('step 1 catches the renamed structural clone across modules', () => {
    const clone = report.contamination.findings.find((f) => f.kind === 'clone');
    expect(clone).toBeDefined();
    const files = [clone!.a.file, clone!.b.file].join(' ');
    expect(files).toMatch(/payment\/validator/);
    expect(files).toMatch(/orders\/validatePayment/);
    expect(clone!.confidence).toBeGreaterThanOrEqual(90);
  });

  it('step 2 catches handleToken vs processToken signature match', () => {
    const sig = report.contamination.findings.find(
      (f) => f.kind === 'signature' && /token/i.test(f.a.name + f.b.name),
    );
    expect(sig).toBeDefined();
  });

  it('same-module similarity is not contamination', () => {
    for (const f of report.contamination.findings) {
      const ma = f.a.file.split('/').slice(0, -1).join('/');
      const mb = f.b.file.split('/').slice(0, -1).join('/');
      expect(ma).not.toBe(mb);
    }
  });
});

describe('composite health (spec §6)', () => {
  it('produces a 0-100 score with a label', () => {
    expect(report.health.score).toBeGreaterThanOrEqual(0);
    expect(report.health.score).toBeLessThanOrEqual(100);
    expect(report.health.label.length).toBeGreaterThan(0);
  });

  it('locality is n/a outside a git repo and weights renormalize', () => {
    expect(report.averages.locality).toBeNull();
    expect(report.health.score).toBeGreaterThan(0);
  });
});

describe('PR markdown', () => {
  it('renders the landing-page comment format', () => {
    const md = renderMarkdown(report);
    expect(md).toMatch(/Architecture Review/);
    expect(md).toMatch(/Similar logic detected/);
    expect(md).toMatch(/zero LLM calls/);
  });
});
