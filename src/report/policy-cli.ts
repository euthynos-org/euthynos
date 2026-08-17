import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { scan } from '../scan.js';
import { loadLanguages } from '../parse/treesitter/loader.js';
import { TREE_SITTER_LANGS } from '../parse/dispatch.js';
import { evaluatePolicy, ratchetPolicy, type Policy } from '../policy/evaluate.js';
import { renderPolicyMarkdown, renderPolicyTerminal } from '../policy/render.js';
import type { ScanReport } from '../types.js';

/**
 * `euthynos policy [path]` — evaluate an architecture policy against a scan.
 *   --policy <file.json>   the policy (rules) to enforce
 *   --ratchet              use the built-in ratchet policy (freeze today, fail on regressions)
 *   --base <report.json>   a prior scan to diff delta rules against (PR base branch)
 *   --head <report.json>   evaluate a stored head instead of scanning [path]
 *                          (the SaaS worker path: scan once, gate from the JSON)
 *   --block                treat ratchet rules as blocking (default warn)
 *   --strict               exit 1 if any block-mode rule is violated (CI gate)
 *   --json <file>          write the PolicyResult (the worker's decision input)
 *   --md <file>            write the PR-comment markdown
 *   --months <n>           git history window
 *   --quiet                suppress the terminal summary
 * Observe-first: exits 0 unless --strict AND a block-mode violation occurred.
 */
export async function runPolicy(rest: string[]): Promise<void> {
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

  const policy = loadPolicy(flags);
  const base = loadBase(flags.get('base'));
  const report = await loadHead(flags, positional);
  const result = evaluatePolicy(policy, report, base);

  if (!flags.has('quiet')) console.log(renderPolicyTerminal(result, report));

  const json = flags.get('json');
  if (json && json !== 'true') {
    writeFileSync(json, JSON.stringify(result, null, 2) + '\n');
    console.log(`  json → ${json}`);
  }
  const md = flags.get('md');
  if (md && md !== 'true') {
    writeFileSync(md, renderPolicyMarkdown(result, report));
    console.log(`  md → ${md}`);
  }

  // Observe-first governance: only a deliberate --strict gate fails the build.
  if (flags.has('strict') && result.blocked) process.exit(1);
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

function loadPolicy(flags: Map<string, string>): Policy {
  const file = flags.get('policy');
  if (file && file !== 'true') {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Policy;
    if (!raw || !Array.isArray(raw.rules)) throw new Error(`policy file ${file} has no "rules" array`);
    return raw;
  }
  // Default / --ratchet: the freeze-today starter policy.
  return ratchetPolicy(flags.has('block') ? 'block' : 'warn');
}

function loadBase(file: string | undefined): ScanReport | undefined {
  if (!file || file === 'true') return undefined;
  return JSON.parse(readFileSync(file, 'utf8')) as ScanReport;
}
