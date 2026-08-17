import type { MetricScore, ModuleGraph, ModuleInfo } from '../types.js';

/**
 * SEAM HEALTH (spec §2): is the module boundary explicit, respected, and tested?
 *   - interface file exists (index.ts as the public surface)
 *   - no deep imports bypassing it
 *   - no circular dependencies crossing it
 *   - tests exercise the boundary
 *
 * Bands: 80+ Healthy · 60-79 Adequate · 40-59 Weak · 0-39 Missing
 */
export function moduleSeams(mod: ModuleInfo, graph: ModuleGraph, allTests: boolean): MetricScore {
  const issues: string[] = [];
  let score = 100;

  if (!mod.hasInterfaceFile) {
    score -= 35;
    issues.push('no interface file');
  }

  const violations = graph.deepImports.filter((d) => d.toModule === mod.name).length;
  if (violations > 0) {
    score -= Math.min(violations * 8, 30);
    issues.push(`${violations} deep import${violations > 1 ? 's' : ''} bypass the interface`);
  }

  const inCycle = graph.cycles.some((c) => c.includes(mod.name));
  if (inCycle) {
    score -= 25;
    issues.push('circular dependency');
  }

  const boundaryTested = mod.files.some((f) => f.isTest);
  if (!boundaryTested && !allTests) {
    score -= 10;
    issues.push('boundary untested');
  }

  score = Math.max(0, score);
  return {
    score,
    label: seamLabel(score),
    detail: issues.length ? issues.join(' · ') : 'explicit, respected, tested',
  };
}

export function seamLabel(s: number): string {
  if (s >= 80) return 'Healthy';
  if (s >= 60) return 'Adequate';
  if (s >= 40) return 'Weak';
  return 'Missing';
}
