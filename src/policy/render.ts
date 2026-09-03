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

  // Config errors first and loud: a verdict below a broken rule is not a verdict.
  if (result.invalidRules.length > 0) {
    L.push(`  ${pc.red(pc.bold(`✗ ${result.invalidRules.length} invalid rule(s) — policy config error`))}`);
    for (const r of result.invalidRules) L.push(`  ${pc.red('[config]')} ${pc.dim(r.ruleId)}  ${r.reason}`);
    L.push('');
  }

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
  if (result.skippedEdgeRules > 0) {
    L.push('');
    L.push(`  ${pc.dim(`${result.skippedEdgeRules} forbidden-dependency rule(s) skipped — report has no import edges (re-scan with this version)`)}`);
  }
  for (const c of caveats(result, report)) {
    L.push('');
    L.push(`  ${pc.dim(c)}`);
  }
  L.push('');
  return L.join('\n');
}

/**
 * What the verdict did NOT cover, stated plainly. Shared by both renderers so
 * the PR comment and the terminal never disagree about the evidence boundary.
 */
function caveats(result: PolicyResult, report: ScanReport): string[] {
  const out: string[] = [];
  for (const u of result.unmatchedGlobs) {
    const seen = report.modules.map((m) => m.name).slice(0, 8).join(', ');
    out.push(`rule ${u.ruleId}: "${u.side}: ${u.glob}" matches no module in this report — it cannot fire. Modules seen: ${seen}${report.modules.length > 8 ? ', …' : ''}.`);
  }
  if (result.partialCoverage) {
    const p = result.partialCoverage;
    const bits: string[] = [];
    if (p.skippedFiles > 0) bits.push(`${p.skippedFiles} file(s) failed to parse`);
    if (p.discoveryTruncated) bits.push('discovery hit the file cap');
    out.push(`${bits.join('; ')} — this verdict covers a partial tree.`);
  }
  if (result.skippedIncompleteRules > 0) {
    out.push(`${result.skippedIncompleteRules} no-new-duplication rule(s) skipped — the base scan lists only a capped subset of its duplicate pairs, so "new vs base" cannot be established; re-scan the base with this version.`);
  }
  if (result.duplicationHeadCapped) {
    out.push('the head scan lists a capped subset of its duplicate pairs; pairs beyond the cap were not judged for newness.');
  }
  if (result.singleModuleTree !== undefined) {
    out.push(`the whole tree scanned as one module ("${result.singleModuleTree}") — no cross-module import edges exist, so boundary rules and module-level deltas cannot fire. Point the scan at the project root (the directory that holds src/), not at a folder that holds the project.`);
  }
  if (result.edgeRulesEvaluated > 0) {
    const un = report.unresolvedImports;
    if (un && un.count > 0) {
      const sample = un.sample.slice(0, 3).map((s) => s.specifier).join(', ');
      out.push(`${un.count} import(s) could not be resolved to a local file and were not judged (e.g. ${sample}).`);
    }
    if ((report.externalImports ?? 0) > 0) {
      out.push(`${report.externalImports} package import(s) treated as external dependencies — workspace packages and path aliases are not resolved.`);
    }
  }
  return out;
}

function line(v: Violation): string {
  const tag = v.mode === 'block' ? pc.red('[block]') : pc.yellow('[warn] ');
  const head = `${tag} ${pc.dim(v.ruleId)}  ${v.message}`;
  // The fix, stated right under the finding — the part a reader acts on.
  return v.remedy ? `${head}\n           ${pc.dim('↳ ' + v.remedy.instruction)}` : head;
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

  if (result.invalidRules.length > 0) {
    lines.push(`❌ **${result.invalidRules.length} invalid rule(s) — policy config error**`);
    for (const r of result.invalidRules) lines.push(`- \`${r.ruleId}\`: ${escapeCell(r.reason)}`);
    lines.push('');
  }

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
      const fix = v.remedy ? `<br>↳ ${escapeCell(v.remedy.instruction)}` : '';
      lines.push(`| ${icon} | \`${v.ruleId}\` | ${escapeCell(v.message)}${fix} |`);
    }
  }
  if (result.skippedDeltaRules > 0) {
    lines.push('');
    lines.push(`<sub>${result.skippedDeltaRules} delta rule(s) skipped — no base scan to diff against.</sub>`);
  }
  if (result.skippedEdgeRules > 0) {
    lines.push('');
    lines.push(`<sub>${result.skippedEdgeRules} forbidden-dependency rule(s) skipped — the report carries no import edges; re-scan with this version.</sub>`);
  }
  for (const c of caveats(result, report)) {
    lines.push('');
    lines.push(`<sub>${escapeCell(c)}</sub>`);
  }
  lines.push('');
  lines.push(`<sub>Deterministic · observe-first · ${report.scannedAt}</sub>`);
  return lines.join('\n') + '\n';
}

/**
 * Make text safe INSIDE a GFM table cell: `|` would split the cell, a newline
 * would break the row — and `_`/`*` are still inline Markdown there, so a path
 * like `__init__.py` renders as bold "init.py", a file that does not exist.
 * Backslash-escaping them is honored by GitHub in cells.
 */
const escapeCell = (s: string): string =>
  s.replace(/\|/g, '\\|').replace(/\n/g, ' ').replace(/([_*])/g, '\\$1');
