import { createHash } from 'node:crypto';

/**
 * SESSION DEDUPLICATION — repeat reads of UNCHANGED source are answered with a
 * receipt; source that changed is always re-sent in full.
 *
 * Agents re-request source they already hold — benchmark transcripts show
 * correct answers followed by re-reads of the same spans. Re-sending an
 * identical span is pure context pollution, so a repeat request whose content
 * has NOT changed is answered with a ~20-token receipt instead of the source.
 *
 * The rules that keep this safe:
 *
 *  - Dedup NEVER fires on different content. The key is the hash of the span
 *    text actually about to be served, recomputed fresh each call — an edit
 *    changes the hash, so the full new source is always sent. Deduping on
 *    args alone would serve a receipt for code that changed underneath.
 *  - The receipt names the escape hatch. An agent whose context was compacted
 *    may genuinely no longer hold the span it once received; `fresh: true`
 *    forces a full re-send. Without a visible escape hatch this feature would
 *    strand exactly the sessions it is meant to help.
 *  - Scope is the server process (stdio MCP = one connection per process).
 *    State never persists: a new session always gets full answers.
 *  - Only SOURCE-serving tools participate (read_function, read_span). Fact
 *    tools (callers_of, repo_map...) are cheap and generation-fresh; a
 *    receipt would save little and cost trust.
 */

const served = new Map<string, string>(); // dedupKey -> content sha

/** Full digest — EQUALITY is decided on this, never on a truncation. */
function fullSha(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Short form for receipts only. Display, not identity. */
export function contentSha(text: string): string {
  return fullSha(text).slice(0, 12);
}

export interface DedupCheck {
  /** True when this exact content was already served for this key. */
  repeat: boolean;
  sha: string;
}

/**
 * Record/check in one step: returns whether (key, content) was already
 * served, and remembers it either way. `fresh` bypasses the repeat answer but
 * still records, so the NEXT non-fresh repeat dedups again.
 */
export function checkServed(key: string, content: string, fresh: boolean): DedupCheck {
  const full = fullSha(content);
  const repeat = !fresh && served.get(key) === full;
  served.set(key, full);
  // The returned sha is the DISPLAY form; the map compared full digests.
  return { repeat, sha: full.slice(0, 12) };
}

/**
 * The receipt: WHAT is unchanged (location + sha) and the escape hatch, in
 * one line. Every extra word here is paid on EVERY dedup hit — the exact cost
 * this feature exists to remove — so the phrasing is terse; the full
 * fresh-call syntax lives in the server instructions.
 */
export function dedupReceipt(location: string, sha: string): string {
  return `unchanged since served (sha ${sha}) — ${location} · already in your context; pass fresh: true if it was compacted away.`;
}

/** Tests + any future multi-connection server: drop all dedup state. */
/**
 * Read-only view for check_my_changes' stale-assumption warnings: the
 * repo-relative FILES this session was served source from (keys are
 * `tool|root|file[#symbol]|…`). The warning claims only what the session
 * actually saw — never generalized to unserved files.
 */
export function servedFiles(root: string): Set<string> {
  const out = new Set<string>();
  for (const key of served.keys()) {
    const parts = key.split('|');
    if (parts.length >= 3 && parts[1] === root) {
      const file = parts[2]!.split('#')[0]!;
      if (file.length > 0) out.add(file);
    }
  }
  return out;
}

export function resetDedup(): void {
  served.clear();
}

/** Introspection for telemetry/tests. */
export function dedupSize(): number {
  return served.size;
}
