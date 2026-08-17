import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import pc from 'picocolors';
import { buildRepoGraph, serializeGraph } from '../graph/repo.js';
import { findFunction, callersOf, calleesOf, impactOf, pathBetween } from '../graph/query.js';
import { loadLanguages } from '../parse/treesitter/loader.js';
import { TREE_SITTER_LANGS } from '../parse/dispatch.js';
import type { CodeGraph } from '../types.js';

/** `euthynos graph` — build the knowledge graph and answer one query, or write the artifact. */
export async function runGraph(rest: string[]): Promise<void> {
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
    } else positional.push(a);
  }

  const root = positional[0] ?? process.cwd();
  await loadLanguages([...TREE_SITTER_LANGS]);
  const graph = buildRepoGraph(root, { withMetrics: flags.has('metrics') });

  console.log('');
  console.log(
    pc.bold(pc.magenta('  ◉ Euthynos')) +
      pc.dim(`  knowledge graph · ${graph.stats.functions} fns · ${graph.stats.callEdges} call edges · ${graph.stats.importEdges} import edges`),
  );

  if (flags.has('impact')) return printImpact(graph, flags.get('impact')!);
  if (flags.has('callers')) return printReach(graph, flags.get('callers')!, 'callers', callersOf);
  if (flags.has('calls')) return printReach(graph, flags.get('calls')!, 'calls', calleesOf);
  if (flags.has('path')) return printPath(graph, flags.get('path')!);

  const jsonOut = flags.get('json');
  if (jsonOut && jsonOut !== 'true') {
    mkdirSync(dirname(jsonOut), { recursive: true });
    writeFileSync(jsonOut, serializeGraph(graph));
    console.log(pc.dim(`  artifact → ${jsonOut}`));
  } else {
    const out = join(root, '.euthynos', 'graph.json');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, serializeGraph(graph));
    console.log(pc.dim(`  artifact → ${out}`));
    console.log(pc.dim('  try: euthynos graph . --impact <fn>  ·  --callers <fn>  ·  --path a..b'));
  }
  console.log('');
}

function printImpact(graph: CodeGraph, query: string): void {
  const r = findFunction(graph, query);
  if ('error' in r) return printErr(r);
  const imp = impactOf(graph, r.node.id);
  console.log('');
  console.log(`  ${pc.bold('Blast radius')} of ${pc.bold(imp.target.label)} ${pc.dim(`(${imp.target.file}:${imp.target.line})`)}`);
  console.log(`  ${radiusColor(imp.blastRadius)(`[${imp.blastRadius}]`)} ${imp.summary}`);
  if (imp.affectedModules.length) console.log(pc.dim(`  modules: ${imp.affectedModules.join(', ')}`));
  console.log('');
  for (const a of imp.affectedFunctions.slice(0, 12)) {
    console.log(`   ${pc.dim('←'.repeat(Math.min(a.depth, 4)))} ${pc.bold(a.label)} ${pc.dim(`${a.file}:${a.line}`)}${confMark(a.confidence)}`);
  }
  if (imp.affectedFunctions.length > 12) console.log(pc.dim(`   … ${imp.affectedFunctions.length - 12} more`));
  console.log('');
}

function printReach(
  graph: CodeGraph,
  query: string,
  word: string,
  fn: (g: CodeGraph, id: string) => Array<{ label: string; file?: string; line?: number; depth: number; confidence?: number }>,
): void {
  const r = findFunction(graph, query);
  if ('error' in r) return printErr(r);
  const list = fn(graph, r.node.id);
  console.log('');
  console.log(`  ${pc.bold(`${list.length} transitive ${word}`)} of ${pc.bold(r.node.label)}`);
  console.log('');
  for (const a of list.slice(0, 20)) {
    console.log(`   ${pc.dim(`d${a.depth}`)} ${pc.bold(a.label)} ${pc.dim(`${a.file}:${a.line}`)}${confMark(a.confidence)}`);
  }
  if (list.length > 20) console.log(pc.dim(`   … ${list.length - 20} more`));
  console.log('');
}

function printPath(graph: CodeGraph, spec: string): void {
  const [a, b] = spec.split('..');
  if (!a || !b) {
    console.error(pc.red('  --path needs two functions: --path funcA..funcB'));
    return;
  }
  const ra = findFunction(graph, a), rb = findFunction(graph, b);
  if ('error' in ra) return printErr(ra);
  if ('error' in rb) return printErr(rb);
  const path = pathBetween(graph, ra.node.id, rb.node.id);
  console.log('');
  if (!path) {
    console.log(pc.dim(`  no call path between ${ra.node.label} and ${rb.node.label}`));
  } else {
    console.log(`  ${pc.bold('Call path')} ${pc.dim(`(${path.length} hops)`)}`);
    console.log('   ' + path.map((n) => pc.bold(n.label)).join(pc.dim(' → ')));
  }
  console.log('');
}

function printErr(r: { error: string; candidates?: string[] }): void {
  console.error(pc.yellow(`  ${r.error}`));
  if (r.candidates) console.error(pc.dim('  ' + r.candidates.join('\n  ')));
}

/** Dim confidence tag on best-effort (import-scoped) edges; high-confidence edges stay clean. */
function confMark(confidence: number | undefined): string {
  return confidence !== undefined && confidence < 0.9 ? pc.yellow(`  ~${Math.round(confidence * 100)}%`) : '';
}

function radiusColor(r: string): (x: string) => string {
  return r === 'wide' ? pc.red : r === 'moderate' ? pc.yellow : r === 'local' ? pc.cyan : pc.green;
}
