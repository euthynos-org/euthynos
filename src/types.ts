/**
 * Core data model. Parser-agnostic: parse/ts.ts produces these today,
 * tree-sitter parsers will produce the same shapes for other languages.
 */

export interface ExportedSymbol {
  name: string;
  kind: 'function' | 'class' | 'const' | 'type' | 'reexport';
  /** Parameters without defaults/optional markers (function-like only). */
  requiredParams: number;
  totalParams: number;
}

/** One call written in a body, with the line it appears on. */
export interface CallSite {
  name: string;
  line: number;
  /** Written as `x.name()` rather than bare `name()`. */
  member: boolean;
}

/** A declaration with an exact source span (class, interface, type, enum...). */
export interface SymbolSpan {
  name: string;
  /**
   * `module` covers namespace-like declarations that are neither a class nor an
   * interface (Ruby `module`, Rust `mod`). Forcing them into `class` would put
   * a wrong word in front of a reader — the point of an outline is that the
   * label is true.
   */
  kind: 'class' | 'interface' | 'type' | 'enum' | 'const' | 'function' | 'module';
  startLine: number;
  endLine: number;
  exported: boolean;
}

export interface FunctionRecord {
  name: string;
  file: string;
  /**
   * First line of the BODY. Kept as-is: every existing metric and finding
   * is anchored to it.
   */
  startLine: number;
  endLine: number;
  /**
   * First line of the DECLARATION (signature, modifiers, decorators) when the
   * parser records it — what a reader wants to see. Falls back to startLine.
   */
  declLine?: number;
  exported: boolean;
  paramCount: number;
  paramNames: string[];
  /** FNV-1a hash of the normalized body token stream (identifiers/literals collapsed). */
  bodyHash: number;
  /** Token count of the normalized body — used to skip trivial matches. */
  bodyTokens: number;
  /**
   * Hash of the body's LITERAL VALUES only (strings, numbers), order
   * preserved. `bodyHash` deliberately erases literals so renamed copies
   * collide — but in a tiny body the literal IS the semantics. hono's
   * adapters share one 6-token `getConnInfo` shape while reading different
   * headers ('cf-connecting-ip' vs 'x-real-ip'); without this they hash
   * identically and we report a confident false positive, which a benchmark
   * agent caught and had to read files to disprove.
   */
  literalHash?: number;
  /** Names of functions/methods invoked in the body (best-effort, deduped) — call-graph source. */
  calls: string[];
  /**
   * The subset of `calls` invoked through a RECEIVER (`obj.foo()`), as opposed
   * to bare `foo()`. Member calls need structural evidence (import/module
   * scope) to resolve: a bare unique-name match on `arr.every()` would
   * otherwise wire a phantom edge to a repo function named `every`.
   * Parsers that do not distinguish the two leave this undefined.
   */
  memberCalls?: string[];
  /** Every call with its exact line — the source of reference locations. */
  callSites?: CallSite[];
  /**
   * Named types referenced in the signature (params + return), for
   * context_bundle's "types touched" section. TypeScript-only today; ABSENT
   * for other languages, and consumers must say "not indexed" rather than
   * treating absence as "touches no types".
   */
  typeRefs?: string[];
  /**
   * Bottom-24 sketch of hashed 4-grams over the normalized token stream —
   * the near-clone tier's structural-similarity signal (Jaccard on two
   * sketches ~ token-stream similarity; exact when a body has <= 24 distinct
   * 4-grams). Absent for bodies under 12 normalized tokens and for parsers
   * without a normalized stream (COBOL).
   */
  ngramSketch?: number[];
}

export interface ImportRecord {
  fromFile: string;
  /** Line the import statement appears on (reference locations). */
  line?: number;
  specifier: string;
  /** Named bindings imported, e.g. import { a, b } -> ['a','b']. */
  named: string[];
  isTypeOnly: boolean;
}

export interface ParsedFile {
  /** Path relative to scan root, forward slashes. */
  path: string;
  module: string;
  isTest: boolean;
  isIndex: boolean;
  codeLines: number;
  exports: ExportedSymbol[];
  internalFunctions: number;
  functions: FunctionRecord[];
  imports: ImportRecord[];
  /**
   * Non-function declarations with spans (classes, interfaces, types, enums).
   * Tier-1 parsers only; absent elsewhere, and the outline says so rather
   * than implying a file has no types.
   */
  symbols?: SymbolSpan[];
  /** Total lines in the file — outline reports coverage honestly. */
  totalLines?: number;
  /**
   * Distinct words used in this file's comments, for LEXICAL RANKING ONLY
   * (the query shaper's BM25 documents). Never a symbol, never a location.
   * Absent for languages whose comment syntax we do not scan.
   */
  commentTokens?: string[];
}

export interface ModuleInfo {
  name: string;
  files: ParsedFile[];
  /** Union of exported symbol names across the module. */
  exportedNames: Set<string>;
  hasInterfaceFile: boolean;
  codeLines: number;
}

export interface ModuleGraph {
  /** module -> set of modules it imports from */
  imports: Map<string, Set<string>>;
  /** module -> set of modules that import it */
  importedBy: Map<string, Set<string>>;
  /** target module -> names imported from it anywhere */
  usedExports: Map<string, Set<string>>;
  /** imports that reach into a module's non-index files from outside */
  deepImports: DeepImport[];
  /** modules participating in at least one import cycle */
  cycles: string[][];
}

export interface DeepImport {
  fromFile: string;
  toFile: string;
  toModule: string;
}

export interface CoChangeStats {
  /** Commits in window that touched this module. */
  commits: number;
  /** Mean distinct top-level directories per touching commit. */
  avgDirSpread: number;
  /** Mean files changed per touching commit. */
  avgFilesTouched: number;
}

export interface GitHistory {
  available: boolean;
  windowMonths: number;
  totalCommits: number;
  perModule: Map<string, CoChangeStats>;
}

/**
 * Per-signal evidence weights (0-1) behind a finding's confidence. Exposed so
 * a weak signal can never masquerade as strong evidence: `name` is capped at
 * NAME_WEIGHT_CAP and can only ever corroborate a structural signal.
 */
export interface SignalScores {
  ast?: number;
  signature?: number;
  name?: number;
  imports?: number;
}

export interface ContaminationFinding {
  kind: 'clone' | 'signature' | 'naming';
  a: { file: string; name: string; line: number; endLine: number };
  b: { file: string; name: string; line: number; endLine: number };
  confidence: number;
  /** Which cascade steps contributed: ast-clone, signature, naming, import-overlap. */
  signals: string[];
  /** Evidence weight per signal (drill-down + damping contract). */
  signalScores?: SignalScores;
  /**
   * Total copies sharing this body, when the finding represents a clone
   * GROUP rather than a pair. N identical functions produce N*(N-1)/2 pairs
   * — six copies of one helper filled 15 of a 20-row budget and crowded out
   * every other finding. The group is the unit a reader acts on.
   */
  groupSize?: number;
  /** Other members of the group beyond `a` and `b`, for group findings. */
  alsoIn?: { file: string; name: string; line: number }[];
  /** Set by the opt-in AI confirmation pass (cascade step 5). */
  aiVerdict?: 'confirmed';
}

export interface MetricScore {
  score: number | null;
  label: string;
  detail: string;
}

/**
 * One raw fact behind a metric score — a primitive the scorer actually used,
 * never a re-phrased verdict. The drill-down contract: a reader must be able
 * to reconstruct WHY a score is what it is from these rows alone.
 */
export interface EvidenceItem {
  /** Stable fact type, e.g. 'deep-import', 'unused-export', 'file-surface'. */
  kind: string;
  /** The fact, stated plainly (includes the point delta where one applies). */
  text: string;
  /** Repo-relative file the fact points at, when it has one. */
  file?: string;
  line?: number;
  /** How the fact bears on the score. */
  effect: 'input' | 'penalty' | 'credit';
}

export interface ModuleEvidence {
  depth: EvidenceItem[];
  seams: EvidenceItem[];
  locality: EvidenceItem[];
  leverage: EvidenceItem[];
}

export interface ModuleReport {
  name: string;
  files: number;
  codeLines: number;
  depth: MetricScore;
  seams: MetricScore;
  locality: MetricScore;
  leverage: MetricScore;
  exportedCount: number;
  callerCount: number;
  utilizationPct: number | null;
  ownership: {
    owner: string | null;
    /** Min authors covering >=80% of the module's commits (structured, not regex-of-detail). */
    busFactor: number | null;
    /** Dominant author's commit share, 0..1. */
    topShare: number | null;
    /** Dominant author (de-facto owner candidate), even when share < 50%. */
    topAuthor: string | null;
    risk: MetricScore;
  };
  /** Raw evidence per metric. Optional: reports serialized before this field lack it. */
  evidence?: ModuleEvidence;
}

// ── Code knowledge graph: nodes, edges, call adjacency ──────────────────────

export interface CodeNode {
  id: string;
  kind: 'module' | 'file' | 'function';
  label: string;
  module: string;
  file?: string;
  line?: number;
  exported?: boolean;
  /** Module-level metrics, attached to module nodes when a scan supplies them. */
  metrics?: { depth: number | null; seams: number | null; leverage: number | null; locality: number | null };
  owner?: string | null;
  /**
   * Bus factor for the module — the author count from the scan's ownership
   * stats, carried as a number rather than re-parsed out of a detail string.
   * Set on module nodes only; null when the scan supplied no ownership data
   * (no git history).
   */
  busFactor?: number | null;
}

export interface CodeEdge {
  from: string;
  to: string;
  kind: 'contains' | 'imports' | 'calls';
  /** Resolution confidence for `calls` edges (0-1). Structural edges omit it. */
  confidence?: number;
  /** How the edge was resolved: 'same-file' | 'unique-name' | 'import-scoped'. */
  reason?: string;
}

export interface CodeGraph {
  nodes: Map<string, CodeNode>;
  edges: CodeEdge[];
  /** fn id -> set of fn ids it calls. */
  callsOut: Map<string, Set<string>>;
  /** fn id -> set of fn ids that call it. */
  callsIn: Map<string, Set<string>>;
  /** `${callerId}|${calleeId}` -> resolution evidence for that call edge. */
  callMeta: Map<string, { confidence: number; reason: string }>;
  stats: { modules: number; files: number; functions: number; callEdges: number; importEdges: number; unresolvedCalls: number };
}

export interface ScanReport {
  root: string;
  scannedAt: string;
  filesScanned: number;
  modules: ModuleReport[];
  contamination: {
    score: number;
    label: string;
    findings: ContaminationFinding[];
    /**
     * Same-module structural clones. NOT part of the score (duplication
     * inside one module is a local refactor, not architectural
     * contamination) but served by `similar_logic_exists`, which answers
     * "does this already exist?" rather than "how contaminated is the
     * architecture?".
     */
    intraModule: ContaminationFinding[];
    /** Totals BEFORE the 20-row presentation caps on `findings`/`intraModule` — a capped list shown without its total reads as exhaustiveness. */
    findingsTotal: number;
    intraModuleTotal: number;
    /** Runtime deep-import count feeding the score — kept so the score can be recomputed after AI filtering. */
    violations: number;
    /** Every function-node id (`fn:file#name`) that is a structural clone (any body-hash group >=2, incl. in-module + beyond top-20). O(1) "is this a clone?" for downstream features. */
    cloneFnIds: string[];
  };
  health: { score: number; label: string };
  averages: {
    depth: number | null;
    seams: number | null;
    locality: number | null;
    leverage: number | null;
  };
  opportunities: string[];
  gitAvailable: boolean;
  /** Module import-graph shape. Optional: reports serialized before this field lack it. */
  graph?: { nodes: number; edges: number; cycles: number };
  /**
   * Files discovered but NOT parsed (capped at 50). Present only when
   * something was skipped: a dropped file is invisible to every query, so
   * the gap is reported rather than hidden.
   */
  skippedFiles?: { file: string; reason: string }[];
  /** True when discovery STOPPED at the file cap — every repo-wide view built
   *  from this report describes a TRUNCATED repository and must say so. */
  discoveryTruncated?: boolean;
}
