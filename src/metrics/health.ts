/**
 * ARCHITECTURE HEALTH (spec §6) — the composite:
 *   Depth 25% · Seams 20% · Locality 25% · Leverage 15% · Inverse Contamination 15%
 * Metrics that are n/a (e.g. no git history) drop out and weights renormalize.
 */
export function architectureHealth(parts: {
  depth: number | null;
  seams: number | null;
  locality: number | null;
  leverage: number | null;
  contamination: number; // 0-100, lower is better
}): { score: number; label: string } {
  const weighted: Array<[number, number]> = [];
  if (parts.depth !== null) weighted.push([parts.depth, 0.25]);
  if (parts.seams !== null) weighted.push([parts.seams, 0.2]);
  if (parts.locality !== null) weighted.push([parts.locality, 0.25]);
  if (parts.leverage !== null) weighted.push([parts.leverage, 0.15]);
  weighted.push([100 - parts.contamination, 0.15]);

  const totalW = weighted.reduce((s, [, w]) => s + w, 0);
  const score = Math.round(weighted.reduce((s, [v, w]) => s + v * w, 0) / totalW);

  return { score, label: healthLabel(score) };
}

export function healthLabel(s: number): string {
  if (s >= 80) return 'Strong';
  if (s >= 60) return 'Stable';
  if (s >= 40) return 'Drifting';
  return 'At Risk';
}
