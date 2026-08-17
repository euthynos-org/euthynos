// ============================================================================
// SUPERSEDED - DO NOT RUN, DO NOT QUOTE. Replaced by measure-latency.mjs.
//
// Its ARGUMENTS are valid (all 9 invocations check out against the live
// schema), so the calls it timed were real calls. Two defects void the output
// anyway:
//
//   1. It performs NO filesystem mutation. Every row it produced was a
//      repeated warm call, yet SUPPORTED-SCALE.md labelled those rows
//      "after edit" and stated the tables "re-edit a file before every call
//      on purpose". Git history confirms this file never contained a write.
//   2. `at(0.95)` on 9 samples resolves to a[8] - the MAXIMUM. The column
//      published as "p95" is a max. It also ran REPS = 9 while every
//      published document said 7 repetitions.
//
// Kept for provenance only. See BENCHMARK-INTEGRITY-AUDIT.md.
// ============================================================================

// G5 acceptance harness: END-TO-END tool latency (median + p95) at three
// repository scales. Read-only; drives the shipped dist exactly as the MCP
// server does (callTool opens its own request scope).
//
//   node --expose-gc scripts/measurement/measure-tools.mjs [label]
import { rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const E = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist')).href;
const { loadLanguages } = await import(`${E}/parse/treesitter/loader.js`);
const { TREE_SITTER_LANGS } = await import(`${E}/parse/dispatch.js`);
const { callTool } = await import(`${E}/mcp/tools.js`);
await loadLanguages([...TREE_SITTER_LANGS]);

const LABEL = process.argv[2] ?? 'run';
const BASE = process.env.EUTHYNOS_SCALE_FIXTURES
  ?? join(process.env.TEMP ?? '/tmp', 'euthynos-scale-fixtures');
const SCALES = [1500, 5000, 10000];
const REPS = 9;

const TOOLS = (root) => [
  ['repo_map', { path: root }],
  ['callers_of', { path: root, function: 'helper7' }],
  ['callees_of', { path: root, function: 'orchestrate7' }],
  ['impact_of', { path: root, function: 'helper7' }],
  ['path_between', { path: root, from: 'orchestrate7', to: 'helper7' }],
  ['boundary_check', { path: root }],
  ['check_my_changes', { path: root }],
  ['change_impact', { path: root }],
  ['diff_context', { path: root }],
];

const stat = (s) => {
  const a = [...s].sort((x, y) => x - y);
  const at = (q) => a[Math.min(a.length - 1, Math.floor(q * a.length))];
  return { median: Math.round(at(0.5) * 10) / 10, p95: Math.round(at(0.95) * 10) / 10 };
};
const mb = (b) => Math.round((b / 1024 / 1024) * 10) / 10;

const out = {};
for (const n of SCALES) {
  const root = join(BASE, `repo-${n}`);
  rmSync(join(root, '.euthynos'), { recursive: true, force: true });
  if (global.gc) global.gc();

  const c0 = performance.now();
  callTool('repo_map', { path: root });
  const coldMs = Math.round(performance.now() - c0);

  const rows = {};
  for (const [tool, args] of TOOLS(root)) {
    callTool(tool, args); // warm
    const s = [];
    for (let i = 0; i < REPS; i++) {
      const a = performance.now();
      callTool(tool, args);
      s.push(performance.now() - a);
    }
    rows[tool] = stat(s);
  }
  out[n] = { coldMs, rows, rssMB: mb(process.memoryUsage().rss) };
}

console.log(`\n=== ${LABEL} — end-to-end tool latency (median / p95 ms, ${REPS} reps) ===`);
const names = TOOLS('x').map(([t]) => t);
console.log('tool'.padEnd(18) + SCALES.map((n) => `${n} files`.padStart(20)).join(''));
for (const t of names) {
  let line = t.padEnd(18);
  for (const n of SCALES) {
    const r = out[n].rows[t];
    line += `${r.median} / ${r.p95}`.padStart(20);
  }
  console.log(line);
}
console.log('\ncold build  ' + SCALES.map((n) => `${n}: ${out[n].coldMs}ms`).join(' · '));
console.log('rss         ' + SCALES.map((n) => `${n}: ${out[n].rssMB}MB`).join(' · '));
console.log('\nover the 400ms warm ceiling (median):');
for (const n of SCALES) {
  const over = names.filter((t) => out[n].rows[t].median > 400);
  console.log(`  ${String(n).padStart(6)} files: ${over.length ? over.map((t) => `${t}=${out[n].rows[t].median}ms`).join(', ') : 'none — all within budget'}`);
}
console.log('\nJSON ' + JSON.stringify({ label: LABEL, out }));
