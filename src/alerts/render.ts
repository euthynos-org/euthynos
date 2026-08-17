import pc from 'picocolors';
import type { AlertEvent } from './diff.js';
import type { ScanReport } from '../types.js';

/** Terminal summary of an alert diff. */
export function renderAlertsTerminal(events: AlertEvent[], head: ScanReport): string {
  const L: string[] = [];
  const crit = events.filter((e) => e.severity === 'critical');
  const warns = events.filter((e) => e.severity === 'warn');
  const infos = events.filter((e) => e.severity === 'info');

  L.push('');
  L.push(`  ${pc.bold(pc.magenta('◉ Euthynos'))}  ${pc.dim('health-regression alerts')}`);
  L.push(`  ${pc.dim('Health')} ${pc.bold(String(head.health.score))}${pc.dim('/100')}  ${pc.dim(head.health.label)}`);
  L.push('  ' + pc.dim('─'.repeat(60)));

  if (events.length === 0) {
    L.push(`  ${pc.green('✓')} no regressions vs base`);
  } else {
    const bits: string[] = [];
    if (crit.length) bits.push(pc.red(pc.bold(`✗ ${crit.length} critical`)));
    if (warns.length) bits.push(pc.yellow(`⚠ ${warns.length} warning`));
    if (infos.length) bits.push(pc.dim(`${infos.length} info`));
    L.push('  ' + bits.join(pc.dim(' · ')));
    L.push('');
    for (const e of events) L.push('  ' + line(e));
  }
  L.push('');
  return L.join('\n');
}

function line(e: AlertEvent): string {
  const tag =
    e.severity === 'critical' ? pc.red('[crit]') :
    e.severity === 'warn' ? pc.yellow('[warn]') : pc.dim('[info]');
  const route = e.routeTo ? pc.dim(` → ${e.routeTo}`) : '';
  return `${tag} ${pc.dim(e.kind)}  ${e.message}${route}`;
}

/**
 * Markdown for Slack/e-mail/PR delivery. Carries the `<!-- euthynos-alerts -->`
 * marker so the SaaS can upsert a single surface per scan.
 */
export function renderAlertsMarkdown(events: AlertEvent[], head: ScanReport): string {
  // Both markers are emitted: consumers that upsert on the pre-rename
  // anchor keep matching their existing comment rather than duplicating it.
  const lines: string[] = ['<!-- euthynos-alerts -->', '<!-- contexthub-alerts -->'];
  lines.push('## ◉ Euthynos — health-regression alerts');
  lines.push('');
  lines.push(`**Architecture health ${head.health.score}/100 — ${head.health.label}**`);
  lines.push('');

  if (events.length === 0) {
    lines.push('✅ **No regressions vs base.**');
  } else {
    lines.push('| | Event | Finding | Route to |');
    lines.push('|---|---|---|---|');
    for (const e of events) {
      const icon = e.severity === 'critical' ? '🚨' : e.severity === 'warn' ? '⚠️' : 'ℹ️';
      lines.push(`| ${icon} | \`${e.kind}\` | ${escapeCell(e.message)} | ${e.routeTo ?? '—'} |`);
    }
  }
  lines.push('');
  lines.push(`<sub>Deterministic — every event reproducible from the two stored scans · ${head.scannedAt}</sub>`);
  return lines.join('\n') + '\n';
}

const escapeCell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
