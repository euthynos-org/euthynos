import { langOf } from '../discover.js';
import type { MetricScore, ModuleGraph, ModuleInfo } from '../types.js';

/**
 * Languages with an interface-FILE convention — a single file that IS the
 * module's public surface (TS/JS `index.*`, Python `__init__.py`; Vue delegates
 * to the TS compiler). For everything else (Java, Kotlin, C#, Go, Rust, C/C++,
 * PHP, Swift, Dart, Ruby, COBOL) the boundary is expressed by member VISIBILITY
 * or headers, so "no interface file" is not a real defect there — penalising it
 * gave every JVM/C-family module a fixed −35 and a meaningless "Weak" seam score.
 */
export const INTERFACE_FILE_LANGS = new Set(['ts', 'py', 'vue']);

/**
 * SEAM HEALTH (spec §2): is the module boundary explicit, respected, and tested?
 *   - interface file exists (index.ts as the public surface) — only judged for
 *     languages that HAVE that convention
 *   - no deep imports bypassing it
 *   - no circular dependencies crossing it
 *   - tests exercise the boundary
 *
 * Bands: 80+ Healthy · 60-79 Adequate · 40-59 Weak · 0-39 Missing
 */
export function moduleSeams(mod: ModuleInfo, graph: ModuleGraph, allTests: boolean): MetricScore {
  const issues: string[] = [];
  let score = 100;

  // Only judge the interface-file criterion where the language uses one.
  const usesInterfaceFiles = mod.files.some((f) => INTERFACE_FILE_LANGS.has(langOf(f.path)));
  if (usesInterfaceFiles && !mod.hasInterfaceFile) {
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
