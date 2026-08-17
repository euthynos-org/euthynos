import { describe, expect, it } from 'vitest';
import { parseVueSource } from '../src/parse/vue.js';

// Vue delegates to the TypeScript compiler API (no tree-sitter grammar), so
// these run without loadLanguages().

describe('vue: <script> extraction → TS delegation', () => {
  it('parses an exported function + import from a <script lang="ts"> block', () => {
    const src = `<template>
  <div>{{ total }}</div>
</template>

<script lang="ts">
import { computeFee } from '../payment/engine';

export function total(amount: number, tax = 0): number {
  return computeFee(amount) + tax;
}

function helper(x: number): number {
  return x * 2;
}
</script>

<style scoped>
.x { color: red; }
</style>
`;
    const pf = parseVueSource('components/Cart.vue', 'components', false, src);

    expect(pf.exports.map((e) => e.name)).toContain('total');
    const total = pf.exports.find((e) => e.name === 'total')!;
    expect(total.requiredParams).toBe(1); // amount required, tax has a default
    expect(total.totalParams).toBe(2);

    expect(pf.imports.map((i) => i.specifier)).toContain('../payment/engine');

    const totalFn = pf.functions.find((f) => f.name === 'total')!;
    expect(totalFn.calls).toContain('computeFee');
    expect(pf.internalFunctions).toBe(1); // helper
  });

  it('maps reported line numbers back to the .vue file (offset correction)', () => {
    const src = `<template>
  <p>hi</p>
</template>

<script lang="ts">
export function late() {
  return 1;
}
</script>
`;
    const pf = parseVueSource('A.vue', 'root', false, src);
    const late = pf.functions.find((f) => f.name === 'late')!;
    // `export function late` is on physical line 6, not line 1.
    expect(late.startLine).toBeGreaterThanOrEqual(6);
  });

  it('parses <script setup lang="ts">', () => {
    const src = `<script setup lang="ts">
import { ref } from 'vue';
export function inc(n: number) { return n + 1; }
</script>
<template><button @click="inc(1)" /></template>
`;
    const pf = parseVueSource('B.vue', 'root', false, src);
    expect(pf.exports.map((e) => e.name)).toContain('inc');
    expect(pf.imports.map((i) => i.specifier)).toContain('vue');
  });

  it('merges a classic <script> and a <script setup> block', () => {
    const src = `<script lang="ts">
export const NAME = 'x';
</script>
<script setup lang="ts">
export function go() { return NAME; }
</script>
`;
    const pf = parseVueSource('C.vue', 'root', false, src);
    const names = pf.exports.map((e) => e.name);
    expect(names).toContain('NAME');
    expect(names).toContain('go');
  });

  it('handles a template-only SFC (no <script>) without crashing', () => {
    const pf = parseVueSource('D.vue', 'root', false, '<template><div/></template>\n');
    expect(pf.exports).toEqual([]);
    expect(pf.functions).toEqual([]);
    expect(pf.isIndex).toBe(false);
  });

  it('defaults to JS when no lang attr is present', () => {
    const src = `<script>
export function plain(a, b) { return a + b; }
</script>
`;
    const pf = parseVueSource('E.vue', 'root', false, src);
    expect(pf.exports.map((e) => e.name)).toContain('plain');
  });
});
