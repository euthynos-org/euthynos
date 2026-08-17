// ============================================================================
// SUPERSEDED - DO NOT RUN, DO NOT QUOTE. Replaced by measure-latency.mjs.
//
// Two of its six invocations are malformed against the live schema:
//   find_symbol   { name: ... }  -> schema requires `query`
//   read_function { name: ... }  -> schema requires `function`
//
// The library returns { text, isError: true } for these and does NOT throw, so
// the harness timed an argument rejection (~1-2 ms) as though it were a read
// (~150-425 ms). That is the sole origin of the published claim that pure
// index reads "stay at <=0.3 ms at every scale". They do not: measured
// 142-425 ms across 1.5k-10k files, and the cost scales with repository size.
//
// find_references was never measured here at all, though the same sentence
// claimed a figure for it.
//
// Kept for provenance only. See BENCHMARK-INTEGRITY-AUDIT.md.
// ============================================================================

// Scale measurement against the SHIPPED engine (dist). Read-only: calls
// library tools exactly as the MCP server does. No engine code modified.
import { execFileSync } from 'node:child_process';
import { statSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const E = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist')).href;
const { loadLanguages } = await import(`${E}/parse/treesitter/loader.js`);
const { TREE_SITTER_LANGS } = await import(`${E}/parse/dispatch.js`);
const { callTool } = await import(`${E}/mcp/tools.js`);

const t0 = performance.now();
await loadLanguages([...TREE_SITTER_LANGS]);
const grammarMs = performance.now() - t0;
console.log(`grammar preload (once per process): ${Math.round(grammarMs)} ms\n`);

const BASE = process.env.EUTHYNOS_SCALE_FIXTURES
  ?? join(process.env.TEMP ?? '/tmp', 'euthynos-scale-fixtures');
const SCALES = [1500, 5000, 10000];

function dirBytes(d) {
  let total = 0;
  const walk = (p) => {
    for (const e of readdirSync(p, { withFileTypes: true })) {
      const full = join(p, e.name);
      if (e.isDirectory()) walk(full);
      else total += statSync(full).size;
    }
  };
  try { walk(d); } catch { /* absent */ }
  return total;
}

const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const mb = (b) => Math.round(b / 1024 / 1024 * 10) / 10;

const rows = [];
for (const n of SCALES) {
  const root = join(BASE, `repo-${n}`);
  // Cold: remove any prior index so we measure a true first build.
  rmSync(join(root, '.euthynos'), { recursive: true, force: true });
  if (global.gc) global.gc();
  const memBefore = process.memoryUsage().heapUsed;

  const c0 = performance.now();
  callTool('repo_map', { path: root });
  const coldMs = performance.now() - c0;

  const warm = {};
  for (const [tool, args] of [
    ['repo_map', { path: root }],
    ['find_symbol', { path: root, name: 'helper7' }],
    ['callers_of', { path: root, function: 'helper7' }],
    ['read_function', { path: root, name: 'orchestrate7' }],
    ['boundary_check', { path: root }],
    ['check_my_changes', { path: root }],
  ]) {
    callTool(tool, args); // warm
    const s = [];
    for (let i = 0; i < 5; i++) { const a = performance.now(); callTool(tool, args); s.push(performance.now() - a); }
    warm[tool] = Math.round(med(s) * 10) / 10;
  }

  const memAfter = process.memoryUsage().heapUsed;
  const idx = dirBytes(join(root, '.euthynos'));
  rows.push({ n, coldMs: Math.round(coldMs), warm, indexMB: mb(idx), heapDeltaMB: mb(memAfter - memBefore), rssMB: mb(process.memoryUsage().rss) });
  console.log(`${n} files: cold ${Math.round(coldMs)} ms · index ${mb(idx)} MB · heapΔ ${mb(memAfter - memBefore)} MB · rss ${mb(process.memoryUsage().rss)} MB`);
  console.log(`   warm: ${Object.entries(warm).map(([k, v]) => `${k} ${v}ms`).join(' · ')}\n`);
}

console.log('=== SUMMARY (400ms warm ceiling) ===');
for (const r of rows) {
  const over = Object.entries(r.warm).filter(([, v]) => v > 400);
  console.log(`${String(r.n).padStart(6)} files · cold ${String(r.coldMs).padStart(6)} ms · index ${String(r.indexMB).padStart(5)} MB · ${over.length ? 'OVER CEILING: ' + over.map(([k, v]) => `${k}=${v}ms`).join(', ') : 'all tools within 400ms'}`);
}
