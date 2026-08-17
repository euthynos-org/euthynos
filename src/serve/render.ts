/**
 * SHARED RESPONSE RENDERER (Phase 5, blueprint §23-24).
 *
 * One place that turns ranked sections into budgeted text. The rules every
 * caller inherits by using it, instead of re-implementing:
 *
 *  - ONE token budget across the whole response, spent in priority order.
 *  - A section that does not fully fit is TRIMMED with an explicit overflow
 *    row that says how much was dropped and names the exact call that serves
 *    the rest — never a silent cap (house law).
 *  - A section that cannot even start within the budget collapses to a stub
 *    carrying its next action, so the agent still learns the section EXISTS
 *    and how to get it.
 *  - Deterministic: section order is the caller's priority order, token
 *    estimation is chars/4 (the same estimate telemetry and the budget tests
 *    use), and nothing here consults a clock.
 *
 * BUDGET ARITHMETIC IS MEASURED, NEVER ASSUMED. The first version of this
 * file reserved a fixed 18 tokens for stubs and overflow rows and then
 * emitted rows whose real cost depended on the caller's nextAction text — a
 * qualified `file#name` address made them ~32 tokens, and the adversarial
 * review proved the "never exceeds the budget" docstring false by up to 10%.
 * Now every candidate line's cost is computed from the exact text about to
 * be pushed, reservations are the sum of ACTUAL bare-stub costs, and the
 * emit path cannot push text it has not measured.
 *
 * Guarantee: estTokens(output) <= budget, PROVIDED budget >= minimumBudget()
 * for the section list (every section can at least announce itself as a
 * bare stub). Below that floor the tail sections are dropped behind one
 * final "... N sections omitted" line — still explicit, never silent — and
 * the guarantee holds all the way down. context_bundle's 900-token budget is
 * ~20x the floor for its profiles; a test pins that relationship.
 *
 * Existing Phase 1-4 tools keep their proven, golden-tested renderers; their
 * budgets are enforced by the tool-metrics suite. New composite surfaces
 * (context_bundle first) MUST render through this. That split is a recorded
 * deviation (D6).
 */

export interface RenderSection {
  /** Short heading, rendered as "== title ==". Empty string = no heading. */
  title: string;
  lines: string[];
  /**
   * The call that serves this section in full, e.g.
   * 'read_function({ function: "src/a.ts#foo" })'. Used in overflow rows and
   * stubs; empty string means the section has no deeper form.
   */
  nextAction: string;
}

export const estTokens = (s: string): number => Math.ceil(s.length / 4);

/** Cost of one output line, including the newline that joins it. */
const lineCost = (s: string): number => estTokens(s + '\n');

/** Stub titles are capped so a caller's long heading cannot bloat every stub. */
const STUB_TITLE_MAX = 40;

function stubTitle(title: string): string {
  const t = title === '' ? 'more' : title;
  return t.length <= STUB_TITLE_MAX ? t : t.slice(0, STUB_TITLE_MAX - 1) + '…';
}

/** Full stub: announces the section AND its deeper call. */
function fullStub(s: RenderSection): string {
  const hint = s.nextAction === '' ? '' : ` — ${s.nextAction}`;
  return `== ${stubTitle(s.title)} == (omitted for budget${hint})`;
}

/** Bare stub: the bounded fallback — announcement only. */
function bareStub(s: RenderSection): string {
  return `== ${stubTitle(s.title)} == (omitted for budget)`;
}

/** Overflow row for `dropped` trailing lines. Cost varies with the count's digits. */
function overflowRow(s: RenderSection, dropped: number): string {
  const hint = s.nextAction === '' ? '' : ` — ${s.nextAction}`;
  return `... ${dropped} more line${dropped === 1 ? '' : 's'} omitted for budget${hint}`;
}

/**
 * The smallest budget under which every section is guaranteed at least its
 * bare-stub announcement. Exposed so composite tools can assert their budget
 * clears it by a wide margin.
 */
export function minimumBudget(sections: readonly RenderSection[]): number {
  return sections.reduce((sum, s) => sum + lineCost(bareStub(s)), 0);
}

/**
 * Render sections under one budget, spending in priority order.
 *
 * Invariant maintained at every step: `spent + reservedForRest <= budget`,
 * where reservedForRest is the sum of the ACTUAL bare-stub costs of the
 * sections not yet emitted. Every emit is measured on the exact text pushed,
 * so the invariant is arithmetic, not hope.
 */
export function renderBudgeted(sections: readonly RenderSection[], budgetTokens: number): string {
  const out: string[] = [];
  let spent = 0;
  const emit = (line: string): void => {
    out.push(line);
    spent += lineCost(line);
  };

  // Actual reservation per remaining section — its bare stub, measured.
  const bareCosts = sections.map((s) => lineCost(bareStub(s)));
  const suffixReserve: number[] = new Array(sections.length + 1).fill(0);
  for (let i = sections.length - 1; i >= 0; i--) {
    suffixReserve[i] = suffixReserve[i + 1]! + bareCosts[i]!;
  }

  // Pathological floor: the budget cannot even announce every section. Emit
  // bare stubs while they fit, then ONE closing omission line — explicit to
  // the end, and still within budget because each emit is measured first.
  if (budgetTokens < suffixReserve[0]!) {
    for (let i = 0; i < sections.length; i++) {
      const stub = bareStub(sections[i]!);
      const remaining = sections.length - i - 1;
      const closer = `... ${remaining} more section${remaining === 1 ? '' : 's'} omitted (budget)`;
      if (spent + lineCost(stub) + (remaining > 0 ? lineCost(closer) : 0) > budgetTokens) {
        const finalCloser = `... ${sections.length - i} more section${sections.length - i === 1 ? '' : 's'} omitted (budget)`;
        if (spent + lineCost(finalCloser) <= budgetTokens) emit(finalCloser);
        return out.join('\n');
      }
      emit(stub);
    }
    return out.join('\n');
  }

  for (let i = 0; i < sections.length; i++) {
    const s = sections[i]!;
    const available = budgetTokens - spent - suffixReserve[i + 1]!;
    const header = s.title === '' ? null : `== ${s.title} ==`;
    const headerCost = header === null ? 0 : lineCost(header);
    const sepCost = i < sections.length - 1 ? lineCost('') : 0;

    // 1) Full section — measured exactly, separator included.
    const fullCost = headerCost + s.lines.reduce((c, l) => c + lineCost(l), 0) + sepCost;
    if (fullCost <= available) {
      if (header !== null) emit(header);
      for (const l of s.lines) emit(l);
      if (sepCost > 0) emit('');
      continue;
    }

    // 2) Trimmed: the longest prefix of lines such that header + prefix +
    //    the EXACT overflow row for what's dropped (+ separator) fits.
    //    Scanned from the largest k down; overflow cost is recomputed per k
    //    because the dropped-count's digits change it.
    let k = s.lines.length - 1;
    let chosen = -1;
    for (; k >= 1; k--) {
      const prefixCost = s.lines.slice(0, k).reduce((c, l) => c + lineCost(l), 0);
      const over = overflowRow(s, s.lines.length - k);
      if (headerCost + prefixCost + lineCost(over) + sepCost <= available) {
        chosen = k;
        break;
      }
    }
    if (chosen >= 1) {
      if (header !== null) emit(header);
      for (const l of s.lines.slice(0, chosen)) emit(l);
      emit(overflowRow(s, s.lines.length - chosen));
      if (sepCost > 0) emit('');
      continue;
    }

    // 3) Stub. Prefer the full stub (with the deeper call); it may not fit —
    //    the bare stub always does, because the invariant reserved for it.
    //    If the full stub costs MORE than the whole section would have, that
    //    was case (1) unless the section genuinely didn't fit; the stub is
    //    then still the honest minimum, not a savings claim.
    const fs = fullStub(s);
    if (lineCost(fs) + sepCost <= available) {
      emit(fs);
    } else {
      emit(bareStub(s));
    }
    if (sepCost > 0 && spent + sepCost + suffixReserve[i + 1]! <= budgetTokens) emit('');
  }

  return out.join('\n');
}
