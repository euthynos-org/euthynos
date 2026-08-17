import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',

    /*
     * Worker cap, not a timeout bump.
     *
     * Many tests build a real index and shell out to git against a fixture
     * repo, so each worker holds a parsed tree and spawns processes. Vitest
     * defaults to one worker per core; on a 16-core box that is 16 concurrent
     * indexers, which exhausts memory rather than CPU.
     *
     * Measured on this repo (16 cores, ~4 GB free), full suite, with the
     * default 5s test timeout left untouched. The reference figure is the
     * slowest test, phase6-step5 "byte-identical on unchanged state", which
     * costs ~1.7s standalone:
     *
     *   forks   result                          that test    headroom
     *   16      FATAL: heap out of memory       timeout      —
     *    4      all pass                        3991 ms      20%
     *    2      all pass                        3119 ms      38%
     *
     * 4 passes, but 20% headroom on a slower CI runner is a coin flip, and a
     * release gate that flakes is worse than one that takes longer. Capping at
     * 2 keeps the margin. Raise it only with a fresh measurement, and never by
     * relaxing testTimeout — the timeout is what surfaced this in the first
     * place.
     */
    pool: 'forks',
    poolOptions: {
      forks: {
        maxForks: 2,
        minForks: 1,
      },
    },
  },
});
