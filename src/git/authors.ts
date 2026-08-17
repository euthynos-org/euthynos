import { runGitLog } from './run.js';

const CODE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|java|go|rs|cs|rb|php)$/;
const MARKER = '__C__';

/**
 * Author concentration analysis (pillars 11+12):
 * for every commit in the window, who wrote it and which modules it touched.
 * From that, per module: commits per author, the dominant author, and the
 * bus factor — the minimum number of authors whose commits cover >=80% of
 * the module's commits.
 *
 * moduleOf is injected so this module stays a leaf (same rule as history.ts —
 * importing discover.ts here creates a runtime cycle our own scanner flags).
 */
export interface ModuleAuthorStats {
  /** Commits in window that touched this module. */
  commits: number;
  /** author name -> commits by that author touching this module. */
  authors: Map<string, number>;
  /** Author with the most commits (count ties broken alphabetically). */
  topAuthor: string;
  /** topAuthor's commits / total commits, 0..1. */
  topShare: number;
  /** Minimum number of authors whose commits cover >=80% of the module's commits. */
  busFactor: number;
}

export interface AuthorAnalysis {
  available: boolean;
  windowMonths: number;
  perModule: Map<string, ModuleAuthorStats>;
}

/**
 * Parse `git log --since=<n>.months --no-merges --name-only --pretty=format:__C__%an`
 * output. A `__C__<author>` line starts a commit; the non-blank lines that follow
 * (until the next marker) are the file paths it changed. Filters to code extensions
 * and normalizes backslashes. Pure so it is unit-testable without git.
 */
export function parseAuthorLog(
  raw: string,
  moduleOf: (rel: string) => string,
): Map<string, ModuleAuthorStats> {
  const commits: Array<{ author: string; files: string[] }> = [];
  let current: { author: string; files: string[] } | null = null;
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (t.startsWith(MARKER)) {
      if (current) commits.push(current);
      current = { author: t.slice(MARKER.length).trim(), files: [] };
    } else if (current && t && CODE_EXT.test(t)) {
      current.files.push(t.replace(/\\/g, '/'));
    }
  }
  if (current) commits.push(current);

  const acc = new Map<string, Map<string, number>>();
  for (const c of commits) {
    if (c.files.length === 0) continue;
    const modulesTouched = new Set(c.files.map(moduleOf));
    for (const m of modulesTouched) {
      let byAuthor = acc.get(m);
      if (!byAuthor) {
        byAuthor = new Map();
        acc.set(m, byAuthor);
      }
      byAuthor.set(c.author, (byAuthor.get(c.author) ?? 0) + 1);
    }
  }

  const perModule = new Map<string, ModuleAuthorStats>();
  for (const [m, byAuthor] of acc) perModule.set(m, moduleStats(byAuthor));
  return perModule;
}

function moduleStats(byAuthor: Map<string, number>): ModuleAuthorStats {
  let commits = 0;
  for (const n of byAuthor.values()) commits += n;

  // Rank by commits desc, then name asc — deterministic on count ties.
  const ranked = [...byAuthor.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const top = ranked[0];
  const topAuthor = top?.[0] ?? '';
  const topCount = top?.[1] ?? 0;

  // Bus factor: walk the ranking until cumulative coverage reaches 80%.
  // Integer comparison (5*covered >= 4*commits) avoids float drift at exactly 80%.
  let busFactor = 0;
  let covered = 0;
  for (const [, n] of ranked) {
    busFactor++;
    covered += n;
    if (5 * covered >= 4 * commits) break;
  }

  return {
    commits,
    authors: byAuthor,
    topAuthor,
    topShare: commits > 0 ? topCount / commits : 0,
    busFactor,
  };
}

export function analyzeAuthors(
  root: string,
  months: number,
  moduleOf: (rel: string) => string,
): AuthorAnalysis {
  const empty: AuthorAnalysis = { available: false, windowMonths: months, perModule: new Map() };

  let raw: string;
  try {
    raw = runGitLog(root, ['log', `--since=${months}.months`, '--no-merges', '--name-only', `--pretty=format:${MARKER}%an`]);
  } catch {
    return empty;
  }

  const perModule = parseAuthorLog(raw, moduleOf);
  if (perModule.size === 0) return empty;
  return { available: true, windowMonths: months, perModule };
}
