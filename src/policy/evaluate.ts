import type { ContaminationFinding, ImportEdge, ScanReport } from '../types.js';

/**
 * Architecture policy engine — paid-moat differentiator #1, but the deterministic
 * core ships in the free CLI/Action too (observe mode).
 *
 * A declarative policy of rules maps 1:1 to signals the scan already computes.
 * Delta rules ("health may not drop", "no NEW duplication") need a BASE report
 * (the SaaS supplies the base-branch's last scan; the CLI takes --base). Floor /
 * ownership rules need only the head report. Evaluation is pure + deterministic:
 * same reports + same policy → same violations. Governance stays observe-first —
 * nothing here exits non-zero unless the caller explicitly opts into block mode.
 */

export type RuleMode = 'warn' | 'block';
export type MetricKey = 'depth' | 'seams' | 'leverage' | 'locality';

export interface PolicyRule {
  /** Stable id for reporting; auto-derived if omitted. */
  id?: string;
  type:
    | 'health-delta' // health may not drop more than `maxDrop` vs base
    | 'contamination-delta' // contamination may not rise more than `maxRise` vs base
    | 'no-new-duplication' // no clone pair present in head but absent in base
    | 'metric-floor' // module `metric` must stay >= `min`
    | 'min-owners' // module bus factor must be >= `minOwners`
    | 'forbidden-dependency'; // no import from a `from` module into a `to` module
  mode?: RuleMode;
  module?: string; // glob for floor/owners rules: 'payment', 'payment/*', 'svc*', '*'
  metric?: MetricKey;
  min?: number;
  maxDrop?: number;
  maxRise?: number;
  minOwners?: number;
  // forbidden-dependency — module globs (same syntax as `module`):
  /** Importing side. Default '*' (any module). */
  from?: string;
  /** Forbidden target. REQUIRED for the rule to mean anything. */
  to?: string;
  /** The legal route, named in the finding so the fix is stated, not guessed. */
  allowedVia?: string;
  /** Count `import type` too. Default false — erased at compile time, no runtime coupling. */
  includeTypeOnly?: boolean;
  /** Count imports made from test files too. Default false — tests may reach across. */
  includeTests?: boolean;
  /** Free-text reason, appended to the finding so the intent travels with the verdict. */
  message?: string;
}

export interface Policy {
  rules: PolicyRule[];
  /** Applied to rules without an explicit `mode`. Default 'warn'. */
  defaultMode?: RuleMode;
}

/** Where a violation lives in the source. Present only for LOCALIZED rules. */
export interface ViolationLocation {
  /** Repo-relative path of the file that must change. */
  file: string;
  /** 1-based line of the offending statement, when the parser records it. */
  line?: number;
  endLine?: number;
}

/**
 * What the code should do instead — DETERMINISTIC, derived from the rule and
 * the report, never a model's suggestion. `suggestedTargets` may be empty: an
 * honest "no legal route is visible in this report" beats an invented one.
 */
export interface Remedy {
  kind: 'reroute-import' | 'remove-import' | 'extract-shared';
  /** One imperative sentence, addressed to whoever (or whatever) is fixing it. */
  instruction: string;
  /** Concrete files from the report that make the fix, each with the reason it qualifies. */
  suggestedTargets: { file: string; why: string }[];
  /**
   * extract-shared only: whether the engine could tell WHICH copy pre-existed.
   * When false, `location` is deliberately absent — pointing at either copy
   * would be a guess — and a fix must not assume a side.
   */
  sideKnown?: boolean;
}

export interface Violation {
  ruleId: string;
  type: PolicyRule['type'];
  mode: RuleMode;
  message: string;
  /**
   * The module the finding is ABOUT — the one that must change. For
   * forbidden-dependency that is the IMPORTING side (the violator); for
   * floor/owners rules, the scoped module.
   */
  module?: string;
  before?: number | null;
  after?: number | null;
  /**
   * Exact source location — present only for localized rules
   * (forbidden-dependency, no-new-duplication). Absent ⇒ the finding is
   * aggregate/advisory and has nothing a fix can be pointed at.
   */
  location?: ViolationLocation;
  /** The prescribed correction, when the engine can state one deterministically. */
  remedy?: Remedy;
  /** forbidden-dependency: the file the offending import resolved to — full path, since a basename is ambiguous. */
  toFile?: string;
}

/** A rule that could not be evaluated because it is malformed. */
export interface InvalidRule {
  ruleId: string;
  reason: string;
}

/** A forbidden-dependency glob that names no module in the evaluated report. */
export interface UnmatchedGlob {
  ruleId: string;
  side: 'from' | 'to';
  glob: string;
}

export interface PolicyResult {
  violations: Violation[];
  /** True if any block-mode rule was violated. */
  blocked: boolean;
  passed: boolean;
  /** Delta rules that were skipped because no base report was supplied. */
  skippedDeltaRules: number;
  /**
   * forbidden-dependency rules skipped because the report carries no
   * `importEdges` (serialized before that field existed). Counted, never
   * silently passed: a rule that could not run must not read as "no violation".
   */
  skippedEdgeRules: number;
  /**
   * Malformed rules (unknown type, missing or misused fields), recorded and
   * SKIPPED. The pure evaluator never throws for these; the CLI turns a
   * non-empty list into exit code 2 — a config error, never a policy verdict,
   * so a typo can never masquerade as "blocked" (1) or "passed" (0).
   */
  invalidRules: InvalidRule[];
  /**
   * forbidden-dependency globs that match NO module this report can see. The
   * rule ran and could not have fired. Disclosed so a permanent no-op — a
   * typo, or two layers that moduleOf folded into one module — never reads as
   * "no violation".
   */
  unmatchedGlobs: UnmatchedGlob[];
  /** forbidden-dependency rules that actually ran; renderers hang resolution caveats on it. */
  edgeRulesEvaluated: number;
  /**
   * no-new-duplication rules skipped because the BASE report cannot prove its
   * duplicate-pair list is complete (capped at 20 with no uncapped `pairKeys`).
   * "Absent from an incomplete list" is not "new"; counted, never passed.
   */
  skippedIncompleteRules: number;
  /** The HEAD's pair list is capped and carries no uncapped set: pairs past the cap were not judged. A safe miss, disclosed. */
  duplicationHeadCapped: boolean;
  /**
   * Set (to the module's name) when the whole tree scanned as ONE module. Then
   * no cross-module import edge exists, so boundary rules and module-level
   * deltas cannot fire — a pass that says nothing. Usually the scan root is a
   * folder that HOLDS the project (or several) one level down, rather than
   * the project root itself.
   */
  singleModuleTree?: string;
  /**
   * Coverage gaps the scan itself reported: files that failed to parse and
   * cap-truncated discovery. A verdict over a partial tree must say so.
   */
  partialCoverage?: { skippedFiles: number; discoveryTruncated: boolean };
}

const RULE_TYPES: ReadonlySet<string> = new Set<PolicyRule['type']>([
  'health-delta', 'contamination-delta', 'no-new-duplication', 'metric-floor', 'min-owners', 'forbidden-dependency',
]);

const ruleIdOf = (rule: PolicyRule, i: number): string => rule.id ?? `${rule.type}#${i + 1}`;

/**
 * Shape-check a policy. Returns every malformed rule with a reason — used by
 * the CLI to fail fast (exit 2, naming the file) BEFORE any scan runs, and by
 * evaluatePolicy to skip-and-record the same rules defensively when a caller
 * bypassed the CLI. One source of truth for "what is a valid rule".
 */
export function validatePolicy(policy: Policy): InvalidRule[] {
  const out: InvalidRule[] = [];
  policy.rules.forEach((rule, i) => {
    const ruleId = ruleIdOf(rule, i);
    if (!RULE_TYPES.has(rule.type)) {
      out.push({ ruleId, reason: `unknown rule type "${String(rule.type)}"` });
      return;
    }
    if (rule.type === 'forbidden-dependency') {
      if (!rule.to) out.push({ ruleId, reason: 'forbidden-dependency requires "to" (the forbidden target module glob)' });
      if (rule.module !== undefined) {
        out.push({ ruleId, reason: 'forbidden-dependency scopes the importing side with "from", not "module" (which would be silently ignored)' });
      }
    }
  });
  return out;
}

/** Evaluate a policy against a head report, optionally diffed against a base. */
export function evaluatePolicy(policy: Policy, report: ScanReport, base?: ScanReport): PolicyResult {
  const violations: Violation[] = [];
  let skippedDeltaRules = 0;
  let skippedEdgeRules = 0;
  let edgeRulesEvaluated = 0;
  let skippedIncompleteRules = 0;
  let duplicationHeadCapped = false;
  const unmatchedGlobs: UnmatchedGlob[] = [];
  const dflt = policy.defaultMode ?? 'warn';

  // Malformed rules are recorded and skipped — never thrown from here.
  const invalidRules = validatePolicy(policy);
  const invalidIds = new Set(invalidRules.map((r) => r.ruleId));

  // The module vocabulary this report can see: the only names a glob can
  // ever match. Folded-out tiny modules still appear via their edges.
  const vocab = new Set<string>();
  for (const m of report.modules) vocab.add(m.name);
  for (const e of report.importEdges ?? []) { vocab.add(e.fromModule); vocab.add(e.toModule); }
  const matchesAny = (glob: string): boolean => {
    for (const n of vocab) if (matchModule(glob, n)) return true;
    return false;
  };
  // One module for many files = nothing cross-module can be judged. Say so,
  // or a vacuous pass reads like a clean one.
  const singleModuleTree = vocab.size === 1 && report.filesScanned > 1 ? [...vocab][0] : undefined;

  policy.rules.forEach((rule, i) => {
    const mode = rule.mode ?? dflt;
    const id = ruleIdOf(rule, i);
    if (invalidIds.has(id)) return;
    const add = (message: string, extra: Partial<Violation> = {}): void => {
      violations.push({ ruleId: id, type: rule.type, mode, message, ...extra });
    };

    switch (rule.type) {
      case 'health-delta': {
        if (!base) { skippedDeltaRules++; break; }
        const maxDrop = rule.maxDrop ?? 0;
        const drop = base.health.score - report.health.score;
        if (drop > maxDrop) {
          add(`Architecture health dropped ${drop} pts (${base.health.score} → ${report.health.score}); policy allows ≤ ${maxDrop}.`,
            { before: base.health.score, after: report.health.score });
        }
        break;
      }
      case 'contamination-delta': {
        if (!base) { skippedDeltaRules++; break; }
        const maxRise = rule.maxRise ?? 0;
        const rise = report.contamination.score - base.contamination.score;
        if (rise > maxRise) {
          add(`Duplication score rose ${rise} (${base.contamination.score} → ${report.contamination.score}); policy allows ≤ ${maxRise}.`,
            { before: base.contamination.score, after: report.contamination.score });
        }
        break;
      }
      case 'no-new-duplication': {
        if (!base) { skippedDeltaRules++; break; }
        // "Absent from base" is "new" only when the base set is COMPLETE. The
        // report's `findings` is a 20-row presentation list; `pairKeys` is the
        // uncapped identity set. Without it, completeness is provable only
        // when the list is under the cap. An unprovable base is a counted skip.
        const baseKeys = completePairKeys(base.contamination);
        if (!baseKeys) { skippedIncompleteRules++; break; }
        if (!completePairKeys(report.contamination)) duplicationHeadCapped = true;
        const fresh = report.contamination.findings.filter((f) => !baseKeys.has(pairKey(f)));
        // One violation PER pair. Which copy is the NEW one is decided from the
        // base — a file that existed before, a function that was already a
        // clone — and when the base cannot say, the finding says so and
        // carries no location rather than pointing at whichever copy sorts first.
        const baseFiles = base.files ? new Set(base.files) : null;
        const baseClones = new Set(base.contamination.cloneFnIds);
        for (const f of fresh) {
          add(
            `New duplicate-logic pair introduced vs base: ${f.a.file}:${f.a.name} ≈ ${f.b.file}:${f.b.name}.`,
            extractSharedFinding(f, newSide(f, baseFiles, baseClones)),
          );
        }
        break;
      }
      case 'metric-floor': {
        const metric = rule.metric ?? 'seams';
        const min = rule.min ?? 0;
        for (const m of report.modules) {
          if (!matchModule(rule.module ?? '*', m.name)) continue;
          const s = m[metric].score;
          if (s != null && s < min) {
            add(`${m.name}: ${metric} ${s} is below the floor of ${min}.`, { module: m.name, after: s });
          }
        }
        break;
      }
      case 'min-owners': {
        const minOwners = rule.minOwners ?? 2;
        for (const m of report.modules) {
          if (!matchModule(rule.module ?? '*', m.name)) continue;
          const bf = m.ownership.busFactor;
          if (bf != null && bf < minOwners) {
            add(`${m.name}: bus factor ${bf} is below the required ${minOwners} (${m.ownership.topAuthor ?? 'one author'} holds ${pct(m.ownership.topShare)}).`,
              { module: m.name, after: bf });
          }
        }
        break;
      }
      case 'forbidden-dependency': {
        // `to` is guaranteed by validatePolicy (a rule without it was
        // skipped above); the guard only keeps the type narrow.
        if (!rule.to) break;
        // A report without import edges predates this field. Skipping it
        // silently would turn "could not check" into "no violation" — the
        // exact failure the fail-closed scan guards against — so count it.
        if (!report.importEdges) { skippedEdgeRules++; break; }
        edgeRulesEvaluated++;
        const from = rule.from ?? '*';
        // A glob that names nothing this report can see is a permanent no-op:
        // a typo, or two layers moduleOf folded into one module. Say so.
        if (!matchesAny(rule.to)) unmatchedGlobs.push({ ruleId: id, side: 'to', glob: rule.to });
        if (from !== '*' && !matchesAny(from)) unmatchedGlobs.push({ ruleId: id, side: 'from', glob: from });
        for (const e of report.importEdges) {
          if (e.isTypeOnly && !rule.includeTypeOnly) continue;
          if (e.fromIsTest && !rule.includeTests) continue;
          if (!matchModule(from, e.fromModule) || !matchModule(rule.to, e.toModule)) continue;
          // The allowed route is, by definition, not a violator — otherwise the
          // natural rule `{ to: 'db', allowedVia: 'services' }` (from = '*')
          // would flag every services→db import and then offer those same
          // files as the fix.
          if (rule.allowedVia && matchModule(rule.allowedVia, e.fromModule)) continue;
          const where = `${e.fromFile}:${e.line ?? '?'}`;
          const why = rule.message ? ` ${rule.message}` : '';
          const route = rule.allowedVia ? ` Allowed route: ${rule.allowedVia}.` : '';
          add(`${where} imports ${e.toModule} (${short(e.toFile)}) — ${from} → ${rule.to} is forbidden.${why}${route}`, {
            module: e.fromModule,
            toFile: e.toFile,
            location: { file: e.fromFile, ...(e.line !== undefined ? { line: e.line } : {}) },
            remedy: rerouteRemedy(e, rule.allowedVia, report.importEdges),
          });
        }
        break;
      }
      default: {
        // Unknown types are caught by validatePolicy and skipped before the
        // switch; this arm makes the compiler enforce that the case list stays
        // exhaustive when a new type is added, and records the impossible.
        const unreachable: never = rule.type;
        invalidRules.push({ ruleId: id, reason: `unknown rule type "${String(unreachable)}"` });
      }
    }
  });

  const skippedFiles = report.skippedFiles?.length ?? 0;
  const discoveryTruncated = report.discoveryTruncated === true;
  const partialCoverage = skippedFiles > 0 || discoveryTruncated ? { skippedFiles, discoveryTruncated } : undefined;

  const blocked = violations.some((v) => v.mode === 'block');
  return {
    violations, blocked, passed: violations.length === 0,
    skippedDeltaRules, skippedEdgeRules, invalidRules, unmatchedGlobs, edgeRulesEvaluated,
    skippedIncompleteRules, duplicationHeadCapped,
    ...(partialCoverage ? { partialCoverage } : {}),
    ...(singleModuleTree !== undefined ? { singleModuleTree } : {}),
  };
}

/**
 * Ratchet policy — "freeze today's numbers, fail only on regressions". The
 * starter policy so day-1 rules never fail on pre-existing debt: health can't
 * drop, duplication can't rise, no new clones. Block strictly opt-in.
 */
export function ratchetPolicy(mode: RuleMode = 'warn', maxHealthDrop = 3): Policy {
  return {
    defaultMode: mode,
    rules: [
      { id: 'health-no-regression', type: 'health-delta', maxDrop: maxHealthDrop },
      { id: 'no-more-duplication', type: 'contamination-delta', maxRise: 0 },
      { id: 'no-new-clones', type: 'no-new-duplication' },
    ],
  };
}

const pairKey = (f: { a: { file: string; name: string }; b: { file: string; name: string } }): string =>
  [`${f.a.file}:${f.a.name}`, `${f.b.file}:${f.b.name}`].sort().join('|');

const short = (p: string): string => p.split('/').pop() ?? p;
const pct = (s: number | null): string => (s == null ? 'n/a' : `${Math.round(s * 100)}%`);

/** Module glob: '*' all · 'X' exact · 'X*' prefix · 'X/*' X or any submodule under X/. */
function matchModule(glob: string, name: string): boolean {
  if (glob === '*' || glob === name) return true;
  if (glob.endsWith('/*')) {
    const base = glob.slice(0, -2);
    return name === base || name.startsWith(base + '/');
  }
  if (glob.endsWith('*')) return name.startsWith(glob.slice(0, -1));
  return false;
}

/**
 * Files inside the allowed-route module that ALREADY reach the forbidden
 * target at runtime — read off the report's own edges, so a suggested route
 * is a real one, never invented. Type-only and test-file edges are not
 * routes; the violator itself is never its own route. Routes to the SAME
 * target file are preferred — a module-level match may import a different
 * file than the violator needs, and when that is all there is, the `why`
 * says so instead of implying it provides what was imported.
 */
function legalRoutes(
  edges: ImportEdge[],
  allowedVia: string,
  violator: ImportEdge,
): { targets: { file: string; why: string }[]; exact: boolean; fallbackVia?: string } {
  const pick = (exact: boolean): { targets: { file: string; why: string }[]; firstVia?: string } => {
    const seen = new Set<string>();
    const targets: { file: string; why: string }[] = [];
    let firstVia: string | undefined;
    for (const e of edges) {
      if (e.isTypeOnly || e.fromIsTest) continue;
      if (e.fromFile === violator.fromFile) continue;
      if (!matchModule(allowedVia, e.fromModule)) continue;
      if (exact ? e.toFile !== violator.toFile : e.toModule !== violator.toModule) continue;
      if (seen.has(e.fromFile)) continue;
      seen.add(e.fromFile);
      firstVia ??= short(e.toFile);
      targets.push({
        file: e.fromFile,
        why: exact
          ? `already imports ${short(violator.toFile)} from inside the allowed route ${allowedVia}`
          : `imports ${violator.toModule} (${short(e.toFile)}, not ${short(violator.toFile)}) from inside ${allowedVia}`,
      });
      if (targets.length >= 5) break;
    }
    return { targets, ...(firstVia !== undefined ? { firstVia } : {}) };
  };
  const exactHits = pick(true);
  if (exactHits.targets.length > 0) return { targets: exactHits.targets, exact: true };
  const fallback = pick(false);
  return { targets: fallback.targets, exact: false, ...(fallback.firstVia !== undefined ? { fallbackVia: fallback.firstVia } : {}) };
}

/** The prescribed correction for a forbidden import — honest when no route is visible. */
function rerouteRemedy(e: ImportEdge, allowedVia: string | undefined, edges: ImportEdge[]): Remedy {
  const fromName = short(e.fromFile);
  if (!allowedVia) {
    return {
      kind: 'remove-import',
      instruction: `Remove the direct import of ${e.toModule} from ${fromName}, or move this dependency behind a module the policy allows.`,
      suggestedTargets: [],
    };
  }
  const { targets, exact, fallbackVia } = legalRoutes(edges, allowedVia, e);
  const head = `Reach ${e.toModule} through ${allowedVia} instead of importing it directly from ${fromName}`;
  const instruction =
    targets.length === 0
      ? `${head}; no file in ${allowedVia} currently reaches ${e.toModule}, so one may need to be added.`
      : exact
        ? `${head} — e.g. via ${targets[0]!.file}.`
        : `${head}; no file in ${allowedVia} currently reaches ${short(e.toFile)} — ${targets[0]!.file} reaches ${e.toModule} via ${fallbackVia ?? 'another file'} and may be the place to add it.`;
  return { kind: 'reroute-import', instruction, suggestedTargets: targets };
}

/** The base's full pair-identity set, or null when the report cannot prove the list is complete. */
function completePairKeys(c: ScanReport['contamination']): Set<string> | null {
  if (c.pairKeys) return new Set(c.pairKeys);
  // No uncapped set: the 20-row list is provably complete only when the total
  // says so, or (older reports, no total) when it sits under the cap.
  const complete = c.findingsTotal !== undefined ? c.findingsTotal === c.findings.length : c.findings.length < 20;
  return complete ? new Set(c.findings.map(pairKey)) : null;
}

type PairSide = 'a' | 'b' | 'both' | 'unknown';

/**
 * Which copy of a fresh pair is the CHANGED one, decided from the base and
 * never guessed. Two signals, strongest first:
 *
 * 1. Clone membership. If exactly one side's function was already a clone in
 *    the base, its body already existed there — so for this pair to be new,
 *    the OTHER side's body must have been created or edited to match. That
 *    side is the changed one, and no file list is needed to say so. If both
 *    were clones (of something), a body moved and the report cannot say whose.
 * 2. File presence (neither was a clone). A file absent from the base's list
 *    is new. Both absent: both are this change. Both present: a new relation
 *    between two old files — unknown which body changed. No list: unknown.
 */
function newSide(f: ContaminationFinding, baseFiles: Set<string> | null, baseClones: Set<string>): PairSide {
  const aClone = baseClones.has(`fn:${f.a.file}#${f.a.name}`);
  const bClone = baseClones.has(`fn:${f.b.file}#${f.b.name}`);
  if (aClone !== bClone) return aClone ? 'b' : 'a';
  if (aClone && bClone) return 'unknown';
  if (!baseFiles) return 'unknown';
  const aFile = baseFiles.has(f.a.file);
  const bFile = baseFiles.has(f.b.file);
  if (aFile !== bFile) return aFile ? 'b' : 'a';
  if (!aFile && !bFile) return 'both';
  return 'unknown';
}

/** Location + remedy for a new clone pair, worded by what the base could prove. */
function extractSharedFinding(f: ContaminationFinding, side: PairSide): Partial<Violation> {
  const A = f.a;
  const B = f.b;
  const at = (s: typeof A): ViolationLocation => ({ file: s.file, line: s.line, endLine: s.endLine });
  const copy = (s: typeof A, why: string): { file: string; why: string } => ({ file: s.file, why });
  if (side === 'a' || side === 'b') {
    const fresh = side === 'a' ? A : B;
    const old = side === 'a' ? B : A;
    return {
      location: at(fresh),
      remedy: {
        kind: 'extract-shared',
        sideKnown: true,
        instruction: `${fresh.name} (${short(fresh.file)}) is a new copy of ${old.name} (${short(old.file)}), which already existed: reuse it, or extract one shared helper.`,
        suggestedTargets: [copy(old, `the pre-existing copy — ${old.name} at line ${old.line}`)],
      },
    };
  }
  if (side === 'both') {
    return {
      location: at(A),
      remedy: {
        kind: 'extract-shared',
        sideKnown: true,
        instruction: `${A.name} (${short(A.file)}) and ${B.name} (${short(B.file)}) are both new to this change and share one body: keep one and extract a shared helper.`,
        suggestedTargets: [copy(B, `the other new copy — ${B.name} at line ${B.line}`)],
      },
    };
  }
  // unknown: no location — pointing at either copy would be a guess.
  return {
    remedy: {
      kind: 'extract-shared',
      sideKnown: false,
      instruction: `${A.name} (${short(A.file)}) and ${B.name} (${short(B.file)}) share one body; the base scan cannot say which copy is new. Keep the original and extract a shared helper.`,
      suggestedTargets: [copy(A, 'one of the two copies'), copy(B, 'one of the two copies')],
    },
  };
}
