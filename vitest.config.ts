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

    /*
     * Never let a test's git spawn a filesystem-monitor daemon.
     *
     * Git for Windows can ship `core.fsmonitor = true` in the SYSTEM config.
     * Every temp repository a test creates then auto-starts
     * `git fsmonitor--daemon run --detach` on its first index-touching
     * command — a DETACHED process that outlives the test, the repository
     * and the worker. One long session accumulated 455 of them (~17 GB of
     * commit charge), after which workers died with ERR_IPC_CHANNEL_CLOSED
     * and V8 "committing semi space failed" — a memory crash that looked
     * like a test-suite problem and was not.
     *
     * The engine's own runner (src/git/run.ts) already passes
     * `-c core.fsmonitor=false`; the tests' direct `git init`/`git add`
     * calls did not. This env is inherited by every child process a worker
     * spawns, so it covers both. It is a targeted key override on purpose:
     * GIT_CONFIG_NOSYSTEM would also drop system autocrlf, and
     * diff-engine.test.ts depends on plain git still seeing that.
     */
    env: {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.fsmonitor',
      GIT_CONFIG_VALUE_0: 'false',
    },
  },
});
