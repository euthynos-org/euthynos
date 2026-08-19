#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { scan } from './scan.js';
import { renderTerminal } from './report/terminal.js';
import { renderMarkdown } from './report/markdown.js';
import { startMcpServer } from './mcp/server.js';
import { runGraph } from './report/graph-cli.js';
import { runDashboard } from './report/dashboard.js';
import { runPolicy } from './report/policy-cli.js';
import { runAlerts } from './report/alerts-cli.js';
import { loadLanguages } from './parse/treesitter/loader.js';
import { TREE_SITTER_LANGS } from './parse/dispatch.js';

const args = process.argv.slice(2);
const cmd = args[0];

if (cmd === 'mcp') {
  // MCP stdio server: stdout is the protocol channel — nothing else may
  // write to it, so this branch must never reach the scan path below.
  startMcpServer().catch((e: unknown) => {
    process.stderr.write((e instanceof Error ? e.message : String(e)) + '\n');
    process.exit(1);
  });
} else if (cmd === 'scan') {
  runScan(args.slice(1)).catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
} else if (cmd === 'graph') {
  runGraph(args.slice(1)).catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
} else if (cmd === 'index') {
  runIndexCommand(args.slice(1)).catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
} else if (cmd === 'dashboard') {
  runDashboard(args.slice(1)).catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
} else if (cmd === 'policy') {
  runPolicy(args.slice(1)).catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
} else if (cmd === 'alerts') {
  runAlerts(args.slice(1)).catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
} else {
  console.log(`euthynos — architecture intelligence

Usage:
  euthynos scan [path]            scan a repo (default: cwd)
    --json <file>                   also write the full report as JSON
    --md <file>                     also write the PR-comment markdown
    --months <n>                    git history window (default: 6)
    --ignore <globs>                comma-separated ignore globs (vendored/generated code)
  euthynos index [path]           build / inspect the local .euthynos index
    --status                        report index state without changing it
    --rebuild                       discard and rebuild from source
    --ai                            confirm uncertain duplicate findings via
                                    Claude (needs ANTHROPIC_API_KEY; cascade
                                    step 5 — everything else stays LLM-free)
    --quiet                         suppress terminal report
  euthynos graph [path]           build the code knowledge graph
    --impact <fn>                   blast radius of a function (who breaks)
    --callers <fn>                  transitive callers of a function
    --calls <fn>                    transitive callees of a function
    --path <a..b>                   shortest call path between two functions
    --metrics                       attach module metrics to graph nodes
    --json <file>                   write the portable graph artifact
  euthynos dashboard [path]       write a self-contained interactive HTML
                                    dashboard (metric-aware knowledge graph)
    --out <file>                    output path (default .euthynos/dashboard.html)
  euthynos policy [path]          enforce an architecture policy (budgets/gate)
    --policy <file.json>            rules to enforce (default: the built-in
                                    ratchet policy — freeze today, flag regressions)
    --base <report.json>            prior scan to diff delta rules against (PR base)
    --head <report.json>            gate a stored head instead of scanning [path]
    --block                         treat the built-in ratchet rules as blocking
                                    (they are warn-only by default: observe first)
    --strict                        exit 1 on a block-mode violation. With the
                                    built-in policy this needs --block as well,
                                    or nothing can ever fail. A CI gate is:
                                      policy --block --base prior.json --strict
                                    or: policy --policy rules.json --strict
                                    with "defaultMode":"block" in the file.
    --json <file>                   write the PolicyResult (worker decision input)
    --md <file>                     write the PR-comment markdown
  euthynos alerts [path]          diff two scans into routed regression alerts
    --base <report.json>            prior scan to diff against (required)
    --head <report.json>            diff a stored head instead of scanning [path]
    --json <file>                   write the events array (webhook payload shape)
    --md <file>                     write the markdown delivery surface
    --min-drop <n>                  composite drop that fires (default 3)
  euthynos mcp                    start the MCP stdio server (23 read-only
                                    tools: callers/callees and dependency
                                    edges, blast radius and diff review,
                                    exact source spans, repo orientation,
                                    near-duplicate and test discovery)
`);
  process.exit(cmd ? 1 : 0);
}

async function runScan(rest: string[]): Promise<void> {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith('--')) {
      const next = rest[i + 1];
      if (next && !next.startsWith('--')) {
        flags.set(a.slice(2), next);
        i++;
      } else {
        flags.set(a.slice(2), 'true');
      }
    } else {
      positional.push(a);
    }
  }

  const root = positional[0] ?? process.cwd();
  const months = Number(flags.get('months') ?? 6);
  const ignore = (flags.get('ignore') ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0);

  await loadLanguages([...TREE_SITTER_LANGS]);
  const started = Date.now();
  const report = scan(root, { months, ignore });

  if (flags.has('ai')) {
    if (!process.env['ANTHROPIC_API_KEY']) {
      console.error('  --ai skipped: ANTHROPIC_API_KEY is not set');
    } else if (report.contamination.findings.length > 0) {
      const { confirmFindings } = await import('./ai/confirm.js');
      const { contaminationScore, contaminationLabel } = await import('./metrics/contamination.js');
      const res = await confirmFindings(report.contamination.findings, root);
      report.contamination.findings = res.findings;
      report.contamination.score = contaminationScore(res.findings, report.contamination.violations);
      report.contamination.label = contaminationLabel(report.contamination.score);
      console.error(`  ai: ${res.confirmed} confirmed · ${res.refuted} refuted · ${res.skipped} skipped`);
    }
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  if (!flags.has('quiet')) {
    console.log(renderTerminal(report));
    console.log(`  scanned in ${elapsed}s\n`);
  }

  const jsonOut = flags.get('json');
  if (jsonOut && jsonOut !== 'true') {
    writeFileSync(jsonOut, JSON.stringify(report, jsonReplacer, 2));
    console.log(`  json  → ${jsonOut}`);
  }
  const mdOut = flags.get('md');
  if (mdOut && mdOut !== 'true') {
    writeFileSync(mdOut, renderMarkdown(report));
    console.log(`  md    → ${mdOut}`);
  }
}

/**
 * `euthynos index [path] [--status] [--rebuild]` — build or inspect the
 * local index. Exists so the cache is never a black box: a developer can see
 * what it holds, how fresh it is, and rebuild it without deleting files by hand.
 */
async function runIndexCommand(rest: string[]): Promise<void> {
  const positional = rest.filter((a) => !a.startsWith('--'));
  const flags = new Set(rest.filter((a) => a.startsWith('--')).map((a) => a.slice(2)));
  const root = resolve(positional[0] ?? process.cwd());

  const { getIndex, flushIndex, resetIndex, ENGINE_VERSION } = await import('./index/incremental.js');
  const { clearIndex, indexSizeBytes, INDEX_SCHEMA_VERSION } = await import('./index/store.js');

  if (flags.has('rebuild')) {
    clearIndex(root);
    resetIndex(root);
    console.log('  cleared existing index');
  }

  await loadLanguages([...TREE_SITTER_LANGS]);
  const started = Date.now();
  const idx = getIndex(root);
  const elapsed = Date.now() - started;
  if (!flags.has('status')) flushIndex(root);

  console.log(`  index    ${root}`);
  console.log(`  schema   v${INDEX_SCHEMA_VERSION} · engine ${ENGINE_VERSION}`);
  console.log(`  files    ${idx.stats.fileCount} indexed${idx.stats.skipped > 0 ? ` · ${idx.stats.skipped} unparseable (absent from every answer)` : ''}`);
  console.log(`  source   ${idx.stats.loadedFromDisk ? `${idx.stats.rehydrated} rehydrated from disk` : 'built from source'} · ${idx.stats.reparsed} parsed this run`);
  console.log(`  timing   ${elapsed}ms`);
  console.log(`  on disk  ${(indexSizeBytes(root) / 1024).toFixed(0)}KB in .euthynos/`);
}

// Exit code is governance Layer 1: observe, don't block. Always 0 on success.
function jsonReplacer(_k: string, v: unknown): unknown {
  return v instanceof Set ? [...v] : v instanceof Map ? Object.fromEntries(v) : v;
}
