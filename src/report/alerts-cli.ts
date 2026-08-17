import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { scan } from '../scan.js';
import { loadLanguages } from '../parse/treesitter/loader.js';
import { TREE_SITTER_LANGS } from '../parse/dispatch.js';
import { diffReports, type AlertOptions } from '../alerts/diff.js';
import { renderAlertsMarkdown, renderAlertsTerminal } from '../alerts/render.js';
import type { ScanReport } from '../types.js';

/**
 * `euthynos alerts [path]` — diff two scans into routed regression alerts.
 *   --base <report.json>   the prior scan to diff against (required)
 *   --head <report.json>   diff a stored head instead of scanning [path]
 *   --json <file>          write the events array (Slack/webhook payload shape)
 *   --md <file>            write the markdown delivery surface
 *   --min-drop <n>         composite-health drop that fires (default 3)
 *   --min-metric-drop <n>  per-module metric drop that fires (default 10)
 *   --months <n>           git history window when scanning
 *   --quiet                suppress the terminal summary
 * Observe-first: always exits 0 — alerts inform, the policy gate enforces.
 */
export async function runAlerts(rest: string[]): Promise<void> {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith('--')) {
      const next = rest[i + 1];
      if (next && !next.startsWith('--')) { flags.set(a.slice(2), next); i++; }
      else flags.set(a.slice(2), 'true');
    } else positional.push(a);
  }

  const baseFile = flags.get('base');
  if (!baseFile || baseFile === 'true') {
    throw new Error('alerts needs --base <report.json> — the prior scan to diff against');
  }
  const base = JSON.parse(readFileSync(baseFile, 'utf8')) as ScanReport;

  const head = await loadHead(flags, positional);

  const opts: AlertOptions = {
    minHealthDrop: numFlag(flags, 'min-drop'),
    minMetricDrop: numFlag(flags, 'min-metric-drop'),
  };
  const events = diffReports(base, head, opts);

  if (!flags.has('quiet')) console.log(renderAlertsTerminal(events, head));

  const json = flags.get('json');
  if (json && json !== 'true') {
    writeFileSync(json, JSON.stringify(events, null, 2) + '\n');
    console.log(`  json → ${json}`);
  }
  const md = flags.get('md');
  if (md && md !== 'true') {
    writeFileSync(md, renderAlertsMarkdown(events, head));
    console.log(`  md → ${md}`);
  }
}

async function loadHead(flags: Map<string, string>, positional: string[]): Promise<ScanReport> {
  const headFile = flags.get('head');
  if (headFile && headFile !== 'true') {
    return JSON.parse(readFileSync(headFile, 'utf8')) as ScanReport;
  }
  const root = resolve(positional[0] ?? process.cwd());
  const months = Number(flags.get('months') ?? 6);
  await loadLanguages([...TREE_SITTER_LANGS]);
  return scan(root, { months });
}

const numFlag = (flags: Map<string, string>, name: string): number | undefined => {
  const v = flags.get(name);
  return v && v !== 'true' ? Number(v) : undefined;
};
