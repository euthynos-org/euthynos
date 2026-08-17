import type { ParsedFile } from '../types.js';
import { resolvesTo } from './bundle.js';

/**
 * Phase 6 C4 — tests_for evidence (PHASE6-COMPLETION-PLAN §1/§5).
 *
 * Three ROUTES, each labeled on every hit, because they carry different
 * trust: an import edge is structural, a name convention is convention,
 * a static call from a test body is the strongest and still name-resolved.
 * The union is deliberately NOT called "coverage": absence of hits is
 * evidence about these three routes only, never about the code being
 * untested — parameterized/dynamic test discovery is invisible here, and
 * the tool's empty answer says so verbatim.
 *
 * Deliberately reads the parsed TEST files' own call arrays rather than
 * the main call graph: test files are excluded from the graph by design
 * (precision decisions frozen), and this keeps it that way.
 */

export type TestRoute = 'import-edge' | 'name-convention' | 'test-call';

export interface TestHit {
  /** The test file. */
  file: string;
  /** Every route that produced this hit, sorted for determinism. */
  routes: TestRoute[];
  /** One line of evidence detail per route, aligned with `routes`. */
  details: string[];
}

/** Strip test-marker affixes from a basename: pay.test -> pay, util_spec -> util. */
function testBaseOf(base: string): string {
  return base
    .replace(/\.(test|spec)$/i, '')
    .replace(/[_.](test|spec)$/i, '')
    .replace(/^test_/i, '')
    .replace(/(Test|Tests|Spec)$/, '');
}

function baseNameNoExt(path: string): string {
  const file = path.split('/').pop() ?? path;
  return file.replace(/\.[a-z]+$/i, '');
}

export function testsFor(
  files: readonly ParsedFile[],
  target: { file?: string; symbol?: string },
): TestHit[] {
  const hits = new Map<string, { routes: Set<TestRoute>; details: Map<TestRoute, string> }>();
  const add = (file: string, route: TestRoute, detail: string): void => {
    const h = hits.get(file) ?? { routes: new Set<TestRoute>(), details: new Map<TestRoute, string>() };
    h.routes.add(route);
    if (!h.details.has(route)) h.details.set(route, detail);
    hits.set(file, h);
  };

  const targetBase = target.file !== undefined ? baseNameNoExt(target.file) : null;

  for (const f of files) {
    if (!f.isTest) continue;

    if (target.file !== undefined) {
      for (const imp of f.imports) {
        if (resolvesTo(imp.specifier, f.path, target.file)) {
          add(f.path, 'import-edge', `imports '${imp.specifier}' resolving to ${target.file}`);
          break;
        }
      }
      if (targetBase !== null && testBaseOf(baseNameNoExt(f.path)) === targetBase) {
        add(f.path, 'name-convention', `test filename matches ${targetBase}.*`);
      }
    }

    if (target.symbol !== undefined) {
      for (const fn of f.functions) {
        if (fn.calls.includes(target.symbol)) {
          add(f.path, 'test-call', `${fn.name} calls ${target.symbol} (name-level match)`);
          break;
        }
      }
    }
  }

  return [...hits.entries()]
    .map(([file, h]) => {
      const routes = [...h.routes].sort() as TestRoute[];
      return { file, routes, details: routes.map((r) => h.details.get(r)!) };
    })
    .sort((a, b) => b.routes.length - a.routes.length || a.file.localeCompare(b.file));
}

/** The exact empty-answer boundary statement, shared with every consumer. */
export const TESTS_FOR_EMPTY_BOUNDARY =
  'No tests found via import edges, name conventions, or static calls from test files — ' +
  'parameterized/dynamic test discovery is invisible here. This is not a claim that the code is untested.';
