import type { ContaminationFinding, FunctionRecord, ModuleGraph, ParsedFile, SignalScores } from '../types.js';

/**
 * CONTAMINATION (spec §5) — the rule cascade, deterministic steps 1-4:
 *   Step 1 (AST):   structural clone detection via normalized body hash
 *   Step 2 (Sigs):  signature match — same shape, similar name, different module
 *   Step 3 (Deps):  import-overlap analysis — boosts confidence of 1/2/4 candidates
 *   Step 4 (Names): naming heuristics — similar exported names across modules
 * Step 5 (AI confirm, opt-in via --ai) lives in src/ai/confirm.ts.
 *
 * Confidence bands (the landing-page promise):
 *   < 60   silent drop — we say nothing rather than guess
 *   60-79  reported as unconfirmed suggestion (step 5 can confirm or kill)
 *   >= 80  reported firmly
 *
 * Score is 0-100 where LOWER is better.
 * Bands: 0-10 Clean · 11-30 Minor · 31-60 Concerning · 61-100 Critical
 */
/** Score floor: below this a clone is noise for an architecture metric. */
const SCORE_CLONE_MIN_TOKENS = 30;
/**
 * Tool floor: an EXACT structural clone this small is still a real answer to
 * "does this exist?", but below ~12 tokens most matches are one-line getters
 * and wrappers no reader acts on.
 */
const TOOL_CLONE_MIN_TOKENS = 12;
/**
 * Below the tool floor there is exactly ONE shape worth reporting: the SAME
 * EXPORTED NAME implemented twice. hono's adapters duplicate a 6-token
 * `getConnInfo` across runtimes — a developer writing the next adapter needs
 * that, and it is unambiguous because the public name is identical. An
 * anonymous 6-token wrapper duplicated elsewhere is noise, and stays out.
 */
const TINY_CLONE_MIN_TOKENS = 4;

export function contamination(
  files: ParsedFile[],
  graph: ModuleGraph,
): {
  score: number;
  label: string;
  findings: ContaminationFinding[];
  /**
   * SAME-MODULE structural clones. Deliberately NOT scored — duplication
   * inside one module is a local refactor, not architectural contamination,
   * and the metric's meaning depends on that distinction.
   *
   * They are collected anyway because `similar_logic_exists` answers a
   * DIFFERENT question from the score: "does this logic already exist?"
   * A developer about to write a helper cares about a copy in the module
   * they are standing in — arguably more than one across the repo. A
   * benchmark agent found this the hard way: it called the tool first on
   * hono's adapters, got nothing (all adapters live in one `adapter`
   * module), and read 29 files by hand, writing in its own answer that our
   * "cross-module duplicate scan reports nothing ... invisible to that
   * check". The filter that protects the metric was silently narrowing the
   * tool.
   */
  intraModule: ContaminationFinding[];
  /**
   * Totals BEFORE the 20-row caps below. The caps are presentation; the
   * totals are the honest count — a tool that shows 20 of 37 must say 37,
   * or its consumer will read the cap as exhaustiveness (a benchmark agent
   * did exactly that on 2026-08-13).
   */
  findingsTotal: number;
  intraModuleTotal: number;
  violations: number;
  cloneFnIds: string[];
  /** Uncapped identity of every finding — the set the policy gate diffs against. */
  pairKeys: string[];
} {
  const fns: FunctionRecord[] = [];
  const importsOfFile = new Map<string, Set<string>>();
  const moduleOfFile = new Map<string, string>();

  for (const f of files) {
    if (f.isTest) continue;
    moduleOfFile.set(f.path, f.module);
    importsOfFile.set(
      f.path,
      new Set(f.imports.map((i) => normalizeSpecifier(i.specifier, f.path))),
    );
    for (const fn of f.functions) {
      // Two floors, because the SCORE and the TOOL ask different questions.
      // The score ignores small bodies (two one-line getters are not
      // architectural contamination). "Does this already exist?" does not:
      // hono's adapters duplicate a 12-token `getConnInfo` across runtimes,
      // and a developer about to write the next one needs exactly that. The
      // 30-token floor hid it — the same metric-rule-leaking-into-the-tool
      // defect as the same-module filter, found the same way.
      if (fn.bodyTokens >= TINY_CLONE_MIN_TOKENS) fns.push(fn);
    }
  }

  const candidates: ContaminationFinding[] = [];
  const intraModule: ContaminationFinding[] = [];
  const seenPair = new Set<string>();

  // Step 1 — structural clones (identifiers/literals normalized away).
  const byHash = new Map<number, FunctionRecord[]>();
  for (const fn of fns) {
    if (!byHash.has(fn.bodyHash)) byHash.set(fn.bodyHash, []);
    byHash.get(fn.bodyHash)!.push(fn);
  }
  for (const group of byHash.values()) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i]!, b = group[j]!;
        // The SCORE keeps the stricter floor.
        if (a.bodyTokens < SCORE_CLONE_MIN_TOKENS) continue;
        // Same module: excluded from the SCORE (a local refactor). Collected
        // separately for the tool — see the return type. Emitted as ONE
        // group finding below, not as pairs.
        if (moduleOfFile.get(a.file) === moduleOfFile.get(b.file)) continue;
        push(a, b, 'clone', 90 + (a.bodyTokens > 120 ? 4 : 0), ['ast-clone'], { ast: 1 });
      }
    }
  }

  // Step 2 — signature matches across modules: same arity (>=2), similar params + name.
  const byArity = new Map<number, FunctionRecord[]>();
  for (const fn of fns) {
    if (fn.bodyTokens < SCORE_CLONE_MIN_TOKENS) continue; // score-only step
    if (fn.paramCount < 2) continue;
    if (!byArity.has(fn.paramCount)) byArity.set(fn.paramCount, []);
    byArity.get(fn.paramCount)!.push(fn);
  }
  for (const group of byArity.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i]!, b = group[j]!;
        if (moduleOfFile.get(a.file) === moduleOfFile.get(b.file)) continue;
        if (a.bodyHash === b.bodyHash) continue; // already a clone
        const params = jaccard(a.paramNames, b.paramNames);
        const names = nameSimilarity(a.name, b.name);
        // Structural agreement (param shape) carries the weight; the name
        // similarity is a gate, not the score.
        if (params >= 0.6 && names >= 0.55) {
          push(a, b, 'signature', Math.round(45 + params * 25), ['signature'], { signature: round2(params) });
        }
      }
    }
  }

  // Step 4 — naming, graded by DEGREE of resemblance. The 2026-08-11
  // benchmark showed a real agent abandoning this tool over name-only hits,
  // and the three observed cases separate cleanly:
  //
  //   sim = 1.0        IDENTICAL names across modules (`serveStatic` in every
  //                    runtime adapter) — an intended interface, not a copy.
  //                    A real copy of one is caught by ast-clone anyway.
  //                    -> never a finding on names alone.
  //   0.92 <= sim < 1  SPELLING DRIFT (`summarizeLedger`/`summariseLedger`,
  //                    one edit) — the same concept diverging. Genuine signal.
  //                    -> low-confidence suggestion, labeled naming-only.
  //   0.75 <= sim <.92 FAMILY RESEMBLANCE (`createWSContext`/`createCssContext`,
  //                    shared prefix+suffix pattern) — the false-positive
  //                    class. -> corroborates a structural finding, never
  //                    creates one, and capped at NAME_WEIGHT_CAP.
  const structural = new Set(candidates.map((c) => pairKey(c.a.file, c.a.name, c.b.file, c.b.name)));
  for (const c of candidates) {
    const sim = nameSimilarity(c.a.name, c.b.name);
    if (sim < 0.75) continue;
    c.confidence = Math.min(99, c.confidence + Math.round(sim * NAME_WEIGHT_CAP * 100));
    c.signals.push('naming');
    c.signalScores = { ...c.signalScores, name: round2(sim) };
  }
  // Step 4 feeds the SCORE, so it keeps the stricter floor: a one-line
  // exported helper with a near-identical name is not architectural
  // contamination, and name-only signals are the ones a real agent already
  // caught us over.
  const exported = fns.filter((f) => f.exported && f.bodyTokens >= SCORE_CLONE_MIN_TOKENS);
  for (let i = 0; i < exported.length; i++) {
    for (let j = i + 1; j < exported.length; j++) {
      const a = exported[i]!, b = exported[j]!;
      if (moduleOfFile.get(a.file) === moduleOfFile.get(b.file)) continue;
      if (a.bodyHash === b.bodyHash) continue; // already a clone
      if (structural.has(pairKey(a.file, a.name, b.file, b.name))) continue;
      const sim = nameSimilarity(a.name, b.name);
      if (sim < NAME_DRIFT_MIN || sim >= 1) continue; // identical => interface pattern
      push(a, b, 'naming', Math.round(60 + (sim - NAME_DRIFT_MIN) * 150), ['naming'], { name: round2(sim) });
    }
  }

  // Step 3 — import-overlap modifier: parallel dependency usage raises suspicion.
  for (const c of candidates) {
    const overlap = jaccardSets(importsOfFile.get(c.a.file), importsOfFile.get(c.b.file));
    if (overlap >= 0.75) {
      c.confidence = Math.min(99, c.confidence + 12);
      c.signals.push('import-overlap');
      c.signalScores = { ...c.signalScores, imports: round2(overlap) };
    } else if (overlap >= 0.5) {
      c.confidence = Math.min(99, c.confidence + 8);
      c.signals.push('import-overlap');
      c.signalScores = { ...c.signalScores, imports: round2(overlap) };
    }
  }

  // Band filter: below 60 we stay silent.
  const findings = candidates.filter((c) => c.confidence >= 60);
  findings.sort((x, y) => y.confidence - x.confidence);

  const violations = graph.deepImports.length;
  const score = contaminationScore(findings, violations);

  // Full structural-clone membership — every fn in any body-hash group >=2,
  // BEFORE the cross-module/top-20 filtering above. Downstream features get an
  // O(1) "is this fn a clone?" set covering in-module + beyond-top-20 clones.
  const cloneIds = new Set<string>();
  for (const group of byHash.values()) {
    if (group.length < 2) continue;
    for (const fn of group) cloneIds.add(`fn:${fn.file}#${fn.name}`);
  }

  // Same-module clones, ONE finding per body-hash group per module. Pairwise
  // emission is quadratic in group size: six copies of one helper is 15 rows
  // saying the same thing, which filled the entire budget on a real repo.
  for (const group of byHash.values()) {
    if (group.length < 2) continue;
    const byModule = new Map<string, FunctionRecord[]>();
    for (const fn of group) {
      const mod = moduleOfFile.get(fn.file) ?? '';
      const list = byModule.get(mod);
      if (list === undefined) byModule.set(mod, [fn]);
      else list.push(fn);
    }
    for (const members of byModule.values()) {
      if (members.length < 2) continue;
      // Small bodies qualify only as the same exported name implemented
      // twice — narrow on purpose, or the output floods with one-line
      // wrappers.
      const isSmall = members.some((m) => m.bodyTokens < TOOL_CLONE_MIN_TOKENS);
      let cohort = members;
      if (isSmall) {
        const names = new Set(members.map((m) => m.name));
        if (names.size !== 1 || !members.every((m) => m.exported)) continue;
        // AND the literals must agree. `bodyHash` erases literals so renamed
        // copies collide — necessary for clone detection, but a 6-token body
        // is mostly ONE literal, so erasing it compares nothing. hono's
        // vercel adapter shares the getConnInfo SHAPE while reading
        // 'x-real-ip' instead of 'cf-connecting-ip'; we reported it at 90%
        // and a benchmark agent had to read the files to disprove us.
        //
        // PARTITION rather than reject: the copies that genuinely agree are
        // still a true finding. Discarding the whole group over one dissenter
        // would trade a false positive for a false negative.
        const byLiteral = new Map<number | undefined, FunctionRecord[]>();
        for (const m of members) {
          const k = m.literalHash;
          const list = byLiteral.get(k);
          if (list === undefined) byLiteral.set(k, [m]);
          else list.push(m);
        }
        const agreeing = [...byLiteral.entries()]
          .filter(([k, v]) => k !== undefined && v.length >= 2)
          .map(([, v]) => v)
          .sort((x, y) => y.length - x.length)[0];
        if (agreeing === undefined) continue;
        cohort = agreeing;
      }
      const sorted = [...cohort].sort((x, y) => x.file.localeCompare(y.file) || x.name.localeCompare(y.name));
      const [a, b, ...rest] = sorted;
      intraModule.push({
        kind: 'clone',
        a: { file: a!.file, name: a!.name, line: a!.declLine ?? a!.startLine, endLine: a!.endLine },
        b: { file: b!.file, name: b!.name, line: b!.declLine ?? b!.startLine, endLine: b!.endLine },
        confidence: 90 + (a!.bodyTokens > 120 ? 4 : 0),
        signals: ['ast-clone'],
        signalScores: { ast: 1 },
        groupSize: sorted.length,
        ...(rest.length > 0
          ? { alsoIn: rest.slice(0, 6).map((f) => ({ file: f.file, name: f.name, line: f.declLine ?? f.startLine })) }
          : {}),
      });
    }
  }

  // Biggest groups first — a helper copied six times matters more than one
  // copied twice — then by path for stable, deterministic output.
  intraModule.sort(
    (x, y) =>
      (y.groupSize ?? 2) - (x.groupSize ?? 2) ||
      y.confidence - x.confidence ||
      x.a.file.localeCompare(y.a.file) ||
      x.a.name.localeCompare(y.a.name),
  );
  return {
    score,
    label: contaminationLabel(score),
    findings: findings.slice(0, 20),
    intraModule: intraModule.slice(0, 20),
    findingsTotal: findings.length,
    intraModuleTotal: intraModule.length,
    violations,
    cloneFnIds: [...cloneIds],
    // The full set, before the presentation cap: the policy gate diffs against
    // this so a capped list never reads as "nothing else existed".
    pairKeys: findings.map(pairKeyOf),
  };

  function push(
    a: FunctionRecord,
    b: FunctionRecord,
    kind: ContaminationFinding['kind'],
    confidence: number,
    signals: string[],
    signalScores: SignalScores,
  ): void {
    const key = [`${a.file}:${a.name}`, `${b.file}:${b.name}`].sort().join('|');
    if (seenPair.has(key)) return;
    seenPair.add(key);
    candidates.push({
      kind,
      // The DECLARATION line, as the intra-module branch and nearclone already
      // record: a fixer lifting a duplicate needs the signature, not the body.
      a: { file: a.file, name: a.name, line: a.declLine ?? a.startLine, endLine: a.endLine },
      b: { file: b.file, name: b.name, line: b.declLine ?? b.startLine, endLine: b.endLine },
      confidence,
      signals,
      signalScores,
    });
  }
}

/** Order-independent identity of a finding; the policy engine builds the same key. */
function pairKeyOf(f: ContaminationFinding): string {
  return [`${f.a.file}:${f.a.name}`, `${f.b.file}:${f.b.name}`].sort().join('|');
}

/** Name similarity can add at most this fraction of the confidence scale. */
const NAME_WEIGHT_CAP = 0.15;
/**
 * Minimum name similarity for a naming-ONLY finding: roughly "one edit in a
 * 13+ character name". Below it, shared prefix/suffix patterns dominate and
 * produce false positives; at exactly 1.0 the names are identical, which
 * across modules means an interface, not a copy.
 */
const NAME_DRIFT_MIN = 0.92;

function pairKey(aFile: string, aName: string, bFile: string, bName: string): string {
  return [`${aFile}:${aName}`, `${bFile}:${bName}`].sort().join('|');
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Recomputable so the AI pass (step 5) can re-score after dropping refuted findings. */
export function contaminationScore(findings: ContaminationFinding[], violations: number): number {
  let s = 0;
  for (const f of findings) {
    if (f.kind === 'clone') s += 12;
    else if (f.confidence >= 80) s += 5;
    else s += 2;
  }
  return Math.min(100, s + Math.min(violations * 3, 15));
}

export function contaminationLabel(s: number): string {
  if (s <= 10) return 'Clean';
  if (s <= 30) return 'Minor';
  if (s <= 60) return 'Concerning';
  return 'Critical';
}

/** Normalize an import for overlap comparison: external pkg name, or resolved-ish relative target. */
function normalizeSpecifier(spec: string, fromFile: string): string {
  if (!spec.startsWith('.')) {
    const parts = spec.split('/');
    return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
  }
  const base = fromFile.split('/').slice(0, -1);
  for (const seg of spec.replace(/\.(js|mjs|cjs|ts)$/, '').split('/')) {
    if (seg === '.' || seg === '') continue;
    else if (seg === '..') base.pop();
    else base.push(seg);
  }
  return base.join('/');
}

function jaccard(a: string[], b: string[]): number {
  return jaccardSets(new Set(a.map((s) => s.toLowerCase())), new Set(b.map((s) => s.toLowerCase())));
}

function jaccardSets(A: Set<string> | undefined, B: Set<string> | undefined): number {
  if (!A || !B || (A.size === 0 && B.size === 0)) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Levenshtein ratio over verb-normalized names — catches processPayment vs handlePayment. */
function nameSimilarity(a: string, b: string): number {
  const na = norm(a), nb = norm(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const d = levenshtein(na, nb);
  return 1 - d / Math.max(na.length, nb.length);
}

const VERB_SYNONYMS = /^(handle|process|execute|run|do|perform|apply)/;

function norm(s: string): string {
  return s.toLowerCase().replace(VERB_SYNONYMS, '');
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const row = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) row[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = row[j]!;
      row[j] = Math.min(
        row[j]! + 1,
        row[j - 1]! + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      prev = tmp;
    }
  }
  return row[n]!;
}
