import type { ScanReport } from '../types.js';

/**
 * PR comment body — the exact format promised on the landing page.
 * The GitHub Action posts the returned string verbatim, so what is assembled
 * here is what a reviewer sees: a score heading, one badge chip per metric,
 * then only the sections that have content — deepening opportunities, at most
 * three similar-logic findings, and modules whose ownership risk scores
 * below 40.
 */
export function renderMarkdown(r: ScanReport): string {
  const a = r.averages;
  const out: string[] = [];

  out.push(`### 📊 Architecture Review — **${r.health.score}/100** \`${r.health.label}\``);
  out.push('');
  out.push(
    [
      chip('Depth', a.depth),
      chip('Seams', a.seams),
      chip('Locality', a.locality),
      chip('Leverage', a.leverage),
      `![Contamination](https://img.shields.io/badge/Contamination-${r.contamination.score}-${r.contamination.score <= 30 ? 'green' : r.contamination.score <= 60 ? 'orange' : 'red'})`,
    ].join(' '),
  );
  out.push('');

  if (r.opportunities.length) {
    out.push(`#### ⚠️ ${r.opportunities.length} deepening opportunit${r.opportunities.length > 1 ? 'ies' : 'y'}`);
    out.push('');
    for (const o of r.opportunities) out.push(`- ${o}`);
    out.push('');
  }

  const top = r.contamination.findings.slice(0, 3);
  if (top.length) {
    out.push('#### 💡 Similar logic detected');
    out.push('');
    for (const f of top) {
      const how = f.kind === 'clone' ? 'structural clone' : f.kind === 'signature' ? 'signature match' : 'naming match';
      const verdict = f.aiVerdict === 'confirmed' ? ', AI-confirmed' : f.confidence < 80 ? ', unconfirmed' : '';
      out.push(
        `- \`${f.a.file}:${f.a.line}\` **${f.a.name}** matches \`${f.b.file}:${f.b.line}\` **${f.b.name}** (${f.confidence}%, ${how} via ${f.signals.join('+')}${verdict}). Import instead of duplicating.`,
      );
    }
    out.push('');
  }

  const risky = r.modules.filter((m) => m.ownership.risk.score !== null && m.ownership.risk.score < 40);
  if (risky.length) {
    out.push('#### 🚌 Knowledge risk');
    out.push('');
    for (const m of risky) {
      out.push(`- **${m.name}** — ${m.ownership.risk.detail}${m.ownership.owner ? ` · owner: ${m.ownership.owner}` : ''}`);
    }
    out.push('');
  }

  out.push('---');
  out.push(`<sub>Powered by Euthynos · deterministic scan, zero LLM calls · ${r.filesScanned} files</sub>`);
  return out.join('\n');
}

function chip(label: string, v: number | null): string {
  if (v === null) return `![${label}](https://img.shields.io/badge/${label}-n%2Fa-lightgrey)`;
  const color = v >= 80 ? 'brightgreen' : v >= 60 ? 'green' : v >= 40 ? 'orange' : 'red';
  return `![${label}](https://img.shields.io/badge/${label}-${v}-${color})`;
}
