import type { DeepImport, ImportEdge, ModuleGraph, ParsedFile, UnresolvedImport } from '../types.js';

const RESOLVE_SUFFIXES = [
  '', '.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs',
  '/index.ts', '/index.tsx', '/index.js', '/index.jsx',
  '.py', '/__init__.py',
  '.rb', '.rs', '/mod.rs', '.go', '.java', '.php',
  '.c', '.h', '.hpp', '.cpp', '.cc', '.cs', '.dart', '.kt', '.swift', '.vue',
];

/** Build the module-level dependency graph from per-file imports. */
export function buildGraph(files: ParsedFile[]): ModuleGraph {
  const byPath = new Map<string, ParsedFile>();
  for (const f of files) byPath.set(f.path, f);

  const imports = new Map<string, Set<string>>();
  const importedBy = new Map<string, Set<string>>();
  const usedExports = new Map<string, Set<string>>();
  const deepImports: DeepImport[] = [];
  const fileImports = new Map<string, Set<string>>();
  const importEdges: ImportEdge[] = [];
  const unresolvedSample: UnresolvedImport[] = [];
  let unresolvedCount = 0;
  let externalCount = 0;

  const moduleIndexes = new Map<string, Set<string>>();
  for (const f of files) {
    if (f.isIndex) {
      if (!moduleIndexes.has(f.module)) moduleIndexes.set(f.module, new Set());
      moduleIndexes.get(f.module)!.add(f.path);
    }
  }

  // Runtime-only edges: `import type` is erased by the compiler, so it can
  // neither form a runtime cycle nor violate a seam at runtime.
  const runtimeImports = new Map<string, Set<string>>();

  const suffixIndex = buildSuffixIndex(files);
  for (const f of files) {
    for (const imp of f.imports) {
      // Relative specifiers resolve by path; module-path specifiers (Go / Java /
      // Rust / PHP / Kotlin / C / C++ packages) resolve by longest unambiguous
      // suffix against the repo's file/directory index.
      //
      // JS-ecosystem files (TS/JS/Vue) are the exception: a NON-relative
      // specifier there is a package (`redis`, `@prisma/client`, `next/router`)
      // or a tsconfig path alias the engine does not read — never a local
      // source file (node_modules is skipped at discovery). Routing it through
      // the suffix resolver let `import 'redis'` bind to a coincidental local
      // `db/redis.ts` and surface as a real file:line boundary violation. So
      // it is left UNRESOLVED (no edge): a disclosed safe miss, never a
      // phantom crossing. Every other consumer of these records already
      // refuses non-relative JS specifiers for this reason.
      let target: string | null;
      if (imp.specifier.startsWith('.')) {
        // A relative import that binds to nothing is usually a non-code
        // asset (.json/.css) or a file excluded by ignore/parse-skip; the
        // parse-skip case is disclosed via ScanReport.skippedFiles, so it is
        // not double-counted here.
        target = resolveRelative(f.path, imp.specifier, byPath);
      } else if (JS_ECOSYSTEM_RE.test(f.path)) {
        target = null;
        externalCount++;
      } else {
        target = resolveModulePath(imp.specifier, suffixIndex, f.path, byPath);
        if (!target) {
          const segs = specSegments(imp.specifier);
          const first = segs[0] ?? '';
          // "Dotted" = a JVM / .NET package path: dot-separated, no path
          // separators. A bare single word (`fmt`) is NOT dotted — it has no
          // separator at all — so the language rules below get to judge it.
          const dotted = imp.specifier.includes('.') && !/[/\\]|::/.test(imp.specifier);
          if (segs.length === 0 || STDLIB_ROOTS.has(first)) {
            // A known standard-library root: an expected miss, not a gap.
          } else if (/\.go$/.test(f.path) && !first.includes('.')) {
            // Go: an import path whose first element has no dot is the
            // standard library by convention (`fmt`, `net/http`). Checked
            // before the dotted rule so `fmt` is never read as a package.
          } else if (dotted) {
            // A dotted (JVM / .NET) specifier that matched no local file is,
            // by construction, an external package — a local package would
            // have matched by suffix. Same class as a JS bare specifier:
            // counted as external, never presented as something unjudged.
            // (A 50-file Spring app otherwise reported "315 unresolved".)
            externalCount++;
          } else {
            // A path-style module import that matched nothing is a crossing
            // the graph cannot see. Counted, so a boundary verdict can say
            // what it did not judge.
            unresolvedCount++;
            if (unresolvedSample.length < UNRESOLVED_SAMPLE_CAP) {
              unresolvedSample.push({ fromFile: f.path, ...(imp.line !== undefined ? { line: imp.line } : {}), specifier: imp.specifier });
            }
          }
        }
      }
      if (!target) continue;
      const targetFile = byPath.get(target)!;
      const from = f.module;
      const to = targetFile.module;

      // File-level resolution, kept regardless of module (a same-module import
      // still binds a receiver call). Never a self-edge.
      if (target !== f.path) {
        if (!fileImports.has(f.path)) fileImports.set(f.path, new Set());
        fileImports.get(f.path)!.add(target);
      }

      if (from !== to) {
        if (!imports.has(from)) imports.set(from, new Set());
        imports.get(from)!.add(to);
        if (!importedBy.has(to)) importedBy.set(to, new Set());
        importedBy.get(to)!.add(from);

        // The statement itself, with its line, for boundary rules. Recorded
        // for EVERY cross-module import — type-only and test-file imports
        // included, flagged — so the policy rule (not the graph) decides
        // what counts. Files arrive in discovery order (siblings byte-sorted,
        // see discover.ts) and imports in source order, so this list is the
        // same on every OS for a given tree.
        importEdges.push({
          fromFile: f.path,
          fromModule: from,
          ...(imp.line !== undefined ? { line: imp.line } : {}),
          toFile: target,
          toModule: to,
          isTypeOnly: imp.isTypeOnly,
          fromIsTest: f.isTest,
        });

        if (!usedExports.has(to)) usedExports.set(to, new Set());
        for (const n of imp.named) usedExports.get(to)!.add(n);

        if (!imp.isTypeOnly && !f.isTest) {
          if (!runtimeImports.has(from)) runtimeImports.set(from, new Set());
          runtimeImports.get(from)!.add(to);

          // Seam violation A (index-file languages): the target module has an
          // interface file, but this import reaches a different (internal) file.
          const indexes = moduleIndexes.get(to);
          const indexBypass = indexes !== undefined && indexes.size > 0 && !targetFile.isIndex;
          // Seam violation B (all languages): the import reaches into an
          // `internal/` directory from outside the scope allowed to import it —
          // Go enforces exactly this rule, and it is a recognized convention in
          // JVM/Rust trees too. Path-based, so it never mis-reads a symbol's
          // visibility; and legal Go code can't trigger it (the compiler already
          // forbids it), so this only surfaces real bypasses.
          if (indexBypass || internalBoundaryBypass(f.path, target)) {
            deepImports.push({ fromFile: f.path, toFile: target, toModule: to });
          }
        }
      }
    }
  }

  return {
    imports, importedBy, usedExports, deepImports, fileImports, importEdges,
    unresolvedImports: { count: unresolvedCount, sample: unresolvedSample },
    externalImports: externalCount,
    cycles: findCycles(runtimeImports),
  };
}

/**
 * Go's `internal/` rule (a convention in JVM/Rust trees too): a package under an
 * `internal/` directory may be imported ONLY by code rooted at that directory's
 * PARENT. An import reaching a target under `internal/` from OUTSIDE that parent
 * scope is a boundary bypass. Path-based — never mis-reads a symbol's visibility —
 * and the Go compiler already forbids the legal-code case, so this surfaces only
 * real bypasses. Binds to the innermost `internal/` (last segment). A top-level
 * `internal/` (idx 0) is module-wide importable and never triggers.
 */
function internalBoundaryBypass(fromPath: string, targetPath: string): boolean {
  const segs = targetPath.split('/');
  const idx = segs.lastIndexOf('internal');
  if (idx <= 0) return false;
  const allowed = segs.slice(0, idx).join('/'); // the directory CONTAINING internal/
  return !(fromPath === allowed || fromPath.startsWith(`${allowed}/`));
}

export function resolveRelative(
  fromPath: string,
  spec: string,
  byPath: Map<string, ParsedFile>,
): string | null {
  const baseDir = fromPath.split('/').slice(0, -1);
  const parts = [...baseDir];
  for (const seg of spec.split('/')) {
    if (seg === '.' || seg === '') continue;
    else if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  let joined = parts.join('/');
  // ESM-style ./x.js written in TS source actually means ./x.ts on disk.
  const jsToTs = joined.replace(/\.(js|mjs|cjs)$/, '');
  for (const candidate of [joined, jsToTs]) {
    for (const suf of RESOLVE_SUFFIXES) {
      const p = candidate + suf;
      if (byPath.has(p)) return p;
    }
  }
  return null;
}

// ── module-path resolution ─────────────────────────────────────────────────
// Module-path languages name a package/dir (Go) or a symbol file (Java, Kotlin,
// Rust, PHP, C/C++), not a file relative to the importer. We resolve them by
// matching the LONGEST trailing suffix of the specifier that maps to exactly one
// module — deterministic, and silent when a tail is ambiguous across modules.

interface SuffixIndex {
  /** trailing path suffix (extension-stripped, and with-ext for C/C++) → file paths */
  fileBySuffix: Map<string, string[]>;
  /** trailing directory suffix → file paths inside that directory */
  dirBySuffix: Map<string, string[]>;
}

const CODE_EXT_RE = /\.(tsx?|mts|cts|jsx?|mjs|cjs|py|go|java|rb|rs|php|c|h|cpp|cc|cxx|hpp|hh|hxx|cs|dart|kts?|swift|vue|cob|cbl|cpy)$/;
/** Files whose non-relative imports name packages/aliases, not local sources. */
const JS_ECOSYSTEM_RE = /\.(tsx?|mts|cts|jsx?|mjs|cjs|vue)$/;
/** Unresolved-import sample kept in the report; the count is exact, the sample bounded. */
const UNRESOLVED_SAMPLE_CAP = 20;
/** Module paths rarely run deeper than this; bounding keeps the index small. */
const MAX_SUFFIX = 6;
/**
 * Specifiers rooted here are standard-library / framework imports — never a
 * local source root — so a coincidental tail match (`java.util.List` onto a
 * local `util/List.java`) must not wire a phantom edge. Matched on the exact
 * casing each ecosystem uses, so a local `core`/`system` dir is unaffected.
 */
const STDLIB_ROOTS = new Set([
  'java', 'javax', 'jakarta', 'kotlin', 'kotlinx', 'android', 'androidx', 'scala', 'groovy',
  'std', 'System', 'Microsoft', 'Windows',
  'Foundation', 'UIKit', 'SwiftUI', 'Combine', 'CoreData', 'CoreGraphics',
]);

function buildSuffixIndex(files: ParsedFile[]): SuffixIndex {
  const fileBySuffix = new Map<string, string[]>();
  const dirBySuffix = new Map<string, string[]>();
  const add = (map: Map<string, string[]>, key: string, val: string): void => {
    const a = map.get(key);
    if (a) {
      if (!a.includes(val)) a.push(val);
    } else map.set(key, [val]);
  };
  const tails = (segs: string[], map: Map<string, string[]>, val: string): void => {
    for (let k = 1; k <= Math.min(segs.length, MAX_SUFFIX); k++) {
      add(map, segs.slice(segs.length - k).join('/'), val);
    }
  };
  for (const f of files) {
    const full = f.path.split('/').filter(Boolean);
    const noExt = f.path.replace(CODE_EXT_RE, '').split('/').filter(Boolean);
    tails(noExt, fileBySuffix, f.path); // Java/Kotlin/Rust/PHP symbol files
    tails(full, fileBySuffix, f.path); // C/C++ includes keep their .h
    tails(noExt.slice(0, -1), dirBySuffix, f.path); // Go packages = directories
  }
  return { fileBySuffix, dirBySuffix };
}

function resolveModulePath(
  spec: string,
  idx: SuffixIndex,
  fromPath: string,
  byPath: Map<string, ParsedFile>,
): string | null {
  const segs = specSegments(spec);
  if (segs.length === 0 || STDLIB_ROOTS.has(segs[0]!)) return null;
  // Dotted specifiers (Java/Kotlin/C#) carry package depth, so a bare last
  // segment (`com.google…Lists` → `Lists`) must not grab a coincidental local
  // class — require ≥2 there. Path/`::` specifiers (a Go import path carries a
  // module prefix the local tree lacks) may match on a single trailing segment.
  const dotted = !/[/\\]|::/.test(spec);
  const minK = Math.min(dotted ? 2 : 1, segs.length);
  for (let k = segs.length; k >= minK; k--) {
    const suffix = segs.slice(segs.length - k).join('/');
    const hit =
      pickUniqueModule(idx.fileBySuffix.get(suffix), fromPath, byPath) ??
      pickUniqueModule(idx.dirBySuffix.get(suffix), fromPath, byPath);
    if (hit) return hit;
  }
  // C#/VB namespaces root at a PROJECT name that exists nowhere on disk
  // (`using AcmeApi.Services;` in a repo whose tree starts at Services/),
  // so the k>=2 loop above can never match them. A single
  // trailing segment may still resolve — but only against a DIRECTORY
  // (module) tail: bare single-segment FILE matches stay forbidden, which
  // is what the >=2 rule protects against (`com.google...Lists`).
  if (dotted && segs.length >= 2) {
    return pickUniqueModule(idx.dirBySuffix.get(segs[segs.length - 1]!), fromPath, byPath);
  }
  return null;
}

/** Segment a specifier on whichever separator it uses; drop Rust path roots. */
function specSegments(spec: string): string[] {
  const s = spec.replace(/\\/g, '/');
  let segs = (s.includes('/') ? s.split('/') : s.includes('::') ? s.split('::') : s.split('.')).filter(Boolean);
  while (segs.length > 1 && (segs[0] === 'crate' || segs[0] === 'self' || segs[0] === 'super')) {
    segs = segs.slice(1);
  }
  return segs;
}

/** Resolve a candidate set only when every match lives in ONE module. */
function pickUniqueModule(
  paths: string[] | undefined,
  fromPath: string,
  byPath: Map<string, ParsedFile>,
): string | null {
  if (!paths) return null;
  const cands = paths.filter((p) => p !== fromPath);
  if (cands.length === 0) return null;
  const mods = new Set<string>();
  for (const p of cands) {
    const m = byPath.get(p)?.module;
    if (m) mods.add(m);
  }
  return mods.size === 1 ? cands[0]! : null;
}

/** All elementary cycles is overkill — report each strongly-connected pair/group once. */
function findCycles(imports: Map<string, Set<string>>): string[][] {
  const cycles: string[][] = [];
  const seenPair = new Set<string>();
  for (const [a, outs] of imports) {
    for (const b of outs) {
      if (imports.get(b)?.has(a)) {
        const key = [a, b].sort().join('|');
        if (!seenPair.has(key) && a !== b) {
          seenPair.add(key);
          cycles.push([a, b].sort() as string[]);
        }
      }
    }
  }
  return cycles;
}
