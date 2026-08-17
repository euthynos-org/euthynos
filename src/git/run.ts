import { execFileSync } from 'node:child_process';

/**
 * Hardened, read-only `git log` invocation.
 *
 * We may be scanning a HOSTILE repository — a cloud SaaS clones untrusted
 * customer code, and even the local CLI can be pointed at a malicious repo.
 * Plain `git` honors the repo-local `.git/config`, `core.fsmonitor`,
 * `core.hooksPath`, `.gitattributes` filters, and alternate transports — any of
 * which can turn a "read-only" git command into arbitrary code execution. We
 * only ever READ history (`git log`); we never checkout, fetch, run hooks, or
 * invoke filters. These overrides neutralize that class of attack:
 *
 *   -c core.hooksPath=/dev/null   no repo hooks fire on any git operation
 *   -c core.fsmonitor=false       repo can't register an fsmonitor command
 *   -c protocol.ext.allow=never   no `ext::` transport (command execution)
 *   -c protocol.file.allow=never  no `file://` submodule/transport tricks
 * plus env: GIT_CONFIG_NOSYSTEM (ignore system config), GIT_TERMINAL_PROMPT=0
 * (never block on auth), GIT_LFS_SKIP_SMUDGE=1 (no LFS filter execution).
 *
 * Command-line `-c` beats repo-local config, so a committed `.git/config` can't
 * re-enable these. Shared by history.ts and authors.ts so the hardening can
 * never drift between them.
 */
const HARDEN_ARGS = [
  // Determinism as well as safety: an operator's ~/.gitconfig with
  // log.showSignature=true would splice GPG blocks into every log we parse.
  '-c', 'log.showSignature=false',
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.fsmonitor=false',
  '-c', 'protocol.ext.allow=never',
  '-c', 'protocol.file.allow=never',
];

const HARDEN_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_LFS_SKIP_SMUDGE: '1',
};

/**
 * REQUEST-SCOPED result sharing.
 *
 * One tool call asks git the same question more than once: the change
 * oracle and the diff engine each ran their own `git status --porcelain`,
 * measured at 302 ms and 303 ms respectively on a 10,000-file repository.
 * Spawning git dominates the diff path, and within a single request the
 * working tree is fixed BY DEFINITION — the agent cannot edit a file
 * midway through our own function call — so a repeated invocation must
 * return the same bytes.
 *
 * This is scoping, not caching: the map is cleared at every request
 * boundary (`beginRequest()`), so a tool call never sees another call's
 * git state and there is no TTL to reason about. Failures are cached too,
 * so a repo without commits does not re-spawn a failing probe repeatedly
 * inside one request.
 */
const requestResults = new Map<string, { ok: true; value: string } | { ok: false; err: unknown }>();
let gitCalls = 0;
/**
 * 0 means NO request scope has ever been opened, and then nothing is
 * shared at all — exactly the rule the index memo uses (`requestId > 0`).
 * A caller that never opens a scope (a library embedder, a test, a CLI
 * one-shot) must never be handed a result it did not just ask for, because
 * without a boundary there is nothing to invalidate the entry.
 */
let gitRequestId = 0;

/** Called at every request boundary; see index/incremental.ts beginRequest(). */
export function resetGitRequestCache(): void {
  gitRequestId++;
  requestResults.clear();
}

/** Test seam: return to the "no scope open" state, disabling sharing. */
export function disableGitRequestCacheForTests(): void {
  gitRequestId = 0;
  requestResults.clear();
}

/** Test seam: how many real git processes have been spawned. */
export function gitCallCountForTests(): number {
  return gitCalls;
}

/** Run `git -C <root> [hardening] <args>` and return stdout. Throws on failure (callers catch). */
export function runGitLog(root: string, args: string[]): string {
  // Root and args together: a different repository, or a different question,
  // is always a different entry. NUL-joined so no argument value can forge a
  // key boundary.
  const key = JSON.stringify([root, ...args]);
  const scoped = gitRequestId > 0;
  if (scoped) {
    const hit = requestResults.get(key);
    if (hit !== undefined) {
      if (hit.ok) return hit.value;
      throw hit.err;
    }
  }
  try {
    gitCalls++;
    const value = execFileSync('git', ['-C', root, ...HARDEN_ARGS, ...args], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: HARDEN_ENV,
      timeout: 120_000, // hang guard; the worker enforces its own wall-clock too
    });
    if (scoped) requestResults.set(key, { ok: true, value });
    return value;
  } catch (e) {
    if (scoped) requestResults.set(key, { ok: false, err: e });
    throw e;
  }
}

