import { readFileSync } from 'node:fs';
import type { Node } from 'web-tree-sitter';
import type { DiscoveredFile } from '../discover.js';
import type { CallSite, ExportedSymbol, FunctionRecord, ImportRecord, ParsedFile } from '../types.js';
import { parseWith } from './treesitter/loader.js';
import { collectSymbolSpans, deriveCalls, lastSegment, lineOf, stripQuotes, totalLinesOf } from './treesitter/util.js';

/**
 * Python parser → the parser-agnostic `ParsedFile` shape.
 *
 * Public-surface convention: if `__all__` is present it defines the exports
 * exactly; otherwise top-level `def`/`class`/assignment names not prefixed with
 * `_` are public. Methods inside classes count toward implementation, not the
 * interface. Requires the 'python' grammar to be pre-loaded via loadLanguages().
 */
export function parsePythonFile(f: DiscoveredFile): ParsedFile {
  return parsePythonSource(f.rel, f.module, f.isTest, readFileSync(f.abs, 'utf8'));
}

const LITERALS = new Set([
  'string', 'concatenated_string', 'integer', 'float', 'true', 'false', 'none',
]);

/** Non-null named children (web-tree-sitter types them as possibly-null). */
const nkids = (n: Node): Node[] => n.namedChildren.filter((c): c is Node => c != null);
/** Non-null children including anonymous nodes (operators, keywords, punctuation). */
const ckids = (n: Node): Node[] => n.children.filter((c): c is Node => c != null);

export function parsePythonSource(
  path: string,
  module: string,
  isTest: boolean,
  text: string,
): ParsedFile {
  const tree = parseWith('python', text);
  const root = tree.rootNode;

  const allList = readDunderAll(root);
  const exports: ExportedSymbol[] = [];
  const imports: ImportRecord[] = [];
  let internalFunctions = 0;
  const topLevelFnIds = new Set<number>();

  for (const stmt of nkids(root)) {
    const node = stmt.type === 'decorated_definition' ? unwrapDecorated(stmt) : stmt;
    if (!node) continue;

    if (node.type === 'function_definition') {
      const name = fieldText(node, 'name');
      topLevelFnIds.add(node.id);
      if (isPublic(name, allList)) exports.push(fnSymbol(name, node));
      else internalFunctions++;
    } else if (node.type === 'class_definition') {
      const name = fieldText(node, 'name');
      if (isPublic(name, allList)) exports.push(classSymbol(name, node));
      else internalFunctions++;
    } else if (stmt.type === 'expression_statement') {
      const assign = nkids(stmt)[0];
      if (assign?.type === 'assignment') {
        const left = assign.childForFieldName('left');
        const lname = left?.type === 'identifier' ? left.text : '';
        if (lname && lname !== '__all__' && isPublic(lname, allList)) {
          exports.push({ name: lname, kind: 'const', requiredParams: 0, totalParams: 0 });
        }
      }
    } else if (stmt.type === 'import_statement') {
      imports.push(...readImport(stmt, path));
    } else if (stmt.type === 'import_from_statement') {
      imports.push(...readFromImport(stmt, path));
    }
  }

  const functions: FunctionRecord[] = [];
  collectFunctions(root, path, allList, topLevelFnIds, functions);

  return {
    path,
    module,
    isTest,
    isIndex: /(^|\/)__init__\.py$/.test(path),
    codeLines: countCodeLines(text),
    exports,
    internalFunctions,
    functions,
    imports,
    // Python expresses every named type as a class (enums and protocols
    // included), so `class` is the honest kind for all of them.
    symbols: collectSymbolSpans(root, {
      kinds: { class_definition: 'class' },
      exported: (name) => isPublic(name, allList),
    }),
    totalLines: totalLinesOf(text),
  };
}

// ── exports / symbols ──

function readDunderAll(root: Node): string[] | null {
  for (const stmt of nkids(root)) {
    if (stmt.type !== 'expression_statement') continue;
    const assign = nkids(stmt)[0];
    if (assign?.type !== 'assignment') continue;
    if (assign.childForFieldName('left')?.text !== '__all__') continue;
    const right = assign.childForFieldName('right');
    if (right && (right.type === 'list' || right.type === 'tuple')) {
      return nkids(right).filter((n) => n.type === 'string').map((n) => stripQuotes(n.text));
    }
  }
  return null;
}

function isPublic(name: string, allList: string[] | null): boolean {
  if (allList) return allList.includes(name);
  return !name.startsWith('_');
}

function unwrapDecorated(node: Node): Node | null {
  return nkids(node).find(
    (n) => n.type === 'function_definition' || n.type === 'class_definition',
  ) ?? null;
}

function fnSymbol(name: string, defNode: Node): ExportedSymbol {
  const p = countParams(defNode.childForFieldName('parameters'));
  return { name, kind: 'function', requiredParams: p.required, totalParams: p.total };
}

function classSymbol(name: string, classNode: Node): ExportedSymbol {
  // Interface complexity of a class ≈ its __init__ params (the construction surface).
  const body = classNode.childForFieldName('body');
  const ctor = body
    ? nkids(body).find((n) => n.type === 'function_definition' && fieldText(n, 'name') === '__init__')
    : undefined;
  const p = ctor ? countParams(ctor.childForFieldName('parameters')) : { required: 0, total: 0 };
  return { name, kind: 'class', requiredParams: p.required, totalParams: p.total };
}

function countParams(params: Node | null): { required: number; total: number } {
  if (!params) return { required: 0, total: 0 };
  let required = 0, total = 0;
  for (const p of nkids(params)) {
    if (p.type === 'identifier') {
      if (p.text === 'self' || p.text === 'cls') continue;
      required++; total++;
    } else if (p.type === 'typed_parameter') {
      total++; required++;
    } else if (p.type === 'default_parameter' || p.type === 'typed_default_parameter') {
      total++;
    }
    // *args / **kwargs (list_splat_pattern, dictionary_splat_pattern): ignored
  }
  return { required, total };
}

// ── functions (recursive, incl. methods) ──

function collectFunctions(
  node: Node,
  file: string,
  allList: string[] | null,
  topLevelFnIds: Set<number>,
  out: FunctionRecord[],
): void {
  if (node.type === 'function_definition') {
    const name = fieldText(node, 'name');
    const params = node.childForFieldName('parameters');
    const body = node.childForFieldName('body');
    const { hash, tokens, literals, sketch, defHash } = body
      ? normalizedBodyHash(body)
      : { hash: 0, tokens: 0, literals: undefined, sketch: undefined };
    out.push({
      name,
      file,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      exported: topLevelFnIds.has(node.id) && isPublic(name, allList),
      paramCount: params ? countParams(params).total : 0,
      paramNames: params ? paramNames(params) : [],
      bodyHash: hash,
      bodyTokens: tokens,
      ...(literals === undefined ? {} : { literalHash: literals }),
      ...(sketch === undefined ? {} : { ngramSketch: sketch }),
      ...(defHash === undefined ? {} : { defHash }),
      ...deriveCalls(body ? collectCallSites(body) : []),
    });
  }
  for (const child of nkids(node)) {
    collectFunctions(child, file, allList, topLevelFnIds, out);
  }
}

function paramNames(params: Node): string[] {
  const names: string[] = [];
  for (const p of nkids(params)) {
    if (p.type === 'identifier') names.push(p.text);
    else if (p.type === 'typed_parameter' || p.type === 'default_parameter' || p.type === 'typed_default_parameter') {
      const id = nkids(p).find((n) => n.type === 'identifier');
      if (id) names.push(id.text);
    }
  }
  return names;
}

/**
 * Same three-signal walk as the shared tree-sitter `bodyHash`: structural
 * hash (identifiers/literals collapsed), literal-value hash, and the bottom-K
 * 4-gram sketch. Kept local because Python's walker predates the shared one;
 * the SEMANTICS must match it exactly — near-clone detection compares these
 * fields across every language's records.
 */
function normalizedBodyHash(body: Node): { hash: number; tokens: number; literals?: number; defHash?: number; sketch?: number[] } {
  let h = 0x811c9dc5;
  let lit = 0x811c9dc5;
  let def = 0x811c9dc5;
  let count = 0;
  const window: string[] = [];
  const grams = new Set<number>();
  const fnv = (seed: number, s: string): number => {
    let x = seed;
    for (let i = 0; i < s.length; i++) {
      x ^= s.charCodeAt(i);
      x = Math.imul(x, 0x01000193) >>> 0;
    }
    x ^= 31;
    return Math.imul(x, 0x01000193) >>> 0;
  };
  const mix = (s: string): void => {
    count++;
    h = fnv(h, s);
    window.push(s);
    if (window.length > 4) window.shift();
    if (window.length === 4) grams.add(fnv(0x811c9dc5, window.join('|')));
  };
  const visit = (n: Node): void => {
    if (n.type === 'identifier') {
      mix('ID');
      def = fnv(def, n.text); // rename-sensitive: identifier text
    } else if (LITERALS.has(n.type)) {
      mix('LIT');
      lit = fnv(lit, n.text);
      def = fnv(def, n.text); // rename-sensitive: literal text
    } else if (n.childCount === 0) {
      mix(n.type);
      def = fnv(def, n.type);
    }
    for (const c of ckids(n)) visit(c);
  };
  visit(body);
  const out: { hash: number; tokens: number; literals?: number; defHash?: number; sketch?: number[] } = {
    hash: h >>> 0,
    tokens: count,
    literals: lit >>> 0,
    defHash: def >>> 0,
  };
  if (count >= 12 && grams.size > 0) out.sketch = [...grams].sort((a, b) => a - b).slice(0, 24);
  return out;
}

/** `foo()` is bare; `obj.foo()` is an attribute call, i.e. a member call. */
function collectCallSites(body: Node): CallSite[] {
  const sites: CallSite[] = [];
  const visit = (n: Node): void => {
    if (n.type === 'call') {
      const fn = n.childForFieldName('function');
      if (fn?.type === 'identifier') sites.push({ name: fn.text, line: lineOf(fn), member: false });
      else if (fn?.type === 'attribute') {
        const attr = fn.childForFieldName('attribute');
        if (attr) sites.push({ name: attr.text, line: lineOf(attr), member: true });
      }
    }
    for (const c of nkids(n)) visit(c);
  };
  visit(body);
  return sites;
}

// ── imports ──

function readImport(stmt: Node, fromFile: string): ImportRecord[] {
  const records: ImportRecord[] = [];
  for (const child of nkids(stmt)) {
    if (child.type === 'dotted_name') {
      const spec = child.text;
      records.push({ fromFile, line: lineOf(stmt), specifier: spec, named: [lastSegment(spec, '.')], isTypeOnly: false });
    } else if (child.type === 'aliased_import') {
      const mod = child.childForFieldName('name');
      const alias = child.childForFieldName('alias');
      if (mod) records.push({ fromFile, line: lineOf(stmt), specifier: mod.text, named: [alias?.text ?? lastSegment(mod.text, '.')], isTypeOnly: false });
    }
  }
  return records;
}

function readFromImport(stmt: Node, fromFile: string): ImportRecord[] {
  const moduleNode = stmt.childForFieldName('module_name');
  const names = importedNames(stmt, moduleNode);
  const prefix = relativePrefix(moduleNode);
  const dotted = moduleNode?.type === 'dotted_name'
    ? moduleNode.text
    : moduleNode?.type === 'relative_import'
      ? relativeDotted(moduleNode)
      : '';

  if (prefix === null) {
    // absolute `from a.b import c` — captured but unresolved by our relative resolver (v1)
    return [{ fromFile, line: lineOf(stmt), specifier: dotted, named: names, isTypeOnly: false }];
  }
  if (dotted) {
    return [{ fromFile, line: lineOf(stmt), specifier: prefix + dotted.replace(/\./g, '/'), named: names, isTypeOnly: false }];
  }
  // `from . import sub1, sub2` — each name is itself a submodule
  return names.map((n) => ({ fromFile, line: lineOf(stmt), specifier: prefix + n, named: [n], isTypeOnly: false }));
}

function importedNames(stmt: Node, moduleNode: Node | null): string[] {
  const names: string[] = [];
  for (const child of nkids(stmt)) {
    if (moduleNode && child.id === moduleNode.id) continue;
    if (child.type === 'dotted_name' || child.type === 'identifier') names.push(lastSegment(child.text, '.'));
    else if (child.type === 'aliased_import') {
      const alias = child.childForFieldName('alias');
      const nm = child.childForFieldName('name');
      names.push(alias?.text ?? (nm ? lastSegment(nm.text, '.') : ''));
    } else if (child.type === 'wildcard_import') names.push('*');
  }
  return names.filter(Boolean);
}

/** Relative-import prefix as JS-style path: `.`→'./', `..`→'../', `...`→'../../'. null = absolute. */
function relativePrefix(moduleNode: Node | null): string | null {
  if (!moduleNode || moduleNode.type !== 'relative_import') return null;
  const dots = (nkids(moduleNode).find((n) => n.type === 'import_prefix')?.text ?? '.').length;
  return dots <= 1 ? './' : '../'.repeat(dots - 1);
}

function relativeDotted(rel: Node): string {
  return nkids(rel).find((n) => n.type === 'dotted_name')?.text ?? '';
}

// ── helpers ──

function fieldText(node: Node, field: string): string {
  return node.childForFieldName(field)?.text ?? '(anon)';
}

function countCodeLines(text: string): number {
  let n = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    n++;
  }
  return n;
}
