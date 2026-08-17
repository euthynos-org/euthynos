import { describe, expect, it } from 'vitest';
import { estTokens, renderBudgeted, type RenderSection } from '../src/serve/render.js';

/**
 * The shared renderer's contract: one budget, spent in priority order, with
 * every cap EXPLICIT. These are golden-style tests — the renderer's output is
 * what every composite tool serves, so a behavior change here is a product
 * change and must show up as a diff.
 */

const sec = (title: string, n: number, nextAction = ''): RenderSection => ({
  title,
  lines: Array.from({ length: n }, (_, i) => `${title} line ${i + 1} with some padding text`),
  nextAction,
});

describe('renderBudgeted', () => {
  it('everything fits: sections render in order, no overflow rows', () => {
    const out = renderBudgeted([sec('a', 2), sec('b', 2)], 500);
    expect(out).toContain('== a ==');
    expect(out).toContain('== b ==');
    expect(out).not.toContain('omitted');
    expect(out.indexOf('== a ==')).toBeLessThan(out.indexOf('== b =='));
  });

  it('never exceeds the budget (measured on its own output)', () => {
    for (const budget of [60, 120, 300, 900]) {
      const out = renderBudgeted([sec('a', 30), sec('b', 30), sec('c', 30)], budget);
      expect(estTokens(out), `budget ${budget}`).toBeLessThanOrEqual(budget);
    }
  });

  it('a trimmed section says how much was dropped and names the deeper call', () => {
    const out = renderBudgeted([sec('big', 40, 'read_function({ function: "x" })')], 120);
    expect(out).toMatch(/\.\.\. \d+ more lines omitted for budget/);
    expect(out).toContain('read_function({ function: "x" })');
  });

  it('tail sections always at least announce themselves (no silent swallowing)', () => {
    // A fat first section must not consume the stubs' reserved room.
    const out = renderBudgeted(
      [sec('fat', 100), sec('tail1', 5, 'callers_of({...})'), sec('tail2', 5)],
      150,
    );
    expect(out).toContain('tail1');
    expect(out).toContain('tail2');
  });

  it('REGRESSION: long nextActions cannot bust the budget (review criticals #1/#2)', () => {
    // The original renderer reserved a fixed 18 tokens for stubs/overflow
    // rows, then emitted rows embedding qualified addresses (~32 tokens) —
    // provably breaching the ceiling by up to 10%. These are the exact
    // adversarial shapes from the review.
    const LONG = 'read_function({ function: "src/services/payments/reconciliation/handler.ts#reconcile" })';
    const fat: RenderSection = {
      title: 'src',
      lines: Array.from({ length: 40 }, (_, i) => `line ${i} of about thirty-three chars!`),
      nextAction: LONG,
    };
    const tail1: RenderSection = { title: 'blast radius', lines: ['one line'], nextAction: LONG };
    const tail2: RenderSection = { title: 'called by', lines: ['one line'], nextAction: LONG };
    for (const budget of [120, 150, 200, 400]) {
      const out = renderBudgeted([fat, tail1, tail2], budget);
      expect(estTokens(out), `budget ${budget}`).toBeLessThanOrEqual(budget);
    }
  });

  it('REGRESSION: a small section that fits is rendered, never stubbed (review major #3)', () => {
    // The old gate compared against a fixed floor and stubbed content that
    // was CHEAPER than its own stub — fewer facts for more tokens.
    const small: RenderSection = { title: 'recent changes (file)', lines: ['no git history available.'], nextAction: '' };
    const out = renderBudgeted([small], 25);
    expect(out).toContain('no git history available.');
    expect(out).not.toContain('omitted');
  });

  it('below the minimum budget, tails are dropped EXPLICITLY and the ceiling still holds', () => {
    const sections = [sec('a', 5, 'x()'), sec('b', 5, 'y()'), sec('c', 5, 'z()')];
    const tiny = 12; // below minimumBudget for three sections
    const out = renderBudgeted(sections, tiny);
    expect(estTokens(out)).toBeLessThanOrEqual(tiny);
    expect(out).toMatch(/omitted/); // never silent
  });

  it('is deterministic', () => {
    const sections = [sec('a', 10), sec('b', 20, 'x()')];
    expect(renderBudgeted(sections, 100)).toBe(renderBudgeted(sections, 100));
  });

  it('an untitled section renders without a heading', () => {
    const out = renderBudgeted([{ title: '', lines: ['just text'], nextAction: '' }], 100);
    expect(out).toBe('just text');
  });
});
