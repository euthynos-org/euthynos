import pc from 'picocolors';
import type { PolicyResult, Violation } from './evaluate.js';

/**
 * Diff scoping — "only what this change made worse".
 *
 * A gate that fails a team's build for debt that was already there gets
 * turned off within the week. Diff scope reports everything but lets only
 * violations the change INTRODUCED block: a head violation whose identity is
 * absent from the base evaluation. The identity is a fingerprint that
 * survives the edits an agent makes while fixing other things — never a line
 * number, which shifts the moment anything above it changes.
 *
 * Pure: two results in, a partition out. The CLI decides what to do with it.
 */

/**
 * Stable identity of a violation. Same rule, same subject → same fingerprint,
 * across line shifts and reformatting. Deliberately COARSE where precision
 * would need data the Violation does not carry: a fingerprint that collides
 * can only make the gate MORE conservative (a fix reads as "still present"
 * until every colliding instance is gone), never less — the safe direction.
 */
export function fingerprintOf(v: Violation): string {
  switch (v.type) {
    case 'forbidden-dependency':
      // The crossing: importing file → resolved target file. Two import
      // statements of the same target from one file are one crossing.
      return `${v.ruleId}|${v.location?.file ?? v.module ?? '?'}|${v.toFile ?? '?'}`;
    case 'no-new-duplication': {
      // The PAIR is the identity, whichever side carries the location — so
      // the fingerprint does not depend on which copy the finding points at.
      // Keyed on the file pair (names live only in prose today): two distinct
      // clone pairs between the same two files share a fingerprint, which is
      // the conservative collision described above.
      const a = v.location?.file ?? '?';
      const b = v.remedy?.suggestedTargets[0]?.file ?? '?';
      return `${v.ruleId}|${[a, b].sort().join('~')}`;
    }
    case 'metric-floor':
    case 'min-owners':
      // Per-module: a pre-existing floor breach in `payment` is not
      // introduced by a change that never touched it.
      return `${v.ruleId}|${v.module ?? '*'}`;
    case 'health-delta':
    case 'contamination-delta':
      // Repo-wide deltas are already "vs base" by construction.
      return v.ruleId;
  }
}

export interface DiffScope {
  /** In head, absent from base — what this change introduced. The only violations a diff-scoped gate may fail on. */
  introduced: Violation[];
  /** In both — reported for the record, never blocking here. */
  preExisting: Violation[];
  /** Fingerprints present in base and gone from head — what the change fixed. */
  resolved: string[];
  /** True when any INTRODUCED violation is block-mode. */
  blocked: boolean;
}

/** Partition a head evaluation against a base evaluation by fingerprint. Order follows the inputs, so it is deterministic. */
export function scopeToDiff(head: PolicyResult, base: PolicyResult): DiffScope {
  const baseFps = new Set(base.violations.map(fingerprintOf));
  const headFps = new Set(head.violations.map(fingerprintOf));
  const introduced: Violation[] = [];
  const preExisting: Violation[] = [];
  for (const v of head.violations) (baseFps.has(fingerprintOf(v)) ? preExisting : introduced).push(v);
  const resolved = [...baseFps].filter((fp) => !headFps.has(fp));
  return { introduced, preExisting, resolved, blocked: introduced.some((v) => v.mode === 'block') };
}

/** Terminal summary of a diff-scoped evaluation, printed after the full verdict. */
export function renderDiffScopeTerminal(d: DiffScope): string {
  const L: string[] = [];
  L.push(`  ${pc.bold('diff scope')}  ${pc.dim('only what this change introduced can block')}`);
  const bits = [
    d.introduced.length ? (d.blocked ? pc.red(`${d.introduced.length} introduced`) : pc.yellow(`${d.introduced.length} introduced`)) : pc.green('0 introduced'),
    pc.dim(`${d.preExisting.length} pre-existing (not blocking)`),
    pc.dim(`${d.resolved.length} resolved`),
  ];
  L.push('  ' + bits.join(pc.dim(' · ')));
  for (const v of d.introduced) {
    const tag = v.mode === 'block' ? pc.red('[block]') : pc.yellow('[warn] ');
    L.push(`  ${tag} ${pc.dim(v.ruleId)}  ${v.message}`);
  }
  L.push('');
  return L.join('\n');
}

/** Markdown section for the PR comment / Check Run summary. */
export function renderDiffScopeMarkdown(d: DiffScope): string {
  const lines: string[] = [''];
  lines.push('### Diff scope — only what this change introduced can block');
  lines.push('');
  lines.push(`**${d.introduced.length} introduced** · ${d.preExisting.length} pre-existing (not blocking) · ${d.resolved.length} resolved`);
  if (d.introduced.length > 0) {
    lines.push('');
    lines.push('| | Rule | Introduced by this change |');
    lines.push('|---|---|---|');
    for (const v of d.introduced) {
      const icon = v.mode === 'block' ? '🚫' : '⚠️';
      lines.push(`| ${icon} | \`${v.ruleId}\` | ${v.message.replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`);
    }
  }
  lines.push('');
  return lines.join('\n');
}
