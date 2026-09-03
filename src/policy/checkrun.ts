import type { PolicyResult } from './evaluate.js';
import { fingerprintOf, renderDiffScopeMarkdown, type DiffScope } from './diff.js';
import { renderPolicyMarkdown } from './render.js';
import type { ScanReport } from '../types.js';

/**
 * GitHub Check Run payload — the ONE surface that can gate a merge. A sticky
 * comment is read by people; a Check Run is read by branch protection: make
 * it a required status check and the conclusion decides mergeability.
 *
 * The shape is the Checks API "create a check run" body (name, conclusion,
 * output with annotations), emitted as JSON for the Action to POST. Rules:
 *  - `conclusion` mirrors the CLI exit-code contract exactly, so what the
 *    terminal says and what GitHub enforces can never disagree:
 *      config error  → failure (never neutral: a broken rule must not pass)
 *      would block AND strict → failure
 *      anything else with findings → neutral (observe-first: reported, not failed)
 *      no findings → success
 *  - one annotation per LOCALIZED violation, on its exact line. Aggregate
 *    findings have nowhere to be pinned and are not annotated — they live in
 *    the summary text. In diff scope a pre-existing finding is a `notice`,
 *    never a `failure`: reported, not blamed on this change.
 *  - GitHub accepts at most 50 annotations per request; the overflow is
 *    stated in the text, not dropped silently.
 *  - `output.text` is the same markdown the PR comment shows.
 * Deterministic: annotations follow violation order.
 */

export const CHECK_RUN_NAME = 'Euthynos policy';
/** GitHub's per-request annotation limit. */
export const MAX_ANNOTATIONS = 50;

export type CheckConclusion = 'success' | 'neutral' | 'failure';

export interface CheckRunAnnotation {
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: 'notice' | 'warning' | 'failure';
  message: string;
  title: string;
}

export interface CheckRunPayload {
  name: string;
  conclusion: CheckConclusion;
  output: {
    title: string;
    summary: string;
    text: string;
    annotations: CheckRunAnnotation[];
  };
}

export interface CheckRunOptions {
  scope: 'repo' | 'diff';
  diff?: DiffScope | null;
  /** The CLI's --strict: only then may a blocking finding fail the check. */
  strict: boolean;
}

export function toCheckRun(result: PolicyResult, report: ScanReport, opts: CheckRunOptions): CheckRunPayload {
  const blocks = result.violations.filter((v) => v.mode === 'block').length;
  const warns = result.violations.length - blocks;
  const wouldBlock = opts.scope === 'diff' ? (opts.diff?.blocked ?? false) : result.blocked;
  const preExisting = opts.diff ? new Set(opts.diff.preExisting.map(fingerprintOf)) : null;

  let conclusion: CheckConclusion;
  let title: string;
  if (result.invalidRules.length > 0) {
    conclusion = 'failure';
    title = `Policy config error — ${result.invalidRules.length} invalid rule(s)`;
  } else if (wouldBlock && opts.strict) {
    conclusion = 'failure';
    title = opts.scope === 'diff'
      ? `Blocked — ${opts.diff!.introduced.filter((v) => v.mode === 'block').length} blocking violation(s) introduced by this change`
      : `Blocked — ${blocks} blocking violation(s)`;
  } else if (result.violations.length > 0) {
    conclusion = 'neutral';
    title = wouldBlock
      ? `${blocks} blocking finding(s) — observe mode, not enforced`
      : opts.scope === 'diff' && opts.diff
        ? `${opts.diff.introduced.length} introduced · ${opts.diff.preExisting.length} pre-existing — nothing blocks`
        : `${result.violations.length} finding(s) — none blocking`;
  } else {
    conclusion = 'success';
    title = 'All architecture policies passed';
  }

  const annotations: CheckRunAnnotation[] = [];
  let unpinned = 0;
  for (const v of result.violations) {
    if (!v.location) { unpinned++; continue; }
    if (annotations.length >= MAX_ANNOTATIONS) continue;
    const line = v.location.line ?? 1;
    const isOld = preExisting !== null && preExisting.has(fingerprintOf(v));
    annotations.push({
      path: v.location.file,
      start_line: line,
      end_line: v.location.endLine ?? line,
      annotation_level: isOld ? 'notice' : v.mode === 'block' ? 'failure' : 'warning',
      message: v.remedy ? `${v.message} ${v.remedy.instruction}` : v.message,
      title: isOld ? `${v.ruleId} (pre-existing)` : v.ruleId,
    });
  }
  const localized = result.violations.length - unpinned;
  const overflow = Math.max(0, localized - annotations.length);

  const summaryBits: string[] = [];
  summaryBits.push(`Architecture health ${report.health.score}/100 — ${report.health.label}.`);
  if (opts.scope === 'diff' && opts.diff) {
    summaryBits.push(`Diff scope: ${opts.diff.introduced.length} introduced, ${opts.diff.preExisting.length} pre-existing (not blocking), ${opts.diff.resolved.length} resolved.`);
  } else {
    summaryBits.push(`${blocks} blocking, ${warns} warning.`);
  }
  if (unpinned > 0) summaryBits.push(`${unpinned} aggregate finding(s) have no single line and appear in the details only.`);
  if (overflow > 0) summaryBits.push(`${overflow} more annotation(s) omitted — GitHub accepts ${MAX_ANNOTATIONS} per check; see details.`);
  if (!opts.strict && wouldBlock) summaryBits.push('Observe mode: blocking findings are reported but do not fail this check (run with --strict to enforce).');
  if (result.singleModuleTree !== undefined) summaryBits.push(`Scanned as a single module ("${result.singleModuleTree}") — cross-module rules cannot fire; point the scan at the project root.`);

  let text = renderPolicyMarkdown(result, report);
  if (opts.diff) text += renderDiffScopeMarkdown(opts.diff);

  return {
    name: CHECK_RUN_NAME,
    conclusion,
    output: { title, summary: summaryBits.join(' '), text, annotations },
  };
}

export function checkRunText(payload: CheckRunPayload): string {
  return JSON.stringify(payload, null, 2) + '\n';
}
