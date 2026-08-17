import { dirname, posix } from 'node:path';
import type { CodeGraph, ModuleGraph, ParsedFile, SymbolSpan } from '../types.js';
import { callersOf, calleesOf, findFunction, impactOf } from '../graph/query.js';
import { readSpan, renderSpan } from './spans.js';
import { runGitLog } from '../git/run.js';
import type { RenderSection } from './render.js';

/**
 * CONTEXT BUNDLE (Phase 5, blueprint §21-22).
 *
 * One call that assembles what an agent otherwise collects piecewise — the
 * span, who calls it, what it calls, the types in its signature, the tests
 * that reach it, where it sits architecturally, what changed recently, and
 * how far a change would ripple — RANKED BY INTENT and rendered under one
 * budget by the shared renderer.
 *
 * M1 named the residual this exists to remove: agents received a correct
 * callers_of answer and then spent Read x26 / Grep x22 assembling the rest of
 * the picture by hand. The bundle's job is to make the assembled picture the
 * FIRST answer.
 *
 * Composition rules:
 *  - Everything comes from machinery that already exists (spans, graph,
 *    git); this module ADDS NO new analysis, so it can introduce no new
 *    class of wrong answer.
 *  - Sections state their gaps: types absent for a language says "not
 *    indexed", tests are labeled as the import heuristic they are, and a
 *    non-function target says call edges do not apply.
 *  - Intent profiles are DATA (a table below), not code branches — adding an
 *    intent is a table row plus a golden test, never new logic.
 */

export type BundleIntent = 'understand' | 'change' | 'debug' | 'review';

export type SectionKey =
  | 'source' | 'callers' | 'callees' | 'types'
  | 'tests' | 'architecture' | 'recent-changes' | 'blast-radius';

/**
 * Which sections each intent gets, in PRIORITY ORDER — the renderer spends
 * the budget top-down, so earlier sections survive trimming longer.
 *
 *  understand: what IS this — source first, then what it uses.
 *  change:     what breaks — callers and blast radius outrank callees.
 *  debug:      how did we get here — callers (the path in) and recent edits.
 *  review:     is this sound — blast radius, tests, and structure lead.
 */
export const INTENT_PROFILES: Readonly<Record<BundleIntent, readonly SectionKey[]>> = {
  understand: ['source', 'callees', 'types', 'architecture', 'callers', 'tests'],
  change: ['source', 'callers', 'blast-radius', 'tests', 'types', 'recent-changes'],
  debug: ['source', 'callers', 'recent-changes', 'callees', 'types'],
  review: ['source', 'blast-radius', 'tests', 'architecture', 'recent-changes', 'callers'],
};

export const BUNDLE_INTENTS = Object.keys(INTENT_PROFILES) as BundleIntent[];

/** One budget for the whole bundle — the point is ONE call, not eight. */
export const BUNDLE_BUDGET_TOKENS = 900;

/** Source lines shown inline before deferring to read_function. */
const SOURCE_CAP_LINES = 48;

export interface BundleTarget {
  name: string;
  file: string;
  kind: string;
  startLine: number;
  endLine: number;
}

export interface BundleDeps {
  root: string;
  files: readonly ParsedFile[];
  graph: CodeGraph;
  moduleGraph: ModuleGraph;
  target: BundleTarget;
  intent: BundleIntent;
}

/** Build the ranked, unrendered sections. Rendering/budget is render.ts's job. */
export function composeBundle(deps: BundleDeps): RenderSection[] {
  const order = INTENT_PROFILES[deps.intent];
  const built: Partial<Record<SectionKey, RenderSection>> = {
    source: sourceSection(deps),
    callers: callerSection(deps, 'callers'),
    callees: callerSection(deps, 'callees'),
    types: typesSection(deps),
    tests: testsSection(deps),
    architecture: architectureSection(deps),
    'recent-changes': recentSection(deps),
    'blast-radius': blastSection(deps),
  };
  return order.map((k) => built[k]!).filter((s) => s !== undefined);
}

// ── sections ───────────────────────────────────────────────────────────────

function qualified(t: BundleTarget): string {
  return `${t.file}#${t.name}`;
}

function sourceSection(d: BundleDeps): RenderSection {
  const { target } = d;
  const end = Math.min(target.endLine, target.startLine + SOURCE_CAP_LINES - 1);
  let lines: string[];
  try {
    const span = readSpan(d.root, target.file, target.startLine, end);
    lines = renderSpan(span).split('\n');
    if (end < target.endLine) {
      lines.push(`... ${target.endLine - end} more lines`);
    }
  } catch (e) {
    lines = [`source unavailable: ${e instanceof Error ? e.message : String(e)}`];
  }
  return {
    title: `${target.name} (${target.kind}) — ${target.file}:${target.startLine}-${target.endLine}`,
    lines,
    nextAction: `read_function({ function: "${qualified(target)}" })`,
  };
}

function callerSection(d: BundleDeps, dir: 'callers' | 'callees'): RenderSection {
  const title = dir === 'callers' ? 'called by' : 'calls';
  const fn = findFunction(d.graph, qualified(d.target));
  if (!('node' in fn)) {
    return {
      title,
      lines: [`not applicable — '${d.target.name}' is a ${d.target.kind}; call edges exist for functions only.`],
      nextAction: `find_references({ symbol: "${d.target.name}" })`,
    };
  }
  const rows = (dir === 'callers' ? callersOf(d.graph, fn.node.id) : calleesOf(d.graph, fn.node.id))
    .filter((c) => c.depth === 1);
  const shown = rows.slice(0, 6);
  // Graph node lines are BODY-start (kept for metric stability); a reader
  // wants the declaration line, so look it up per row. Nodes without a
  // location (module pseudo-nodes) omit the suffix rather than printing
  // "undefined:undefined".
  const declLineOf = (file: string | undefined, name: string, fallback: number | undefined): number | undefined => {
    if (file === undefined) return fallback;
    const fnRec = d.files.find((f) => f.path === file)?.functions.find((r) => r.name === name);
    return fnRec?.declLine ?? fallback;
  };
  const lines = shown.map((c) => {
    const line = declLineOf(c.file, c.label, c.line);
    return `${c.label}${c.file !== undefined ? ` — ${c.file}:${line ?? '?'}` : ''}`;
  });
  if (rows.length > shown.length) lines.push(`... and ${rows.length - shown.length} more`);
  if (rows.length === 0) {
    lines.push(
      dir === 'callers'
        ? 'none in the graph — dynamic or reflective calls are invisible to it; verify with a text search before treating this as isolated.'
        : 'none in the graph.',
    );
  }
  return {
    title,
    lines,
    nextAction:
      dir === 'callers'
        ? `callers_of({ function: "${qualified(d.target)}" })`
        // There is no callees_of tool until Phase 6, and impact_of serves
        // CALLERS — pointing there for hidden callees was a wrong escalation
        // (review finding). The honest deeper call is the source itself:
        // read_function's footer lists the direct calls.
        : `read_function({ function: "${qualified(d.target)}" })`,
  };
}

function typesSection(d: BundleDeps): RenderSection {
  const { target } = d;
  const targetModule = d.files.find((f) => f.path === target.file)?.module ?? '';
  const rec = d.files
    .find((f) => f.path === target.file)
    ?.functions.find((fn) => fn.name === target.name);
  const lines: string[] = [];
  if (rec === undefined || !('typeRefs' in rec) || rec.typeRefs === undefined) {
    // Absent field = the parser does not record signature types for this
    // language (TS-only today). Saying "no types" would be a lie.
    lines.push('signature types: not indexed for this language (TypeScript only today).');
  } else if (rec.typeRefs.length === 0) {
    lines.push('no named types in the signature.');
  } else {
    for (const name of rec.typeRefs) {
      const res = resolveTypeSpan(d.files, name, target.file, targetModule);
      if (res.kind === 'none') {
        lines.push(`${name} — not declared in this repository (external or built-in)`);
      } else if (res.kind === 'ambiguous') {
        // A same-named type in N other modules is not "the" type — naming one
        // alphabetically would be a confident guess about code we did not
        // check. Say what we know and how to disambiguate.
        lines.push(`${name} — ${res.count} declarations in other modules; find_symbol({ query: "${name}" }) to disambiguate`);
      } else {
        const span = res.span;
        lines.push(`${name} (${span.kind}) — ${span.file}:${span.startLine}-${span.endLine}`);
      }
    }
  }
  return {
    title: 'types touched',
    lines,
    nextAction: lines.some((l) => l.includes(' — ') && !l.includes('external'))
      ? `read_function({ function: "<file>#<type name>" })`
      : '',
  };
}

/**
 * Resolve a signature type name with the SAME evidence ladder the call graph
 * uses: same file, then same module. Beyond that we do NOT guess — a
 * same-named type in a distant module is exactly the lookalike class of
 * error the phantom-resolution guard exists to prevent.
 */
function resolveTypeSpan(
  files: readonly ParsedFile[],
  name: string,
  nearFile: string,
  nearModule: string,
):
  | { kind: 'resolved'; span: SymbolSpan & { file: string } }
  | { kind: 'ambiguous'; count: number }
  | { kind: 'none' } {
  const all: (SymbolSpan & { file: string; module: string })[] = [];
  for (const f of files) {
    for (const s of f.symbols ?? []) {
      if (s.name === name) all.push({ ...s, file: f.path, module: f.module });
    }
  }
  if (all.length === 0) return { kind: 'none' };
  const sameFile = all.filter((s) => s.file === nearFile);
  if (sameFile.length > 0) return { kind: 'resolved', span: sameFile[0]! };
  const sameModule = all.filter((s) => s.module === nearModule).sort((a, b) => a.file.localeCompare(b.file));
  if (sameModule.length > 0) return { kind: 'resolved', span: sameModule[0]! };
  if (all.length === 1) return { kind: 'resolved', span: all[0]! };
  return { kind: 'ambiguous', count: all.length };
}

/**
 * Tests that import the target's file — labeled as the heuristic it is.
 * tests.json (call-edge-aware) is Phase 6; overstating this section today
 * would poison the one Phase 6 exists to make trustworthy.
 */
function testsSection(d: BundleDeps): RenderSection {
  const targetPath = d.target.file;
  const hits: string[] = [];
  for (const f of d.files) {
    if (!f.isTest) continue;
    // Scan ALL imports before labeling: an earlier import of the same file
    // must not hide a later one that names the target symbol explicitly
    // (review finding — the break dropped the by-name annotation).
    let matched = false;
    let byName = false;
    for (const imp of f.imports) {
      if (resolvesTo(imp.specifier, f.path, targetPath)) {
        matched = true;
        if (imp.named.includes(d.target.name)) byName = true;
      }
    }
    if (matched) hits.push(`${f.path}${byName ? ` (imports ${d.target.name} by name)` : ''}`);
  }
  const shown = hits.slice(0, 4);
  const lines = shown.length > 0 ? shown : ['no test file imports this file.'];
  if (hits.length > shown.length) lines.push(`... and ${hits.length - shown.length} more`);
  lines.push('(heuristic: test-file import edges; call-graph-aware tests_for lands in Phase 6)');
  return { title: 'tests', lines, nextAction: '' };
}

/**
 * Does a relative import specifier from `fromFile` resolve to `targetPath`?
 *
 * Candidate-based, never extension-erasing on BOTH sides: stripping the
 * extension from both attributed `import './a'` to `a.py` when `a.ts` and
 * `a.py` are siblings (review finding). An explicit-extension specifier must
 * match exactly; an extensionless one matches only via its concrete
 * candidate expansions.
 */
const RESOLVE_EXTS = [
  '.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs',
  '.py', '.go', '.java', '.rb', '.rs', '.php', '.cs', '.dart', '.kt', '.swift', '.vue',
];
export function resolvesTo(specifier: string, fromFile: string, targetPath: string): boolean {
  if (!specifier.startsWith('.')) return false;
  const resolved = posix.normalize(posix.join(dirname(fromFile).replace(/\\/g, '/'), specifier));
  if (resolved === targetPath) return true; // explicit extension, exact match
  if (/\.[A-Za-z0-9]+$/.test(resolved)) return false; // explicit extension, different file
  for (const ext of RESOLVE_EXTS) {
    if (resolved + ext === targetPath) return true;
    if (`${resolved}/index${ext}` === targetPath) return true;
  }
  return false;
}

function architectureSection(d: BundleDeps): RenderSection {
  const file = d.files.find((f) => f.path === d.target.file);
  const mod = file?.module ?? '(unknown)';
  const inMod = d.files.filter((f) => f.module === mod);
  const loc = inMod.reduce((s, f) => s + f.codeLines, 0);
  const imports = d.moduleGraph.imports.get(mod)?.size ?? 0;
  const importedBy = d.moduleGraph.importedBy.get(mod)?.size ?? 0;
  return {
    title: 'architecture',
    lines: [
      `module '${mod}' — ${inMod.length} files, ${loc.toLocaleString('en-US')} code lines; imports ${imports} module${imports === 1 ? '' : 's'}, imported by ${importedBy}.`,
    ],
    nextAction: `module_metrics({ module: "${mod}" })`,
  };
}

function recentSection(d: BundleDeps): RenderSection {
  let lines: string[];
  try {
    const out = runGitLog(d.root, [
      'log', '-n', '3', '--date=short', '--format=%h %ad %s', '--', d.target.file,
    ]).trim();
    lines = out === '' ? ['no commits touch this file in the repository history.'] : out.split('\n');
  } catch {
    lines = ['no git history available.'];
  }
  return { title: 'recent changes (file)', lines, nextAction: '' };
}

function blastSection(d: BundleDeps): RenderSection {
  const fn = findFunction(d.graph, qualified(d.target));
  if (!('node' in fn)) {
    return {
      title: 'blast radius',
      lines: [`not applicable — '${d.target.name}' is a ${d.target.kind}.`],
      nextAction: `find_references({ symbol: "${d.target.name}" })`,
    };
  }
  const impact = impactOf(d.graph, fn.node.id);
  return {
    title: 'blast radius',
    // impactOf's own summary carries the honesty this section must not lose:
    // the lower-bound note when unresolved calls exist, and the leverage
    // warning on high-leverage modules. Re-phrasing it here would be a second
    // place for that wording to rot.
    lines: [`[${impact.blastRadius}] ${impact.summary}`],
    nextAction: `impact_of({ function: "${qualified(d.target)}" })`,
  };
}
