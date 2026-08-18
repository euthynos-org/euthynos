#!/usr/bin/env node
// ============================================================================
// SUPERSEDED - DO NOT RUN, DO NOT QUOTE.
//
// This file calls itself "the ONE instrument behind any latency number we
// state". 8 of its 13 invocations are malformed against the live schema, and
// one names a tool that does not exist:
//
//   find_symbol/read_function/callers_of/callees_of/find_references/
//   tests_for/context_bundle   all passed { name: ... }; the schemas require
//                              query / function / function / function /
//                              symbol / target / target respectively
//   similar_code               not in the registry (the real tool is
//                              similar_logic_exists)
//
// Unchecked isError means every one of those would have been timed as a
// result. No artifact from this script was ever published - a search of the
// docs, site, feed and release notes found zero references - so it invalidated
// no shipped claim. It is disabled to keep it that way.
//
// Kept for provenance only. See ../docs/BENCHMARK-INTEGRITY-AUDIT.md.
// ============================================================================

/**
 * Latency lock — the ONE instrument behind any latency number we state.
 *
 * Measures warm per-tool latency of the MCP tool layer against a pinned
 * repository, in-process (library call, grammars preloaded exactly like the
 * server), and writes a JSON artifact stamped with the engine build and the
 * subject commit. Reporting rules, fixed here so they cannot drift per
 * session:
 *
 *  - COLD (first call, includes scan/index build) is reported separately
 *    from WARM (steady-state) — never blended into one number;
 *  - warm statistic is the MEDIAN with p95 alongside; means are not
 *    reported (one GC pause would own the average);
 *  - the artifact records machine facts (platform, node version) because a
 *    latency number without its machine is not a claim, it is an anecdote;
 *  - CI ceilings live in test/tool-metrics (per-tool budgets on the
 *    fixture); this script is the RECORDED measurement on a real subject.
 *
 * Usage:
 *   node scripts/latency-bench.mjs --repo <subjectRoot> [--reps 30] [--out <file.json>]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1];
};
const repo = resolve(flag('--repo') ?? 'D:/euthynos-experiments/subjects/hono');
const reps = Number(flag('--reps') ?? 30);
const outFile = flag('--out');

const { callTool } = await import(`file://${join(here, '..', 'dist', 'mcp', 'tools.js').replaceAll('\\', '/')}`);
const { loadLanguages } = await import(`file://${join(here, '..', 'dist', 'parse', 'treesitter', 'loader.js').replaceAll('\\', '/')}`);
const { TREE_SITTER_LANGS } = await import(`file://${join(here, '..', 'dist', 'parse', 'dispatch.js').replaceAll('\\', '/')}`);
await loadLanguages([...TREE_SITTER_LANGS]);

const buildInfoPath = join(here, '..', 'dist', 'build-info.json');
const buildInfo = existsSync(buildInfoPath) ? JSON.parse(readFileSync(buildInfoPath, 'utf8')) : null;
const subjectCommit = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

// Fixed, deterministic call list — the read/navigation path the M2
// token/recall benchmark leans on (repo_map, symbol lookup, callers/callees,
// references, tests, context_bundle) plus the post-edit review tools
// (boundary_check, check_my_changes). Arguments are pinned to real hono
// symbols so every future run measures the same work.
const CALLS = [
  ['repo_map', { path: repo }],
  ['find_symbol', { path: repo, name: 'compose' }],
  ['read_function', { path: repo, name: 'compose' }],
  ['callers_of', { path: repo, name: 'compose' }],
  ['callees_of', { path: repo, name: 'compose' }],
  ['find_references', { path: repo, name: 'compose' }],
  ['dependencies_of', { path: repo, module: 'middleware' }],
  ['dependents_of', { path: repo, module: 'utils' }],
  ['tests_for', { path: repo, name: 'serialize' }],
  ['similar_code', { path: repo, name: 'serveStatic' }],
  ['context_bundle', { path: repo, name: 'serialize' }],
  ['boundary_check', { path: repo }],
  ['check_my_changes', { path: repo }],
];

function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const at = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return { medianMs: Math.round(at(0.5) * 10) / 10, p95Ms: Math.round(at(0.95) * 10) / 10, maxMs: Math.round(s[s.length - 1] * 10) / 10 };
}

const results = [];
// Cold: the first tool call pays scan + index build for the subject.
{
  const t0 = performance.now();
  callTool('repo_map', { path: repo });
  results.push({ tool: 'repo_map (COLD: includes scan/index build)', coldMs: Math.round(performance.now() - t0) });
}
for (const [tool, args] of CALLS) {
  callTool(tool, args); // warmup, excluded
  const samples = [];
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now();
    callTool(tool, args);
    samples.push(performance.now() - t0);
  }
  results.push({ tool, args: Object.fromEntries(Object.entries(args).filter(([k]) => k !== 'path')), reps, ...stats(samples) });
}

const artifact = {
  instrument: 'latency-bench.mjs',
  statistic: 'median (p95 alongside); warm in-process library calls; cold reported separately',
  engine: buildInfo,
  subject: { repo, commit: subjectCommit },
  machine: { platform: process.platform, arch: process.arch, node: process.version },
  measuredAt: new Date().toISOString(),
  results,
};

console.log(`engine ${buildInfo?.commit ?? '?'} · subject ${subjectCommit.slice(0, 8)} · ${reps} reps/tool (warm, in-process)`);
for (const r of results) {
  if (r.coldMs !== undefined) {
    console.log(`${r.tool.padEnd(46)} ${String(r.coldMs).padStart(7)} ms`);
  } else {
    console.log(`${r.tool.padEnd(46)} median ${String(r.medianMs).padStart(7)} ms · p95 ${String(r.p95Ms).padStart(7)} ms · max ${String(r.maxMs).padStart(7)} ms`);
  }
}
if (outFile) {
  writeFileSync(resolve(outFile), JSON.stringify(artifact, null, 1));
  console.log(`artifact -> ${resolve(outFile)}`);
}
