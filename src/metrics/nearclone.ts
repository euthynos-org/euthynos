import type { FunctionRecord, ParsedFile } from '../types.js';

/**
 * NEAR-CLONE DETECTION (Phase 6, §14) — the tier the A1 milestone proved
 * exact hashing cannot reach, handed over with two named target cases:
 *
 *  1. DIVERGED RENAMED COPIES. hono's `isContentTypeBinary` (lambda-edge)
 *     and `defaultIsContentTypeBinary` (aws-lambda) are one function under
 *     two names whose regexes have drifted apart. Their normalized token
 *     streams are IDENTICAL (`return ! LIT . test ( ID )`) — exact clone
 *     detection collapses literals by design, and the A1 literal gate
 *     rightly keeps them out of the exact tier. What identifies them as a
 *     diverged copy is precisely the combination the exact tier rejects:
 *     same structure + different literals + similar-but-different names.
 *
 *  2. STRUCTURAL DRIFT: copies whose token stream itself changed (a branch
 *     added, a parameter threaded through). Detected via Jaccard over the
 *     bottom-K 4-gram sketches parsed into every FunctionRecord.
 *
 * This tier is ADDITIVE to the frozen A1 exact-clone machinery: it reports
 * under its own label ('near-clone'), never enters the contamination score,
 * and its existence must not change a single exact/tiny finding —
 * `test/intra-module-clones.test.ts` stays green unchanged, by decree.
 *
 * The interface-pattern discriminator (from the agent's own verdicts): the
 * SAME exported name with different literals across sibling files is an
 * interface being implemented per runtime (getConnInfo reading a different
 * header per platform) — suppressed. DIFFERENT names with the same shape is
 * a copy that was renamed and then drifted — reported. Phase 1's rule that
 * a name signal never exceeds 0.2 weight still holds: names GATE candidacy
 * here, they never inflate the similarity score, which stays structural.
 */

export interface NearCloneFinding {
  kind: 'literal-drift' | 'structural';
  a: { file: string; name: string; line: number; endLine: number };
  b: { file: string; name: string; line: number; endLine: number };
  /** Structural similarity 0..1. literal-drift pairs are 1.0 by definition. */
  similarity: number;
  signals: string[];
  /** One human line naming WHAT diverged — the evidence a reader acts on. */
  divergence: string;
}

/**
 * Floors, mirroring the frozen A1 tiers without touching them.
 *
 * The literal-drift floor is 3, not 6: the TypeScript parser walks AST
 * NODES (forEachChild skips punctuation and keywords), so a single-return
 * body like `return !/re/.test(x)` is only THREE normalized tokens — regex,
 * `test`, argument — where tree-sitter would count ~10. The gate case
 * (isContentTypeBinary) sits exactly there. The evidence bar is held by the
 * OTHER gates instead: identical structure + drifted literal + >= 0.5
 * name-token overlap; three thin tokens alone can never fire.
 */
const LITERAL_DRIFT_MIN_TOKENS = 3;
const STRUCTURAL_MIN_TOKENS = 12;
/** Sketch-Jaccard threshold for the structural tier (initial calibration). */
const STRUCTURAL_MIN_SIMILARITY = 0.72;
/** Name-token Jaccard required to treat two names as "the same concept". */
const NAME_OVERLAP_MIN = 0.5;
const MAX_FINDINGS = 20;

/** The presentation cap. Consumers that show a capped list MUST also state
 *  the uncapped total (from detectAllNearClones) — a capped list without its
 *  total reads as exhaustiveness. */
export const NEAR_CLONE_CAP = MAX_FINDINGS;

export function detectNearClones(files: readonly ParsedFile[]): NearCloneFinding[] {
  return detectAllNearClones(files).slice(0, MAX_FINDINGS);
}

/**
 * The UNCAPPED finding list, deterministically ordered. Exists so a consumer
 * can apply its own exclusions (e.g. pairs the exact tier already reports)
 * BEFORE capping, and state an exact remaining total — never an estimate.
 */
export function detectAllNearClones(files: readonly ParsedFile[]): NearCloneFinding[] {
  const fns: FunctionRecord[] = [];
  for (const f of files) {
    if (f.isTest) continue;
    for (const fn of f.functions) {
      if (!fn.name.startsWith('(')) fns.push(fn);
    }
  }

  const findings: NearCloneFinding[] = [];
  const seen = new Set<string>();
  const pairKey = (a: FunctionRecord, b: FunctionRecord): string =>
    [`${a.file}#${a.name}`, `${b.file}#${b.name}`].sort().join('|');

  // ── Tier A: literal drift — identical structure, drifted literals ──
  const byBodyHash = new Map<number, FunctionRecord[]>();
  for (const fn of fns) {
    if (fn.bodyTokens < LITERAL_DRIFT_MIN_TOKENS || fn.literalHash === undefined) continue;
    const g = byBodyHash.get(fn.bodyHash);
    if (g === undefined) byBodyHash.set(fn.bodyHash, [fn]);
    else g.push(fn);
  }
  for (const group of byBodyHash.values()) {
    if (group.length < 2) continue;
    // Qualifying pairs first, then UNION into variant clusters and emit ONE
    // finding per cluster — N same-shape variants would otherwise cost
    // N(N-1)/2 rows saying the same thing, the exact defect the A1 exact
    // tier already fixed (hono's useEffect/useLayoutEffect/useInsertionEffect
    // triplet is 3 rows as pairs, 1 as a cluster).
    const parent = new Map<FunctionRecord, FunctionRecord>();
    const find = (x: FunctionRecord): FunctionRecord => {
      let r = x;
      while (parent.get(r) !== undefined && parent.get(r) !== r) r = parent.get(r)!;
      return r;
    };
    const union = (x: FunctionRecord, y: FunctionRecord): void => {
      const rx = find(x), ry = find(y);
      parent.set(rx, rx);
      parent.set(ry, rx);
    };
    let anyPair = false;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i]!, b = group[j]!;
        if (a.literalHash === b.literalHash) continue; // exact tier's territory
        if (a.name === b.name) continue; // interface pattern (per-runtime impls)
        if (nameTokenJaccard(a.name, b.name) < NAME_OVERLAP_MIN) continue;
        union(a, b);
        anyPair = true;
      }
    }
    if (!anyPair) continue;
    const clusters = new Map<FunctionRecord, FunctionRecord[]>();
    for (const fn of group) {
      if (parent.get(fn) === undefined && ![...parent.keys()].includes(fn)) continue;
      const root = find(fn);
      const list = clusters.get(root);
      if (list === undefined) clusters.set(root, [fn]);
      else list.push(fn);
    }
    for (const members of clusters.values()) {
      if (members.length < 2) continue;
      const sorted = [...members].sort((x, y) => x.file.localeCompare(y.file) || x.name.localeCompare(y.name));
      const [a, b, ...rest] = sorted;
      const key = pairKey(a!, b!);
      if (seen.has(key)) continue;
      seen.add(key);
      for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < sorted.length; j++) seen.add(pairKey(sorted[i]!, sorted[j]!));
      }
      const more =
        rest.length > 0
          ? `; ${sorted.length} variants total — also ${rest.slice(0, 4).map((f) => `${f.file}:${f.declLine ?? f.startLine} ${f.name}`).join(', ')}`
          : '';
      findings.push({
        kind: 'literal-drift',
        a: loc(a!),
        b: loc(b!),
        similarity: 1,
        signals: ['identical-structure', 'literal-drift', 'renamed'],
        divergence:
          'identical structure; the literal values differ — a copy whose constants (regex/strings/numbers) have drifted after renaming' + more,
      });
    }
  }

  // ── Tier B: structural drift — sketch similarity below identity ──
  // Inverted index over sketch values bounds candidate pairs without an
  // O(n^2) sweep: only pairs sharing >= 3 sketch values are compared.
  const bySketchValue = new Map<number, FunctionRecord[]>();
  const sketchable = fns.filter(
    (fn) => fn.bodyTokens >= STRUCTURAL_MIN_TOKENS && fn.ngramSketch !== undefined && fn.ngramSketch.length > 0,
  );
  for (const fn of sketchable) {
    for (const v of fn.ngramSketch!) {
      const list = bySketchValue.get(v);
      if (list === undefined) bySketchValue.set(v, [fn]);
      else list.push(fn);
    }
  }
  const shared = new Map<string, { a: FunctionRecord; b: FunctionRecord; count: number }>();
  for (const list of bySketchValue.values()) {
    if (list.length < 2 || list.length > 24) continue; // hub values match everything: noise
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]!, b = list[j]!;
        if (a === b || (a.file === b.file && a.name === b.name)) continue;
        const key = pairKey(a, b);
        const e = shared.get(key);
        if (e === undefined) shared.set(key, { a, b, count: 1 });
        else e.count++;
      }
    }
  }
  for (const { a, b, count } of shared.values()) {
    if (count < 3) continue;
    if (a.bodyHash === b.bodyHash) continue; // identical shape = Tier A or exact tier
    // Bottom-K sketches are TRUNCATED sets: two large bodies can share every
    // sketch value while their full streams differ (their bodyHash proves
    // they differ — that is this tier's precondition). Cap the reported
    // similarity at 0.99 so the output never claims "100% similar" about
    // bodies known to be non-identical.
    const sim = Math.min(0.99, jaccard(a.ngramSketch!, b.ngramSketch!));
    if (sim < STRUCTURAL_MIN_SIMILARITY) continue;
    const key = pairKey(a, b);
    if (seen.has(key)) continue;
    seen.add(key);
    const signals = ['ngram-similarity'];
    if (a.paramCount === b.paramCount) signals.push('same-arity');
    const callSim = jaccardStr(a.calls, b.calls);
    if (callSim >= 0.5) signals.push('shared-callees');
    if (nameTokenJaccard(a.name, b.name) >= NAME_OVERLAP_MIN) signals.push('similar-name');
    findings.push({
      kind: 'structural',
      a: loc(a),
      b: loc(b),
      similarity: Math.round(sim * 100) / 100,
      signals,
      divergence: `token streams ${Math.round(sim * 100)}% similar — the bodies have structurally diverged`,
    });
  }

  // Literal drift first (identity of shape is the stronger evidence), then by
  // similarity, then path — deterministic.
  findings.sort(
    (x, y) =>
      Number(y.kind === 'literal-drift') - Number(x.kind === 'literal-drift') ||
      y.similarity - x.similarity ||
      x.a.file.localeCompare(y.a.file) ||
      x.a.name.localeCompare(y.a.name),
  );
  return findings;
}

function loc(fn: FunctionRecord): NearCloneFinding['a'] {
  return { file: fn.file, name: fn.name, line: fn.declLine ?? fn.startLine, endLine: fn.endLine };
}

/** camelCase/snake_case token overlap of two names, 0..1. */
function nameTokenJaccard(a: string, b: string): number {
  const toks = (s: string): Set<string> =>
    new Set(
      s
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/[_-]/g, ' ')
        .toLowerCase()
        .split(/\s+/)
        .filter((t) => t.length > 0),
    );
  return jaccardSets(toks(a), toks(b));
}

function jaccard(a: readonly number[], b: readonly number[]): number {
  return jaccardSets(new Set(a), new Set(b));
}

function jaccardStr(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  return jaccardSets(new Set(a), new Set(b));
}

function jaccardSets<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}
