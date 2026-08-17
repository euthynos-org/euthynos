import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { Parser, Language, Query } from 'web-tree-sitter';

/**
 * Tree-sitter WASM runtime loader.
 *
 * web-tree-sitter's init + grammar load are async, but `parser.parse()` is
 * synchronous once a grammar is loaded. So we do the async work ONCE up front
 * (`loadLanguages`) and cache the result — letting the rest of the scan
 * pipeline stay fully synchronous. Pure WASM: no native bindings, installs
 * clean on any OS.
 *
 * Grammar `.wasm` files ship in `tree-sitter-wasms/out/tree-sitter-<lang>.wasm`.
 */

const require = createRequire(import.meta.url);

let initPromise: Promise<void> | null = null;
let sharedParser: Parser | null = null;
const grammars = new Map<string, Language>();

/** Resolve the web-tree-sitter core wasm + grammar wasm dir, robust to layout. */
function wasmPaths(): { core: string; grammarDir: string } {
  let wtsDir: string;
  try {
    wtsDir = dirname(require.resolve('web-tree-sitter'));
  } catch {
    wtsDir = join(process.cwd(), 'node_modules', 'web-tree-sitter');
  }
  const core = join(wtsDir, 'tree-sitter.wasm');
  // tree-sitter-wasms sits next to web-tree-sitter in a flat npm layout.
  let grammarDir = join(dirname(wtsDir), 'tree-sitter-wasms', 'out');
  if (!existsSync(grammarDir)) {
    grammarDir = join(process.cwd(), 'node_modules', 'tree-sitter-wasms', 'out');
  }
  return { core, grammarDir };
}

/**
 * Initialize the runtime and load the requested grammars. Idempotent and
 * cached — safe to call before every scan; only the first call does work.
 * Silently skips grammars that fail to load (a missing wasm shouldn't crash
 * a scan — that language's files are just skipped).
 */
export async function loadLanguages(names: readonly string[]): Promise<void> {
  const { core, grammarDir } = wasmPaths();
  if (!initPromise) {
    initPromise = Parser.init({ locateFile: () => core });
  }
  await initPromise;
  if (!sharedParser) sharedParser = new Parser();

  for (const name of names) {
    if (grammars.has(name)) continue;
    const wasm = join(grammarDir, `tree-sitter-${name}.wasm`);
    if (!existsSync(wasm)) continue;
    try {
      grammars.set(name, await Language.load(wasm));
    } catch {
      // grammar ABI mismatch or corrupt wasm: skip this language
    }
  }
}

/** True once `loadLanguages` has loaded this grammar. */
export function hasLanguage(name: string): boolean {
  return grammars.has(name);
}

/** Parse source with a pre-loaded grammar. Throws if the grammar isn't loaded. */
export function parseWith(name: string, source: string): import('web-tree-sitter').Tree {
  const lang = grammars.get(name);
  if (!lang || !sharedParser) {
    throw new Error(`tree-sitter grammar '${name}' not loaded — call loadLanguages() first`);
  }
  sharedParser.setLanguage(lang);
  const tree = sharedParser.parse(source);
  if (!tree) throw new Error(`tree-sitter failed to parse ${name} source`);
  return tree;
}

/** Compile a query against a loaded grammar (caller caches the result). */
export function compileQuery(name: string, query: string): Query {
  const lang = grammars.get(name);
  if (!lang) throw new Error(`tree-sitter grammar '${name}' not loaded`);
  return new Query(lang, query);
}
