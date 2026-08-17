import type { CoChangeStats, GitHistory } from '../types.js';
import { runGitLog } from './run.js';

const CODE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|java|go|rs|cs|rb|php)$/;

/**
 * Co-change analysis (the spec's strongest locality signal):
 * for every commit in the window, which files changed together,
 * and how many distinct top-level directories did each change span.
 *
 * moduleOf is injected so this module stays a leaf (our own scan flagged
 * the import of discover.ts here as a runtime cycle — it was right).
 */
export function analyzeHistory(
  root: string,
  months: number,
  moduleOf: (rel: string) => string,
): GitHistory {
  const empty: GitHistory = {
    available: false,
    windowMonths: months,
    totalCommits: 0,
    perModule: new Map(),
  };

  let raw: string;
  try {
    raw = runGitLog(root, ['log', `--since=${months}.months`, '--name-only', '--pretty=format:__COMMIT__', '--no-merges']);
  } catch {
    return empty;
  }

  const commits: string[][] = [];
  let current: string[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (t === '__COMMIT__') {
      if (current.length) commits.push(current);
      current = [];
    } else if (t && CODE_EXT.test(t)) {
      current.push(t.replace(/\\/g, '/'));
    }
  }
  if (current.length) commits.push(current);
  if (commits.length === 0) return empty;

  const acc = new Map<string, { commits: number; dirSum: number; fileSum: number }>();
  for (const filesChanged of commits) {
    const modulesTouched = new Set(filesChanged.map(moduleOf));
    const topDirs = new Set(filesChanged.map((f) => f.split('/')[0] ?? f));
    for (const m of modulesTouched) {
      const a = acc.get(m) ?? { commits: 0, dirSum: 0, fileSum: 0 };
      a.commits++;
      a.dirSum += topDirs.size;
      a.fileSum += filesChanged.length;
      acc.set(m, a);
    }
  }

  const perModule = new Map<string, CoChangeStats>();
  for (const [m, a] of acc) {
    perModule.set(m, {
      commits: a.commits,
      avgDirSpread: a.dirSum / a.commits,
      avgFilesTouched: a.fileSum / a.commits,
    });
  }

  return { available: true, windowMonths: months, totalCommits: commits.length, perModule };
}
