import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan } from '../scan.js';
import { loadLanguages } from '../parse/treesitter/loader.js';
import { TREE_SITTER_LANGS } from '../parse/dispatch.js';
import { evaluatePolicy, ratchetPolicy, validatePolicy, type Policy } from '../policy/evaluate.js';
import { renderDiffScopeMarkdown, renderDiffScopeTerminal, scopeToDiff, type DiffScope } from '../policy/diff.js';
import { sarifText, toSarif } from '../policy/sarif.js';
import { checkRunText, toCheckRun } from '../policy/checkrun.js';
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
 *   --sarif <file>         write SARIF 2.1.0 — GitHub Code Scanning ingests it (Security
 *                          tab + inline annotations); alerts carry line-stable fingerprints
 *   --check-run <file>     write a GitHub Check Run payload (name, conclusion, annotations).
 *                          The conclusion mirrors the exit code below, so branch protection
 *                          and the terminal can never disagree.
 *   --months <n>           git history window
 *   --quiet                suppress the terminal summary
 *   --scope repo|diff      repo (default): any block-mode violation can fail the build.
 *                          diff: only violations this change INTRODUCED (absent from
 *                          --base) can fail it; pre-existing ones are reported, never
 *                          punished. Needs --base; without one it degrades to observe
 *                          and says so — it never silently passes.
 * Exit codes are a contract (CI reads them):
 *   0  passed, or observe mode
 *   1  blocked — only with --strict AND a block-mode violation
 *   2  config error (malformed policy) — never confusable with a verdict
 */
/** Flags that never take a value. Listed so they cannot swallow the path that follows them. */
const BOOLEAN_FLAGS: ReadonlySet<string> = new Set(['strict', 'quiet', 'block', 'ratchet']);

/**
 * Split argv into flags and positionals. A boolean flag MUST NOT consume the
 * next token: `policy --strict some/repo` used to take `some/repo` as the
 * value of --strict and then scan the current directory instead — a gate
 * that silently measures the wrong tree and reports on it as if it were the
 * right one. Exported so the contract is pinned by a test.
 */
export function parsePolicyArgs(rest: string[]): { positional: string[]; flags: Map<string, string> } {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith('--')) {
      const name = a.slice(2);
      const next = rest[i + 1];
      if (!BOOLEAN_FLAGS.has(name) && next && !next.startsWith('--')) { flags.set(name, next); i++; }
      else flags.set(name, 'true');
    } else positional.push(a);
  }
  return { positional, flags };
}

export async function runPolicy(rest: string[]): Promise<void> {
  const { positional, flags } = parsePolicyArgs(rest);

  const root = resolve(positional[0] ?? process.cwd());
  const policy = loadPolicy(flags, root);
  const base = loadBase(flags.get('base'));
  const report = await loadHead(flags, positional);
  const result = evaluatePolicy(policy, report, base);

  if (!flags.has('quiet')) console.log(renderPolicyTerminal(result, report));

  // Defensive: loadPolicy already fails fast on a malformed file; this catches
  // a policy that reached the evaluator by another route. Exit 2, not 1.
  if (result.invalidRules.length > 0) process.exit(2);

  // --scope diff: "only what this change made worse". A missing base cannot
  // attribute anything, so it degrades to observe and SAYS so.
  const scope = flags.get('scope') ?? 'repo';
  if (scope !== 'repo' && scope !== 'diff') {
    console.error(`  --scope must be "repo" or "diff" (got "${scope}")`);
    process.exit(2);
  }
  let diff: DiffScope | null = null;
  let diffCaveat: string | null = null;
  if (scope === 'diff') {
    if (!base) {
      diffCaveat = 'diff scope needs --base <report.json> to tell introduced from pre-existing; no base was given, so nothing blocks (observe).';
      if (!flags.has('quiet')) console.log(`  ${diffCaveat}\n`);
    } else {
      // The base is evaluated on its own (delta rules skip there — they are
      // already "vs base"), so localized and per-module findings present in
      // both sides read as pre-existing.
      diff = scopeToDiff(result, evaluatePolicy(policy, base));
      if (!flags.has('quiet')) console.log(renderDiffScopeTerminal(diff));
    }
  }

  const json = flags.get('json');
  if (json && json !== 'true') {
    const payload = scope === 'diff' ? { ...result, scope, diff, ...(diffCaveat ? { diffCaveat } : {}) } : result;
    writeFileSync(json, JSON.stringify(payload, null, 2) + '\n');
    console.log(`  json → ${json}`);
  }
  const md = flags.get('md');
  if (md && md !== 'true') {
    let out = renderPolicyMarkdown(result, report);
    if (diff) out += renderDiffScopeMarkdown(diff);
    else if (diffCaveat) out += `\n<sub>${diffCaveat}</sub>\n`;
    writeFileSync(md, out);
    console.log(`  md → ${md}`);
  }
  const sarif = flags.get('sarif');
  if (sarif && sarif !== 'true') {
    writeFileSync(sarif, sarifText(toSarif(result, report, { version: readPkgVersion(), diff })));
    console.log(`  sarif → ${sarif}`);
  }
  const checkRun = flags.get('check-run');
  if (checkRun && checkRun !== 'true') {
    writeFileSync(checkRun, checkRunText(toCheckRun(result, report, { scope: scope as 'repo' | 'diff', diff, strict: flags.has('strict') })));
    console.log(`  check-run → ${checkRun}`);
  }

  // Observe-first governance: only a deliberate --strict gate fails the build —
  // on the whole repo in repo scope, on INTRODUCED violations only in diff scope.
  const wouldBlock = scope === 'diff' ? (diff?.blocked ?? false) : result.blocked;
  if (flags.has('strict') && wouldBlock) process.exit(1);
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

/**
 * The repository's policy-as-code file, at the ROOT. Not inside `.euthynos/`:
 * that directory is the local index and gitignores itself entirely, so a
 * policy placed there would never be committed and never reach CI — the gate
 * would silently fall back to the built-in ratchet. The Action defaults to
 * the same name, so a local verdict and the CI verdict read one file.
 */
export const POLICY_FILE = 'euthynos.policy.json';

export type PolicySource = { kind: 'file'; path: string; discovered: boolean } | { kind: 'ratchet' };

/**
 * Which policy applies, in precedence order: an explicit --policy file; --ratchet;
 * the repository's own `euthynos.policy.json` when present; else the built-in
 * ratchet. Pure, so the precedence is pinned by a test.
 */
export function resolvePolicySource(flags: Map<string, string>, root: string): PolicySource {
  const file = flags.get('policy');
  if (file && file !== 'true') return { kind: 'file', path: file, discovered: false };
  if (flags.has('ratchet')) return { kind: 'ratchet' };
  const discovered = join(root, POLICY_FILE);
  if (existsSync(discovered)) return { kind: 'file', path: discovered, discovered: true };
  return { kind: 'ratchet' };
}

function loadPolicy(flags: Map<string, string>, root: string): Policy {
  const source = resolvePolicySource(flags, root);
  if (source.kind === 'ratchet') {
    // The freeze-today starter policy.
    return ratchetPolicy(flags.has('block') ? 'block' : 'warn');
  }
  const raw = JSON.parse(readFileSync(source.path, 'utf8')) as Policy;
  if (!raw || !Array.isArray(raw.rules)) throw new Error(`policy file ${source.path} has no "rules" array`);
  // Fail fast, before any scan runs, naming the file. Exit 2 = config
  // error: a typo in a block-mode rule must never exit 1 (looks like a
  // block) or 0 (looks like a pass).
  const invalid = validatePolicy(raw);
  if (invalid.length > 0) {
    console.error(`  policy ${source.path}: ${invalid.length} invalid rule(s)`);
    for (const r of invalid) console.error(`    ${r.ruleId}: ${r.reason}`);
    process.exit(2);
  }
  if (source.discovered && !flags.has('quiet')) console.log(`  policy ← ${POLICY_FILE}`);
  return raw;
}

function loadBase(file: string | undefined): ScanReport | undefined {
  if (!file || file === 'true') return undefined;
  return JSON.parse(readFileSync(file, 'utf8')) as ScanReport;
}

/** Version from package.json — never a second hardcoded copy (mirrors src/mcp/server.ts). */
function readPkgVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
