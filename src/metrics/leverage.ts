import type { MetricScore, ModuleGraph, ModuleInfo } from '../types.js';

/**
 * LEVERAGE (spec §4):
 *   Leverage = (Usage Breadth × Usage Depth) / Interface Complexity
 *   Breadth = unique caller modules · Depth = utilization of the exported surface.
 *
 * Bands: 80+ High Leverage · 60-79 Good · 40-59 Underutilized · 0-39 Dead Weight
 */
export function moduleLeverage(
  mod: ModuleInfo,
  graph: ModuleGraph,
  totalModules: number,
): MetricScore & { callers: number; utilizationPct: number | null } {
  const exported = mod.exportedNames.size;
  if (exported === 0) {
    return { score: null, label: 'n/a', detail: 'no exported surface', callers: 0, utilizationPct: null };
  }

  const callers = graph.importedBy.get(mod.name)?.size ?? 0;
  const used = graph.usedExports.get(mod.name)?.size ?? 0;
  const utilization = Math.min(used / exported, 1);

  if (callers === 0) {
    return {
      score: 10,
      label: 'Dead Weight',
      detail: `${exported} exports, zero callers`,
      callers,
      utilizationPct: 0,
    };
  }

  // Breadth saturates against codebase size (being used by 6+ of any size counts as broad).
  const breadth = Math.min(callers / Math.min(Math.max(totalModules - 1, 1), 6), 1);
  // Penalize bloated interfaces: utilization already does, surface size adds drag.
  const surfaceDrag = Math.min(exported / 25, 1) * 0.15;
  const raw = 0.55 * breadth + 0.45 * utilization - surfaceDrag;
  const score = Math.round(Math.max(0, Math.min(1, raw)) * 100);

  return {
    score,
    label: leverageLabel(score),
    detail: `${callers} caller modules · ${used}/${exported} exports used`,
    callers,
    utilizationPct: Math.round(utilization * 100),
  };
}

export function leverageLabel(s: number): string {
  if (s >= 80) return 'High Leverage';
  if (s >= 60) return 'Good';
  if (s >= 40) return 'Underutilized';
  return 'Dead Weight';
}
