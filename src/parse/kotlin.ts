import { readFileSync } from 'node:fs';
import type { Node } from 'web-tree-sitter';
import type { DiscoveredFile } from '../discover.js';
import type { CallSite, ExportedSymbol, FunctionRecord, ImportRecord, ParsedFile, SymbolSpan } from '../types.js';
import { parseWith } from './treesitter/loader.js';
import {
  bodyHash, EMPTY_BODY, ckids, collectSymbolSpans, countCodeLines, deriveCalls, lastSegment,
  lineOf, nkids, totalLinesOf,
} from './treesitter/util.js';

/**
 * Kotlin parser → the parser-agnostic `ParsedFile` shape.
 *
 * Public-surface convention: Kotlin has no `export` keyword — visibility is the
 * (optional) `visibility_modifier`. The default is PUBLIC, so a declaration is
 * exported unless it is explicitly `private` or `protected` (`public` and
 * `internal` both count as part of the module's public surface). Top-level
 * `fun`s, `class`/`interface`/`object` declarations form the export surface;
 * methods inside a class body count toward implementation, not the interface.
 * Requires the 'kotlin' grammar pre-loaded via loadLanguages().
 */
export function parseKotlinFile(f: DiscoveredFile): ParsedFile {
  return parseKotlinSource(f.rel, f.module, f.isTest, readFileSync(f.abs, 'utf8'));
}

/** Node types collapsed to 'ID' in the body hash (rename-insensitive clones). */
const ID_TYPES = new Set(['simple_identifier', 'type_identifier']);
/** Node types collapsed to 'LIT' in the body hash. */
const LIT_TYPES = new Set([
  'integer_literal', 'real_literal', 'line_string_literal', 'string_literal',
  'boolean_literal', 'character_literal', 'null',
]);

/**
 * Kotlin puts `class`, `interface` and `enum class` all under
 * `class_declaration`, so the kind comes from the keyword actually written.
 * An `object` is a singleton instance of an anonymous class — close enough to
 * a class that calling it one is not misleading.
 */
const SPAN_KINDS: Readonly<Record<string, (n: Node) => SymbolSpan['kind']>> = {
  class_declaration: (n) => {
    const words = new Set(ckids(n).map((c) => c.text));
    return words.has('interface') ? 'interface' : words.has('enum') ? 'enum' : 'class';
  },
  object_declaration: () => 'class',
};

/** Kotlin type declarations carry no `name` field — the type_identifier is it. */
const typeIdentifier = (n: Node): string | undefined =>
  nkids(n).find((c) => c.type === 'type_identifier')?.text;

export function parseKotlinSource(
  path: string,
  module: string,
  isTest: boolean,
  text: string,
): ParsedFile {
  const tree = parseWith('kotlin', text);
  const root = tree.rootNode;

  const exports: ExportedSymbol[] = [];
  const imports: ImportRecord[] = [];
  let internalFunctions = 0;
  const topLevelFnIds = new Set<number>();

  for (const stmt of nkids(root)) {
    if (stmt.type === 'function_declaration') {
      topLevelFnIds.add(stmt.id);
      if (isExported(stmt)) exports.push(fnSymbol(funcName(stmt), stmt));
      else internalFunctions++;
    } else if (stmt.type === 'class_declaration' || stmt.type === 'object_declaration') {
      if (isExported(stmt)) exports.push(classSymbol(stmt));
      else internalFunctions++;
    } else if (stmt.type === 'import_list') {
      imports.push(...readImports(stmt, path));
    }
    // package_header is intentionally skipped (not an import).
  }

  const functions: FunctionRecord[] = [];
  collectFunctions(root, path, topLevelFnIds, functions);

  return {
    path,
    module,
    isTest,
    isIndex: false, // Kotlin has no interface-file convention
    codeLines: countCodeLines(text, '//'),
    exports,
    internalFunctions,
    functions,
    imports,
    symbols: collectSymbolSpans(root, {
      kinds: SPAN_KINDS,
      name: typeIdentifier,
      exported: (_n, node) => isExported(node),
    }),
    totalLines: totalLinesOf(text),
  };
}

// ── visibility / names ──

/**
 * Kotlin default visibility is PUBLIC. A declaration carries an optional leading
 * `modifiers` child that may hold a `visibility_modifier` (public/private/
 * protected/internal). Exported iff there is no modifier, or its text is not
 * `private`/`protected`. Only the declaration's OWN direct `modifiers` child is
 * inspected — never a nested one (e.g. a constructor param's modifier).
 */
function isExported(decl: Node): boolean {
  const mods = nkids(decl).find((c) => c.type === 'modifiers');
  if (!mods) return true;
  const vis = nkids(mods).find((c) => c.type === 'visibility_modifier');
  const text = vis?.text;
  return text !== 'private' && text !== 'protected';
}

/** A function_declaration's name = its first `simple_identifier` child (no name field). */
function funcName(fn: Node): string {
  return nkids(fn).find((c) => c.type === 'simple_identifier')?.text ?? '(anon)';
}

// ── exported symbols ──

function fnSymbol(name: string, fn: Node): ExportedSymbol {
  const p = countParams(paramsNode(fn));
  return { name, kind: 'function', requiredParams: p.required, totalParams: p.total };
}

function classSymbol(decl: Node): ExportedSymbol {
  const name = nkids(decl).find((c) => c.type === 'type_identifier')?.text ?? '(anon)';
  // Construction surface ≈ the primary constructor's class_parameter count.
  const ctor = nkids(decl).find((c) => c.type === 'primary_constructor');
  const params = ctor ? nkids(ctor).filter((c) => c.type === 'class_parameter') : [];
  // Defaults inside the primary constructor appear as loose non-class_parameter
  // value nodes (same rule as function params).
  const defaults = ctor
    ? nkids(ctor).filter((c) => c.type !== 'class_parameter' && c.type !== 'modifiers').length
    : 0;
  const total = params.length;
  return { name, kind: 'class', requiredParams: Math.max(0, total - defaults), totalParams: total };
}

// ── params ──

function paramsNode(fn: Node): Node | null {
  return nkids(fn).find((c) => c.type === 'function_value_parameters') ?? null;
}

/**
 * `function_value_parameters` → `parameter` children are the declared params.
 * A default value (`tax: Int = 0`) shows up as a LOOSE non-`parameter` value
 * node (integer_literal, string, call_expression, …) positioned after the param
 * it defaults. So total = #parameter children; required = total − #defaults.
 */
function countParams(params: Node | null): { required: number; total: number } {
  if (!params) return { required: 0, total: 0 };
  let total = 0;
  let defaults = 0;
  for (const c of nkids(params)) {
    if (c.type === 'parameter') total++;
    else defaults++; // loose default-value node
  }
  return { required: Math.max(0, total - defaults), total };
}

/** Each `parameter`'s name = its first `simple_identifier`. */
function paramNames(params: Node | null): string[] {
  if (!params) return [];
  const names: string[] = [];
  for (const c of nkids(params)) {
    if (c.type !== 'parameter') continue;
    const id = nkids(c).find((n) => n.type === 'simple_identifier');
    if (id) names.push(id.text);
  }
  return names;
}

// ── functions (recursive, incl. class/object methods) ──

function collectFunctions(
  node: Node,
  file: string,
  topLevelFnIds: Set<number>,
  out: FunctionRecord[],
): void {
  if (node.type === 'function_declaration') {
    const name = funcName(node);
    const params = paramsNode(node);
    const body = nkids(node).find((c) => c.type === 'function_body') ?? null;
    const { hash, tokens, literals, sketch } = body ? bodyHash(body, { idTypes: ID_TYPES, litTypes: LIT_TYPES }) : EMPTY_BODY;
    const names = paramNames(params);
    // Top-level funcs use the visibility rule; methods are exported iff their
    // own visibility allows AND they are reachable from a public type. We keep
    // it simple and consistent with the other parsers: a method is "exported"
    // when its own visibility is public (matches Java's per-member rule).
    out.push({
      name,
      file,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      exported: isExported(node),
      paramCount: names.length,
      paramNames: names,
      bodyHash: hash,
      bodyTokens: tokens,
      ...(literals === undefined ? {} : { literalHash: literals }),
      ...(sketch === undefined ? {} : { ngramSketch: sketch }),
      ...deriveCalls(body ? collectCallSites(body) : []),
    });
  }
  for (const child of nkids(node)) {
    collectFunctions(child, file, topLevelFnIds, out);
  }
}

// ── calls ──

/**
 * A call is a `call_expression` whose first child is the callee:
 *   plain    `(call_expression (simple_identifier) (call_suffix ...))` → that id
 *   member   `a.b.c()` → first child is a `navigation_expression`; the callee
 *            name is the LAST `navigation_suffix`'s `simple_identifier`.
 */
function collectCallSites(body: Node): CallSite[] {
  const sites: CallSite[] = [];
  const visit = (n: Node): void => {
    if (n.type === 'call_expression') {
      const callee = nkids(n).find((c) => c.type !== 'call_suffix');
      if (callee?.type === 'simple_identifier') {
        sites.push({ name: callee.text, line: lineOf(callee), member: false });
      } else if (callee?.type === 'navigation_expression') {
        const hit = lastNavIdentifier(callee);
        if (hit) sites.push({ name: hit.text, line: lineOf(hit), member: true });
      }
    }
    for (const c of nkids(n)) visit(c);
  };
  visit(body);
  return sites;
}

/**
 * Trailing `simple_identifier` NODE of the outermost navigation_suffix in a
 * chain — the node, not just its text, because the call site needs its line.
 */
function lastNavIdentifier(nav: Node): Node | null {
  const suffixes: Node[] = [];
  const dig = (n: Node): void => {
    if (n.type === 'navigation_suffix') suffixes.push(n);
    for (const c of nkids(n)) dig(c);
  };
  dig(nav);
  const last = suffixes[suffixes.length - 1];
  if (!last) return null;
  return nkids(last).find((c) => c.type === 'simple_identifier') ?? null;
}

// ── imports ──

/**
 * `import_list` → `import_header` → `identifier` (a dotted name whose `.text` is
 * e.g. 'kotlin.math.max'). specifier = the full dotted path; `named` is the last
 * segment. Kotlin imports are package paths, not local files — captured, not
 * resolved. isTypeOnly is always false (Kotlin has no type-only imports).
 */
function readImports(list: Node, fromFile: string): ImportRecord[] {
  const records: ImportRecord[] = [];
  for (const header of nkids(list)) {
    if (header.type !== 'import_header') continue;
    const id = nkids(header).find((c) => c.type === 'identifier');
    if (!id) continue;
    const specifier = id.text;
    records.push({ fromFile, line: lineOf(header), specifier, named: [lastSegment(specifier, '.')], isTypeOnly: false });
  }
  return records;
}
