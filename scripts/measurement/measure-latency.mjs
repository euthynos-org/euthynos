/**
 * Authoritative latency harness. Supersedes measure-tools.mjs and
 * measure-scale.mjs, both of which produced numbers that cannot be reproduced
 * from a valid operation (see BENCHMARK-INTEGRITY-AUDIT.md).
 *
 *   node --expose-gc scripts/measurement/measure-latency.mjs [--scales=1500,5000] [--reps=20]
 *
 * Integrity properties this harness holds, each of which the superseded
 * harnesses violated:
 *
 *   1. SCHEMA-CHECKED. Every planned invocation is validated against the live
 *      tool registry's inputSchema BEFORE anything runs. A misnamed argument
 *      aborts the run instead of silently timing an error return.
 *   2. FAIL-CLOSED. Every call asserts isError !== true and a non-empty result.
 *      A failed call throws; it never enters a timing sample.
 *   3. HONEST LABELS. cold / warm / edit-loop each correspond to what the code
 *      actually does. The edit loop performs a real filesystem mutation.
 *   4. MUTATION-VERIFIED. The edit loop proves the engine observed the edit by
 *      asserting the new symbol appears in the tool's own output, then restores
 *      the file and asserts the restored bytes hash to the original.
 *   5. DOCUMENTED STATISTICS. Nearest-rank percentile (no interpolation), the
 *      sample count is reported with every figure, and a percentile is only
 *      emitted when the sample size can express it distinctly from the maximum.
 *
 * Everything it prints carries its own n. Nothing here is quotable without it.
 */

import { readFileSync, writeFileSync, rmSync, existsSync, statSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');

/* The superseded harnesses hardcoded an absolute path through a machine-local
   junction, so they measured whatever that junction happened to point at and
   could not run on another machine at all. Resolve from this file instead. */
const DIST = join(REPO, 'dist');
if (!existsSync(join(DIST, 'mcp', 'tools.js'))) {
  throw new Error(`No build at ${DIST}. Run \`npm run build\` first.`);
}
const E = pathToFileURL(DIST).href;

const { loadLanguages } = await import(`${E}/parse/treesitter/loader.js`);
const { TREE_SITTER_LANGS } = await import(`${E}/parse/dispatch.js`);
const { callTool, TOOLS: REGISTRY } = await import(`${E}/mcp/tools.js`);
await loadLanguages([...TREE_SITTER_LANGS]);

// ------------------------------------------------------------------ options
const argv = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? 'true'];
  }),
);
const SCALES = (argv.scales ?? '1500,5000,10000').split(',').map(Number);
const REPS = Number(argv.reps ?? 20);
/* Fixture location. The default is machine-neutral; pass --base to point at an
   existing fixture set. Generate them with gen-scale-repos.mjs. */
const BASE = argv.base ?? process.env.EUTHYNOS_SCALE_FIXTURES ??
  join(process.env.TEMP ?? '/tmp', 'euthynos-scale-fixtures');

// -------------------------------------------------------------- statistics
/**
 * Nearest-rank percentile on a sorted ascending sample: the smallest value at
 * or below which at least p percent of observations fall. No interpolation, so
 * every reported figure is an observation that actually occurred.
 *
 * A percentile is only meaningful if its rank is distinct from n. At n=9,
 * ceil(0.95 * 9) = 9 — the maximum. Reporting that as "p95" is what the
 * superseded harness did. `percentileIsDistinct` refuses it instead.
 */
const nearestRank = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
const percentileIsDistinct = (n, p) => Math.ceil(p * n) < n;

function summarise(samples) {
  const a = [...samples].sort((x, y) => x - y);
  const n = a.length;
  const r1 = (v) => Math.round(v * 10) / 10;
  const out = {
    n,
    min: r1(a[0]),
    median: r1(nearestRank(a, 0.5)),
    max: r1(a[n - 1]),
    /* Every observation is retained. A future reader who disagrees with the
       choice of statistic can re-derive any other one from these without
       re-running, and can check that the summary above matches the samples.
       A summary whose raw data is gone has to be taken on trust, which is the
       position this audit exists to get out of. */
    samplesMs: a.map(r1),
  };
  if (percentileIsDistinct(n, 0.95)) {
    out.p95 = r1(nearestRank(a, 0.95));
    out.p95Rank = Math.ceil(0.95 * n);
  } else {
    // Say why, rather than emitting a max wearing a percentile's name.
    out.p95 = null;
    out.p95Note = `n=${n} too small: ceil(0.95*${n})=${Math.ceil(0.95 * n)} is the maximum`;
  }
  return out;
}

// ------------------------------------------------- schema-checked invocation
function schemaOf(tool) {
  const def = (REGISTRY ?? []).find((t) => t.name === tool);
  if (!def) throw new Error(`SCHEMA: tool '${tool}' is not in the live registry`);
  return def.inputSchema ?? def.input_schema ?? {};
}

/**
 * Validates a planned invocation against the live schema. Runs for every
 * invocation BEFORE any measurement, so a misnamed argument aborts the whole
 * run rather than contributing a fast error return to a timing table.
 */
function assertArgsValid(tool, args) {
  const schema = schemaOf(tool);
  const props = schema.properties ?? {};
  const required = schema.required ?? [];
  const known = Object.keys(props);

  const missing = required.filter((k) => !(k in args));
  if (missing.length) {
    throw new Error(
      `SCHEMA: ${tool} missing required argument(s): ${missing.join(', ')}. ` +
      `Schema requires [${required.join(', ')}]; got [${Object.keys(args).join(', ')}].`,
    );
  }
  const unknown = Object.keys(args).filter((k) => known.length && !known.includes(k));
  if (unknown.length) {
    throw new Error(
      `SCHEMA: ${tool} given unknown argument(s): ${unknown.join(', ')}. ` +
      `Schema accepts [${known.join(', ')}].`,
    );
  }
}

/**
 * Calls a tool and refuses to return anything that is not a real success.
 *
 * The library entry point returns `{ text }` on success and `{ text, isError:
 * true }` on failure — it does NOT throw, and it does not use the MCP wire
 * shape. So an unchecked caller receives a normal-looking object whose only
 * distinguishing feature is a flag it never reads. That is precisely how the
 * superseded harnesses timed argument rejections as if they were reads: a
 * rejection returns in ~1-2 ms, a real read in ~300 ms.
 */
function call(tool, args) {
  const res = callTool(tool, args);
  const text = typeof res?.text === 'string' ? res.text : (res?.content?.[0]?.text ?? '');
  if (res?.isError === true) {
    throw new Error(`FAIL-CLOSED: ${tool} returned isError=true :: ${text.slice(0, 200)}`);
  }
  if (!text.trim()) {
    throw new Error(`FAIL-CLOSED: ${tool} returned an empty result`);
  }
  // Belt and braces: the error text is recognisable even if the flag regresses.
  if (/^Tool '[^']+' failed:/.test(text)) {
    throw new Error(`FAIL-CLOSED: ${tool} returned an error string without isError :: ${text.slice(0, 200)}`);
  }
  return text;
}

function timed(tool, args) {
  const t = performance.now();
  const text = call(tool, args);
  return { ms: performance.now() - t, text };
}

// -------------------------------------------------------------- the plan
/* Arguments below are written against the live schema, not from memory. The
   superseded harness passed {name:...} to find_symbol and read_function, which
   require {query:...} and {function:...} — so both were timing an argument
   rejection, not a read. */
const PLAN = (root) => [
  ['repo_map',        { path: root }],
  ['find_symbol',     { path: root, query: 'helper7' }],
  ['read_function',   { path: root, function: 'orchestrate7' }],
  ['find_references', { path: root, symbol: 'helper7' }],
  ['callers_of',      { path: root, function: 'helper7' }],
  ['callees_of',      { path: root, function: 'orchestrate7' }],
  ['impact_of',       { path: root, function: 'helper7' }],
  ['path_between',    { path: root, from: 'orchestrate7', to: 'helper7' }],
  ['boundary_check',  { path: root }],
  ['check_my_changes',{ path: root }],
  ['change_impact',   { path: root }],
  ['diff_context',    { path: root }],
];

/*
 * How each tool proves it observed the edit. A tool with no predicate here is
 * measured warm and labelled warm — never labelled "after edit" on the strength
 * of an edit it cannot be shown to have seen.
 *
 *   graph tools  — the appended function must appear as a new caller
 *   diff tools   — the mutated file must appear in the reported diff
 */
const OBSERVES = {
  callers_of:       (text, probe) => text.includes(probe.symbol),
  impact_of:        (text, probe) => text.includes(probe.symbol),
  find_references:  (text, probe) => text.includes(probe.symbol),
  check_my_changes: (text, probe) => text.includes(probe.rel),
  diff_context:     (text, probe) => text.includes(probe.rel),
  change_impact:    (text, probe) => text.includes(probe.rel),
};

const sha = (b) => createHash('sha256').update(b).digest('hex');

/**
 * Finds a file that already imports the edit target, to host the probe.
 *
 * Discovered per scale rather than hardcoded: the fixture generator wires a
 * different importer at each size, so a fixed path is an importer at 1,500
 * files and an unrelated file at 5,000 and 10,000 — where the appended call
 * would not resolve and the edit would be unobservable. Placing the probe in a
 * file that already imports the symbol lets the import-scoped tier resolve it.
 */
function findProbeFile(root, symbol) {
  const src = join(root, 'src');
  const importRe = new RegExp(`^import\\s*\\{[^}]*\\b${symbol}\\b[^}]*\\}`, 'm');
  const stack = [src];
  while (stack.length) {
    const dir = stack.pop();
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) { stack.push(full); continue; }
      if (!e.name.endsWith('.ts')) continue;
      const text = readFileSync(full, 'utf8');
      if (importRe.test(text)) return { file: full, text };
    }
  }
  return null;
}

/**
 * One edit-loop iteration:
 *   mutate -> assert the engine observed it -> time the query -> restore ->
 *   assert the bytes are byte-identical to the original.
 * Any failure throws, so a "measurement" can never survive a mutation that did
 * not happen or a restore that did not complete.
 */
function editLoopSample(root, tool, args, probe, i) {
  const symbol = `__editProbe${i}`;

  /*
   * The edit does two things, because one is not enough to exercise the whole
   * surface. Appending a function makes the graph tools observable (a new
   * caller appears) but leaves change_impact with nothing to say — it traces
   * MODIFIED and REMOVED symbols, and correctly answers "added symbols have no
   * callers yet by definition". So the edit also mutates an existing function
   * body, which is what a real edit usually looks like anyway.
   *
   * The injected statement is a call, not a comment or a literal: body hashing
   * is deliberately literal-blind, so a cosmetic change would not register as
   * a modified symbol and the mutation would be invisible by design.
   */
  const injected = probe.original.replace(
    /(export function\s+\w+\s*\([^)]*\)\s*:\s*[^{]*\{)/,
    `$1\n  const __editTouch${i} = helper7();`,
  );
  if (injected === probe.original) {
    throw new Error(`MUTATION: could not inject into an existing function in ${probe.rel}`);
  }
  const mutated = `${injected}\nexport function ${symbol}(): number { return helper7(); }\n`;
  writeFileSync(probe.file, mutated, 'utf8');

  try {
    if (statSync(probe.file).size <= Buffer.byteLength(probe.original)) {
      throw new Error('MUTATION: file did not grow after write');
    }
    const t = performance.now();
    const text = call(tool, args);
    const ms = performance.now() - t;

    const observed = OBSERVES[tool];
    if (observed && !observed(text, { symbol, rel: probe.rel })) {
      throw new Error(
        `MUTATION-NOT-OBSERVED: ${tool} answered with no trace of the edit ` +
        `(expected '${symbol}' or '${probe.rel}'). The measurement would describe a ` +
        `stale index, not an edit loop.`,
      );
    }
    return ms;
  } finally {
    writeFileSync(probe.file, probe.original, 'utf8');
    if (sha(readFileSync(probe.file, 'utf8')) !== probe.hash) {
      throw new Error('RESTORE-FAILED: probe file does not hash to its original content');
    }
  }
}

// ---------------------------------------------------------------- measure
const results = {};
const skipped = [];
const probeUsed = {};   // fixture provenance, per scale

for (const n of SCALES) {
  const root = join(BASE, `repo-${n}`);
  if (!existsSync(root)) { skipped.push({ scale: n, reason: 'fixture missing' }); continue; }

  // Validate the whole plan before touching anything.
  for (const [tool, args] of PLAN(root)) assertArgsValid(tool, args);

  const found = findProbeFile(root, 'helper7');
  if (!found) { skipped.push({ scale: n, reason: 'no file imports helper7; edit could not be made observable' }); continue; }
  const probe = {
    file: found.file,
    original: found.text,
    hash: sha(found.text),
    rel: found.file.slice(root.length + 1).replace(/\\/g, '/'),
  };

  rmSync(join(root, '.euthynos'), { recursive: true, force: true });
  if (global.gc) global.gc();
  const rssBefore = process.memoryUsage().rss;

  // COLD: first call against an empty index. One observation by definition.
  const cold = timed('repo_map', { path: root }).ms;

  const warm = {};
  const edit = {};
  for (const [tool, args] of PLAN(root)) {
    call(tool, args); // prime; not sampled

    const w = [];
    for (let i = 0; i < REPS; i++) w.push(timed(tool, args).ms);
    warm[tool] = summarise(w);

    if (OBSERVES[tool]) {
      const e = [];
      for (let i = 0; i < REPS; i++) e.push(editLoopSample(root, tool, args, probe, i));
      edit[tool] = summarise(e);
    }
  }

  if (sha(readFileSync(probe.file, 'utf8')) !== probe.hash) {
    throw new Error(`POST-CHECK: ${probe.file} was left modified at scale ${n}`);
  }

  probeUsed[n] = { probeFile: probe.rel, probeSha256: probe.hash, fixtureRoot: root };
  results[n] = {
    coldMs: Math.round(cold),
    coldN: 1,
    warm,
    edit,
    rssBeforeMB: Math.round(rssBefore / 1048576),
    rssAfterMB: Math.round(process.memoryUsage().rss / 1048576),
  };
  console.log(`  scale ${n}: cold ${Math.round(cold)} ms · n=${REPS} · probe ${probe.rel} restored`);
}

// ----------------------------------------------------------------- artifact
/* A latency number without its machine, its build and its method is an
   anecdote. The artifact carries all three so a figure can never be quoted
   detached from the conditions that produced it. */
async function gitInfo() {
  try {
    // `require` is not defined in an ES module; the previous version used it,
    // silently threw, and fell back to "unknown" while still stamping the
    // artifact "committed build" — a confident provenance claim on no evidence.
    const { execFileSync } = await import('node:child_process');
    const at = (args) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8' }).trim();
    return { commit: at(['rev-parse', '--short=12', 'HEAD']), dirty: at(['status', '--porcelain']).length > 0 };
  } catch (e) {
    return { commit: null, dirty: null, error: e.message };
  }
}

const os = await import('node:os');
const git = await gitInfo();

const artifact = {
  schema: 'euthynos.latency.v1',
  producedAtIso: new Date().toISOString(),
  harness: 'scripts/measurement/measure-latency.mjs',
  supersedes: ['scripts/measurement/measure-tools.mjs', 'scripts/measurement/measure-scale.mjs', 'scripts/latency-bench.mjs'],
  engine: {
    commit: git.commit,
    dirty: git.dirty,
    dist: DIST,
    /* Three distinct states, never collapsed. A dirty tree means the measured
       build corresponds to no commit; an unavailable git means provenance is
       simply unknown. Neither may be reported as a clean committed build. */
    provenance:
      git.commit === null ? `UNKNOWN (git unavailable: ${git.error ?? 'no reason given'})`
      : git.dirty ? 'WORKING TREE — not a committed build'
      : 'committed build',
  },
  machine: {
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    cpus: os.cpus().length,
    cpuModel: os.cpus()[0]?.model ?? 'unknown',
    totalMemGB: Math.round(os.totalmem() / 1073741824),
    freeMemAtStartGB: Math.round(os.freemem() / 1073741824),
  },
  method: {
    reps: REPS,
    coldSamples: 1,
    percentile: 'nearest-rank, no interpolation; omitted when ceil(0.95*n) === n',
    schemaCheck: 'every invocation validated against the live TOOLS registry before the run',
    failClosed: 'every call asserts isError !== true, non-empty text, and no "Tool ... failed:" prefix',
    editLoop:
      'per iteration: modify an existing function body AND append a caller; assert the tool output ' +
      'contains the new symbol (graph tools) or the mutated path (diff tools); restore; assert sha256 ' +
      'matches the original. Any failure throws — a sample is never recorded from an unverified edit.',
    warmLabel: 'repeated calls with no mutation; never labelled "after edit"',
    rawSamplesRetained: true,
  },
  fixtures: probeUsed,
  results,
  skipped,
};

/* Deliberately NOT bench-results/ — that directory is gitignored, and an
   authoritative record that is not tracked cannot be the single source a
   published number cites. measurements/ is tracked. */
const outFile = argv.out ?? join(REPO, 'measurements', 'latency-local.json');
try {
  const { mkdirSync } = await import('node:fs');
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify(artifact, null, 1), 'utf8');
  console.log(`\n  artifact -> ${outFile}`);
} catch (e) {
  console.log(`\n  (could not write artifact: ${e.message})`);
}
console.log(JSON.stringify({ ...artifact, results: '(see artifact)', fixtures: probeUsed }, null, 2));
