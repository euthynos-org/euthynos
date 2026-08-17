import type { ScanReport } from '../types.js';

/**
 * Architecture policy engine — paid-moat differentiator #1, but the deterministic
 * core ships in the free CLI/Action too (observe mode).
 *
 * A declarative policy of rules maps 1:1 to signals the scan already computes.
 * Delta rules ("health may not drop", "no NEW duplication") need a BASE report
 * (the SaaS supplies the base-branch's last scan; the CLI takes --base). Floor /
 * ownership rules need only the head report. Evaluation is pure + deterministic:
 * same reports + same policy → same violations. Governance stays observe-first —
 * nothing here exits non-zero unless the caller explicitly opts into block mode.
 */

export type RuleMode = 'warn' | 'block';
export type MetricKey = 'depth' | 'seams' | 'leverage' | 'locality';

export interface PolicyRule {
  /** Stable id for reporting; auto-derived if omitted. */
  id?: string;
  type:
    | 'health-delta' // health may not drop more than `maxDrop` vs base
    | 'contamination-delta' // contamination may not rise more than `maxRise` vs base
    | 'no-new-duplication' // no clone pair present in head but absent in base
    | 'metric-floor' // module `metric` must stay >= `min`
    | 'min-owners'; // module bus factor must be >= `minOwners`
  mode?: RuleMode;
  module?: string; // glob for floor/owners rules: 'payment', 'payment/*', 'svc*', '*'
  metric?: MetricKey;
  min?: number;
  maxDrop?: number;
  maxRise?: number;
  minOwners?: number;
}

export interface Policy {
  rules: PolicyRule[];
  /** Applied to rules without an explicit `mode`. Default 'warn'. */
  defaultMode?: RuleMode;
}

export interface Violation {
  ruleId: string;
  type: PolicyRule['type'];
  mode: RuleMode;
  message: string;
  module?: string;
  before?: number | null;
  after?: number | null;
}

export interface PolicyResult {
  violations: Violation[];
  /** True if any block-mode rule was violated. */
  blocked: boolean;
  passed: boolean;
  /** Delta rules that were skipped because no base report was supplied. */
  skippedDeltaRules: number;
}

/** Evaluate a policy against a head report, optionally diffed against a base. */
export function evaluatePolicy(policy: Policy, report: ScanReport, base?: ScanReport): PolicyResult {
  const violations: Violation[] = [];
  let skippedDeltaRules = 0;
  const dflt = policy.defaultMode ?? 'warn';

  policy.rules.forEach((rule, i) => {
    const mode = rule.mode ?? dflt;
    const id = rule.id ?? `${rule.type}#${i + 1}`;
    const add = (message: string, extra: Partial<Violation> = {}): void => {
      violations.push({ ruleId: id, type: rule.type, mode, message, ...extra });
    };

    switch (rule.type) {
      case 'health-delta': {
        if (!base) { skippedDeltaRules++; break; }
        const maxDrop = rule.maxDrop ?? 0;
        const drop = base.health.score - report.health.score;
        if (drop > maxDrop) {
          add(`Architecture health dropped ${drop} pts (${base.health.score} → ${report.health.score}); policy allows ≤ ${maxDrop}.`,
            { before: base.health.score, after: report.health.score });
        }
        break;
      }
      case 'contamination-delta': {
        if (!base) { skippedDeltaRules++; break; }
        const maxRise = rule.maxRise ?? 0;
        const rise = report.contamination.score - base.contamination.score;
        if (rise > maxRise) {
          add(`Duplication score rose ${rise} (${base.contamination.score} → ${report.contamination.score}); policy allows ≤ ${maxRise}.`,
            { before: base.contamination.score, after: report.contamination.score });
        }
        break;
      }
      case 'no-new-duplication': {
        if (!base) { skippedDeltaRules++; break; }
        const basePairs = new Set(base.contamination.findings.map(pairKey));
        const fresh = report.contamination.findings.filter((f) => !basePairs.has(pairKey(f)));
        if (fresh.length > 0) {
          const sample = fresh.slice(0, 5)
            .map((f) => `${short(f.a.file)}:${f.a.name} ≈ ${short(f.b.file)}:${f.b.name}`)
            .join('; ');
          add(`${fresh.length} new duplicate-logic pair${fresh.length > 1 ? 's' : ''} introduced vs base — ${sample}${fresh.length > 5 ? ' …' : ''}.`);
        }
        break;
      }
      case 'metric-floor': {
        const metric = rule.metric ?? 'seams';
        const min = rule.min ?? 0;
        for (const m of report.modules) {
          if (!matchModule(rule.module ?? '*', m.name)) continue;
          const s = m[metric].score;
          if (s != null && s < min) {
            add(`${m.name}: ${metric} ${s} is below the floor of ${min}.`, { module: m.name, after: s });
          }
        }
        break;
      }
      case 'min-owners': {
        const minOwners = rule.minOwners ?? 2;
        for (const m of report.modules) {
          if (!matchModule(rule.module ?? '*', m.name)) continue;
          const bf = m.ownership.busFactor;
          if (bf != null && bf < minOwners) {
            add(`${m.name}: bus factor ${bf} is below the required ${minOwners} (${m.ownership.topAuthor ?? 'one author'} holds ${pct(m.ownership.topShare)}).`,
              { module: m.name, after: bf });
          }
        }
        break;
      }
    }
  });

  const blocked = violations.some((v) => v.mode === 'block');
  return { violations, blocked, passed: violations.length === 0, skippedDeltaRules };
}

/**
 * Ratchet policy — "freeze today's numbers, fail only on regressions". The
 * starter policy so day-1 rules never fail on pre-existing debt: health can't
 * drop, duplication can't rise, no new clones. Block strictly opt-in.
 */
export function ratchetPolicy(mode: RuleMode = 'warn', maxHealthDrop = 3): Policy {
  return {
    defaultMode: mode,
    rules: [
      { id: 'health-no-regression', type: 'health-delta', maxDrop: maxHealthDrop },
      { id: 'no-more-duplication', type: 'contamination-delta', maxRise: 0 },
      { id: 'no-new-clones', type: 'no-new-duplication' },
    ],
  };
}

const pairKey = (f: { a: { file: string; name: string }; b: { file: string; name: string } }): string =>
  [`${f.a.file}:${f.a.name}`, `${f.b.file}:${f.b.name}`].sort().join('|');

const short = (p: string): string => p.split('/').pop() ?? p;
const pct = (s: number | null): string => (s == null ? 'n/a' : `${Math.round(s * 100)}%`);

/** Module glob: '*' all · 'X' exact · 'X*' prefix · 'X/*' X or any submodule under X/. */
function matchModule(glob: string, name: string): boolean {
  if (glob === '*' || glob === name) return true;
  if (glob.endsWith('/*')) {
    const base = glob.slice(0, -2);
    return name === base || name.startsWith(base + '/');
  }
  if (glob.endsWith('*')) return name.startsWith(glob.slice(0, -1));
  return false;
}
