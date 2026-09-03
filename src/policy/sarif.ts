import type { PolicyResult, Violation } from './evaluate.js';
import { fingerprintOf, type DiffScope } from './diff.js';
import type { ScanReport } from '../types.js';

/**
 * SARIF 2.1.0 — the interchange format every static-analysis consumer speaks.
 * GitHub Code Scanning ingests it natively, so a policy verdict lands in the
 * PR's Security tab and as inline annotations on the diff with no UI of our
 * own; anything else that reads SARIF (IDEs, ASPM tools) reads us too.
 *
 * Mapping, deliberately minimal and honest:
 *  - one `result` per violation; `level` error (block) / warning (warn)
 *  - a physical location ONLY when the violation carries one — an aggregate
 *    finding gets no location rather than a fabricated one
 *  - `partialFingerprints` = the same line-stable fingerprint the diff scope
 *    uses, so GitHub tracks an alert across commits instead of re-opening it
 *    every time a line above it moves
 *  - the remedy travels in the message text (what a reader sees) AND in
 *    `properties` (what a tool reads); SARIF `fixes` are not used because the
 *    schema requires artifact edits we do not synthesize
 *  - config errors and skipped rules become tool-execution notifications, and
 *    a config error marks the invocation unsuccessful — a SARIF file that
 *    looked clean because rules could not run would be the silent pass this
 *    engine refuses
 * Output is deterministic: results follow violation order, rules are sorted.
 */

export const SARIF_SCHEMA = 'https://json.schemastore.org/sarif-2.1.0.json';
export const SARIF_VERSION = '2.1.0';

export interface SarifOptions {
  /** Engine version stamped on the tool driver. */
  version: string;
  /** When the CLI ran in diff scope, each result says whether the change introduced it. */
  diff?: DiffScope | null;
}

export interface SarifLog {
  $schema: string;
  version: string;
  runs: SarifRun[];
}

export interface SarifRun {
  tool: { driver: { name: string; version: string; informationUri: string; rules: SarifRule[] } };
  results: SarifResult[];
  invocations: SarifInvocation[];
}

export interface SarifRule {
  id: string;
  shortDescription: { text: string };
  properties: { type: string; mode: 'warn' | 'block' };
}

export interface SarifResult {
  ruleId: string;
  level: 'error' | 'warning';
  message: { text: string };
  partialFingerprints: { 'euthynos/v1': string };
  locations?: SarifLocation[];
  properties?: Record<string, unknown>;
}

export interface SarifLocation {
  physicalLocation: {
    artifactLocation: { uri: string; uriBaseId: string };
    region: { startLine: number; endLine?: number };
  };
}

export interface SarifInvocation {
  executionSuccessful: boolean;
  toolExecutionNotifications: { level: 'error' | 'warning' | 'note'; message: { text: string } }[];
}

const RULE_TEXT: Record<Violation['type'], string> = {
  'forbidden-dependency': 'An import crosses a module boundary the policy forbids.',
  'no-new-duplication': 'A duplicate-logic pair was introduced relative to the base.',
  'health-delta': 'Architecture health dropped more than the policy allows.',
  'contamination-delta': 'Duplication rose more than the policy allows.',
  'metric-floor': 'A module metric fell below its policy floor.',
  'min-owners': 'A module has fewer owners than the policy requires.',
};

/** Render a policy evaluation as a SARIF 2.1.0 log. Pure and deterministic. */
export function toSarif(result: PolicyResult, report: ScanReport, opts: SarifOptions): SarifLog {
  const rules = new Map<string, SarifRule>();
  const introduced = opts.diff ? new Set(opts.diff.introduced.map(fingerprintOf)) : null;

  const results: SarifResult[] = result.violations.map((v) => {
    if (!rules.has(v.ruleId)) {
      rules.set(v.ruleId, { id: v.ruleId, shortDescription: { text: RULE_TEXT[v.type] }, properties: { type: v.type, mode: v.mode } });
    }
    const fingerprint = fingerprintOf(v);
    const text = v.remedy ? `${v.message} ${v.remedy.instruction}` : v.message;
    const properties: Record<string, unknown> = { type: v.type, mode: v.mode };
    if (v.module !== undefined) properties['module'] = v.module;
    if (v.toFile !== undefined) properties['toFile'] = v.toFile;
    if (v.remedy) properties['remedy'] = v.remedy;
    if (introduced) properties['introduced'] = introduced.has(fingerprint);
    const out: SarifResult = {
      ruleId: v.ruleId,
      level: v.mode === 'block' ? 'error' : 'warning',
      message: { text },
      partialFingerprints: { 'euthynos/v1': fingerprint },
      properties,
    };
    if (v.location) {
      const region: SarifLocation['physicalLocation']['region'] = { startLine: v.location.line ?? 1 };
      if (v.location.endLine !== undefined) region.endLine = v.location.endLine;
      out.locations = [{ physicalLocation: { artifactLocation: { uri: v.location.file, uriBaseId: '%SRCROOT%' }, region } }];
    }
    return out;
  });

  const notifications: SarifInvocation['toolExecutionNotifications'] = [];
  for (const r of result.invalidRules) notifications.push({ level: 'error', message: { text: `rule ${r.ruleId}: ${r.reason}` } });
  if (result.skippedDeltaRules > 0) notifications.push({ level: 'warning', message: { text: `${result.skippedDeltaRules} delta rule(s) skipped — no base report.` } });
  if (result.skippedEdgeRules > 0) notifications.push({ level: 'warning', message: { text: `${result.skippedEdgeRules} forbidden-dependency rule(s) skipped — the report carries no import edges.` } });
  if (result.skippedIncompleteRules > 0) notifications.push({ level: 'warning', message: { text: `${result.skippedIncompleteRules} no-new-duplication rule(s) skipped — the base pair list is not provably complete.` } });
  for (const u of result.unmatchedGlobs) notifications.push({ level: 'note', message: { text: `rule ${u.ruleId}: "${u.side}: ${u.glob}" matches no module in this report.` } });
  if (result.partialCoverage) {
    const p = result.partialCoverage;
    notifications.push({ level: 'warning', message: { text: `partial coverage — ${p.skippedFiles} file(s) failed to parse${p.discoveryTruncated ? '; discovery hit the file cap' : ''}.` } });
  }
  if (result.duplicationHeadCapped) notifications.push({ level: 'note', message: { text: 'the head duplicate-pair list is capped; pairs beyond it were not judged for newness.' } });
  if (result.singleModuleTree !== undefined) {
    notifications.push({ level: 'warning', message: { text: `the whole tree scanned as one module ("${result.singleModuleTree}"); no cross-module edges exist, so boundary rules cannot fire — point the scan at the project root.` } });
  }

  return {
    $schema: SARIF_SCHEMA,
    version: SARIF_VERSION,
    runs: [
      {
        tool: {
          driver: {
            name: 'euthynos',
            version: opts.version,
            informationUri: 'https://euthynos.dev',
            rules: [...rules.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
          },
        },
        results,
        invocations: [{ executionSuccessful: result.invalidRules.length === 0, toolExecutionNotifications: notifications }],
      },
    ],
  };
}

/** Serialize with a trailing newline; indentation keeps the file diffable. */
export function sarifText(log: SarifLog): string {
  return JSON.stringify(log, null, 2) + '\n';
}
