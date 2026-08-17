/**
 * Benchmark harness argument auditor.
 *
 *   node scripts/measurement/audit-harness-args.mjs
 *
 * Statically extracts every `['tool_name', { ...args }]` invocation from the
 * benchmark harnesses and checks each against the LIVE tool registry: does the
 * tool exist, are all required arguments present, are any arguments unknown.
 *
 * This exists because two shipped harnesses timed argument rejections as if
 * they were measurements. A rejection returns in ~1-2 ms and a real call in
 * ~150-400 ms, so the resulting table looked like an extraordinary performance
 * result rather than a bug. Nothing catches that except checking the arguments
 * against the schema before trusting the number.
 *
 * Exit code 1 if any invocation is invalid, so this can gate CI.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const DIST = join(REPO, 'dist');
if (!existsSync(join(DIST, 'mcp', 'tools.js'))) throw new Error('No build; run `npm run build`.');

const { TOOLS } = await import(`${pathToFileURL(DIST).href}/mcp/tools.js`);
const REGISTRY = new Map(TOOLS.map((t) => [t.name, t.inputSchema ?? t.input_schema ?? {}]));

const HARNESSES = [
  'scripts/latency-bench.mjs',
  'scripts/measurement/measure-tools.mjs',
  'scripts/measurement/measure-scale.mjs',
  'scripts/measurement/measure-latency.mjs',
];

/* Matches ['tool', { a: ..., b: ... }] invocation tuples. Argument VALUES are
   irrelevant here — only the key names and the tool name are being audited. */
const CALL_RE = /\[\s*'([a-z_]+)'\s*,\s*\{([^}]*)\}/g;
const KEY_RE = /(?:^|,)\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/g;

let bad = 0, total = 0;
const report = [];

for (const rel of HARNESSES) {
  const file = join(REPO, rel);
  if (!existsSync(file)) continue;
  const src = readFileSync(file, 'utf8');
  const rows = [];

  for (const m of src.matchAll(CALL_RE)) {
    const tool = m[1];
    const keys = [...m[2].matchAll(KEY_RE)].map((k) => k[1]);
    total++;

    if (!REGISTRY.has(tool)) {
      // Only flag names that look like tool calls, not arbitrary tuples.
      if (/^[a-z]+(_[a-z]+)+$/.test(tool)) {
        rows.push({ tool, keys, verdict: 'NO SUCH TOOL', detail: 'not in the live registry' });
        bad++;
      }
      continue;
    }
    const schema = REGISTRY.get(tool);
    const props = Object.keys(schema.properties ?? {});
    const required = schema.required ?? [];
    const missing = required.filter((r) => !keys.includes(r));
    const unknown = keys.filter((k) => props.length && !props.includes(k));

    if (missing.length || unknown.length) {
      rows.push({
        tool, keys, verdict: 'INVALID',
        detail: [
          missing.length ? `missing required: ${missing.join(', ')}` : '',
          unknown.length ? `unknown: ${unknown.join(', ')}` : '',
          `schema accepts [${props.join(', ')}] requires [${required.join(', ')}]`,
        ].filter(Boolean).join(' · '),
      });
      bad++;
    } else {
      rows.push({ tool, keys, verdict: 'ok', detail: '' });
    }
  }
  report.push({ file: rel, rows });
}

for (const { file, rows } of report) {
  const nBad = rows.filter((r) => r.verdict !== 'ok').length;
  console.log(`\n${file}  —  ${rows.length} invocations, ${nBad} invalid`);
  for (const r of rows) {
    const mark = r.verdict === 'ok' ? '  ok  ' : `  ${r.verdict.padEnd(4)}`;
    console.log(`${mark} ${r.tool.padEnd(22)} {${r.keys.join(', ')}}`);
    if (r.detail) console.log(`         ${r.detail}`);
  }
}

console.log(`\n${total} invocations audited · ${bad} invalid`);
if (bad > 0) {
  console.log('\nAn invalid invocation does not fail loudly at runtime: the library');
  console.log('returns { text, isError: true } and an unchecked harness times it as a');
  console.log('result. Every number produced by an invalid invocation is void.');
  process.exit(1);
}
