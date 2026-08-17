import type { DeepImport, ModuleGraph, ParsedFile } from '../types.js';

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
      const target = imp.specifier.startsWith('.')
        ? resolveRelative(f.path, imp.specifier, byPath)
        : resolveModulePath(imp.specifier, suffixIndex, f.path, byPath);
      if (!target) continue;
      const targetFile = byPath.get(target)!;
      const from = f.module;
      const to = targetFile.module;

      if (from !== to) {
        if (!imports.has(from)) imports.set(from, new Set());
        imports.get(from)!.add(to);
        if (!importedBy.has(to)) importedBy.set(to, new Set());
        importedBy.get(to)!.add(from);

        if (!usedExports.has(to)) usedExports.set(to, new Set());
        for (const n of imp.named) usedExports.get(to)!.add(n);

        if (!imp.isTypeOnly) {
          if (!runtimeImports.has(from)) runtimeImports.set(from, new Set());
          runtimeImports.get(from)!.add(to);

          // Seam violation: the target module has an interface file,
          // but this import reaches a different (internal) file.
          const indexes = moduleIndexes.get(to);
          if (indexes && indexes.size > 0 && !targetFile.isIndex && !f.isTest) {
            deepImports.push({ fromFile: f.path, toFile: target, toModule: to });
          }
        }
      }
    }
  }

  return { imports, importedBy, usedExports, deepImports, cycles: findCycles(runtimeImports) };
}

function resolveRelative(
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
