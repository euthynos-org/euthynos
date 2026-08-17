import pc from 'picocolors';
import type { PolicyResult, Violation } from './evaluate.js';
import type { ScanReport } from '../types.js';

/** Terminal summary of a policy evaluation. */
export function renderPolicyTerminal(result: PolicyResult, report: ScanReport): string {
  const L: string[] = [];
  const blocks = result.violations.filter((v) => v.mode === 'block');
  const warns = result.violations.filter((v) => v.mode === 'warn');

  L.push('');
  L.push(`  ${pc.bold(pc.magenta('◉ Euthynos'))}  ${pc.dim('architecture policy')}`);
  L.push(`  ${pc.dim('Health')} ${pc.bold(String(report.health.score))}${pc.dim('/100')}  ${pc.dim(report.health.label)}`);
  L.push('  ' + pc.dim('─'.repeat(60)));

  if (result.passed) {
    L.push(`  ${pc.green('✓')} all architecture policies passed`);
  } else {
    if (blocks.length) L.push(`  ${pc.red(pc.bold(`✗ ${blocks.length} blocking`))}${warns.length ? pc.dim(' · ') + pc.yellow(`${warns.length} warning`) : ''}`);
    else L.push(`  ${pc.yellow(pc.bold(`⚠ ${warns.length} warning`))}`);
    L.push('');
    for (const v of result.violations) L.push('  ' + line(v));
  }
  if (result.skippedDeltaRules > 0) {
    L.push('');
    L.push(`  ${pc.dim(`${result.skippedDeltaRules} delta rule(s) skipped — no base report (pass --base <report.json>)`)}`);
  }
  L.push('');
  return L.join('\n');
}

function line(v: Violation): string {
  const tag = v.mode === 'block' ? pc.red('[block]') : pc.yellow('[warn] ');
  return `${tag} ${pc.dim(v.ruleId)}  ${v.message}`;
}

/**
 * Markdown for the PR sticky comment / GitHub Check Run summary. Carries the
 * `<!-- euthynos-policy -->` marker so the SaaS/Action can upsert one comment.
 */
export function renderPolicyMarkdown(result: PolicyResult, report: ScanReport): string {
  const blocks = result.violations.filter((v) => v.mode === 'block');
  const warns = result.violations.filter((v) => v.mode === 'warn');
  // Both markers are emitted: consumers that upsert on the pre-rename
  // anchor keep matching their existing comment rather than duplicating it.
  const lines: string[] = ['<!-- euthynos-policy -->', '<!-- contexthub-policy -->'];
  lines.push(`## ◉ Euthynos — architecture policy`);
  lines.push('');
  lines.push(`**Architecture health ${report.health.score}/100 — ${report.health.label}**`);
  lines.push('');

  if (result.passed) {
    lines.push('✅ **All architecture policies passed.**');
  } else {
    const bits: string[] = [];
    if (blocks.length) bits.push(`🚫 **${blocks.length} blocking**`);
    if (warns.length) bits.push(`⚠️ ${warns.length} warning`);
    lines.push(bits.join(' · '));
    lines.push('');
    lines.push('| | Rule | Finding |');
    lines.push('|---|---|---|');
    for (const v of result.violations) {
      const icon = v.mode === 'block' ? '🚫' : '⚠️';
      lines.push(`| ${icon} | \`${v.ruleId}\` | ${escapeCell(v.message)} |`);
    }
  }
  if (result.skippedDeltaRules > 0) {
    lines.push('');
    lines.push(`<sub>${result.skippedDeltaRules} delta rule(s) skipped — no base scan to diff against.</sub>`);
  }
  lines.push('');
  lines.push(`<sub>Deterministic · observe-first · ${report.scannedAt}</sub>`);
  return lines.join('\n') + '\n';
}

const escapeCell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
