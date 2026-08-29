/**
 * MCP tools for Euthynos.
 *
 * Three read-only tools over the deterministic scan engine. Zero new
 * dependencies: these plain objects are serialized verbatim into the
 * `tools/list` response, and `callTool` is the dispatcher behind
 * `tools/call`.
 *
 * Scans of big repos can take seconds, so reports are cached per resolved
 * path (+ git-history window) for 60 seconds.
 */
import { existsSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { scan } from '../scan.js';
import { beginRequest, getIndex } from '../index/incremental.js';
import { buildRepoGraph } from '../graph/repo.js';
import { findFunction, callersOf, calleesOf, impactOf, pathBetween } from '../graph/query.js';
import type { MatchKind } from '../graph/query.js';
import { buildOutline, renderOutline } from '../serve/outline.js';
import { renderRepoMap } from '../serve/repo-map.js';
import { readSpan, renderSpan, SpanError } from '../serve/spans.js';
import { findReferences, findSymbols, hasCallSites, symbolIndex } from '../serve/symbols.js';
import type { SymbolHit } from '../serve/symbols.js';
import { shapeQuery } from '../query/shape.js';
import { BUNDLE_BUDGET_TOKENS, BUNDLE_INTENTS, composeBundle, resolvesTo, type BundleIntent } from '../serve/bundle.js';
import { detectAllNearClones, NEAR_CLONE_CAP } from '../metrics/nearclone.js';
import { testsFor, TESTS_FOR_EMPTY_BOUNDARY } from '../serve/tests-for.js';
import { renderBudgeted } from '../serve/render.js';
import { checkServed, dedupReceipt, servedFiles } from './dedup.js';
import { diffWorktree, hybridOldFiles } from '../diff/engine.js';
import { buildGraph } from '../graph/imports.js';
import { contamination } from '../metrics/contamination.js';
import { evaluatePolicy, ratchetPolicy } from '../policy/evaluate.js';
import type { Resolution, StructuredQuery } from '../query/shape.js';
import { recordCall } from './telemetry.js';
import type { CodeGraph, MetricScore, ModuleGraph, ModuleReport, ParsedFile, ScanReport } from '../types.js';

// ---------------------------------------------------------------------------
// Caches (scan + knowledge graph), TTL-bounded
// ---------------------------------------------------------------------------

/**
 * Cache generations: every cache is keyed to the WORKING-TREE STATE, never
 * to wall-clock time.
 *
 * A time-based cache made this server contradict itself: read_function
 * served the new body of a function while callers_of answered "not found"
 * for it, and impact_of asserted "no callers — changing this is isolated"
 * about a function that had just been renamed. "No callers" is the claim an
 * agent acts on to delete code, so a stale graph is not a performance
 * detail — it is a wrong answer with consequences.
 */
const generations = new Map<string, number>();
const cache = new Map<string, { gen: number; report: ScanReport }>();
const graphCache = new Map<string, { gen: number; graph: CodeGraph }>();

/** Whether the current tool call was served from cache (for telemetry). */
let lastCacheOutcome: 'hit' | 'miss' | 'n/a' = 'n/a';
/** Resolved repo root of the current call — telemetry uses THIS, not the raw
 *  arg, so pathless calls (the common MCP configuration, cwd-defaulted) are
 *  persisted too. While persistence required an explicit `path` argument,
 *  every cwd-defaulted call went unrecorded, so the telemetry log covered
 *  only a minority of real usage. */
let lastResolvedRoot: string | null = null;
/** Files the current tool call's underlying scan covered (for telemetry). */
let lastFilesTouched = 0;
/** Whether the current call was answered by session dedup (for telemetry). */
let lastDedup = false;

function cachedScan(root: string, months: number): ScanReport {
  // The index is the single authority on which files exist: the scan report
  // must not be computed over a wider universe than the index publishes.
  const index = getIndex(root);
  const gen = index.generation;
  const key = `${root}|${months}`;
  const hit = cache.get(key);
  if (hit && hit.gen === gen) {
    lastCacheOutcome = 'hit';
    lastFilesTouched = hit.report.filesScanned;
    return hit.report;
  }
  lastCacheOutcome = 'miss';
  // Reuse the index's artifacts rather than re-walking and re-parsing.
  const report = scan(root, { months, ignore: index.ignore, files: index.files });
  lastFilesTouched = report.filesScanned;
  cache.set(key, { gen, report });
  return report;
}

/**
 * Parsed files + module graph for the source-serving tools, kept CURRENT
 * with the working tree and PERSISTED across processes (src/index/).
 *
 * The freshness rule lives in the index: every call sweeps the tree and
 * reparses only what moved, so an agent that writes a file and immediately
 * asks about it gets the new file, and one that edits a function never sees
 * the old body.
 */
function cachedParse(root: string): { files: ParsedFile[]; moduleGraph: ModuleGraph } {
  const idx = getIndex(root);
  const prevGen = generations.get(root);
  lastCacheOutcome = prevGen === idx.generation ? 'hit' : 'miss';
  lastFilesTouched = idx.files.length;
  generations.set(root, idx.generation);
  return { files: idx.files, moduleGraph: idx.moduleGraph };
}

/**
 * Uniform lower-bound disclosure for an EMPTY call-graph answer. impact_of
 * already appends this via its summary; callers_of / callees_of / path_between
 * did not, so an empty result there read as proven absence. The graph counts
 * every call it could not resolve to a definition (unresolvedCalls) — when that
 * count is > 0, an empty answer is a lower bound, not a fact. Disclosure only:
 * never adds or removes an edge, and stays silent when nothing is unresolved so
 * a fully-resolved answer carries no false uncertainty.
 */
function unresolvedLowerBound(graph: CodeGraph): string {
  const n = graph.stats.unresolvedCalls;
  if (n <= 0) return '';
  return (
    ` Lower bound: ${n} call${n === 1 ? '' : 's'} repo-wide couldn't be resolved to a definition ` +
    `(external, dynamic, or ambiguous calls the resolver won't guess), so an empty result here is not proof of absence.`
  );
}

function cachedGraph(root: string): CodeGraph {
  // The index publishes the EFFECTIVE ignore set; the graph must discover
  // over the same universe or the two tiers answer from different repos.
  // Before that was enforced, `callers_of` resolved symbols out of files
  // the repo config excluded.
  const index = getIndex(root);
  const gen = index.generation;
  const hit = graphCache.get(root);
  if (hit && hit.gen === gen) {
    lastCacheOutcome = 'hit';
    lastFilesTouched = hit.graph.stats.files;
    return hit.graph;
  }
  lastCacheOutcome = 'miss';
  // The index already holds the parsed artifacts AND the module graph built
  // from them, and cachedScan holds the metrics scan over the same set — so
  // a graph rebuild costs graph assembly only, never a re-parse.
  const graph = buildRepoGraph(root, {
    withMetrics: true,
    ignore: index.ignore,
    files: index.files,
    moduleGraph: index.moduleGraph,
    report: cachedScan(root, 6),
  });
  lastFilesTouched = graph.stats.files;
  graphCache.set(root, { gen, graph });
  return graph;
}

/**
 * Working-tree generation for a repo: the index bumps it whenever any file
 * changed, so every other cache invalidates off the same signal, never a
 * timer.
 */
function currentGeneration(root: string): number {
  return getIndex(root).generation;
}

// ---------------------------------------------------------------------------
// Tool definitions (MCP `tools/list` payload)
// ---------------------------------------------------------------------------

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

const PATH_PROP = {
  type: 'string',
  description: 'Repository root. OPTIONAL — defaults to the current project.',
};

export const TOOLS: ToolDefinition[] = [
  {
    name: 'repo_map',
    description:
      'CALL THIS FIRST in a new session instead of listing directories and reading entry files: one compact map of the whole repository — modules with their size and metrics, entry points, languages, test layout, dependency edges and cycles. Replaces the entire orientation phase for a fraction of the tokens.',
    inputSchema: { type: 'object', properties: { path: PATH_PROP } },
  },
  {
    name: 'file_outline',
    description:
      'Use this INSTEAD OF READING A FILE to see what is in it: every declaration with its exact line range, so you can then read only the one span you need. A file outline costs ~100 tokens; the file costs thousands.',
    inputSchema: {
      type: 'object',
      properties: { path: PATH_PROP, file: { type: 'string', description: 'Repository-relative file path.' } },
      required: ['file'],
    },
  },
  {
    name: 'read_function',
    description:
      'ALWAYS prefer this over reading a file to see one function: returns the EXACT source span of a function/class/type from the current working tree, plus its direct callers and callees so the next hop needs no search. Reading a 500-line file to inspect a 20-line function is the waste this replaces.',
    inputSchema: {
      type: 'object',
      properties: {
        path: PATH_PROP,
        function: { type: 'string', description: "Name, or 'file/path.ts#name' to disambiguate." },
        context: { type: 'number', description: 'Extra lines of context on each side (default 0).' },
        fresh: { type: 'boolean', description: 'Force a full re-send even if this session already received identical content (use after context compaction).' },
      },
      required: ['function'],
    },
  },
  {
    name: 'read_span',
    description:
      'Read an exact line range of one file when you already know the location (e.g. from file_outline or a stack trace). Never returns the whole file.',
    inputSchema: {
      type: 'object',
      properties: {
        path: PATH_PROP,
        file: { type: 'string', description: 'Repository-relative file path.' },
        startLine: { type: 'number', description: 'First line (1-based).' },
        endLine: { type: 'number', description: 'Last line (inclusive).' },
        fresh: { type: 'boolean', description: 'Force a full re-send even if this session already received identical content (use after context compaction).' },
      },
      required: ['file', 'startLine', 'endLine'],
    },
  },
  {
    name: 'find_symbol',
    description:
      'Use this INSTEAD OF grep to locate something: resolves a name or a phrase ("authentication middleware") to ranked declarations with exact file:line spans and a confidence per hit. Kills the grep-then-read-five-files cascade.',
    inputSchema: {
      type: 'object',
      properties: {
        path: PATH_PROP,
        query: { type: 'string', description: 'Symbol name or a short phrase describing it.' },
        limit: { type: 'number', description: 'Max candidates (default 8).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'find_references',
    description:
      'Use this INSTEAD OF a grep cascade to find every use of a symbol: definitions, call sites with exact lines, and import statements, each labeled by kind. Structural, not textual — comments and unrelated strings do not appear.',
    inputSchema: {
      type: 'object',
      properties: {
        path: PATH_PROP,
        symbol: { type: 'string', description: 'Exact symbol name.' },
        limit: { type: 'number', description: 'Max references (default 40).' },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'architecture_health',
    description:
      'ALWAYS use this instead of reading files when asked about code quality, architecture, or repo structure: one call returns the whole-repo health score (0-100), every module with its metrics, and the top structural issues — the complete picture that would otherwise take dozens of file reads.',
    inputSchema: {
      type: 'object',
      properties: {
        path: PATH_PROP,
        months: {
          type: 'number',
          description: 'Git co-change history window in months (default: 6).',
        },
      },
    },
  },
  {
    name: 'module_metrics',
    description:
      'Use this instead of reading a module’s files to judge its state: depth, seams, locality, leverage scores with the evidence behind them, for one module, in one call.',
    inputSchema: {
      type: 'object',
      properties: {
        path: PATH_PROP,
        module: {
          type: 'string',
          description:
            "Module name, e.g. 'payment' or 'services/auth'. Exact match first, then case-insensitive substring match.",
        },
      },
      required: ['module'],
    },
  },
  {
    name: 'similar_logic_exists',
    description:
      "USE THIS WHEN YOU DO NOT KNOW THE TARGET YET. Describe what you are looking for in words — \"sending an HTTP request\", \"validating a token\" — and it searches the WHOLE repository for existing implementations of that shape. It is the tool for \"are there duplicates in here?\", \"does similar logic already exist?\", and \"before I write this helper, has someone written it?\". Matching is structural (AST-level), so it finds copies that were RENAMED or reformatted — which grep cannot do — and returns each with file:line. Reading files one at a time to audit for duplication is the work this replaces.",
    inputSchema: {
      type: 'object',
      properties: { path: PATH_PROP },
    },
  },
  {
    name: 'impact_of',
    description:
      'ALWAYS use this instead of grep/reading files before editing a function: one call returns the full blast radius — every function that transitively calls it (grep only sees direct, same-name references), how many modules it spans, and the leverage of the owning module.',
    inputSchema: {
      type: 'object',
      properties: {
        path: PATH_PROP,
        function: { type: 'string', description: "Function name, or 'file/path.ts#name' to disambiguate." },
      },
      required: ['function'],
    },
  },
  {
    name: 'callers_of',
    description:
      'Use this first when asked who calls a function: one deterministic call-graph query returns direct AND transitive callers with file locations, far cheaper than reading candidate files. If it reports no callers, verify with a text search before concluding — dynamic and interface-dispatched calls can be invisible to the graph.',
    inputSchema: {
      type: 'object',
      properties: {
        path: PATH_PROP,
        function: { type: 'string', description: "Function name, or 'file/path.ts#name'." },
      },
      required: ['function'],
    },
  },
  {
    name: 'callees_of',
    description:
      'What does this function call? One deterministic call-graph query returns direct AND transitive callees with file locations — the reading list for understanding an implementation top-down, far cheaper than opening files. Empty means "no static callees in indexed source"; dynamic dispatch is invisible to the graph.',
    inputSchema: {
      type: 'object',
      properties: {
        path: PATH_PROP,
        function: { type: 'string', description: "Function name, or 'file/path.ts#name'." },
      },
      required: ['function'],
    },
  },
  {
    name: 'dependencies_of',
    description:
      'Which modules does this module import from? Module-level import edges with deep-import flags — the architecture view of "what does M stand on". Evidence is import edges in indexed source only; dynamic imports are invisible.',
    inputSchema: {
      type: 'object',
      properties: {
        path: PATH_PROP,
        module: { type: 'string', description: 'Module name (fuzzy match; a miss lists what exists).' },
      },
      required: ['module'],
    },
  },
  {
    name: 'dependents_of',
    description:
      'Which modules import this module? The inverse dependency view, with deep imports INTO the module flagged. An empty answer is not an "unused" claim: dynamic imports are invisible and entry points are imported by nothing by design.',
    inputSchema: {
      type: 'object',
      properties: {
        path: PATH_PROP,
        module: { type: 'string', description: 'Module name (fuzzy match; a miss lists what exists).' },
      },
      required: ['module'],
    },
  },
  {
    name: 'tests_for',
    description:
      'Which tests exercise this file or symbol? Route-labeled evidence — import edges (structural), name conventions, and static calls from test bodies. A hit list is evidence, never a coverage claim; an empty answer names its three routes and is NOT a claim the code is untested.',
    inputSchema: {
      type: 'object',
      properties: {
        path: PATH_PROP,
        target: { type: 'string', description: "A file ('src/x.ts'), a symbol address ('src/x.ts#name'), or a bare symbol name." },
      },
      required: ['target'],
    },
  },
  {
    name: 'check_my_changes',
    description:
      'You just edited code — what does the repository say about it? One call: changed files and symbols vs HEAD, boundary violations INTRODUCED by the diff (pre-existing stated separately), blast radius of modified symbols, route-labeled relevant tests, a delta policy check against the real HEAD state, and warnings when files you were served earlier have changed. Evidence and findings only — it never says a change is safe; that judgment stays with you.',
    inputSchema: {
      type: 'object',
      properties: { path: PATH_PROP },
    },
  },
  {
    name: 'boundary_check',
    description:
      'Does this module (or my current diff) violate the architecture boundaries? Deep imports past a module index and import cycles, module-scoped or diff-scoped (INTRODUCED-only, pre-existing stated). Checks the import-edge rules only — never a claim the architecture is sound.',
    inputSchema: {
      type: 'object',
      properties: {
        path: PATH_PROP,
        module: { type: 'string', description: 'Optional module scope; omit for diff scope (or whole-repo when git is absent).' },
      },
    },
  },
  {
    name: 'diff_context',
    description:
      'Working context for what I just changed: the spans of up to three added/modified symbols plus direct callers and route-labeled tests, with everything omitted stated by name. For the full picture use check_my_changes.',
    inputSchema: {
      type: 'object',
      properties: { path: PATH_PROP },
    },
  },
  {
    name: 'change_impact',
    description:
      'Blast radius of my whole diff: per modified symbol, everything that transitively calls it (static call graph — dynamic dispatch invisible, stated), plus the broken-callers note for removed symbols. Evidence only; the ship decision stays with you.',
    inputSchema: {
      type: 'object',
      properties: { path: PATH_PROP },
    },
  },
  {
    name: 'path_between',
    description:
      'Use this instead of tracing code by hand: the shortest call path between two functions — how one reaches the other — in one query.',
    inputSchema: {
      type: 'object',
      properties: {
        path: PATH_PROP,
        from: { type: 'string', description: 'Source function name.' },
        to: { type: 'string', description: 'Destination function name.' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'context_bundle',
    description:
      "START HERE when you are about to change, review, debug or understand one symbol. Returns its source, who calls it, what it calls, its signature types, the tests that reach it, its module, recent commits and blast radius — ONE budgeted answer instead of the find_symbol → read_function → callers_of → file_outline chain you would otherwise run by hand. Set intent to change/review/debug/understand to rank the sections; every section names the deeper call that serves more.",
    inputSchema: {
      type: 'object',
      properties: {
        path: PATH_PROP,
        target: { type: 'string', description: "Symbol name, or 'file/path.ts#name' to disambiguate." },
        intent: {
          type: 'string',
          enum: ['understand', 'change', 'debug', 'review'],
          description: "What you are doing — selects and ranks the sections. Default 'understand'.",
        },
      },
      required: ['target'],
    },
  },
  {
    name: 'compare_implementations',
    description:
      "Side-by-side EVIDENCE for deciding between two implementations of the same idea (a duplicate, a near-clone, a candidate to fold): both source spans, exactly what differs (structure vs literals), caller and test counts for each, and module context. It does NOT decide which copy is canonical — that is a judgment about intent and correctness only you can make; this hands you everything the judgment needs in one call instead of a file-reading session.",
    inputSchema: {
      type: 'object',
      properties: {
        path: PATH_PROP,
        a: { type: 'string', description: "First implementation: 'file/path.ts#name'." },
        b: { type: 'string', description: "Second implementation: 'file/path.ts#name'." },
      },
      required: ['a', 'b'],
    },
  },
  {
    name: 'query_repository',
    description:
      "Ask a repository question in plain language when you are not sure which specific tool fits — 'what breaks if I change X', 'who calls Y', 'where is JWT auth implemented'. Deterministically routes to the right query and resolves the target against the repository's own vocabulary. If it cannot resolve confidently it says so and names the candidates rather than guessing, so an answer here can be acted on.",
    inputSchema: {
      type: 'object',
      properties: {
        path: PATH_PROP,
        query: { type: 'string', description: 'The question, in plain language.' },
        fresh: { type: 'boolean', description: 'When the routed answer serves source, force a full re-send even if identical content was already served this session.' },
      },
      required: ['query'],
    },
  },
];

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export interface ToolResult {
  text: string;
  isError?: boolean;
}

export function callTool(name: string, args: Record<string, unknown>): ToolResult {
  const started = Date.now();
  // One tool call = one working-tree sweep, however many caches it touches.
  beginRequest();
  lastCacheOutcome = 'n/a';
  lastFilesTouched = 0;
  lastDedup = false;
  lastResolvedRoot = null;
  const out = dispatchTool(name, args);
  // Every call is measured locally: response shape, latency and cache
  // behavior are regression-testable without an LLM session.
  recordCall({
    tool: name,
    args,
    text: out.text,
    latencyMs: Date.now() - started,
    filesTouched: lastFilesTouched,
    cache: lastCacheOutcome,
    dedup: lastDedup,
    isError: out.isError === true,
    // The RESOLVED root, so pathless (cwd-defaulted) calls persist too —
    // the explicit-path condition made "instruments EVERY call" false.
    ...(lastResolvedRoot !== null ? { root: lastResolvedRoot } : {}),
  });
  return out;
}

function dispatchTool(name: string, args: Record<string, unknown>): ToolResult {
  try {
    switch (name) {
      case 'repo_map':
        return repoMapTool(args);
      case 'file_outline':
        return fileOutlineTool(args);
      case 'read_function':
        return readFunctionTool(args);
      case 'read_span':
        return readSpanTool(args);
      case 'find_symbol':
        return findSymbolTool(args);
      case 'find_references':
        return findReferencesTool(args);
      case 'architecture_health':
        return architectureHealthTool(args);
      case 'module_metrics':
        return moduleMetricsTool(args);
      case 'similar_logic_exists':
        return similarLogicExistsTool(args);
      case 'impact_of':
        return impactOfTool(args);
      case 'callers_of':
        return callersOfTool(args);
      case 'callees_of':
        return calleesOfTool(args);
      case 'dependencies_of':
        return moduleDepsTool(args, 'dependencies');
      case 'dependents_of':
        return moduleDepsTool(args, 'dependents');
      case 'tests_for':
        return testsForTool(args);
      case 'check_my_changes':
        return checkMyChangesTool(args);
      case 'boundary_check':
        return boundaryCheckTool(args);
      case 'diff_context':
        return diffContextTool(args);
      case 'change_impact':
        return changeImpactTool(args);
      case 'path_between':
        return pathBetweenTool(args);
      case 'query_repository':
        return queryRepositoryTool(args);
      case 'context_bundle':
        return contextBundleTool(args);
      case 'compare_implementations':
        return compareImplementationsTool(args);
      default:
        return {
          text: `Unknown tool: '${name}'. Available tools: ${TOOLS.map((t) => t.name).join(', ')}.`,
          isError: true,
        };
    }
  } catch (e) {
    return {
      text: `Tool '${name}' failed: ${e instanceof Error ? e.message : String(e)}`,
      isError: true,
    };
  }
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

// ── P0 source tools ────────────────────────────────────────────────────────

/** A single span never exceeds this many lines; beyond it, read_span. */
const MAX_SPAN_LINES = 160;

function repoMapTool(args: Record<string, unknown>): ToolResult {
  const root = repoPathArg(args);
  const { files, moduleGraph } = cachedParse(root);
  const report = cachedScan(root, 6);
  return { text: renderRepoMap({ root, report, files, moduleGraph }) };
}

function fileOutlineTool(args: Record<string, unknown>): ToolResult {
  const root = repoPathArg(args);
  const want = stringArg(args, 'file').replace(/\\/g, '/').replace(/^\.\//, '');
  const { files } = cachedParse(root);
  const file =
    files.find((f) => f.path === want) ??
    files.find((f) => f.path.endsWith(`/${want}`)) ??
    files.find((f) => f.path.toLowerCase() === want.toLowerCase());
  if (!file) {
    const near = files.filter((f) => f.path.includes(want.split('/').pop() ?? want)).slice(0, 5);
    return {
      text:
        `No indexed file '${want}'.` +
        (near.length > 0 ? ` Did you mean: ${near.map((f) => f.path).join(', ')}?` : ''),
      isError: true,
    };
  }
  return { text: renderOutline(buildOutline(file)) };
}

function readFunctionTool(args: Record<string, unknown>): ToolResult {
  const root = repoPathArg(args);
  const query = stringArg(args, 'function');
  const context = Math.max(0, Math.min(20, Number(args['context'] ?? 0) || 0));
  const { files } = cachedParse(root);
  const index = symbolIndex(files);

  // Qualified `file#name` is an ADDRESS, not a search: it matches the name
  // EXACTLY or it fails. Fuzzy-resolving it once returned a different
  // function's body for a symbol that did not exist — the worst possible
  // answer from a tool whose product is trustworthy source.
  let hit: SymbolHit | undefined;
  if (query.includes('#')) {
    const hash = query.lastIndexOf('#');
    const f = query.slice(0, hash).replace(/\\/g, '/').replace(/^\.\//, '');
    const n = query.slice(hash + 1);
    const inFile = index.filter((r) => r.file === f || r.file.endsWith(`/${f}`));
    if (inFile.length === 0) {
      return { text: `No indexed file '${f}' (searched ${root}).`, isError: true };
    }
    const exact = inFile.filter((r) => r.name === n);
    if (exact.length === 0) {
      const near = inFile.filter((r) => r.name.toLowerCase().includes(n.toLowerCase())).slice(0, 6);
      return {
        text:
          `No symbol named '${n}' in ${f}.` +
          (near.length > 0 ? ` Similar names there: ${near.map((r) => r.name).join(', ')}.` : '') +
          ` Use file_outline({ file: "${f}" }) to see what it declares.`,
        isError: true,
      };
    }
    if (exact.length > 1) {
      return {
        text:
          `'${n}' is declared ${exact.length} times in ${f} (overloads or same-named members):\n` +
          exact.map((r) => `  lines ${r.startLine}-${r.endLine} (${r.kind})`).join('\n') +
          `\nRead one directly with read_span({ file: "${f}", startLine, endLine }).`,
        isError: true,
      };
    }
    const r = exact[0]!;
    hit = { ...r, score: 1, why: 'exact' };
  } else {
    const hits = findSymbols(index, query, 8);
    if (hits.length === 0) {
      return {
        text: `No symbol matching '${query}' in ${root}. Try find_symbol({ query }) for a broader search, or repo_map for the layout.`,
        isError: true,
      };
    }
    const top = hits[0]!;
    const tied = hits.filter((h) => h.score === top.score);
    if (tied.length > 1) {
      return {
        text:
          `'${query}' resolves to ${tied.length} declarations with equal confidence:\n` +
          tied.map((h) => `  ${h.file}#${h.name} (${h.kind}, lines ${h.startLine}-${h.endLine})`).join('\n') +
          `\nRe-run with the full 'file#name' address.`,
        isError: true,
      };
    }
    hit = top;
  }

  // A doc comment directly above the declaration is part of the contract a
  // reader needs — omitting it forces the file read this tool exists to
  // prevent. `context` is added on top of it, never instead of it.
  const docStart = docCommentStart(root, hit.file, hit.startLine);
  const truncated = hit.endLine - hit.startLine + 1 > MAX_SPAN_LINES;
  const endLine = truncated ? hit.startLine + MAX_SPAN_LINES - 1 : hit.endLine;
  const span = readSpan(root, hit.file, Math.min(docStart, hit.startLine), endLine, context);

  const lines: string[] = [];
  // "declared export": exported at its declaration. Package-surface
  // reachability (re-export from an entry point) is a different fact this
  // engine does not compute — the bare word "exported" was misread as it.
  lines.push(`${hit.name} (${hit.kind}) — ${hit.file}:${hit.startLine}-${hit.endLine}${hit.exported ? ' · declared export' : ''}`);
  if (hit.why !== 'exact') lines.push(`[resolved by ${hit.why} match, confidence ${hit.score}]`);
  lines.push('');
  lines.push(renderSpan(span));
  if (truncated) {
    // The continuation starts after what was ACTUALLY served (context
    // included), so the caller never re-reads lines it already has.
    const next = span.endLine + 1;
    lines.push(
      `... truncated at ${MAX_SPAN_LINES} lines (${hit.endLine - span.endLine} more). ` +
        `Continue with read_span({ file: "${hit.file}", startLine: ${next}, endLine: ${hit.endLine} }).`,
    );
  }

  // Direct callers/callees make the next hop free — no exploratory search.
  const graph = cachedGraph(root);
  const fn = findFunction(graph, `${hit.file}#${hit.name}`);
  lines.push('');
  if ('node' in fn) {
    const callers = callersOf(graph, fn.node.id).filter((c) => c.depth === 1).slice(0, 6);
    const callees = calleesOf(graph, fn.node.id).filter((c) => c.depth === 1).slice(0, 6);
    // "(none in the static graph …)" — the bare "(none in graph)" read as a
    // fact about the code rather than about the graph's reach.
    const noneNote = '(none in the static graph — dynamic dispatch is invisible)';
    lines.push(`Called by: ${callers.length === 0 ? noneNote : callers.map((c) => `${c.label} (${c.file}:${c.line})`).join(', ')}`);
    lines.push(`Calls: ${callees.length === 0 ? noneNote : callees.map((c) => `${c.label} (${c.file}:${c.line})`).join(', ')}`);
  } else {
    // Say so rather than silently dropping the section a previous answer had.
    lines.push(
      `Called by / Calls: not available — '${hit.name}' is a ${hit.kind} and only functions carry call edges. ` +
        `Use find_references({ symbol: "${hit.name}" }) instead.`,
    );
  }

  // Session dedup: identical content already served to THIS session is
  // answered with a ~20-token receipt instead of re-polluting the context.
  // The hash covers the text about to be served, so an edit (which changes
  // the span or the footer) always re-sends in full; `fresh: true` is the
  // escape hatch for a session whose context was compacted.
  const text = lines.join('\n');
  const dedupKey = `read_function|${root}|${hit.file}#${hit.name}|${context}`;
  const { repeat, sha } = checkServed(dedupKey, text, args['fresh'] === true);
  if (repeat) {
    lastDedup = true;
    return {
      text: dedupReceipt(`${hit.name} — ${hit.file}:${hit.startLine}-${hit.endLine}`, sha),
    };
  }
  return { text };
}

/** First line of a doc comment (`/** ... *\/` or a `//` run) above a declaration. */
function docCommentStart(root: string, file: string, declLine: number): number {
  if (declLine <= 1) return declLine;
  try {
    // Look back at most 30 lines — enough for a doc block, never a scan.
    const look = readSpan(root, file, Math.max(1, declLine - 30), declLine - 1);
    const lines = look.text.split('\n');
    let i = lines.length - 1;
    let start = declLine;
    // Skip decorators/attributes attached to the declaration.
    while (i >= 0 && /^\s*[@[]/.test(lines[i] ?? '')) {
      start = look.startLine + i;
      i--;
    }
    if (i >= 0 && /\*\/\s*$/.test(lines[i] ?? '')) {
      while (i >= 0 && !/^\s*\/\*/.test(lines[i] ?? '')) i--;
      if (i >= 0) return look.startLine + i;
    }
    while (i >= 0 && /^\s*\/\//.test(lines[i] ?? '')) {
      start = look.startLine + i;
      i--;
    }
    return start;
  } catch {
    return declLine;
  }
}

function readSpanTool(args: Record<string, unknown>): ToolResult {
  const root = repoPathArg(args);
  const file = stringArg(args, 'file').replace(/\\/g, '/');
  const start = Number(args['startLine']);
  const end = Number(args['endLine']);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
    return { text: 'startLine/endLine must be integers with endLine >= startLine >= 1.', isError: true };
  }
  if (end - start + 1 > MAX_SPAN_LINES * 2) {
    return {
      text: `Refusing to serve ${end - start + 1} lines in one span (limit ${MAX_SPAN_LINES * 2}). Ask for a narrower range — file_outline shows where the boundaries are.`,
      isError: true,
    };
  }
  const indexed = requireIndexedFile(root, file);
  if ('error' in indexed) return { text: indexed.error, isError: true };
  const span = readSpan(root, indexed.path, start, end);
  const head =
    `${span.file}:${span.startLine}-${span.endLine} of ${span.totalLines} lines` +
    (span.clamped ? ' (requested range ran past the end of the file — clamped)' : '');
  const text = `${head}\n\n${renderSpan(span)}`;
  // Same dedup contract as read_function: content-hashed, edit-proof,
  // fresh:true escape hatch. See src/mcp/dedup.ts for the rules.
  const dedupKey = `read_span|${root}|${indexed.path}|${start}|${end}`;
  const { repeat, sha } = checkServed(dedupKey, text, args['fresh'] === true);
  if (repeat) {
    lastDedup = true;
    return {
      text: dedupReceipt(`${span.file}:${span.startLine}-${span.endLine}`, sha),
    };
  }
  return { text };
}

/**
 * Only INDEXED SOURCE is servable. The path argument makes the repo root
 * caller-chosen, so without this a request could read `.env`, `.git`
 * internals or any file on disk — this server's job is repository source,
 * and every servable file is one the scanner already discovered.
 */
function requireIndexedFile(root: string, want: string): { path: string } | { error: string } {
  const norm = want.replace(/\\/g, '/').replace(/^\.\//, '');
  const { files } = cachedParse(root);
  const hit =
    files.find((f) => f.path === norm) ??
    files.find((f) => f.path.endsWith(`/${norm}`)) ??
    files.find((f) => f.path.toLowerCase() === norm.toLowerCase());
  if (hit) return { path: hit.path };
  const near = files.filter((f) => f.path.includes(norm.split('/').pop() ?? norm)).slice(0, 5);
  return {
    error:
      `'${norm}' is not an indexed source file in ${root}. Only files the scanner indexed can be served.` +
      (near.length > 0 ? ` Did you mean: ${near.map((f) => f.path).join(', ')}?` : ''),
  };
}

function findSymbolTool(args: Record<string, unknown>): ToolResult {
  const root = repoPathArg(args);
  const query = stringArg(args, 'query');
  const limit = Math.max(1, Math.min(25, Number(args['limit'] ?? 8) || 8));
  const { files } = cachedParse(root);
  const hits = findSymbols(symbolIndex(files), query, limit);
  if (hits.length === 0) {
    return {
      text:
        `No declaration matching '${query}' in ${root} (${files.length} files indexed). ` +
        `Only indexed declarations are searched — unindexed files/languages and sub-declaration code (inline expressions, statement blocks) are invisible here. ` +
        `Try a shorter query, or repo_map for the module layout.`,
    };
  }
  const lines = [`${hits.length} candidate${hits.length === 1 ? '' : 's'} for '${query}':`, ''];
  for (const h of hits) {
    lines.push(
      `  ${h.name} (${h.kind}) — ${h.file}:${h.startLine}-${h.endLine}` +
        `  [${h.score} ${h.why}${h.exported ? ', declared export' : ''}]`,
    );
  }
  lines.push('');
  lines.push('Read one with read_function({ function: "file#name" }).');
  return { text: lines.join('\n') };
}

function findReferencesTool(args: Record<string, unknown>): ToolResult {
  const root = repoPathArg(args);
  const symbol = stringArg(args, 'symbol');
  const limit = Math.max(1, Math.min(200, Number(args['limit'] ?? 40) || 40));
  const { files } = cachedParse(root);
  const refs = findReferences(files, symbol);
  if (refs.length === 0) {
    // An empty result is an ANSWER, not a failure: isError makes an agent
    // treat the tool as broken and fall back to grep.
    return {
      text:
        `No references to '${symbol}' found in ${root}.` +
        (hasCallSites(files)
          ? ' Definitions, call sites and imports in INDEXED SOURCE were all searched. Boundary: string-built names, dynamic dispatch, and unindexed files (configs, templates, generated code) are invisible here — a text search is the check for those.'
          : ' Call sites are not indexed for this language yet — treat this as inconclusive and verify with a text search.'),
    };
  }
  const shown = refs.slice(0, limit);
  const lines = [`${refs.length} reference${refs.length === 1 ? '' : 's'} to '${symbol}':`, ''];
  for (const r of shown) {
    const loc = r.line === null ? `${r.file}:?` : `${r.file}:${r.line}`;
    // The source line itself, so a reference list is actionable without a
    // read_span per hit.
    const src = r.line === null ? '' : sourceLine(root, r.file, r.line);
    lines.push(
      `  ${r.kind.padEnd(11)} ${loc}${r.inFunction ? `  in ${r.inFunction}()` : ''}` + (src === '' ? '' : `\n      ${src}`),
    );
  }
  if (refs.length > shown.length) lines.push(`  ... and ${refs.length - shown.length} more (raise limit to see them)`);
  if (refs.some((r) => r.line === null)) {
    lines.push('');
    lines.push('NOTE: some imports show ":?" — this language\'s parser does not record import lines yet.');
  }
  if (!hasCallSites(files)) {
    lines.push('');
    lines.push('NOTE: call sites are not indexed for this language yet — imports and definitions only.');
  }
  return { text: lines.join('\n') };
}

/** One trimmed source line for a reference row (capped, never a file read). */
function sourceLine(root: string, file: string, line: number): string {
  try {
    const s = readSpan(root, file, line, line);
    const t = s.text.trim();
    return t.length > 120 ? `${t.slice(0, 117)}...` : t;
  } catch {
    return '';
  }
}

function architectureHealthTool(args: Record<string, unknown>): ToolResult {
  const root = repoPathArg(args);
  const months = monthsArg(args);
  const r = cachedScan(root, months);
  const a = r.averages;

  const lines: string[] = [];
  lines.push(`Architecture Health: ${r.health.score}/100 (${r.health.label})`);
  lines.push(
    `Repo: ${r.root} · ${r.filesScanned} files · ${r.modules.length} modules · git history ${r.gitAvailable ? `available (${months}-month window)` : 'unavailable'}`,
  );
  if (r.discoveryTruncated === true) {
    lines.push('⚠ discovery stopped at the file cap — this score describes a TRUNCATED view of the repository.');
  }
  if (r.skippedFiles !== undefined && r.skippedFiles.length > 0) {
    // A file that fails to parse vanishes from the graph; an unqualified
    // 0-100 score over a partially-parsed repo overclaims.
    lines.push(`Note: ${r.skippedFiles.length} file(s) failed to parse and are OUTSIDE this score.`);
  }
  lines.push('');
  lines.push(
    `Averages: Depth ${fmtAvg(a.depth)} · Seams ${fmtAvg(a.seams)} · Locality ${fmtAvg(a.locality)} · Leverage ${fmtAvg(a.leverage)} · Contamination ${r.contamination.score} (lower is better, ${r.contamination.label})`,
  );
  lines.push('');
  const top = r.opportunities.slice(0, 5);
  if (top.length === 0) {
    // Scoped negative: the metrics can only flag what they compute over
    // indexed, parsed files — never "this architecture has no problems".
    lines.push(
      'Top opportunities: none flagged within the six computed metrics (indexed, parsed files only — this is not a claim that no architectural issues exist).',
    );
  } else {
    lines.push('Top opportunities:');
    top.forEach((o, i) => lines.push(`${i + 1}. ${o}`));
  }
  return { text: lines.join('\n') };
}

function moduleMetricsTool(args: Record<string, unknown>): ToolResult {
  const root = repoPathArg(args);
  const query = stringArg(args, 'module');
  const r = cachedScan(root, 6);

  const found = findModule(r, query);
  if (typeof found === 'string') return { text: found, isError: true };
  const m = found;

  const lines: string[] = [];
  lines.push(`Module: ${m.name} (repo ${r.root})`);
  lines.push(
    `Files: ${m.files} · Code lines: ${m.codeLines} · Exports: ${m.exportedCount} · Caller modules: ${m.callerCount} · Export utilization: ${m.utilizationPct === null ? 'n/a' : `${m.utilizationPct}%`}`,
  );
  lines.push('');
  lines.push(fmtMetric('Depth', m.depth));
  lines.push(fmtMetric('Seams', m.seams));
  lines.push(fmtMetric('Locality', m.locality));
  lines.push(fmtMetric('Leverage', m.leverage));
  return { text: lines.join('\n') };
}

function similarLogicExistsTool(args: Record<string, unknown>): ToolResult {
  const root = repoPathArg(args);
  const r = cachedScan(root, 6);
  const findings = r.contamination.findings;
  // Same-module clones are excluded from the SCORE by design, but they are
  // exactly what "does this already exist?" is asking about. A benchmark
  // agent called this tool first on hono's adapters, got nothing back
  // because every adapter lives in one module, and read 29 files by hand —
  // the metric's filter was silently narrowing the tool.
  const intra = r.contamination.intraModule;

  // Near-clone tier: diverged copies exact hashing cannot see — renamed
  // functions whose literals drifted, and bodies whose structure itself
  // changed. ADDITIVE to the exact-hash tier: reported under its own label,
  // never folded into the contamination score, and pairs the exact tier
  // already reports are excluded here.
  const { files } = cachedParse(root);
  const exactPairs = new Set(
    [...findings, ...intra].map((f) =>
      [`${f.a.file}#${f.a.name}`, `${f.b.file}#${f.b.name}`].sort().join('|'),
    ),
  );
  const nearAll = detectAllNearClones(files).filter(
    (n) => !exactPairs.has([`${n.a.file}#${n.a.name}`, `${n.b.file}#${n.b.name}`].sort().join('|')),
  );
  const nearClones = nearAll.slice(0, NEAR_CLONE_CAP);

  // The evidence boundary, stated on EVERY answer — especially the negative
  // one. On 2026-08-13 a benchmark agent turned this tool's silence into
  // "everything else is already correctly centralized" while two real
  // duplicates sat BELOW declaration granularity (an inlined boolean
  // expression, an argument-object literal). The tool was never wrong; its
  // unstated scope let a negative be read as repository-wide. A negative
  // here must never claim more than its search surface.
  let declCount = 0;
  let fileCount = 0;
  for (const f of files) {
    if (f.isTest) continue;
    fileCount++;
    for (const fn of f.functions) if (!fn.name.startsWith('(')) declCount++;
  }
  const surface =
    `Search surface: ${declCount} function declarations across ${fileCount} non-test files` +
    (r.discoveryTruncated === true ? ' (discovery stopped at the file cap — these counts cover a TRUNCATED view of the repository)' : '') +
    `. ` +
    `NOT searched: inline expressions, statement blocks, argument literals, test files — duplication below declaration granularity is invisible here. ` +
    `A negative from this tool means "none found within that surface", never "no duplicates exist in the repository".`;

  if (findings.length === 0 && intra.length === 0 && nearClones.length === 0) {
    return {
      text:
        `no duplicate logic detected within indexed FUNCTION DECLARATIONS (structural, whole repo)\n` +
        `Contamination: ${r.contamination.score}/100 (${r.contamination.label}) · ${r.filesScanned} files scanned.\n` +
        `${surface}\n` +
        `Detection is AST-level: it finds exact copies (renaming-insensitive) and near-clones (drifted copies), and will NOT find two implementations that merely do the same thing differently.`,
    };
  }

  const lines: string[] = [];
  const total = findings.length + intra.length;
  lines.push(
    `${total} duplicate-logic finding${total > 1 ? 's' : ''} · contamination ${r.contamination.score}/100 (${r.contamination.label}, lower is better)`,
  );
  const row = (f: (typeof findings)[number], i: number): string => {
    const head = `${i + 1}. [${f.kind} ${f.confidence}%] ${f.a.file}:${f.a.line} ${f.a.name} ≈ ${f.b.file}:${f.b.line} ${f.b.name}`;
    if (f.groupSize === undefined || f.groupSize <= 2) return head;
    // A clone group is one fact, not N-choose-2 facts. Name the extra copies
    // inline so the reader sees the whole group without another call.
    const also = (f.alsoIn ?? []).map((x) => `${x.file}:${x.line}`).join(', ');
    const hidden = f.groupSize - 2 - (f.alsoIn?.length ?? 0);
    return `${head}\n     ${f.groupSize} copies total${also ? ` — also ${also}` : ''}${hidden > 0 ? ` (+${hidden} more)` : ''}`;
  };

  // Truncation is stated with the deterministic total, never implied by
  // silence — a capped list read without its total IS an exhaustiveness
  // claim, whatever the code intended.
  const shownOf = (shown: number, total: number): string =>
    total > shown ? `${shown} shown of ${total} total — TRUNCATED at ${shown}` : String(shown);
  if (findings.length > 0) {
    lines.push('');
    lines.push(
      `ACROSS modules (${shownOf(findings.length, r.contamination.findingsTotal)}) — these drive the contamination score:`,
    );
    findings.forEach((f, i) => lines.push(row(f, i)));
  }
  if (intra.length > 0) {
    lines.push('');
    lines.push(
      `WITHIN one module (${shownOf(intra.length, r.contamination.intraModuleTotal)}) — structural clones, NOT scored (duplication inside a module is a local refactor, not architectural contamination):`,
    );
    intra.forEach((f, i) => lines.push(row(f, i)));
  }
  if (nearClones.length > 0) {
    lines.push('');
    lines.push(
      `NEAR-CLONES (${shownOf(nearClones.length, nearAll.length)}) — DIVERGED copies, not exact matches; each names what drifted. Decide between copies with compare_implementations({ a, b }):`,
    );
    nearClones.forEach((n, i) => {
      lines.push(
        `${i + 1}. [near-clone${n.kind === 'structural' ? ` ~${Math.round(n.similarity * 100)}%` : ''}] ${n.a.file}:${n.a.line} ${n.a.name} ≈ ${n.b.file}:${n.b.line} ${n.b.name}`,
      );
      lines.push(`     ${n.divergence}`);
    });
  }
  lines.push('');
  lines.push(surface);
  lines.push('Import the existing implementation instead of writing a new one; fold near-clones only after comparing them.');
  return { text: lines.join('\n') };
}

function impactOfTool(args: Record<string, unknown>): ToolResult {
  const root = repoPathArg(args);
  const graph = cachedGraph(root);
  const r = findFunction(graph, stringArg(args, 'function'));
  if ('error' in r) return graphMiss(r);
  const imp = impactOf(graph, r.node.id);

  const lines: string[] = [];
  lines.push(matchNote(r.match, stringArg(args, 'function'), r.node));
  lines.push(`Blast radius of ${imp.target.label} (${imp.target.file}:${imp.target.line})`);
  lines.push(`[${imp.blastRadius}] ${imp.summary}`);
  if (imp.affectedModules.length) lines.push(`Modules affected: ${imp.affectedModules.join(', ')}`);
  if (imp.moduleLeverage !== null) lines.push(`Owning module leverage: ${imp.moduleLeverage}/100`);
  lines.push('');
  if (imp.affectedFunctions.length === 0) {
    // Never assert isolation as a fact — the graph sees static calls in
    // indexed source only. This exact line once claimed "changing this is
    // isolated" about a function the graph simply could not see into.
    lines.push(
      'No callers found in the static call graph — nothing indexed calls it. ' +
        'Boundary: dynamic dispatch, reflection, framework wiring and unindexed files are invisible to the graph; ' +
        'confirm with a text search for the name before treating a change as isolated.',
    );
  } else {
    lines.push('Callers (transitive):');
    imp.affectedFunctions.slice(0, 15).forEach((a) => lines.push(`  d${a.depth} ${a.label} — ${a.file}:${a.line}${confMark(a.confidence)}`));
    if (imp.affectedFunctions.length > 15) lines.push(`  … ${imp.affectedFunctions.length - 15} more`);
  }
  // Name the cheapest next step so the follow-up is not a grep.
  lines.push('');
  lines.push(
    `Exact call sites with their source lines: find_references({ symbol: "${imp.target.label}" }). ` +
      `Read the target: read_function({ function: "${imp.target.file}#${imp.target.label}" }).`,
  );
  return { text: lines.join('\n') };
}

function callersOfTool(args: Record<string, unknown>): ToolResult {
  const root = repoPathArg(args);
  const graph = cachedGraph(root);
  const r = findFunction(graph, stringArg(args, 'function'));
  if ('error' in r) return graphMiss(r);
  const list = callersOf(graph, r.node.id);
  const note = matchNote(r.match, stringArg(args, 'function'), r.node);
  if (list.length === 0) {
    return {
      text:
        `${note}${r.node.label} has no callers in the graph. ` +
        `Boundary: static calls in indexed source only — dynamic dispatch, reflection and unindexed files are invisible; ` +
        `verify with a text search before concluding it is unused.` +
        unresolvedLowerBound(graph),
    };
  }
  const lines = [note + `${list.length} transitive callers of ${r.node.label}:`, ''];
  list.slice(0, 25).forEach((a) => lines.push(`  d${a.depth} ${a.label} — ${a.file}:${a.line}${confMark(a.confidence)}`));
  if (list.length > 25) lines.push(`  … ${list.length - 25} more`);
  // Every response names the cheapest next step: an agent that wants
  // the exact call-site lines should not go back to grep for them.
  lines.push('');
  lines.push(
    `For the exact call-site lines with their source: find_references({ symbol: "${r.node.label}" }). ` +
      `To read one of these: read_function({ function: "file#name" }).`,
  );
  return { text: lines.join('\n') };
}

/**
 * callees_of — everything this function calls, direct and transitive.
 *
 * The exact mirror of callers_of: it walks each node's outgoing call edges
 * (callsOut) instead of its incoming ones, and states the same boundary —
 * static calls in indexed source only.
 */
function calleesOfTool(args: Record<string, unknown>): ToolResult {
  const root = repoPathArg(args);
  const graph = cachedGraph(root);
  const r = findFunction(graph, stringArg(args, 'function'));
  if ('error' in r) return graphMiss(r);
  const list = calleesOf(graph, r.node.id);
  const note = matchNote(r.match, stringArg(args, 'function'), r.node);
  if (list.length === 0) {
    return {
      text:
        `${note}${r.node.label} has no callees in the graph. ` +
        `Boundary: static calls in indexed source only — dynamic dispatch, reflection and unindexed files are invisible; ` +
        `the function may still invoke code the graph cannot see.` +
        unresolvedLowerBound(graph),
    };
  }
  const lines = [note + `${list.length} transitive callees of ${r.node.label}:`, ''];
  list.slice(0, 25).forEach((a) => lines.push(`  d${a.depth} ${a.label} — ${a.file}:${a.line}${confMark(a.confidence)}`));
  if (list.length > 25) lines.push(`  … ${list.length - 25} more`);
  lines.push('');
  lines.push(
    `To read one of these: read_function({ function: "file#name" }). ` +
      `For everything that depends on ${r.node.label} instead: callers_of.`,
  );
  return { text: lines.join('\n') };
}

/**
 * check_my_changes — what the working tree changed against HEAD, and what
 * the repository can say about those changes.
 *
 * The contract: findings + boundaries, NEVER a safety verdict. The words
 * "safe", "isolated" or "no impact" never appear as facts; the merge
 * decision stays with the agent. Boundary findings are NEWLY-INTRODUCED
 * only, with the pre-existing count stated (no silent baseline). Every
 * section names what it cannot see.
 */
function checkMyChangesTool(args: Record<string, unknown>): ToolResult {
  const root = repoPathArg(args);
  const { files, moduleGraph } = cachedParse(root);
  const byPath = new Map(files.map((f) => [f.path, f]));
  const d = diffWorktree(root, byPath, getIndex(root).ignore);

  if (!d.gitAvailable) {
    return {
      text:
        `Diff-based analysis unavailable: ${d.unavailableReason}. ` +
        `Worktree-only views still work: repo_map, architecture_health, similar_logic_exists.`,
    };
  }

  const scopeLine =
    `Scope: tracked changes vs HEAD ${d.head} plus untracked CODE files. Not diffed: binary/oversized blobs, ` +
    `non-code files, unindexed languages, line-ending-only differences. Symbol diff covers FUNCTION declarations — type-only edits appear as file-level changes.`;

  if (d.changedFiles.length === 0) {
    return {
      text:
        `No changes vs HEAD ${d.head}.\n${scopeLine}` +
        (d.skipped.length > 0 ? `\nSkipped: ${d.skipped.map((s) => `${s.path} (${s.reason})`).join('; ')}` : ''),
    };
  }

  const lines: string[] = [];
  lines.push(`Changes vs HEAD ${d.head}`);
  lines.push(scopeLine);
  if (d.skipped.length > 0) {
    lines.push(`Skipped from the symbol diff (${d.skipped.length}): ${d.skipped.slice(0, 5).map((s) => `${s.path} (${s.reason})`).join('; ')}${d.skipped.length > 5 ? ' …' : ''}`);
  }

  lines.push('');
  lines.push(`Changed files (${d.changedFiles.length}):`);
  d.changedFiles.slice(0, 20).forEach((c) => {
    lines.push(`  [${c.status}] ${c.path}${c.oldPath !== undefined ? ` (was ${c.oldPath})` : ''}`);
  });
  if (d.changedFiles.length > 20) lines.push(`  … ${d.changedFiles.length - 20} more`);

  if (d.symbolChanges.length > 0) {
    lines.push('');
    lines.push(`Changed symbols (${d.symbolChanges.length}):`);
    d.symbolChanges.slice(0, 20).forEach((s) => {
      const loc = s.kind === 'removed' ? `was ${s.file}:${s.oldLine ?? '?'}` : `${s.file}:${s.line ?? '?'}`;
      lines.push(`  [${s.kind}] ${s.name} — ${loc}`);
    });
    if (d.symbolChanges.length > 20) lines.push(`  … ${d.symbolChanges.length - 20} more`);
  }

  // ── Boundary: NEWLY-INTRODUCED deep imports only ──────────────────────────
  // Old state = the hybrid HEAD view (current parses, with changed files
  // swapped for their HEAD parses), shared with boundary_check via the
  // engine so the two can never disagree on what "old" means.
  const oldFiles = hybridOldFiles(files, d);
  const oldGraph = buildGraph(oldFiles);
  const edgeKey = (e: { fromFile: string; toFile: string }): string => `${e.fromFile}|${e.toFile}`;
  const oldEdges = new Set(oldGraph.deepImports.map(edgeKey));
  const newlyIntroduced = moduleGraph.deepImports.filter((e) => !oldEdges.has(edgeKey(e)));
  const preExisting = moduleGraph.deepImports.length - newlyIntroduced.length;
  lines.push('');
  if (newlyIntroduced.length === 0) {
    lines.push(
      `Boundary: no deep-import violations INTRODUCED by this diff (pre-existing, unchanged: ${preExisting}). ` +
        `Within the import-edge boundary rule only — not a claim the architecture is sound.`,
    );
  } else {
    lines.push(`Boundary: ${newlyIntroduced.length} deep-import violation${newlyIntroduced.length === 1 ? '' : 's'} INTRODUCED by this diff (pre-existing, unchanged: ${preExisting}):`);
    newlyIntroduced.slice(0, 8).forEach((e) => lines.push(`  ${e.fromFile} → ${e.toFile} (reaches into ${e.toModule} internals)`));
    if (newlyIntroduced.length > 8) lines.push(`  … ${newlyIntroduced.length - 8} more`);
  }

  // ── Blast radius of modified symbols (static graph, stated) ───────────────
  const graph = cachedGraph(root);
  const modified = d.symbolChanges.filter((s) => s.kind === 'modified');
  const removed = d.symbolChanges.filter((s) => s.kind === 'removed');
  const affected = new Map<string, { label: string; file?: string; line?: number }>();
  for (const s of modified.slice(0, 10)) {
    const r = findFunction(graph, `${s.file}#${s.name}`);
    if ('error' in r) continue;
    for (const a of callersOf(graph, r.node.id)) {
      affected.set(a.label + (a.file ?? ''), { label: a.label, file: a.file, line: a.line });
    }
  }
  lines.push('');
  if (modified.length === 0 && removed.length === 0) {
    lines.push('Blast radius: no modified or removed symbols — nothing to trace in the call graph.');
  } else {
    lines.push(
      `Blast radius (static call graph — dynamic dispatch and unindexed files are invisible): ` +
        `${affected.size} function${affected.size === 1 ? '' : 's'} transitively call the ${modified.length} modified symbol${modified.length === 1 ? '' : 's'}.`,
    );
    [...affected.values()].slice(0, 10).forEach((a) => lines.push(`  ${a.label}${a.file !== undefined ? ` — ${a.file}:${a.line}` : ''}`));
    if (affected.size > 10) lines.push(`  … ${affected.size - 10} more`);
    if (removed.length > 0) {
      lines.push(
        `Removed symbols (${removed.length}): ${removed.slice(0, 6).map((s) => s.name).join(', ')}${removed.length > 6 ? ' …' : ''} — ` +
          `any remaining callers now reference a missing symbol; find_references({ symbol }) locates them.`,
      );
    }
  }

  // ── Relevant tests (route-labeled; never a coverage claim) ────────────────
  const testHits = new Map<string, Set<string>>();
  const changedCode = d.changedFiles.filter((c) => c.status !== 'deleted' && byPath.has(c.path)).slice(0, 8);
  for (const c of changedCode) {
    for (const h of testsFor(files, { file: c.path })) {
      const set = testHits.get(h.file) ?? new Set<string>();
      h.routes.forEach((r) => set.add(r));
      testHits.set(h.file, set);
    }
  }
  for (const s of d.symbolChanges.slice(0, 12)) {
    if (s.kind === 'removed') continue;
    for (const h of testsFor(files, { symbol: s.name })) {
      const set = testHits.get(h.file) ?? new Set<string>();
      h.routes.forEach((r) => set.add(r));
      testHits.set(h.file, set);
    }
  }
  lines.push('');
  if (testHits.size === 0) {
    lines.push(`Relevant tests: none found. ${TESTS_FOR_EMPTY_BOUNDARY}`);
  } else {
    lines.push(`Relevant tests (${testHits.size} — route-labeled evidence, not coverage):`);
    [...testHits.entries()].sort().slice(0, 6).forEach(([f, routes]) => lines.push(`  ${f} [${[...routes].sort().join(', ')}]`));
    if (testHits.size > 6) lines.push(`  … ${testHits.size - 6} more`);
  }

  // ── Policy verdict vs HEAD (delta rules on real HEAD contamination) ──────
  const report = cachedScan(root, 6);
  const oldContam = contamination(oldFiles, oldGraph);
  const baseLite = { ...report, contamination: oldContam } as typeof report;
  const policy = { rules: ratchetPolicy('warn').rules.filter((r) => r.type !== 'health-delta') };
  const verdict = evaluatePolicy(policy, report, baseLite);
  lines.push('');
  if (verdict.violations.length === 0) {
    lines.push(
      `Policy (default ratchet, ${policy.rules.length} rules): no violations. ` +
        `health-delta vs HEAD is NOT evaluated by this tool (needs a full HEAD scan); duplication deltas ARE evaluated against the real HEAD state.`,
    );
  } else {
    lines.push(`Policy (default ratchet): ${verdict.violations.length} violation${verdict.violations.length === 1 ? '' : 's'}${verdict.blocked ? ' (BLOCK-mode among them)' : ''}:`);
    verdict.violations.slice(0, 5).forEach((v) => lines.push(`  [${v.mode}] ${v.message}`));
    lines.push('  (health-delta vs HEAD not evaluated by this tool — needs a full HEAD scan.)');
  }

  // ── Stale-assumption warnings (only what this session was served) ─────────
  const servedSet = servedFiles(root);
  const stale = d.changedFiles.filter((c) => servedSet.has(c.path) || (c.oldPath !== undefined && servedSet.has(c.oldPath)));
  if (stale.length > 0) {
    lines.push('');
    lines.push(
      `Stale-assumption warning: you were served source from ${stale.length} of these files earlier in this session — ` +
        `${stale.slice(0, 5).map((c) => c.path).join(', ')}${stale.length > 5 ? ' …' : ''}. Re-read before relying on what you saw (fresh: true).`,
    );
  }

  lines.push('');
  lines.push(
    'This is evidence, not a verdict: whether these changes should ship is a judgment about intent and correctness that stays with you.',
  );
  return { text: lines.join('\n') };
}

/**
 * boundary_check — the boundary section of check_my_changes as a standalone
 * question, module-scoped or diff-scoped. Negatives are scoped to the checks
 * actually performed (deep imports past a module index, and import cycles) —
 * never a soundness claim about the architecture as a whole.
 */
function boundaryCheckTool(args: Record<string, unknown>): ToolResult {
  const root = repoPathArg(args);
  const { files, moduleGraph } = cachedParse(root);
  const rawModule = typeof args['module'] === 'string' && args['module'].length > 0 ? args['module'] : null;
  const scopeLine =
    'Checked: deep imports (imports reaching past a module\'s index into internals) and import cycles — the import-edge boundary rules only. Not a claim the architecture is sound.';

  if (rawModule !== null) {
    const known = [...new Set([...files.map((f) => f.module), ...moduleGraph.imports.keys(), ...moduleGraph.importedBy.keys()])].sort();
    const mod = known.find((m) => m === rawModule) ?? known.find((m) => m.toLowerCase().includes(rawModule.toLowerCase()));
    if (mod === undefined) {
      return { text: `Module '${rawModule}' not found. Available modules: ${known.join(', ') || '(none indexed)'}.`, isError: true };
    }
    const into = moduleGraph.deepImports.filter((e) => e.toModule === mod);
    const cycles = moduleGraph.cycles.filter((c) => c.includes(mod));
    const lines: string[] = [`Boundary check for module ${mod}:`];
    if (into.length === 0) lines.push(`  No deep imports INTO ${mod} recorded.`);
    else {
      lines.push(`  Deep imports INTO ${mod} (${into.length}):`);
      into.slice(0, 8).forEach((e) => lines.push(`    ${e.fromFile} → ${e.toFile}`));
      if (into.length > 8) lines.push(`    … ${into.length - 8} more`);
    }
    if (cycles.length > 0) {
      lines.push(`  Import cycles involving ${mod} (${cycles.length}): ${cycles.slice(0, 3).map((c) => c.join(' → ')).join('; ')}${cycles.length > 3 ? ' …' : ''}`);
    } else {
      lines.push(`  No import cycles involving ${mod} detected.`);
    }
    lines.push(scopeLine);
    return { text: lines.join('\n') };
  }

  // Diff scope when git is available; whole-repo view otherwise.
  const d = diffWorktree(root, new Map(files.map((f) => [f.path, f])), getIndex(root).ignore);
  if (!d.gitAvailable) {
    const total = moduleGraph.deepImports.length;
    const lines = [`Boundary check (whole repository — ${d.unavailableReason}, so no diff scope):`];
    lines.push(`  Deep imports: ${total}${total > 0 ? ` — e.g. ${moduleGraph.deepImports.slice(0, 5).map((e) => `${e.fromFile} → ${e.toFile}`).join('; ')}` : ''}`);
    lines.push(`  Import cycles: ${moduleGraph.cycles.length}`);
    lines.push(scopeLine);
    return { text: lines.join('\n') };
  }
  const oldGraphB = buildGraph(hybridOldFiles(files, d));
  const keyB = (e: { fromFile: string; toFile: string }): string => `${e.fromFile}|${e.toFile}`;
  const oldSet = new Set(oldGraphB.deepImports.map(keyB));
  const fresh = moduleGraph.deepImports.filter((e) => !oldSet.has(keyB(e)));
  const lines = [`Boundary check (diff scope, vs HEAD ${d.head}):`];
  if (fresh.length === 0) {
    lines.push(`  No deep-import violations INTRODUCED by this diff (pre-existing, unchanged: ${moduleGraph.deepImports.length}).`);
  } else {
    lines.push(`  ${fresh.length} deep-import violation${fresh.length === 1 ? '' : 's'} INTRODUCED (pre-existing: ${moduleGraph.deepImports.length - fresh.length}):`);
    fresh.slice(0, 8).forEach((e) => lines.push(`    ${e.fromFile} → ${e.toFile} (into ${e.toModule} internals)`));
  }
  lines.push(scopeLine);
  return { text: lines.join('\n') };
}

/**
 * diff_context — working context for what just changed. Serves the SPANS of
 * up to three added/modified symbols plus direct callers and route-labeled
 * tests, and states exactly what was omitted: a span boundary is a recall
 * boundary, so every cut is named by count and by name, never left silent.
 */
function diffContextTool(args: Record<string, unknown>): ToolResult {
  const root = repoPathArg(args);
  const { files } = cachedParse(root);
  const d = diffWorktree(root, new Map(files.map((f) => [f.path, f])), getIndex(root).ignore);
  if (!d.gitAvailable) {
    return {
      text: `Diff-based analysis unavailable: ${d.unavailableReason}. context_bundle({ target }) gives working context without a diff.`,
    };
  }
  const interesting = d.symbolChanges.filter((s) => s.kind !== 'removed');
  if (interesting.length === 0) {
    return {
      text:
        `No added or modified symbols vs HEAD ${d.head} to contextualize` +
        (d.symbolChanges.length > 0 ? ` (${d.symbolChanges.length} removed symbol(s) — check_my_changes covers those)` : '') +
        `. Scope: function declarations in the diff.`,
    };
  }
  const graph = cachedGraph(root);
  const shown = interesting.slice(0, 3);
  const lines: string[] = [`Context for ${shown.length} of ${interesting.length} changed symbol${interesting.length === 1 ? '' : 's'} (vs HEAD ${d.head}):`];
  for (const s of shown) {
    lines.push('');
    lines.push(`── [${s.kind}] ${s.file}#${s.name}`);
    const file = files.find((f) => f.path === s.file);
    const fn = file?.functions.find((f) => f.name === s.name);
    if (fn === undefined) {
      lines.push('  (span unavailable — symbol not in the current index)');
      continue;
    }
    const start = fn.declLine ?? fn.startLine;
    const end = Math.min(fn.endLine, start + 29);
    try {
      lines.push(renderSpan(readSpan(root, s.file, start, end)));
      if (end < fn.endLine) lines.push(`  … span cut at 30 lines (${fn.endLine - end} more) — read_function({ function: "${s.file}#${s.name}" }) serves the full body.`);
    } catch {
      lines.push('  (span unavailable)');
    }
    const r = findFunction(graph, `${s.file}#${s.name}`);
    if (!('error' in r)) {
      const direct = callersOf(graph, r.node.id).filter((a) => a.depth === 1).slice(0, 3);
      lines.push(direct.length === 0
        ? '  Direct callers: (none in the static graph — dynamic dispatch is invisible)'
        : `  Direct callers: ${direct.map((a) => `${a.label} (${a.file}:${a.line})`).join(', ')}`);
    }
    const th = testsFor(files, { file: s.file, symbol: s.name }).slice(0, 2);
    lines.push(th.length === 0
      ? `  Tests: none found via the three routes (not a claim the code is untested).`
      : `  Tests: ${th.map((h) => `${h.file} [${h.routes.join(', ')}]`).join('; ')}`);
  }
  if (interesting.length > shown.length) {
    lines.push('');
    lines.push(`… ${interesting.length - shown.length} more changed symbols not shown — check_my_changes lists them all.`);
  }
  return { text: lines.join('\n') };
}

/**
 * change_impact — the blast radius of the whole diff, per modified symbol,
 * with the static-graph boundary stated on the answer itself (dynamic
 * dispatch and unindexed files are invisible). Evidence only; whether the
 * diff should ship stays with the caller.
 */
function changeImpactTool(args: Record<string, unknown>): ToolResult {
  const root = repoPathArg(args);
  const { files } = cachedParse(root);
  const d = diffWorktree(root, new Map(files.map((f) => [f.path, f])), getIndex(root).ignore);
  if (!d.gitAvailable) {
    return { text: `Diff-based analysis unavailable: ${d.unavailableReason}. impact_of({ function }) traces a single symbol without a diff.` };
  }
  const modified = d.symbolChanges.filter((s) => s.kind === 'modified');
  const removed = d.symbolChanges.filter((s) => s.kind === 'removed');
  if (modified.length === 0 && removed.length === 0) {
    return {
      text: `No modified or removed symbols vs HEAD ${d.head} — nothing to trace in the call graph. (Added symbols have no callers yet by definition.)`,
    };
  }
  const graph = cachedGraph(root);
  const lines: string[] = [`Change impact vs HEAD ${d.head} (static call graph — dynamic dispatch and unindexed files are invisible):`];
  const union = new Set<string>();
  for (const s of modified.slice(0, 8)) {
    const r = findFunction(graph, `${s.file}#${s.name}`);
    if ('error' in r) continue;
    const imp = impactOf(graph, r.node.id);
    imp.affectedFunctions.forEach((a) => union.add(a.label + (a.file ?? '')));
    lines.push('');
    lines.push(`[${imp.blastRadius}] ${s.name} — ${imp.summary}`);
    imp.affectedFunctions.slice(0, 5).forEach((a) => lines.push(`  d${a.depth} ${a.label} — ${a.file}:${a.line}${confMark(a.confidence)}`));
    if (imp.affectedFunctions.length > 5) lines.push(`  … ${imp.affectedFunctions.length - 5} more`);
  }
  if (modified.length > 8) lines.push(`… ${modified.length - 8} more modified symbols not traced — check_my_changes lists them.`);
  lines.push('');
  lines.push(`Union: ${union.size} distinct function${union.size === 1 ? '' : 's'} transitively affected by the ${modified.length} modified symbol${modified.length === 1 ? '' : 's'}.`);
  if (removed.length > 0) {
    lines.push(
      `Removed symbols (${removed.length}): ${removed.slice(0, 6).map((s) => s.name).join(', ')}${removed.length > 6 ? ' …' : ''} — remaining callers now reference a missing symbol; find_references({ symbol }) locates them.`,
    );
  }
  return { text: lines.join('\n') };
}

/**
 * tests_for — which test files reach a file or symbol. Target forms:
 * 'file/path.ts', 'file/path.ts#name' or a bare symbol name (resolved
 * through the symbol index; ambiguity is answered, never guessed). Every hit
 * is route-labeled; the empty answer names all three routes and never claims
 * the code is untested.
 */
function testsForTool(args: Record<string, unknown>): ToolResult {
  const root = repoPathArg(args);
  const raw = stringArg(args, 'target');
  const { files } = cachedParse(root);

  let targetFile: string | undefined;
  let targetSymbol: string | undefined;
  if (raw.includes('#')) {
    const [f, n] = raw.split('#');
    targetFile = f;
    targetSymbol = n;
  } else if (/[\\/]/.test(raw) || /\.[a-z]{1,5}$/i.test(raw)) {
    targetFile = raw.replaceAll('\\', '/');
  } else {
    targetSymbol = raw;
    const decls = files.filter((f) => !f.isTest && f.functions.some((fn) => fn.name === raw));
    if (decls.length === 1) targetFile = decls[0]!.path;
    else if (decls.length > 1) {
      return {
        text:
          `'${raw}' is declared in ${decls.length} files: ${decls.slice(0, 6).map((f) => f.path).join(', ')}${decls.length > 6 ? ', …' : ''}. ` +
          `Pick one: tests_for({ target: "file/path#${raw}" }).`,
        isError: true,
      };
    }
  }
  if (targetFile !== undefined && !files.some((f) => f.path === targetFile)) {
    return {
      text: `No indexed file '${targetFile}'. file_outline or find_symbol can locate the target first.`,
      isError: true,
    };
  }

  const hits = testsFor(files, { file: targetFile, symbol: targetSymbol });
  const label = targetFile !== undefined ? targetFile + (targetSymbol !== undefined ? `#${targetSymbol}` : '') : targetSymbol!;
  if (hits.length === 0) {
    return { text: `Tests for ${label}: none found. ${TESTS_FOR_EMPTY_BOUNDARY}` };
  }
  const lines = [`${hits.length} test file${hits.length === 1 ? '' : 's'} for ${label} (route-labeled evidence, not coverage):`, ''];
  hits.slice(0, 10).forEach((h) => {
    lines.push(`  ${h.file}`);
    h.routes.forEach((r, i) => lines.push(`    [${r}] ${h.details[i]}`));
  });
  if (hits.length > 10) lines.push(`  … ${hits.length - 10} more test files`);
  lines.push('');
  lines.push(
    'Routes: import-edge (structural), name-convention (convention), test-call (static, name-level). ' +
      'Dynamic/parameterized test discovery is invisible — a hit list is evidence, never a coverage claim.',
  );
  return { text: lines.join('\n') };
}

/**
 * dependencies_of / dependents_of — module-level import-edge views. Shared
 * renderer; the direction decides which side of the module graph is read.
 * Boundary stated on EVERY answer: import edges in indexed source only, and
 * an empty dependents list is never an "unused module" claim — the same rule
 * impact_of applies to functions, applied here at module level.
 */
function moduleDepsTool(args: Record<string, unknown>, direction: 'dependencies' | 'dependents'): ToolResult {
  const root = repoPathArg(args);
  const query = stringArg(args, 'module');
  const { files, moduleGraph } = cachedParse(root);
  // ALL modules, not just those with edges: a module with zero import edges
  // is precisely the empty-answer case whose honesty statement matters —
  // reporting it "not found" would hide the module behind its isolation.
  const known = [
    ...new Set([
      ...files.map((f) => f.module),
      ...moduleGraph.imports.keys(),
      ...moduleGraph.importedBy.keys(),
    ]),
  ].sort();
  const mod =
    known.find((m) => m === query) ??
    known.find((m) => m.toLowerCase() === query.toLowerCase()) ??
    known.find((m) => m.toLowerCase().includes(query.toLowerCase()));
  if (mod === undefined) {
    return {
      text: `Module '${query}' not found. Available modules: ${known.join(', ') || '(none indexed)'}.`,
      isError: true,
    };
  }
  const scope =
    'Evidence: import edges in indexed source only — dynamic imports, require-by-variable and unindexed files are invisible here.';
  const set = direction === 'dependencies' ? moduleGraph.imports.get(mod) : moduleGraph.importedBy.get(mod);
  const others = [...(set ?? [])].sort();
  const deepIn = moduleGraph.deepImports.filter((d) => d.toModule === mod);

  const lines: string[] = [];
  if (direction === 'dependencies') {
    lines.push(
      others.length === 0
        ? `Module ${mod} imports from no other module in the graph.`
        : `Module ${mod} imports from ${others.length} module${others.length === 1 ? '' : 's'}:`,
    );
    others.forEach((o) => lines.push(`  ${mod} → ${o}`));
  } else {
    if (others.length === 0) {
      lines.push(
        `No importing modules in the graph for ${mod}. This is not a claim the module is unused: ` +
          `dynamic import / require-by-variable edges are invisible, and an entry point is imported by nothing by design.`,
      );
    } else {
      lines.push(`Module ${mod} is imported by ${others.length} module${others.length === 1 ? '' : 's'}:`);
      others.forEach((o) => lines.push(`  ${o} → ${mod}`));
    }
  }
  if (deepIn.length > 0) {
    lines.push('');
    lines.push(
      `Deep imports INTO ${mod} (${deepIn.length} — imports reaching past its index into internals):`,
    );
    deepIn.slice(0, 8).forEach((d) => lines.push(`  ${d.fromFile} → ${d.toFile}`));
    if (deepIn.length > 8) lines.push(`  … ${deepIn.length - 8} more`);
  }
  lines.push('');
  lines.push(scope);
  lines.push(`Per-module metrics: module_metrics({ module: "${mod}" }).`);
  return { text: lines.join('\n') };
}

function pathBetweenTool(args: Record<string, unknown>): ToolResult {
  const root = repoPathArg(args);
  const graph = cachedGraph(root);
  const ra = findFunction(graph, stringArg(args, 'from'));
  if ('error' in ra) return graphMiss(ra);
  const rb = findFunction(graph, stringArg(args, 'to'));
  if ('error' in rb) return graphMiss(rb);
  const path = pathBetween(graph, ra.node.id, rb.node.id);
  if (!path)
    return {
      text: `No call path between ${ra.node.label} and ${rb.node.label} in the static call graph (dynamic-dispatch edges are invisible — absence of a static path does not prove the two never interact at runtime).${unresolvedLowerBound(graph)}`,
    };
  // A hop is an EDGE, not a node: `a → b` is one call, not two. `path` holds
  // nodes, so the edge count is one less. Reporting the node count here
  // overstated every distance an agent reasons about.
  const hops = path.length - 1;
  return {
    text: `Call path (${hops} ${hops === 1 ? 'hop' : 'hops'}):\n  ${path.map((n) => n.label).join(' → ')}`,
  };
}

// ── query_repository (plain-language router) ───────────────────────────────

/**
 * One plain-language entry point that routes deterministically to the tools
 * above.
 *
 * It exists because an agent should not have to know our tool taxonomy to ask
 * a repository question — but it is only allowed to exist because the shaper
 * clears the >=90% intent-accuracy gate in `test/shaper-golden.test.ts`. A
 * router that guesses is worse than no router: benchmarked sessions showed
 * one caught mistake makes an agent re-verify everything afterwards, which
 * costs more tokens than it ever saved.
 *
 * So the failure paths are first-class. It answers with the routed tool's own
 * output when it is sure, names the candidates when it is not, and says plainly
 * that it could not route rather than picking something plausible.
 */
function queryRepositoryTool(args: Record<string, unknown>): ToolResult {
  const root = repoPathArg(args);
  const query = stringArg(args, 'query');
  const idx = getIndex(root);
  lastFilesTouched = idx.files.length;

  const shaped = shapeQuery(query, idx.files, idx.generation);

  if (shaped.intent === null) {
    return {
      text:
        `Could not route: ${shaped.fallback?.reason ?? 'no intent rule matched.'}\n\n` +
        `Questions this answers: ${(shaped.fallback?.supported ?? []).join(', ')}.\n` +
        'Or call a specific tool directly — repo_map to orient, find_symbol to locate a name.',
      isError: true,
    };
  }

  const head = `intent: ${shaped.intent}  (rule ${shaped.rule})`;

  // Targetless questions route straight through — nothing to resolve.
  if (shaped.resolution.status === 'not-needed') {
    const routed =
      shaped.intent === 'overview' ? repoMapTool({ path: root }) : architectureHealthTool({ path: root });
    return { text: `${head}\n\n${routed.text}` };
  }

  if (shaped.resolution.status === 'unresolved') {
    return {
      text:
        // Scoped to the actual search surface: the symbol/vocabulary INDEX.
        // "nothing in this repository matches" over-claimed — a symbol in an
        // unindexed file or below declaration granularity is invisible here
        // and would still have produced this answer.
        `${head}\nTarget: UNRESOLVED — no indexed declaration matches ` +
        `${shaped.resolution.tried.map((t) => `'${t}'`).join(', ') || 'the query'} ` +
        `(the search surface is the symbol index; unindexed files and sub-declaration code are not searched).\n\n` +
        'No candidate cleared the confidence bar, and a near-miss is not reported as an answer. ' +
        `Next: find_symbol({ query: "${shaped.entities[0] ?? query}" }) to search by name, ` +
        'or repo_map to see what this repository actually contains.',
      isError: true,
    };
  }

  if (shaped.resolution.status === 'ambiguous') {
    const lines = shaped.resolution.candidates.map(
      (c, i) =>
        `  ${i + 1}. ${c.name}  ${c.file}:${c.line}  (${c.kind}, confidence ${c.confidence.toFixed(2)} — ${c.why.join(', ')})`,
    );
    return {
      text:
        `${head}\nTarget: AMBIGUOUS — ${shaped.resolution.candidates.length} candidates, none clearly ahead.\n` +
        `${lines.join('\n')}\n\n` +
        `Pick one and re-ask with its qualified name, e.g. query_repository({ query: "${query.replace(/"/g, "'")}" }) ` +
        `after narrowing, or go straight to read_function({ function: "${shaped.resolution.candidates[0]?.file}#${shaped.resolution.candidates[0]?.name}" }).`,
    };
  }

  const target = shaped.resolution.target;
  const qualified = `${target.file}#${target.name}`;
  const routed = routeResolved(shaped, root, qualified, args['fresh'] === true);
  const alts =
    shaped.resolution.alternatives.length > 0
      ? `\nOther candidates considered: ${shaped.resolution.alternatives.map((a) => `${a.name} (${a.confidence.toFixed(2)})`).join(', ')}`
      : '';

  return {
    text:
      `${head}\ntarget: ${target.name}  ${target.file}:${target.line}  ` +
      `confidence ${target.confidence.toFixed(2)} (${target.why.join(', ')})${alts}\n\n${routed.text}`,
    ...(routed.isError === true ? { isError: true } : {}),
  };
}

/**
 * Intent -> the existing tool that answers it. `fresh` rides along to the
 * source-serving routes: without it, a dedup receipt served THROUGH the
 * router had no reachable escape hatch: the receipt tells the caller to
 * "pass fresh: true", and that must work on the tool the agent actually
 * called, not only on the tool it was routed to.
 */
function routeResolved(shaped: StructuredQuery, root: string, qualified: string, fresh: boolean): ToolResult {
  switch (shaped.intent) {
    case 'callers':
      return callersOfTool({ path: root, function: qualified });
    case 'callees':
    case 'dependencies':
      return impactOfTool({ path: root, function: qualified });
    case 'blast_radius':
    case 'dependents':
      return impactOfTool({ path: root, function: qualified });
    case 'references':
      return findReferencesTool({ path: root, symbol: shaped.resolution.status === 'resolved' ? shaped.resolution.target.name : '' });
    case 'similar_logic':
      return similarLogicExistsTool({ path: root, description: shaped.entities.join(' ') });
    case 'source':
    case 'explain':
      return readFunctionTool({ path: root, function: qualified, fresh });
    case 'find_path':
      // Two endpoints are needed and the shaper resolves one; say so instead
      // of inventing the other.
      return {
        text:
          'A path needs two endpoints. Re-ask with both, e.g. ' +
          `path_between({ from: "${qualified}", to: "<other function>" }).`,
      };
    case 'tests':
    case 'history':
      // Honest gap: the shaper recognizes these intents but no route is
      // wired for them, so say so instead of routing to something adjacent.
      // (tests_for answers the tests question when called directly.)
      return {
        text:
          `Not yet available: '${shaped.intent}' queries are not implemented. ` +
          `What IS available for this target: read_function({ function: "${qualified}" }), ` +
          `callers_of, find_references, impact_of.`,
        isError: true,
      };
    case 'locate':
    default:
      return readFunctionTool({ path: root, function: qualified, fresh });
  }
}

// ── compare_implementations ────────────────────────────────────────────────

/**
 * Evidence for a canonical-selection JUDGMENT — never the judgment itself.
 *
 * Benchmarked duplicate-audit sessions still read ~23 files after receiving
 * a correct duplicate list: "which copy should be canonical" required the
 * agent to compare the implementations, and it assembled that comparison by
 * hand. This serves the assembled comparison in one call: both spans, what
 * structurally differs, and each copy's callers and tests. Deciding stays
 * with the agent — an index knows structure, not intent.
 */
function compareImplementationsTool(args: Record<string, unknown>): ToolResult {
  const root = repoPathArg(args);
  const { files } = cachedParse(root);
  const index = symbolIndex(files);

  const resolveOne = (key: 'a' | 'b'): SymbolHit | ToolResult => {
    const query = stringArg(args, key);
    if (!query.includes('#')) {
      return {
        text: `'${key}' must be a qualified 'file/path.ts#name' address (got '${query}'). Use find_symbol({ query: "${query}" }) to find it first.`,
        isError: true,
      };
    }
    const hash = query.lastIndexOf('#');
    const f = query.slice(0, hash).replace(/\\/g, '/').replace(/^\.\//, '');
    const n = query.slice(hash + 1);
    const exact = index.filter((r) => (r.file === f || r.file.endsWith(`/${f}`)) && r.name === n);
    if (exact.length !== 1) {
      return {
        text:
          exact.length === 0
            ? `No symbol '${n}' in '${f}'. file_outline({ file: "${f}" }) shows what it declares.`
            : `'${query}' matches ${exact.length} declarations — disambiguate with read_span.`,
        isError: true,
      };
    }
    return { ...exact[0]!, score: 1, why: 'exact' };
  };

  const ra = resolveOne('a');
  if ('isError' in ra) return ra;
  const rb = resolveOne('b');
  if ('isError' in rb) return rb;
  const a = ra as SymbolHit;
  const b = rb as SymbolHit;

  const recOf = (h: SymbolHit) =>
    files.find((f) => f.path === h.file)?.functions.find((fn) => fn.name === h.name);
  const fa = recOf(a);
  const fb = recOf(b);

  const sections: import('../serve/render.js').RenderSection[] = [];

  // ── what differs (structural facts first — this is the comparison) ──
  const diffLines: string[] = [];
  if (fa !== undefined && fb !== undefined) {
    const sameShape = fa.bodyHash === fb.bodyHash;
    const sameLits = fa.literalHash !== undefined && fa.literalHash === fb.literalHash;
    if (sameShape && sameLits) diffLines.push('bodies are STRUCTURALLY IDENTICAL including literals — a pure duplicate.');
    else if (sameShape) diffLines.push('identical structure; the LITERAL VALUES differ (constants/regex/strings drifted) — see the spans below for the exact values.');
    else {
      const sim =
        fa.ngramSketch !== undefined && fb.ngramSketch !== undefined
          ? sketchJaccard(fa.ngramSketch, fb.ngramSketch)
          : null;
      diffLines.push(
        sim === null
          ? 'structures differ (bodies too small to sketch — compare the spans directly).'
          : `structures have DIVERGED — token streams ${Math.round(sim * 100)}% similar.`,
      );
    }
    diffLines.push(
      `params: ${fa.paramCount} (${fa.paramNames.join(', ') || 'none'}) vs ${fb.paramCount} (${fb.paramNames.join(', ') || 'none'})${fa.paramCount === fb.paramCount ? ' — same arity' : ''}`,
    );
    // DECLARATION-level only. On 2026-08-13 `exported: true` was read as
    // "on the package surface" for a symbol absent from every package entry
    // point — the flag was truthful and the label was a lie. Package-surface
    // reachability (re-export chains, package.json exports) is NOT computed
    // by this engine; the output must say so rather than let `true` imply it.
    diffLines.push(
      `declared exported: ${fa.exported} vs ${fb.exported} — declaration-level only; package-surface reachability is NOT computed here. ` +
        `A symbol can be 'true' yet absent from every package entry point (internal), or re-exported publicly. Check the package's index/barrel before treating either copy as public or internal.`,
    );
    diffLines.push(`size: ${fa.bodyTokens} vs ${fb.bodyTokens} normalized tokens`);
  } else {
    diffLines.push('one or both targets are not functions — structural comparison limited to the spans below.');
  }
  sections.push({ title: 'what differs', lines: diffLines, nextAction: '' });

  // ── evidence per side: callers + tests (the canonical-choice inputs) ──
  const graph = cachedGraph(root);
  const evidence = (h: SymbolHit, label: string): string[] => {
    const lines: string[] = [];
    const fn = findFunction(graph, `${h.file}#${h.name}`);
    if ('node' in fn) {
      const callers = callersOf(graph, fn.node.id);
      const direct = callers.filter((c) => c.depth === 1);
      lines.push(
        `callers: ${direct.length} direct, ${callers.length} transitive${direct.length > 0 ? ` — ${direct.slice(0, 3).map((c) => c.label).join(', ')}${direct.length > 3 ? ', ...' : ''}` : ''}`,
      );
    } else {
      lines.push('callers: not in the call graph (dynamic dispatch is invisible to it).');
    }
    const tests = files.filter(
      (f) => f.isTest && f.imports.some((imp) => resolvesTo(imp.specifier, f.path, h.file)),
    );
    lines.push(
      // The label must stay heuristic: this counts test FILES whose imports
      // resolve to the file — not executed coverage — and a 0 must never
      // read as "untested".
      `tests importing its file (heuristic — import edges, not execution): ${tests.length}${tests.length > 0 ? ` — ${tests.slice(0, 2).map((t) => t.path).join(', ')}${tests.length > 2 ? `, +${tests.length - 2} more` : ''}` : ''}`,
    );
    void label;
    return lines;
  };
  sections.push({ title: `evidence: ${a.name} (${a.file})`, lines: evidence(a, 'a'), nextAction: `callers_of({ function: "${a.file}#${a.name}" })` });
  sections.push({ title: `evidence: ${b.name} (${b.file})`, lines: evidence(b, 'b'), nextAction: `callers_of({ function: "${b.file}#${b.name}" })` });

  // ── both spans, capped — the material of the judgment ──
  const spanSection = (h: SymbolHit): import('../serve/render.js').RenderSection => {
    const end = Math.min(h.endLine, h.startLine + 27);
    let lines: string[];
    try {
      const span = readSpan(root, h.file, h.startLine, end);
      lines = renderSpan(span).split('\n');
      if (end < h.endLine) lines.push(`... ${h.endLine - end} more lines`);
    } catch (e) {
      lines = [`source unavailable: ${e instanceof Error ? e.message : String(e)}`];
    }
    return {
      title: `${h.name} — ${h.file}:${h.startLine}-${h.endLine}`,
      lines,
      nextAction: `read_function({ function: "${h.file}#${h.name}" })`,
    };
  };
  sections.push(spanSection(a));
  sections.push(spanSection(b));

  const preamble = `compare_implementations · the CHOICE of canonical copy is yours — this is the evidence it needs\n\n`;
  const body = renderBudgeted(sections, 900 - Math.ceil(preamble.length / 4));
  return { text: `${preamble}${body}` };
}

function sketchJaccard(a: readonly number[], b: readonly number[]): number {
  const sa = new Set(a);
  let inter = 0;
  for (const x of b) if (sa.has(x)) inter++;
  return inter / (sa.size + new Set(b).size - inter);
}

// ── context_bundle ─────────────────────────────────────────────────────────

/**
 * Rendered bundles are cached per (root, resolved target, intent) against the
 * index generation, which moves whenever any indexed file moves — so the
 * generation IS the repo-state hash this cache keys on. A hit is served only
 * while the generation is unchanged, so it always reflects the current
 * working tree; an edit anywhere invalidates by construction.
 */
const bundleCache = new Map<string, { gen: number; text: string }>();

function contextBundleTool(args: Record<string, unknown>): ToolResult {
  const root = repoPathArg(args);
  const query = stringArg(args, 'target');
  const intentRaw = typeof args['intent'] === 'string' ? args['intent'] : 'understand';
  if (!(BUNDLE_INTENTS as string[]).includes(intentRaw)) {
    return {
      text: `Unknown intent '${intentRaw}'. Supported: ${BUNDLE_INTENTS.join(', ')}.`,
      isError: true,
    };
  }
  const intent = intentRaw as BundleIntent;

  const { files, moduleGraph } = cachedParse(root);
  const index = symbolIndex(files);

  // Resolution mirrors read_function's contract (qualified = exact address,
  // ambiguity = candidates, never a silent pick). Kept separate rather than
  // extracted because read_function's error texts are golden-pinned; the
  // parity between the two is held by the bundle test suite instead.
  let hit: SymbolHit | undefined;
  if (query.includes('#')) {
    const hash = query.lastIndexOf('#');
    const f = query.slice(0, hash).replace(/\\/g, '/').replace(/^\.\//, '');
    const n = query.slice(hash + 1);
    const exact = index.filter((r) => (r.file === f || r.file.endsWith(`/${f}`)) && r.name === n);
    if (exact.length !== 1) {
      return {
        text:
          exact.length === 0
            ? `No symbol '${n}' in '${f}'. Use file_outline({ file: "${f}" }) to see what it declares.`
            : `'${query}' matches ${exact.length} declarations. Read one span directly with read_span.`,
        isError: true,
      };
    }
    hit = { ...exact[0]!, score: 1, why: 'exact' };
  } else {
    const hits = findSymbols(index, query, 8);
    if (hits.length === 0) {
      return {
        text: `No symbol matching '${query}'. Try find_symbol({ query: "${query}" }) for a broader search.`,
        isError: true,
      };
    }
    const top = hits[0]!;
    const tied = hits.filter((h) => h.score === top.score);
    if (tied.length > 1) {
      return {
        text:
          `'${query}' resolves to ${tied.length} declarations with equal confidence:\n` +
          tied.map((h) => `  ${h.file}#${h.name} (${h.kind})`).join('\n') +
          `\nRe-run with the full 'file#name' address.`,
        isError: true,
      };
    }
    hit = top;
  }

  const gen = currentGeneration(root);
  const cacheKey = `${root}|${hit.file}#${hit.name}|${intent}`;
  const cached = bundleCache.get(cacheKey);
  if (cached !== undefined && cached.gen === gen) {
    lastCacheOutcome = 'hit';
    return { text: cached.text };
  }

  const graph = cachedGraph(root);
  const sections = composeBundle({
    root,
    files,
    graph,
    moduleGraph,
    target: {
      name: hit.name,
      file: hit.file,
      kind: hit.kind,
      startLine: hit.startLine,
      endLine: hit.endLine,
    },
    intent,
  });
  // The preamble is part of the budget it announces: while it sat outside
  // the budget, the total ran over by the preamble's own cost.
  const preamble = `context_bundle · intent: ${intent} · budget ${BUNDLE_BUDGET_TOKENS} tokens\n\n`;
  const body = renderBudgeted(sections, BUNDLE_BUDGET_TOKENS - Math.ceil(preamble.length / 4));
  const text = `${preamble}${body}`;
  bundleCache.set(cacheKey, { gen, text });
  return { text };
}

function graphMiss(r: { error: string; candidates?: string[] }): ToolResult {
  const extra = r.candidates ? `\nDid you mean:\n  ${r.candidates.join('\n  ')}` : '';
  return { text: `${r.error}.${extra}`, isError: true };
}

// ---------------------------------------------------------------------------
// Argument validation + formatting helpers
// ---------------------------------------------------------------------------

function stringArg(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v.trim() === '') {
    throw new Error(`Missing or invalid '${key}' argument: expected a non-empty string.`);
  }
  return v.trim();
}

/**
 * Servable-root pinning. When configured — the MCP server pins roots at
 * startup — every tool's `path` argument must resolve inside one of them.
 * Without pinning, ANY readable directory on the machine was servable per
 * call, which turned prompt-injected text in one repository into a lens
 * onto every other local project. Library/test use without configuration
 * is unrestricted (no server, no exposure).
 */
let servableRoots: string[] | null = null;

export function setServableRoots(roots: string[] | null): void {
  servableRoots = roots === null ? null : roots.map((r) => resolve(r));
}

function insideRoot(root: string, child: string): boolean {
  const [r, c] =
    process.platform === 'win32' ? [root.toLowerCase(), child.toLowerCase()] : [root, child];
  return c === r || c.startsWith(r.endsWith(sep) ? r : r + sep);
}

function repoPathArg(args: Record<string, unknown>): string {
  // Optional: MCP clients launch this server with cwd = the project root,
  // so the common case needs no path argument at all (adoption friction).
  const raw = args['path'];
  const abs = resolve(typeof raw === 'string' && raw.length > 0 ? raw : process.cwd());
  if (servableRoots !== null && !servableRoots.some((r) => insideRoot(r, abs))) {
    throw new Error(
      `Path is outside the servable roots pinned at server start: ${abs}. ` +
        `Servable: ${servableRoots.join('; ')}. Set EUTHYNOS_ROOTS to serve additional repositories.`,
    );
  }
  if (!existsSync(abs)) throw new Error(`Path does not exist: ${abs}`);
  if (!statSync(abs).isDirectory()) throw new Error(`Path is not a directory: ${abs}`);
  lastResolvedRoot = abs;
  return abs;
}

function monthsArg(args: Record<string, unknown>): number {
  const v = args['months'];
  if (v === undefined || v === null) return 6;
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : Number.NaN;
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid 'months' argument: expected a positive number, got ${JSON.stringify(v)}.`);
  }
  return n;
}

/** Exact name match, then case-insensitive exact, then substring. Returns an error string otherwise. */
function findModule(r: ScanReport, query: string): ModuleReport | string {
  const exact = r.modules.find((m) => m.name === query);
  if (exact) return exact;

  const lower = query.toLowerCase();
  const ciExact = r.modules.find((m) => m.name.toLowerCase() === lower);
  if (ciExact) return ciExact;

  const partial = r.modules.filter((m) => m.name.toLowerCase().includes(lower));
  if (partial.length === 1) return partial[0]!;

  const available = r.modules
    .map((m) => m.name)
    .sort()
    .join(', ');
  if (partial.length > 1) {
    return `Module '${query}' is ambiguous — matches: ${partial.map((m) => m.name).join(', ')}. Available modules: ${available}.`;
  }
  return `Module '${query}' not found. Available modules: ${available}.`;
}

/**
 * State how the target was resolved when it was NOT an exact match — an
 * agent must never mistake a substring hit for the symbol it asked for.
 */
function matchNote(match: MatchKind, query: string, node: { label: string; file?: string; line?: number }): string {
  if (match !== 'substring') return '';
  return `[resolved '${query}' by substring match -> ${node.label} (${node.file}:${node.line}) — verify this is the symbol you meant]\n`;
}

/** Flag best-effort call edges (import-scoped) so an agent weights them cautiously. */
function confMark(confidence: number | undefined): string {
  return confidence !== undefined && confidence < 0.9 ? `  ~${Math.round(confidence * 100)}% confidence` : '';
}

function fmtAvg(v: number | null): string {
  return v === null ? 'n/a' : String(v);
}

function fmtMetric(label: string, m: MetricScore): string {
  const score = m.score === null ? 'n/a' : `${m.score}/100 (${m.label})`;
  return `${label.padEnd(9)}${score} — ${m.detail}`;
}
