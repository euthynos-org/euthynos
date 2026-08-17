import type { MetricScore, ModuleInfo } from '../types.js';

/**
 * MODULE DEPTH (spec §1):
 *   Depth = (Implementation Complexity / Interface Complexity) * normalization
 *   Interface Complexity = exported functions + exported types + required params + config surface
 *   Implementation       = internal LOC + private functions
 *
 * Bands: 80+ Deep · 60-79 Moderate · 40-59 Shallow · 0-39 Very Shallow
 */
export function moduleDepth(mod: ModuleInfo): MetricScore {
  const src = mod.files.filter((f) => !f.isTest);
  if (src.length === 0) return { score: null, label: 'n/a', detail: 'tests only' };

  let exportedFns = 0;
  let exportedTypes = 0;
  let exportedConsts = 0;
  let reExports = 0;
  let requiredParams = 0;
  let privateFns = 0;
  let loc = 0;

  for (const f of src) {
    loc += f.codeLines;
    privateFns += f.internalFunctions;
    for (const e of f.exports) {
      if (e.kind === 'function' || e.kind === 'class') {
        exportedFns++;
        requiredParams += e.requiredParams;
      } else if (e.kind === 'type') exportedTypes++;
      else if (e.kind === 'const') exportedConsts++;
      else if (e.kind === 'reexport') reExports++;
    }
  }

  const interfaceComplexity =
    exportedFns + exportedTypes + 0.5 * exportedConsts + 0.5 * requiredParams + 0.25 * reExports;
  const implementation = loc + 5 * privateFns;

  if (interfaceComplexity === 0) {
    // Nothing exported: internal-only module. Deep by definition but flag it.
    return { score: 75, label: 'Moderate', detail: `no exports, ${loc} LOC internal` };
  }

  const raw = implementation / interfaceComplexity;
  // Saturation curve: raw 18 lines-per-interface-unit ≈ 50, 72 ≈ 80.
  const score = Math.round(100 * (raw / (raw + 18)));
  // Pure re-export barrels are the shallowest thing there is.
  const reExportRatio = reExports / Math.max(1, exportedFns + exportedTypes + exportedConsts + reExports);
  const final = reExportRatio > 0.8 && loc < 30 ? Math.min(score, 25) : score;

  return {
    score: final,
    label: depthLabel(final),
    detail: `${exportedFns} exported fns, ${requiredParams} required params, ${loc} LOC`,
  };
}

export function depthLabel(s: number): string {
  if (s >= 80) return 'Deep';
  if (s >= 60) return 'Moderate';
  if (s >= 40) return 'Shallow';
  return 'Very Shallow';
}
