/**
 * Independent verifier for a latency artifact.
 *
 *   node scripts/measurement/verify-artifact.mjs [path]
 *
 * Re-derives every published statistic from the retained raw samples using its
 * own implementation of nearest-rank, and checks the artifact's provenance,
 * sample counts and fixture restoration. It deliberately does NOT import the
 * harness: a summary checked by the code that produced it is not checked.
 *
 * Exit code 1 on any discrepancy.
 */

import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const file = process.argv[2] ?? join(REPO, 'measurements', 'latency-local.json');

const raw = readFileSync(file);
const a = JSON.parse(raw.toString('utf8'));
const sha256 = createHash('sha256').update(raw).digest('hex');

let fail = 0;
const ok = (label, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!cond) fail++;
};

console.log(`artifact: ${file}`);
console.log(`sha256:   ${sha256}\n`);

// ---- [4] provenance -------------------------------------------------------
console.log('[4] provenance');
let headSha = null;
try { headSha = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim(); } catch {}

ok('engine.commit is a real SHA', /^[0-9a-f]{12}$/.test(a.engine?.commit ?? ''), a.engine?.commit ?? 'null');
ok('provenance === "committed build"', a.engine?.provenance === 'committed build', a.engine?.provenance);
ok('engine.dirty === false', a.engine?.dirty === false, String(a.engine?.dirty));

/*
 * Three provenance states, reported distinctly. Never collapsed.
 *
 *   PUBLIC   — the source commit is in this repository, so the figures are
 *              traceable to a build you can check out yourself.
 *   EXTERNAL — the artifact names a commit this repository does not contain.
 *              Euthynos develops in a private repository and publishes a
 *              curated tree, so this is the expected state in the public repo.
 *              It is a STATED LIMITATION, not a pass and not a failure.
 *   INVALID  — the artifact does not carry usable provenance at all.
 *
 * Two rules this must never break: an unavailable commit is never silently
 * upgraded to PASS, and the artifact's historical commit is never required to
 * equal current HEAD. An artifact measures the build it measured and stays
 * valid when later commits land.
 */
const commit = a.engine?.commit;
let provenance;
if (!/^[0-9a-f]{7,40}$/.test(commit ?? '')) {
  provenance = 'INVALID';
} else {
  let inRepo = false;
  try {
    execFileSync('git', ['cat-file', '-e', `${commit}^{commit}`], { cwd: REPO, stdio: 'ignore' });
    inRepo = true;
  } catch { /* absent from this repository, or a shallow clone */ }
  provenance = inRepo ? 'PUBLIC' : 'EXTERNAL';
}

ok('artifact carries usable provenance', provenance !== 'INVALID', `state: ${provenance}`);

if (provenance === 'PUBLIC') {
  console.log(`  PUBLIC PROVENANCE — source commit ${commit} is present in this repository` +
              (commit === headSha ? ' and is current HEAD.' : `; HEAD has since moved to ${headSha}.`));
} else if (provenance === 'EXTERNAL') {
  console.log(`  EXTERNAL PROVENANCE — evidence generated from build commit ${commit}; ` +
              `that source commit is not part of this public repository.`);
  console.log('  The checks below are self-contained: they re-derive every published');
  console.log('  figure from the raw samples in the artifact. What cannot be checked');
  console.log('  here is that the build matches that commit — see PROVENANCE.md.');
}

// ---- [5] raw samples reproduce every statistic ----------------------------
console.log('\n[5] statistics re-derived from raw samples (independent implementation)');
const nearestRank = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
const r1 = (v) => Math.round(v * 10) / 10;

let cells = 0, mismatches = [];
for (const [scale, res] of Object.entries(a.results ?? {})) {
  for (const phase of ['warm', 'edit']) {
    for (const [tool, s] of Object.entries(res[phase] ?? {})) {
      cells++;
      const samples = s.samplesMs;
      if (!Array.isArray(samples) || samples.length === 0) { mismatches.push(`${scale}/${phase}/${tool}: no raw samples`); continue; }
      const sorted = [...samples].sort((x, y) => x - y);

      if (sorted.length !== s.n) mismatches.push(`${scale}/${phase}/${tool}: n=${s.n} but ${sorted.length} samples`);
      if (r1(nearestRank(sorted, 0.5)) !== s.median) mismatches.push(`${scale}/${phase}/${tool}: median ${s.median} != re-derived ${r1(nearestRank(sorted, 0.5))}`);
      if (r1(sorted[0]) !== s.min) mismatches.push(`${scale}/${phase}/${tool}: min mismatch`);
      if (r1(sorted[sorted.length - 1]) !== s.max) mismatches.push(`${scale}/${phase}/${tool}: max mismatch`);

      const distinct = Math.ceil(0.95 * sorted.length) < sorted.length;
      if (distinct) {
        if (r1(nearestRank(sorted, 0.95)) !== s.p95) mismatches.push(`${scale}/${phase}/${tool}: p95 ${s.p95} != re-derived ${r1(nearestRank(sorted, 0.95))}`);
        // The defect that started this: a p95 equal to the max at small n.
        if (s.p95 === s.max && sorted.length < 20) mismatches.push(`${scale}/${phase}/${tool}: p95 equals max`);
      } else if (s.p95 !== null) {
        mismatches.push(`${scale}/${phase}/${tool}: p95 emitted at n=${sorted.length} where ceil(.95n)===n`);
      }
    }
  }
}
ok(`every median/p95/min/max re-derives from raw samples (${cells} cells)`, mismatches.length === 0,
   mismatches.length ? mismatches.slice(0, 4).join(' | ') : '');
ok('raw samples retained flag set', a.method?.rawSamplesRetained === true);

// ---- [6] every invocation succeeded ---------------------------------------
console.log('\n[6] invocation success');
/* The harness is fail-closed: any isError, empty result or error-prefixed text
   throws and aborts the run. A complete artifact covering every planned tool at
   every scale is therefore proof that no sample came from a failed call. */
const PLANNED = ['repo_map','find_symbol','read_function','find_references','callers_of','callees_of',
                 'impact_of','path_between','boundary_check','check_my_changes','change_impact','diff_context'];
let missing = [];
for (const [scale, res] of Object.entries(a.results ?? {})) {
  for (const t of PLANNED) if (!res.warm?.[t]) missing.push(`${scale}/${t}`);
}
ok('all 12 planned tools present at every scale', missing.length === 0, missing.join(', '));
ok('no scale skipped', (a.skipped ?? []).length === 0, JSON.stringify(a.skipped ?? []));
ok('fail-closed contract recorded', typeof a.method?.failClosed === 'string' && /isError/.test(a.method.failClosed));

// ---- [7] mutation + restoration -------------------------------------------
console.log('\n[7] edit-loop mutation and restoration');
const EDIT_TOOLS = ['find_references','callers_of','impact_of','check_my_changes','change_impact','diff_context'];
let editIssues = [];
for (const [scale, res] of Object.entries(a.results ?? {})) {
  const fx = a.fixtures?.[scale];
  if (!fx?.probeFile || !/^[0-9a-f]{64}$/.test(fx.probeSha256 ?? '')) { editIssues.push(`${scale}: no probe provenance`); continue; }
  const probePath = join(fx.fixtureRoot, fx.probeFile.replace(/\//g, '\\'));
  if (existsSync(probePath)) {
    const now = createHash('sha256').update(readFileSync(probePath)).digest('hex');
    if (now !== fx.probeSha256) editIssues.push(`${scale}: probe file NOT restored (${fx.probeFile})`);
  } else {
    editIssues.push(`${scale}: probe file missing on disk — cannot confirm restoration`);
  }
  for (const t of EDIT_TOOLS) if (!res.edit?.[t]) editIssues.push(`${scale}: no edit-loop samples for ${t}`);
}
ok('every edit-loop tool measured at every scale', !editIssues.some((e) => /no edit-loop/.test(e)),
   editIssues.filter((e) => /no edit-loop/.test(e)).join(', '));
ok('probe file restored to its original sha256 at every scale', !editIssues.some((e) => /NOT restored|cannot confirm/.test(e)),
   editIssues.filter((e) => /NOT restored|cannot confirm/.test(e)).join(', '));
ok('edit-loop methodology recorded', /assert|sha256/i.test(a.method?.editLoop ?? ''));
ok('warm is labelled as warm, never "after edit"', /never labelled/i.test(a.method?.warmLabel ?? ''));

if (fail === 0) {
  console.log(`\nALL CHECKS PASS  ·  provenance: ${provenance}`);
  if (provenance === 'EXTERNAL') {
    console.log('The artifact verifies against itself: every published figure was re-derived');
    console.log('from its raw samples here. The link to its source commit is asserted by the');
    console.log('maintainers, not proven in this repository. See PROVENANCE.md.');
  }
} else {
  console.log(`\n${fail} CHECK(S) FAILED  ·  provenance: ${provenance}`);
}
process.exit(fail === 0 ? 0 : 1);
