import type { MetricScore } from '../types.js';
import type { ModuleAuthorStats } from '../git/authors.js';

/**
 * KNOWLEDGE RISK — how widely a module's commit history is spread across authors.
 *   score = clamp(0, 100, round(25 * min(busFactor, 4) - max(0, topShare - 0.5) * 100))
 *   Higher = healthier distribution. Bus factor earns 25 pts per author
 *   (saturating at 4); a dominant author pays one point per percentage
 *   point of commit share above 50%.
 *
 * Reads commit authorship only — it says nothing about the quality of the code
 * or how well any author actually understands it. Below 3 commits the score is
 * null ('n/a'), not 0: that history is too thin to tell concentration apart
 * from a module nobody has touched yet.
 *
 * Bands: 80+ Distributed · 60-79 Shared · 40-59 Concentrated · 0-39 Bus Factor 1
 */
export function knowledgeRisk(stats: ModuleAuthorStats | undefined): MetricScore {
  if (!stats || stats.commits < 3) return { score: null, label: 'n/a', detail: 'too few commits' };

  const raw = 25 * Math.min(stats.busFactor, 4) - Math.max(0, stats.topShare - 0.5) * 100;
  const score = Math.max(0, Math.min(100, Math.round(raw)));

  return {
    score,
    label: riskLabel(score),
    detail: `${stats.topAuthor} ${Math.round(stats.topShare * 100)}% of ${stats.commits} commits · bus factor ${stats.busFactor}`,
  };
}

export function riskLabel(s: number): string {
  if (s >= 80) return 'Distributed';
  if (s >= 60) return 'Shared';
  if (s >= 40) return 'Concentrated';
  return 'Bus Factor 1';
}

/** Dominant author = de-facto owner; only meaningful with a real majority and enough signal. */
export function inferOwner(stats: ModuleAuthorStats | undefined): string | null {
  if (!stats || stats.commits < 3) return null;
  return stats.topShare >= 0.5 ? stats.topAuthor : null;
}
