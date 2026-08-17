import pc from 'picocolors';
import type { MetricScore, ScanReport } from '../types.js';

const W = 78;

export function renderTerminal(r: ScanReport): string {
  const lines: string[] = [];
  const bar = '─'.repeat(W);

  lines.push('');
  lines.push(pc.bold(pc.magenta('  ◉ Euthynos')) + pc.dim(`  architecture scan · ${r.filesScanned} files · ${r.modules.length} modules`));
  lines.push(pc.dim('  ' + bar));

  // Composite
  const h = r.health;
  lines.push('');
  lines.push(`  ${pc.bold('Architecture Health')}  ${scoreColor(h.score)(pc.bold(String(h.score)))}${pc.dim('/100')}  ${badge(h.label, h.score)}`);
  lines.push('  ' + meter(h.score));
  lines.push('');

  // Metric averages row
  const a = r.averages;
  lines.push(
    '  ' +
    cell('Depth', a.depth) +
    cell('Seams', a.seams) +
    cell('Locality', a.locality) +
    cell('Leverage', a.leverage) +
    cell('Contam', 100 - r.contamination.score, r.contamination.score, true),
  );
  if (!r.gitAvailable) {
    lines.push(pc.dim('  locality: n/a — not a git repository (or no commits in window)'));
  }
  lines.push('');
  lines.push(pc.dim('  ' + bar));

  // Module table
  lines.push('');
  lines.push(pc.bold('  Modules') + pc.dim('  (sorted by depth, worst first)'));
  lines.push(pc.dim('  ' + pad('module', 26) + pad('depth', 16) + pad('seams', 14) + pad('leverage', 16) + 'callers'));
  for (const m of r.modules.slice(0, 14)) {
    lines.push(
      '  ' +
      pad(truncate(m.name, 24), 26) +
      metricCell(m.depth, 16) +
      metricCell(m.seams, 14) +
      metricCell(m.leverage, 16) +
      pc.dim(String(m.callerCount)),
    );
  }
  if (r.modules.length > 14) lines.push(pc.dim(`  … ${r.modules.length - 14} more (see --json)`));

  // Contamination
  lines.push('');
  lines.push(pc.dim('  ' + bar));
  lines.push('');
  const c = r.contamination;
  lines.push(`  ${pc.bold('Contamination')}  ${contamColor(c.score)(pc.bold(String(c.score)))}${pc.dim('/100 · lower is better')}  ${badge(c.label, 100 - c.score)}`);
  for (const f of c.findings.slice(0, 5)) {
    const tag = f.kind === 'clone' ? pc.red('CLONE') : f.kind === 'signature' ? pc.yellow('SIG  ') : pc.yellow('NAME ');
    const verdict = f.aiVerdict === 'confirmed' ? pc.green(' ✓AI') : f.confidence < 80 ? pc.dim(' unconfirmed') : '';
    lines.push(
      `   ${tag} ${pc.dim(`${f.confidence}%`)} ${f.a.file}:${f.a.line} ${pc.bold(f.a.name)} ${pc.dim('≈')} ${f.b.file}:${f.b.line} ${pc.bold(f.b.name)} ${pc.dim(`[${f.signals.join('+')}]`)}${verdict}`,
    );
  }
  if (c.findings.length === 0) lines.push(pc.dim('   no cross-module duplicate logic detected'));

  // Ownership / knowledge risk
  const risky = r.modules.filter((m) => m.ownership.risk.score !== null && m.ownership.risk.score < 40);
  if (risky.length) {
    lines.push('');
    lines.push(pc.bold('  Knowledge risk') + pc.dim('  (modules few people know)'));
    for (const m of risky.slice(0, 5)) {
      const owner = m.ownership.owner ? `owner ${pc.bold(m.ownership.owner)}` : 'no clear owner';
      lines.push(
        '  ' +
        pad(truncate(m.name, 24), 26) +
        metricCell(m.ownership.risk, 16) +
        pc.dim(`${owner} · ${m.ownership.risk.detail}`),
      );
    }
    if (risky.length > 5) lines.push(pc.dim(`   … ${risky.length - 5} more (see --json)`));
  }

  // Opportunities
  if (r.opportunities.length) {
    lines.push('');
    lines.push(pc.bold('  Top deepening opportunities'));
    r.opportunities.forEach((o, i) => lines.push(pc.dim(`   ${i + 1}. `) + o));
  }

  lines.push('');
  lines.push(pc.dim(`  deterministic scan · zero LLM calls · ${r.scannedAt}`));
  lines.push('');
  return lines.join('\n');
}

function meter(score: number): string {
  const filled = Math.round((score / 100) * 40);
  return scoreColor(score)('█'.repeat(filled)) + pc.dim('░'.repeat(40 - filled)) + pc.dim(` ${score}%`);
}

function cell(label: string, value: number | null, rawContam?: number, contam = false): string {
  const v = value === null ? pc.dim('n/a') : scoreColor(value)(pc.bold(String(contam ? rawContam : value)));
  return pad(`${pc.dim(label)} ${v}`, 24 + colorPad(value));
}

function metricCell(m: MetricScore, width: number): string {
  if (m.score === null) return pad(pc.dim('n/a'), width + 10);
  const s = scoreColor(m.score)(String(m.score).padStart(3));
  return pad(`${s} ${pc.dim(m.label)}`, width + 10);
}

function scoreColor(s: number): (x: string) => string {
  if (s >= 80) return pc.green;
  if (s >= 60) return pc.cyan;
  if (s >= 40) return pc.yellow;
  return pc.red;
}

function contamColor(s: number): (x: string) => string {
  return scoreColor(100 - s);
}

function badge(label: string, goodness: number): string {
  return scoreColor(goodness)(`[${label}]`);
}

function pad(s: string, w: number): string {
  const visible = s.replace(/\[[0-9;]*m/g, '');
  return s + ' '.repeat(Math.max(0, w - visible.length));
}

function colorPad(v: number | null): number {
  return v === null ? 0 : 10;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}
