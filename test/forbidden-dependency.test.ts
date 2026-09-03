import { beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { evaluatePolicy, validatePolicy } from '../src/policy/evaluate.js';
import { renderPolicyMarkdown, renderPolicyTerminal } from '../src/policy/render.js';
import { buildGraph } from '../src/graph/imports.js';
import { parseTsSource } from '../src/parse/ts.js';
import { parseGoSource } from '../src/parse/go.js';
import { parseJavaSource } from '../src/parse/java.js';
import { loadLanguages } from '../src/parse/treesitter/loader.js';
import { discoverFiles, moduleOf } from '../src/discover.js';
import { scan } from '../src/scan.js';
import type { PolicyRule } from '../src/policy/evaluate.js';
import type { ContaminationFinding, ImportEdge, MetricScore, ModuleReport, ScanReport } from '../src/types.js';

/**
 * C1 — the `forbidden-dependency` policy rule: "module A may not import
 * module B", judged on the resolved cross-module import statements the graph
 * already builds. This is the first LOCALIZED rule (a file:line, not an
 * aggregate score), which is what makes a violation something a person — or
 * an agent — can actually go and fix.
 *
 * Two halves are tested: (1) the rule, against hand-built edges, so every
 * branch is pinned; (2) the edge SOURCE, against real parsed TypeScript and a
 * real scan, so the plumbing from import statement → serialized report is
 * proven and not assumed.
 */

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, 'fixtures', 'sample');

const edge = (over: Partial<ImportEdge> = {}): ImportEdge => ({
  fromFile: 'src/ui/cart.ts', fromModule: 'ui', line: 3,
  toFile: 'src/db/orders.ts', toModule: 'db',
  isTypeOnly: false, fromIsTest: false,
  ...over,
});

function rep(over: Partial<ScanReport> = {}): ScanReport {
  return {
    root: '/r', scannedAt: 't', filesScanned: 1, modules: [],
    contamination: { score: 0, label: 'Clean', findings: [], violations: 0, cloneFnIds: [] },
    health: { score: 60, label: 'Stable' },
    averages: { depth: 50, seams: 70, locality: 50, leverage: 50 },
    opportunities: [], gitAvailable: true, ...over,
  };
}

const ms = (score: number | null): MetricScore => ({ score, label: '', detail: '' });
/** A minimal module row — only `name` matters to the glob vocabulary. */
function moduleReport(name: string): ModuleReport {
  return {
    name, files: 1, codeLines: 10,
    depth: ms(50), seams: ms(70), locality: ms(50), leverage: ms(50),
    exportedCount: 1, callerCount: 1, utilizationPct: 50,
    ownership: { owner: 'a', busFactor: 2, topShare: 0.5, topAuthor: 'a', risk: ms(60) },
  };
}

const NO_UI_TO_DB = { id: 'no-ui-to-db', type: 'forbidden-dependency' as const, from: 'ui', to: 'db', mode: 'block' as const };

describe('forbidden-dependency rule — evaluation', () => {
  it('fires on a cross-module import that matches from → to, and blocks in block mode', () => {
    const r = evaluatePolicy({ rules: [NO_UI_TO_DB] }, rep({ importEdges: [edge()] }));
    expect(r.passed).toBe(false);
    expect(r.blocked).toBe(true);
    expect(r.violations).toHaveLength(1);
    const v = r.violations[0]!;
    expect(v.ruleId).toBe('no-ui-to-db');
    expect(v.type).toBe('forbidden-dependency');
    expect(v.module).toBe('ui'); // the offending (importing) module
  });

  it('names the exact file:line and the forbidden crossing in the message', () => {
    const r = evaluatePolicy({ rules: [NO_UI_TO_DB] }, rep({ importEdges: [edge()] }));
    const msg = r.violations[0]!.message;
    expect(msg).toContain('src/ui/cart.ts:3');
    expect(msg).toContain('imports db');
    expect(msg).toContain('ui → db is forbidden');
  });

  it('does NOT fire when the target module is not the forbidden one', () => {
    const r = evaluatePolicy({ rules: [NO_UI_TO_DB] }, rep({ importEdges: [edge({ toModule: 'services', toFile: 'src/services/orders.ts' })] }));
    expect(r.passed).toBe(true);
  });

  it('does NOT fire when the importing module is outside `from`', () => {
    const r = evaluatePolicy({ rules: [NO_UI_TO_DB] }, rep({ importEdges: [edge({ fromModule: 'services', fromFile: 'src/services/x.ts' })] }));
    expect(r.passed).toBe(true);
  });

  it('`from` defaults to any module', () => {
    const r = evaluatePolicy({ rules: [{ type: 'forbidden-dependency', to: 'db' }] }, rep({ importEdges: [edge({ fromModule: 'anything' })] }));
    expect(r.violations).toHaveLength(1);
  });

  it('honors the module glob syntax on both sides (X/* covers X and X/sub; X* is a prefix)', () => {
    const edges = [
      edge({ fromModule: 'ui', toModule: 'db' }),
      edge({ fromModule: 'ui/cart', toModule: 'db/legacy', fromFile: 'src/ui/cart/x.ts' }),
      edge({ fromModule: 'uix', toModule: 'db', fromFile: 'src/uix/y.ts' }),
    ];
    const subtree = evaluatePolicy({ rules: [{ type: 'forbidden-dependency', from: 'ui/*', to: 'db/*' }] }, rep({ importEdges: edges }));
    expect(subtree.violations.map((v) => v.module)).toEqual(['ui', 'ui/cart']); // 'uix' is not under ui/
    const prefix = evaluatePolicy({ rules: [{ type: 'forbidden-dependency', from: 'ui*', to: 'db' }] }, rep({ importEdges: edges }));
    expect(prefix.violations.map((v) => v.module)).toEqual(['ui', 'uix']); // db/legacy ≠ db
  });

  it('emits one violation per offending import statement (two lines → two findings)', () => {
    const r = evaluatePolicy({ rules: [NO_UI_TO_DB] }, rep({ importEdges: [edge({ line: 3 }), edge({ line: 9, toFile: 'src/db/users.ts' })] }));
    expect(r.violations).toHaveLength(2);
    expect(r.violations.map((v) => v.message)).toEqual([
      expect.stringContaining(':3'),
      expect.stringContaining(':9'),
    ]);
  });

  it('ignores `import type` by default and counts it with includeTypeOnly', () => {
    const typed = rep({ importEdges: [edge({ isTypeOnly: true })] });
    expect(evaluatePolicy({ rules: [NO_UI_TO_DB] }, typed).passed).toBe(true);
    expect(evaluatePolicy({ rules: [{ ...NO_UI_TO_DB, includeTypeOnly: true }] }, typed).violations).toHaveLength(1);
  });

  it('ignores imports made from test files by default and counts them with includeTests', () => {
    const fromTest = rep({ importEdges: [edge({ fromIsTest: true, fromFile: 'src/ui/cart.test.ts' })] });
    expect(evaluatePolicy({ rules: [NO_UI_TO_DB] }, fromTest).passed).toBe(true);
    expect(evaluatePolicy({ rules: [{ ...NO_UI_TO_DB, includeTests: true }] }, fromTest).violations).toHaveLength(1);
  });

  it('carries the human reason and the allowed route into the finding', () => {
    const r = evaluatePolicy(
      { rules: [{ ...NO_UI_TO_DB, message: 'The UI must reach data through a service.', allowedVia: 'services/*' }] },
      rep({ importEdges: [edge()] }),
    );
    expect(r.violations[0]!.message).toContain('The UI must reach data through a service.');
    expect(r.violations[0]!.message).toContain('Allowed route: services/*');
  });

  it('a report with no importEdges is COUNTED as skipped, never silently passed', () => {
    const r = evaluatePolicy({ rules: [NO_UI_TO_DB] }, rep()); // pre-field report
    expect(r.violations).toHaveLength(0);
    expect(r.skippedEdgeRules).toBe(1);
    expect(r.skippedDeltaRules).toBe(0);
  });

  it('a rule with no `to` is RECORDED as invalid and skipped — never thrown, never a silent no-op', () => {
    const r = evaluatePolicy({ rules: [{ type: 'forbidden-dependency', from: 'ui' }] }, rep({ importEdges: [edge()] }));
    expect(r.invalidRules).toEqual([{ ruleId: 'forbidden-dependency#1', reason: expect.stringContaining('requires "to"') }]);
    expect(r.violations).toHaveLength(0);
    expect(r.edgeRulesEvaluated).toBe(0);
  });

  it('is deterministic: same report + same policy → identical violations', () => {
    const report = rep({ importEdges: [edge({ line: 9 }), edge({ line: 3 })] });
    const a = evaluatePolicy({ rules: [NO_UI_TO_DB] }, report);
    const b = evaluatePolicy({ rules: [NO_UI_TO_DB] }, report);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('leaves the existing rule types untouched (skippedEdgeRules stays 0 for them)', () => {
    const r = evaluatePolicy({ rules: [{ type: 'metric-floor', metric: 'seams', min: 1 }] }, rep());
    expect(r.skippedEdgeRules).toBe(0);
  });
});

describe('import edges — the rule’s data source, from real parsed TypeScript', () => {
  const ui = parseTsSource('src/ui/cart.ts', 'ui', false,
    `// header comment\n// another\nimport { listOrders } from '../db/orders.js';\nexport function cart() { return listOrders(); }\n`);
  const db = parseTsSource('src/db/orders.ts', 'db', false, `export function listOrders() { return []; }\n`);
  const dbUtil = parseTsSource('src/db/util.ts', 'db', false, `import { listOrders } from './orders.js';\nexport const n = () => listOrders().length;\n`);
  const uiTypes = parseTsSource('src/ui/types.ts', 'ui', false, `import type { Order } from '../db/orders.js';\nexport type Cart = { items: Order[] };\n`);
  const uiTest = parseTsSource('src/ui/cart.test.ts', 'ui', true, `import { listOrders } from '../db/orders.js';\nlistOrders();\n`);

  const graph = buildGraph([ui, db, dbUtil, uiTypes, uiTest]);

  it('records a resolved cross-module import with the exact statement line', () => {
    const e = graph.importEdges.find((x) => x.fromFile === 'src/ui/cart.ts');
    expect(e).toBeDefined();
    expect(e!.fromModule).toBe('ui');
    expect(e!.toModule).toBe('db');
    expect(e!.toFile).toBe('src/db/orders.ts'); // ./x.js in TS source resolved to x.ts on disk
    expect(e!.line).toBe(3); // two comment lines above it — a plausible-but-wrong line would fail
    expect(e!.isTypeOnly).toBe(false);
    expect(e!.fromIsTest).toBe(false);
  });

  it('does NOT record intra-module imports (a boundary is a crossing between modules)', () => {
    expect(graph.importEdges.some((x) => x.fromFile === 'src/db/util.ts')).toBe(false);
  });

  it('records `import type` and test-file imports, FLAGGED, so the rule can decide', () => {
    const typed = graph.importEdges.find((x) => x.fromFile === 'src/ui/types.ts');
    expect(typed?.isTypeOnly).toBe(true);
    const fromTest = graph.importEdges.find((x) => x.fromFile === 'src/ui/cart.test.ts');
    expect(fromTest?.fromIsTest).toBe(true);
  });

  it('end to end: the rule fires from real edges on exactly the runtime import', () => {
    const r = evaluatePolicy({ rules: [NO_UI_TO_DB] }, rep({ importEdges: graph.importEdges }));
    // cart.ts (runtime) fires; types.ts (import type) and cart.test.ts (test) do not, by default.
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]!.message).toContain('src/ui/cart.ts:3');
  });
});

describe('import edges — carried inside a real scan report', () => {
  const report = scan(FIXTURE, { months: 6 });

  it('the scan report carries importEdges, all cross-module, none self-referential', () => {
    expect(report.importEdges).toBeDefined();
    expect(report.importEdges!.length).toBeGreaterThan(0);
    for (const e of report.importEdges!) {
      expect(e.fromModule).not.toBe(e.toModule);
      expect(e.fromFile).not.toBe(e.toFile);
    }
  });

  it('survives JSON serialization byte-for-byte — the stored-report gate path depends on this', () => {
    const roundTripped = JSON.parse(JSON.stringify(report)) as ScanReport;
    expect(roundTripped.importEdges).toEqual(report.importEdges);
    // And a rule evaluated from the round-tripped report behaves identically.
    const live = evaluatePolicy({ rules: [{ type: 'forbidden-dependency', to: '*' }] }, report);
    const stored = evaluatePolicy({ rules: [{ type: 'forbidden-dependency', to: '*' }] }, roundTripped);
    expect(JSON.stringify(stored)).toBe(JSON.stringify(live));
    expect(live.skippedEdgeRules).toBe(0);
  });
});

/**
 * Regressions from the C1 adversarial review. Both are the forbidden outcome:
 * a WRONG verdict at a real file:line, not a safe miss.
 */
describe('import edges — no phantom crossings (review regressions)', () => {
  it('a bare npm specifier NEVER binds to a coincidentally-named local file (was: false "services → db")', () => {
    // Locals whose basenames collide with package names/tails: redis, client, router.
    const files = [
      parseTsSource('src/services/cache.ts', 'services', false,
        `import { createClient } from 'redis';\nimport { PrismaClient } from '@prisma/client';\nimport { useRouter } from 'next/router';\nexport const c = () => createClient();\n`),
      parseTsSource('src/db/redis.ts', 'db', false, `export const redis = 1;\n`),
      parseTsSource('src/db/client.ts', 'db', false, `export const client = 1;\n`),
      parseTsSource('src/api/router.ts', 'api', false, `export const router = 1;\n`),
    ];
    const graph = buildGraph(files);
    expect(graph.importEdges.filter((e) => e.fromFile === 'src/services/cache.ts')).toEqual([]);
    expect(graph.imports.get('services')).toBeUndefined(); // no module edge either — the graph is honest, not just the rule
    const r = evaluatePolicy({ rules: [{ type: 'forbidden-dependency', from: 'services', to: 'db', mode: 'block' }] }, rep({ importEdges: graph.importEdges }));
    expect(r.passed).toBe(true);
    expect(r.blocked).toBe(false);
  });

  it('a relative import from the same file still resolves — the gate is on the specifier, not the file', () => {
    const files = [
      parseTsSource('src/services/cache.ts', 'services', false, `import { x } from '../db/redis.js';\nimport { createClient } from 'redis';\nexport const c = () => x + createClient();\n`),
      parseTsSource('src/db/redis.ts', 'db', false, `export const x = 1;\n`),
    ];
    const edges = buildGraph(files).importEdges;
    expect(edges).toHaveLength(1);
    expect(edges[0]!.toFile).toBe('src/db/redis.ts');
    expect(edges[0]!.line).toBe(1);
  });

  it('inline `import { type A }` is type-only (erased) and does not fire the rule; a mixed list stays runtime', () => {
    const db = parseTsSource('src/db/orders.ts', 'db', false, `export type Order = { id: string };\nexport function listOrders() { return []; }\n`);
    const typeOnlyInline = parseTsSource('src/ui/a.ts', 'ui', false, `import { type Order } from '../db/orders.js';\nexport type Cart = Order[];\n`);
    const allTypeInline = parseTsSource('src/ui/c.ts', 'ui', false, `import { type Order, type Order as O2 } from '../db/orders.js';\nexport type Pair = [Order, O2];\n`);
    const mixed = parseTsSource('src/ui/b.ts', 'ui', false, `import { type Order, listOrders } from '../db/orders.js';\nexport const n = () => listOrders().length;\n`);
    const stmtType = parseTsSource('src/ui/d.ts', 'ui', false, `import type { Order } from '../db/orders.js';\nexport type X = Order;\n`);
    const graph = buildGraph([db, typeOnlyInline, allTypeInline, mixed, stmtType]);
    const flag = (file: string) => graph.importEdges.find((e) => e.fromFile === file)?.isTypeOnly;
    expect(flag('src/ui/a.ts')).toBe(true);   // inline, single
    expect(flag('src/ui/c.ts')).toBe(true);   // inline, all type-only
    expect(flag('src/ui/d.ts')).toBe(true);   // statement-level, unchanged
    expect(flag('src/ui/b.ts')).toBe(false);  // mixed — a runtime binding remains
    const r = evaluatePolicy({ rules: [NO_UI_TO_DB] }, rep({ importEdges: graph.importEdges }));
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]!.message).toContain('src/ui/b.ts:1');
  });
});

/**
 * Review round 2 — the fail-closed surface: a rule that cannot run, cannot
 * match, or ran over a partial tree must SAY so, and a config error must
 * never wear the exit code of a verdict.
 */
describe('policy validation — malformed rules are recorded, never thrown, never silent', () => {
  it('validatePolicy names each defect with its rule id', () => {
    const bad = {
      rules: [
        { type: 'forbiden-dependency', to: 'db' } as unknown as PolicyRule,           // typo in type
        { type: 'forbidden-dependency', from: 'ui' },                                  // missing to
        { id: 'scoped', type: 'forbidden-dependency', to: 'db', module: 'ui' },         // misused module
        { type: 'metric-floor', metric: 'seams', min: 1 },                              // fine
      ] as PolicyRule[],
    };
    const inv = validatePolicy(bad);
    expect(inv.map((r) => r.ruleId)).toEqual(['forbiden-dependency#1', 'forbidden-dependency#2', 'scoped']);
    expect(inv[0]!.reason).toContain('unknown rule type');
    expect(inv[1]!.reason).toContain('requires "to"');
    expect(inv[2]!.reason).toContain('"from", not "module"');
  });

  it('a mistyped block-mode rule is NOT a pass: it is skipped and reported, and valid rules still run', () => {
    const r = evaluatePolicy(
      { rules: [{ type: 'forbiden-dependency', to: 'db', mode: 'block' } as unknown as PolicyRule, NO_UI_TO_DB] },
      rep({ importEdges: [edge()] }),
    );
    expect(r.invalidRules).toHaveLength(1);
    expect(r.violations).toHaveLength(1); // the valid rule still fired
    expect(r.blocked).toBe(true);
  });

  it('`module:` on a forbidden-dependency rule is rejected rather than silently widening `from` to *', () => {
    const r = evaluatePolicy(
      { rules: [{ id: 'scoped', type: 'forbidden-dependency', to: 'db', module: 'services' }] },
      rep({ importEdges: [edge()] }), // edge is ui → db; a silently-ignored module would have fired it
    );
    expect(r.invalidRules[0]!.ruleId).toBe('scoped');
    expect(r.violations).toHaveLength(0);
  });

  it('renders config errors loudly in both the terminal and the PR comment', () => {
    const report = rep({ importEdges: [edge()] });
    const r = evaluatePolicy({ rules: [{ type: 'forbidden-dependency', from: 'ui' }] }, report);
    expect(renderPolicyTerminal(r, report)).toContain('invalid rule(s) — policy config error');
    expect(renderPolicyMarkdown(r, report)).toContain('❌ **1 invalid rule(s)');
  });
});

describe('unmatched globs — a rule that cannot fire is disclosed, not passed', () => {
  const apiOnly = rep({ modules: [moduleReport('api')], importEdges: [] });

  it('a `to` glob naming no module in the report is reported with the modules actually seen', () => {
    const r = evaluatePolicy({ rules: [{ id: 'no-ui-to-db', type: 'forbidden-dependency', from: 'ui', to: 'db' }] }, apiOnly);
    expect(r.violations).toHaveLength(0);
    expect(r.unmatchedGlobs).toEqual([
      { ruleId: 'no-ui-to-db', side: 'to', glob: 'db' },
      { ruleId: 'no-ui-to-db', side: 'from', glob: 'ui' },
    ]);
    expect(renderPolicyTerminal(r, apiOnly)).toContain('matches no module in this report');
    expect(renderPolicyMarkdown(r, apiOnly)).toContain('Modules seen: api');
  });

  it('`from: *` is never "unmatched", and a glob that matches via an edge module counts as matched', () => {
    const r = evaluatePolicy({ rules: [{ type: 'forbidden-dependency', to: 'db' }] }, rep({ modules: [], importEdges: [edge()] }));
    expect(r.unmatchedGlobs).toEqual([]); // 'db' is visible through the edge even with no module report
  });

  it('documents the moduleOf layer-collapse the disclosure exists for: sibling layer dirs under one root share a module', () => {
    // A user would call these "ui" and "db"; moduleOf folds both into the same module,
    // so their import is intra-module — never an edge — and `to: db` can never match.
    // The unmatched-glob caveat is what turns that silent no-op into a stated one.
    expect(moduleOf('apps/api/src/ui/cart.ts')).toBe(moduleOf('apps/api/src/db/orders.ts'));
  });
});

describe('partial coverage — a verdict over a partial tree says so', () => {
  it('carries skippedFiles / discoveryTruncated from the scan into the result and the renderers', () => {
    const partial = rep({ importEdges: [], skippedFiles: [{ file: 'src/ui/broken.ts', reason: 'parse error' }], discoveryTruncated: true });
    const r = evaluatePolicy({ rules: [{ type: 'forbidden-dependency', to: '*' }] }, partial);
    expect(r.partialCoverage).toEqual({ skippedFiles: 1, discoveryTruncated: true });
    expect(renderPolicyTerminal(r, partial)).toContain('1 file(s) failed to parse; discovery hit the file cap');
  });

  it('is absent when coverage is complete', () => {
    expect(evaluatePolicy({ rules: [NO_UI_TO_DB] }, rep({ importEdges: [] })).partialCoverage).toBeUndefined();
  });
});

describe('unresolved imports — what the graph could not see is counted and disclosed', () => {
  beforeAll(async () => { await loadLanguages(['go', 'java']); });

  it('a path-style module import that matches nothing is counted with a sample (Go, non-stdlib)', () => {
    const files = [
      parseGoSource('svc/handler.go', 'svc', false, `package svc\nimport "github.com/acme/does/not/exist"\nfunc H(){ exist.Do() }`),
    ];
    const g = buildGraph(files);
    expect(g.unresolvedImports.count).toBe(1);
    expect(g.unresolvedImports.sample[0]!.specifier).toBe('github.com/acme/does/not/exist');
    expect(g.unresolvedImports.sample[0]!.fromFile).toBe('svc/handler.go');
  });

  it('Go standard-library imports (no dot in the first element) are neither unresolved nor external', () => {
    const g = buildGraph([parseGoSource('svc/h.go', 'svc', false, `package svc\nimport (\n\t"fmt"\n\t"net/http"\n)\nfunc H(){ fmt.Println(http.StatusOK) }`)]);
    expect(g.unresolvedImports.count).toBe(0);
    expect(g.externalImports).toBe(0);
  });

  it('a dotted JVM import that matches no local file is an EXTERNAL dependency, not an unjudged gap (was: "315 unresolved" on a 50-file Spring app)', () => {
    const g = buildGraph([parseJavaSource('src/main/java/com/acme/App.java', 'com/acme', false,
      `package com.acme;\nimport org.springframework.boot.SpringApplication;\nimport org.springframework.boot.autoconfigure.SpringBootApplication;\n@SpringBootApplication public class App { public static void main(String[] a){ SpringApplication.run(App.class, a); } }\n`)]);
    expect(g.externalImports).toBe(2);
    expect(g.unresolvedImports.count).toBe(0);
  });

  it('JS bare specifiers are counted as EXTERNAL, not unresolved — a design choice, disclosed separately', () => {
    const g = buildGraph([parseTsSource('src/a.ts', 'a', false, `import x from 'react';\nimport y from '@scope/pkg';\nexport const z = [x, y];\n`)]);
    expect(g.externalImports).toBe(2);
    expect(g.unresolvedImports.count).toBe(0);
  });

  it('a boundary verdict states the resolution caveats only when an edge rule actually ran', () => {
    const report = rep({ importEdges: [], unresolvedImports: { count: 2, sample: [{ fromFile: 'a.go', specifier: 'x/y' }] }, externalImports: 5 });
    const withRule = evaluatePolicy({ rules: [{ type: 'forbidden-dependency', to: '*' }] }, report);
    const md = renderPolicyMarkdown(withRule, report);
    expect(md).toContain('2 import(s) could not be resolved');
    expect(md).toContain('5 package import(s) treated as external');
    const noEdgeRule = evaluatePolicy({ rules: [{ type: 'metric-floor', metric: 'seams', min: 1 }] }, report);
    expect(renderPolicyMarkdown(noEdgeRule, report)).not.toContain('could not be resolved');
  });
});

describe('discovery order is OS-independent', () => {
  it('siblings within every directory come back byte-sorted, so edge/violation order cannot depend on the filesystem', () => {
    const rels = discoverFiles(FIXTURE, [], {}, {}).map((f) => f.rel);
    expect(rels.length).toBeGreaterThan(1);
    const byDir = new Map<string, string[]>();
    for (const r of rels) {
      const dir = r.includes('/') ? r.slice(0, r.lastIndexOf('/')) : '';
      (byDir.get(dir) ?? byDir.set(dir, []).get(dir)!).push(r);
    }
    for (const [, names] of byDir) {
      const sorted = [...names].sort(); // default sort = UTF-16 code units, the same comparator
      expect(names).toEqual(sorted);
    }
  });
});

/**
 * C2 — localized violations. A finding a person or an agent can act on needs
 * WHERE (an exact file:line) and WHAT (a deterministic remedy). The remedy is
 * read off the report — a suggested route is always a real file that already
 * makes the legal crossing — and is honest when none is visible.
 */
const clone = (af: string, an: string, al: number, bf: string, bn: string, bl: number): ContaminationFinding => ({
  kind: 'clone',
  a: { file: af, name: an, line: al, endLine: al + 4 },
  b: { file: bf, name: bn, line: bl, endLine: bl + 4 },
  confidence: 90, signals: ['ast-clone'],
});
const contam = (findings: ContaminationFinding[]): ScanReport['contamination'] =>
  ({ score: findings.length ? 12 : 0, label: findings.length ? 'Minor' : 'Clean', findings, violations: 0, cloneFnIds: [] });

describe('C2 — localized violations: an exact location and a deterministic remedy', () => {
  const uiToDb = edge(); // src/ui/cart.ts:3 → src/db/orders.ts (ui → db) — the violation
  const legal = edge({ fromFile: 'src/services/orders.ts', fromModule: 'services', line: 1, toFile: 'src/db/orders.ts', toModule: 'db' });
  const legalTypeOnly = edge({ fromFile: 'src/services/types.ts', fromModule: 'services', toFile: 'src/db/orders.ts', toModule: 'db', isTypeOnly: true });
  const legalFromTest = edge({ fromFile: 'src/services/orders.test.ts', fromModule: 'services', toFile: 'src/db/orders.ts', toModule: 'db', fromIsTest: true });

  it('forbidden-dependency carries the exact location and the FULL target path (a basename is ambiguous)', () => {
    const v = evaluatePolicy({ rules: [NO_UI_TO_DB] }, rep({ importEdges: [uiToDb] })).violations[0]!;
    expect(v.location).toEqual({ file: 'src/ui/cart.ts', line: 3 });
    expect(v.toFile).toBe('src/db/orders.ts');
  });

  it('with allowedVia, the remedy suggests only REAL runtime routes already in the report — never type-only, never a test', () => {
    const r = evaluatePolicy({ rules: [{ ...NO_UI_TO_DB, allowedVia: 'services' }] }, rep({ importEdges: [uiToDb, legal, legalTypeOnly, legalFromTest] }));
    expect(r.violations).toHaveLength(1); // the services→db edges are legal, not violations
    const rem = r.violations[0]!.remedy!;
    expect(rem.kind).toBe('reroute-import');
    expect(rem.suggestedTargets.map((t) => t.file)).toEqual(['src/services/orders.ts']);
    expect(rem.instruction).toContain('via src/services/orders.ts');
  });

  it('with allowedVia but no visible route, it says so instead of inventing one', () => {
    const rem = evaluatePolicy({ rules: [{ ...NO_UI_TO_DB, allowedVia: 'services' }] }, rep({ importEdges: [uiToDb] })).violations[0]!.remedy!;
    expect(rem.suggestedTargets).toEqual([]);
    expect(rem.instruction).toContain('no file in services currently reaches db');
  });

  it('without allowedVia the remedy is remove-import, with no invented target', () => {
    const rem = evaluatePolicy({ rules: [NO_UI_TO_DB] }, rep({ importEdges: [uiToDb] })).violations[0]!.remedy!;
    expect(rem.kind).toBe('remove-import');
    expect(rem.suggestedTargets).toEqual([]);
  });

  it('no-new-duplication emits ONE violation per new pair; with no base evidence of which copy is new, it says so instead of guessing', () => {
    // No file list and no clone record in the base: the report cannot tell
    // which side the change added. The first cut located every pair at side
    // `a` — which is merely the path that sorts first — and told the fixer to
    // reuse the OTHER copy. Half the time that is the exact inverse.
    const base = rep({ contamination: contam([]) });
    const head = rep({ contamination: contam([clone('a.ts', 'x', 10, 'b.ts', 'x', 40), clone('c.ts', 'y', 5, 'd.ts', 'y', 9)]) });
    const r = evaluatePolicy({ rules: [{ type: 'no-new-duplication', mode: 'block' }] }, head, base);
    expect(r.violations).toHaveLength(2);
    for (const v of r.violations) {
      expect(v.remedy!.kind).toBe('extract-shared');
      expect(v.remedy!.sideKnown).toBe(false);
      expect(v.location).toBeUndefined(); // pointing at either copy would be a guess
      expect(v.remedy!.suggestedTargets).toHaveLength(2);
    }
    expect(r.violations[0]!.message).toContain('a.ts:x ≈ b.ts:x');
    expect(r.blocked).toBe(true);
  });

  it('a pair already present in base is not re-reported', () => {
    const pair = clone('a.ts', 'x', 10, 'b.ts', 'x', 40);
    const r = evaluatePolicy({ rules: [{ type: 'no-new-duplication' }] }, rep({ contamination: contam([pair]) }), rep({ contamination: contam([pair]) }));
    expect(r.violations).toHaveLength(0);
  });

  it('aggregate rules stay advisory: no location, no remedy — the actionable/advisory split is real', () => {
    const v = evaluatePolicy(
      { rules: [{ type: 'health-delta', maxDrop: 3 }] },
      rep({ health: { score: 58, label: 'Drifting' } }),
      rep({ health: { score: 64, label: 'Stable' } }),
    ).violations[0]!;
    expect(v.location).toBeUndefined();
    expect(v.remedy).toBeUndefined();
  });

  it('location and remedy survive JSON round-trip — the stored decision path the gate runs on', () => {
    const r = evaluatePolicy({ rules: [{ ...NO_UI_TO_DB, allowedVia: 'services' }] }, rep({ importEdges: [uiToDb, legal] }));
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
  });

  it('both renderers put the remedy right under the finding', () => {
    const report = rep({ importEdges: [uiToDb, legal] });
    const r = evaluatePolicy({ rules: [{ ...NO_UI_TO_DB, allowedVia: 'services' }] }, report);
    expect(renderPolicyTerminal(r, report)).toContain('↳ Reach db through services');
    expect(renderPolicyMarkdown(r, report)).toContain('↳ Reach db through services');
  });
});
