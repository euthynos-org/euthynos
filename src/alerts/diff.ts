import type { MetricScore, ModuleReport, ScanReport } from '../types.js';

/**
 * Health-regression alerts — paid-moat differentiator #2, riding the same
 * delta spine as the policy gate: two ScanReports in, typed events out.
 *
 * Every event is reproducible from the two stored reports (no hidden state),
 * routed to the head module's dominant author (the SaaS refines routing to the
 * offending commit's author once it has per-push attribution). "Metric became
 * n/a" is a distinct event and is NEVER treated as a drop — the composite
 * renormalizes weights, and an alert that cries wolf on missing git history
 * is the kind of noise that gets a tool ripped out of Slack.
 */

export type AlertSeverity = 'critical' | 'warn' | 'info';

export type AlertKind =
  | 'health-band-drop' // composite crossed a band boundary downward
  | 'health-drop' // composite fell >= minHealthDrop (within the same band)
  | 'contamination-spike' // duplication score rose >= minContaminationRise
  | 'new-clones' // clone pairs present in head, absent in base
  | 'bus-factor-one' // a module collapsed to a single knowledge holder
  | 'new-cycle' // a module entered an import cycle it wasn't in before
  | 'metric-drop' // a per-module metric fell >= minMetricDrop
  | 'metric-unavailable' // a metric became n/a (informational, never a drop)
  | 'module-added'
  | 'module-removed';

export interface AlertEvent {
  kind: AlertKind;
  severity: AlertSeverity;
  message: string;
  module?: string;
  metric?: 'depth' | 'seams' | 'locality' | 'leverage';
  before?: number | null;
  after?: number | null;
  /** Best-known routing target: the module's dominant author in the head scan. */
  routeTo?: string | null;
}

export interface AlertOptions {
  /** Composite drop (points) that fires within the same band. Default 3. */
  minHealthDrop?: number;
  /** Per-module metric drop (points) that fires. Default 10. */
  minMetricDrop?: number;
  /** Contamination rise (points) that fires. Default 5. */
  minContaminationRise?: number;
}

const METRICS = ['depth', 'seams', 'locality', 'leverage'] as const;
const SEVERITY_RANK: Record<AlertSeverity, number> = { critical: 0, warn: 1, info: 2 };

/** Diff two scans of the same repo into alert events. Pure + deterministic. */
export function diffReports(base: ScanReport, head: ScanReport, opts: AlertOptions = {}): AlertEvent[] {
  const minHealthDrop = opts.minHealthDrop ?? 3;
  const minMetricDrop = opts.minMetricDrop ?? 10;
  const minContaminationRise = opts.minContaminationRise ?? 5;
  const events: AlertEvent[] = [];

  // ── composite health ──────────────────────────────────────────────────────
  const drop = base.health.score - head.health.score;
  if (drop > 0 && head.health.label !== base.health.label) {
    events.push({
      kind: 'health-band-drop', severity: 'critical',
      message: `Architecture health fell out of "${base.health.label}" — ${base.health.score} → ${head.health.score} ("${head.health.label}").`,
      before: base.health.score, after: head.health.score,
    });
  } else if (drop >= minHealthDrop) {
    events.push({
      kind: 'health-drop', severity: 'warn',
      message: `Architecture health dropped ${drop} pts (${base.health.score} → ${head.health.score}).`,
      before: base.health.score, after: head.health.score,
    });
  }

  // ── duplication ───────────────────────────────────────────────────────────
  const rise = head.contamination.score - base.contamination.score;
  if (rise >= minContaminationRise) {
    events.push({
      kind: 'contamination-spike', severity: 'warn',
      message: `Duplication score rose ${rise} pts (${base.contamination.score} → ${head.contamination.score} — ${head.contamination.label}).`,
      before: base.contamination.score, after: head.contamination.score,
    });
  }
  const basePairs = new Set(base.contamination.findings.map(pairKey));
  const fresh = head.contamination.findings.filter((f) => !basePairs.has(pairKey(f)));
  if (fresh.length > 0) {
    const sample = fresh.slice(0, 3)
      .map((f) => `${short(f.a.file)}:${f.a.name} ≈ ${short(f.b.file)}:${f.b.name}`)
      .join('; ');
    events.push({
      kind: 'new-clones', severity: 'warn',
      message: `${fresh.length} new duplicate-logic pair${fresh.length > 1 ? 's' : ''} — ${sample}${fresh.length > 3 ? ' …' : ''}.`,
    });
  }

  // ── per-module deltas ─────────────────────────────────────────────────────
  const baseMods = new Map(base.modules.map((m) => [m.name, m]));
  const headMods = new Map(head.modules.map((m) => [m.name, m]));

  for (const [name, hm] of headMods) {
    const bm = baseMods.get(name);
    if (!bm) {
      events.push({ kind: 'module-added', severity: 'info', module: name, message: `New module ${name} (${hm.files} file${hm.files > 1 ? 's' : ''}).`, routeTo: hm.ownership.topAuthor });
      continue;
    }

    const routeTo = hm.ownership.topAuthor;

    // Knowledge risk: collapsed to a single holder.
    if ((bm.ownership.busFactor ?? 0) >= 2 && hm.ownership.busFactor === 1) {
      events.push({
        kind: 'bus-factor-one', severity: 'critical', module: name, routeTo,
        message: `${name}: bus factor fell to 1 — ${hm.ownership.topAuthor ?? 'one author'} now holds ${pct(hm.ownership.topShare)} of commits.`,
        before: bm.ownership.busFactor, after: 1,
      });
    }

    // A module entered a cycle it wasn't in before (structural seam breach).
    if (!inCycle(bm.seams) && inCycle(hm.seams)) {
      events.push({
        kind: 'new-cycle', severity: 'critical', module: name, routeTo,
        message: `${name}: entered an import cycle (seams ${fmt(bm.seams.score)} → ${fmt(hm.seams.score)}).`,
        before: bm.seams.score, after: hm.seams.score,
      });
    }

    for (const key of METRICS) {
      const b = bm[key].score;
      const h = hm[key].score;
      if (b != null && h == null) {
        events.push({
          kind: 'metric-unavailable', severity: 'info', module: name, metric: key,
          message: `${name}: ${key} became n/a (was ${b}) — not counted as a drop; composite weights renormalize.`,
          before: b, after: null,
        });
        continue;
      }
      if (b != null && h != null && b - h >= minMetricDrop) {
        events.push({
          kind: 'metric-drop', severity: 'warn', module: name, metric: key, routeTo,
          message: `${name}: ${key} dropped ${b - h} pts (${b} → ${h} — ${hm[key].label}).`,
          before: b, after: h,
        });
      }
    }
  }

  for (const [name, bm] of baseMods) {
    if (!headMods.has(name)) {
      events.push({ kind: 'module-removed', severity: 'info', module: name, message: `Module ${name} removed (${bm.files} file${bm.files > 1 ? 's' : ''}, ${bm.codeLines} LOC).` });
    }
  }

  // Deterministic ordering: severity, then kind, then module.
  return events.sort((a, b) =>
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
    || a.kind.localeCompare(b.kind)
    || (a.module ?? '').localeCompare(b.module ?? ''));
}

const pairKey = (f: { a: { file: string; name: string }; b: { file: string; name: string } }): string =>
  [`${f.a.file}:${f.a.name}`, `${f.b.file}:${f.b.name}`].sort().join('|');

const short = (p: string): string => p.split('/').pop() ?? p;
const pct = (s: number | null): string => (s == null ? 'n/a' : `${Math.round(s * 100)}%`);
const fmt = (s: number | null): string => (s == null ? 'n/a' : String(s));
/** The seams detail names cycle membership; structured cycle data stays graph-side. */
const inCycle = (seams: MetricScore): boolean => seams.detail.includes('circular');

/** Convenience for callers that only track people-risk. */
export function busFactorAlerts(events: AlertEvent[]): AlertEvent[] {
  return events.filter((e) => e.kind === 'bus-factor-one');
}

export type { ModuleReport };
