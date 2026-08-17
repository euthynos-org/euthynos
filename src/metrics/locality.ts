import type { GitHistory, MetricScore } from '../types.js';

/**
 * LOCALITY (spec §3): Locality = 1 - Scatter Index, from git co-change.
 * A module whose changes also sweep through many other top-level directories
 * (and many files) has scattered logic.
 *
 * Bands: 80+ Concentrated · 60-79 Moderate · 40-59 Scattered · 0-39 Fragmented
 */
export function moduleLocality(moduleName: string, git: GitHistory): MetricScore {
  if (!git.available) return { score: null, label: 'n/a', detail: 'no git history' };
  const stats = git.perModule.get(moduleName);
  if (!stats || stats.commits < 2) {
    return { score: null, label: 'n/a', detail: 'too few commits in window' };
  }

  // 1 directory => 0 spread; 5+ directories => full spread.
  const dirSpread = Math.min(Math.max(stats.avgDirSpread - 1, 0) / 4, 1);
  const fileSpread = Math.min(stats.avgFilesTouched / 12, 1);
  const scatter = 0.7 * dirSpread + 0.3 * fileSpread;
  const score = Math.round(100 * (1 - scatter));

  return {
    score,
    label: localityLabel(score),
    detail: `${stats.commits} commits · ${stats.avgDirSpread.toFixed(1)} dirs, ${stats.avgFilesTouched.toFixed(1)} files per change`,
  };
}

export function localityLabel(s: number): string {
  if (s >= 80) return 'Concentrated';
  if (s >= 60) return 'Moderate';
  if (s >= 40) return 'Scattered';
  return 'Fragmented';
}
