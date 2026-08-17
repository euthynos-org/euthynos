import { readFileSync } from 'node:fs';
import type { Node } from 'web-tree-sitter';
import type { DiscoveredFile } from '../discover.js';
import type { CallSite, ExportedSymbol, FunctionRecord, ImportRecord, ParsedFile, SymbolSpan } from '../types.js';
import { parseWith } from './treesitter/loader.js';
import {
  bodyHash, EMPTY_BODY, ckids, collectSymbolSpans, countCodeLines, deriveCalls, lineOf,
  nkids, totalLinesOf,
} from './treesitter/util.js';

/**
 * Swift parser → the parser-agnostic `ParsedFile` shape.
 *
 * Public-surface convention: Swift's default access level is `internal`, which
 * makes a declaration visible across the entire module/target — i.e. cross-file,
 * which is exactly what our module-surface analysis cares about. So we treat a
 * declaration as EXPORTED iff it is NOT `private` and NOT `fileprivate`. That
 * means `public`, `open`, `internal`, and the (modifier-less) default all count
 * as the module surface; only `private`/`fileprivate` are implementation-local.
 *
 * Structural notes verified against the live tree-sitter-swift grammar:
 *  - Parameters are FLAT children of `function_declaration` (no parameter_list
 *    wrapper). Count direct `parameter` children.
 *  - A parameter default is a `default_value:` node that is a SIBLING of the
 *    params (a child of the function), NOT nested inside the parameter.
 *  - The function/method name AND the return type both use the `name:` field;
 *    `childForFieldName('name')` returns the FIRST match = the name
 *    (a simple_identifier), so it is the correct accessor for the name.
 *  - `class`, `struct`, and `enum` all parse as `class_declaration`.
 *  - `init_declaration` is the constructor (no name).
 *
 * Requires the 'swift' grammar pre-loaded via loadLanguages().
 */
export function parseSwiftFile(f: DiscoveredFile): ParsedFile {
  return parseSwiftSource(f.rel, f.module, f.isTest, readFileSync(f.abs, 'utf8'));
}

/** Node types collapsed to 'ID' in the body hash (rename-insensitive clones). */
const ID_TYPES = new Set(['simple_identifier', 'type_identifier']);
/** Node types collapsed to 'LIT' in the body hash. */
const LIT_TYPES = new Set([
  'integer_literal', 'real_literal', 'line_string_literal', 'boolean_literal',
  'oct_literal', 'hex_literal', 'bin_literal',
]);

/**
 * `class`, `struct` and `enum` all parse as `class_declaration`, so the kind
 * comes from the keyword written. A `protocol` is Swift's interface.
 */
const SPAN_KINDS: Readonly<Record<string, (n: Node) => SymbolSpan['kind']>> = {
  class_declaration: (n) => (ckids(n).some((c) => c.text === 'enum') ? 'enum' : 'class'),
  protocol_declaration: () => 'interface',
};

export function parseSwiftSource(
  path: string,
  module: string,
  isTest: boolean,
  text: string,
): ParsedFile {
  const tree = parseWith('swift', text);
  const root = tree.rootNode;

  const exports: ExportedSymbol[] = [];
  const imports: ImportRecord[] = [];
  const topLevelFnIds = new Set<number>();
  let internalFunctions = 0;

  for (const stmt of nkids(root)) {
    if (stmt.type === 'function_declaration') {
      const name = funcName(stmt);
      topLevelFnIds.add(stmt.id);
      if (isExported(stmt)) exports.push(fnSymbol(name, stmt));
      else internalFunctions++;
    } else if (stmt.type === 'class_declaration') {
      const name = typeName(stmt);
      if (isExported(stmt)) exports.push(classSymbol(name, stmt));
      else internalFunctions++;
    } else if (stmt.type === 'import_declaration') {
      const rec = readImport(stmt, path);
      if (rec) imports.push(rec);
    }
  }

  const functions: FunctionRecord[] = [];
  collectFunctions(root, path, topLevelFnIds, functions);

  return {
    path,
    module,
    isTest,
    isIndex: false, // Swift has no interface-file convention
    codeLines: countCodeLines(text, '//'),
    exports,
    internalFunctions,
    functions,
    imports,
    symbols: collectSymbolSpans(root, { kinds: SPAN_KINDS, exported: (_n, node) => isExported(node) }),
    totalLines: totalLinesOf(text),
  };
}

// ── visibility ──

/**
 * Exported = visible beyond the file. Swift's default (no modifier) is
 * `internal` (module-wide), so a missing `visibility_modifier` means exported.
 * Only `private`/`fileprivate` restrict to the file/scope.
 */
function isExported(decl: Node): boolean {
  const vis = visibilityText(decl);
  return vis !== 'private' && vis !== 'fileprivate';
}

/** Text of the declaration's `visibility_modifier` (inside its `modifiers`), or ''. */
function visibilityText(decl: Node): string {
  const mods = nkids(decl).find((c) => c.type === 'modifiers');
  if (!mods) return '';
  return nkids(mods).find((c) => c.type === 'visibility_modifier')?.text ?? '';
}

// ── names ──

/** Function/method name = the FIRST `name:` field (a simple_identifier). */
function funcName(fn: Node): string {
  const n = fn.childForFieldName('name');
  return n?.type === 'simple_identifier' ? n.text : '(anon)';
}

/** Class/struct/enum name = the `name:` type_identifier. */
function typeName(decl: Node): string {
  return decl.childForFieldName('name')?.text ?? '(anon)';
}

// ── exported symbols ──

function fnSymbol(name: string, fn: Node): ExportedSymbol {
  const p = countParams(fn);
  return { name, kind: 'function', requiredParams: p.required, totalParams: p.total };
}

function classSymbol(name: string, classNode: Node): ExportedSymbol {
  // Construction surface ≈ the init's params. If there's no explicit init, 0.
  const body = nkids(classNode).find((c) => c.type === 'class_body');
  const init = body ? nkids(body).find((c) => c.type === 'init_declaration') : undefined;
  const p = init ? countParams(init) : { required: 0, total: 0 };
  return { name, kind: 'class', requiredParams: p.required, totalParams: p.total };
}

/**
 * Params are FLAT `parameter` children of the function/init. A default is
 * exposed as the `default_value` FIELD on a sibling of the params — NOT a node
 * whose `.type` is 'default_value'. The node's own type is the literal/expr kind
 * (e.g. `integer_literal`), so defaults must be detected by FIELD NAME, via
 * `fieldNameForChild`. requiredParams = paramCount − defaultsCount.
 *
 * e.g. `computeFee(_ amount: Int, tax: Int = 0)` → 2 parameters, 1 default_value
 *      → required 1, total 2.
 */
function countParams(fn: Node): { required: number; total: number } {
  let total = 0;
  let defaults = 0;
  // Index against the raw children array so indices line up with
  // fieldNameForChild (the `default_value` field is what marks a default).
  for (let i = 0; i < fn.childCount; i++) {
    const c = fn.child(i);
    if (!c) continue;
    if (c.type === 'parameter') total++;
    else if (fn.fieldNameForChild(i) === 'default_value') defaults++;
  }
  return { required: total - defaults, total };
}

/** Internal name of each parameter = its FIRST `name:` field (a simple_identifier). */
function paramNames(fn: Node): string[] {
  const names: string[] = [];
  for (const c of nkids(fn)) {
    if (c.type !== 'parameter') continue;
    const id = c.childForFieldName('name');
    if (id?.type === 'simple_identifier') names.push(id.text);
    else {
      // Fallback: first simple_identifier under the parameter.
      const first = nkids(c).find((g) => g.type === 'simple_identifier');
      if (first) names.push(first.text);
    }
  }
  return names;
}

// ── functions / methods (recursive, incl. methods + inits) ──

function collectFunctions(
  node: Node,
  file: string,
  topLevelFnIds: Set<number>,
  out: FunctionRecord[],
): void {
  if (node.type === 'function_declaration' || node.type === 'init_declaration') {
    out.push(fnRecord(node, file, topLevelFnIds));
  }
  for (const child of nkids(node)) {
    collectFunctions(child, file, topLevelFnIds, out);
  }
}

function fnRecord(fn: Node, file: string, topLevelFnIds: Set<number>): FunctionRecord {
  const isInit = fn.type === 'init_declaration';
  const name = isInit ? 'init' : funcName(fn);
  const body = fn.childForFieldName('body');
  const { hash, tokens, literals, sketch } = body
    ? bodyHash(body, { idTypes: ID_TYPES, litTypes: LIT_TYPES })
    : EMPTY_BODY;
  const names = paramNames(fn);
  return {
    name,
    file,
    startLine: fn.startPosition.row + 1,
    endLine: fn.endPosition.row + 1,
    // Methods/inits live inside a type → never part of the file's top-level
    // function surface; only top-level funcs that pass the visibility rule are.
    exported: topLevelFnIds.has(fn.id) && isExported(fn),
    paramCount: names.length,
    paramNames: names,
    bodyHash: hash,
    bodyTokens: tokens,
    ...(literals === undefined ? {} : { literalHash: literals }),
    ...(sketch === undefined ? {} : { ngramSketch: sketch }),
    ...deriveCalls(body ? collectCallSites(body) : []),
  };
}

// ── calls ──

/**
 * A `call_expression`'s callee is its first child. For a plain call
 * (`foo(...)`) that child is a `simple_identifier`. For a method/navigation
 * call (`obj.foo(...)`) it is a `navigation_expression` whose trailing
 * `navigation_suffix` carries the called name. Deduped.
 */
function collectCallSites(body: Node): CallSite[] {
  const sites: CallSite[] = [];
  const visit = (n: Node): void => {
    if (n.type === 'call_expression') {
      const callee = nkids(n)[0];
      if (callee?.type === 'simple_identifier') {
        sites.push({ name: callee.text, line: lineOf(callee), member: false });
      } else if (callee?.type === 'navigation_expression') {
        const suffix = callee.childForFieldName('suffix');
        const id = suffix
          ? suffix.childForFieldName('suffix') ?? nkids(suffix).find((g) => g.type === 'simple_identifier')
          : undefined;
        if (id?.type === 'simple_identifier') sites.push({ name: id.text, line: lineOf(id), member: true });
      }
    }
    for (const c of nkids(n)) visit(c);
  };
  visit(body);
  return sites;
}

// ── imports ──

/**
 * `import Foundation` → import_declaration containing an `identifier` whose text
 * is the module name. Swift imports name modules/frameworks, not local files —
 * captured, not resolved. `named` is the module name; `isTypeOnly` is false.
 */
function readImport(stmt: Node, fromFile: string): ImportRecord | null {
  const id = nkids(stmt).find((c) => c.type === 'identifier');
  const name = id?.text;
  if (!name) return null;
  return { fromFile, line: lineOf(stmt), specifier: name, named: [name], isTypeOnly: false };
}
