import { readFileSync } from 'node:fs';
import type { Node } from 'web-tree-sitter';
import type { DiscoveredFile } from '../discover.js';
import type { CallSite, ExportedSymbol, FunctionRecord, ImportRecord, ParsedFile } from '../types.js';
import { parseWith } from './treesitter/loader.js';
import {
  bodyHash, EMPTY_BODY, ckids, collectSymbolSpans, countCodeLines, deriveCalls, fieldText,
  lastSegment, lineOf, nkids, stripQuotes, totalLinesOf,
} from './treesitter/util.js';

/**
 * Ruby parser → the parser-agnostic `ParsedFile` shape.
 *
 * Public-surface convention: Ruby is public by default. Inside a class/module
 * body a bare `private`/`protected` (with no arguments) flips every following
 * method in that body to non-exported — mirrored here by tracking a `priv` flag
 * while walking the body in source order. Top-level methods are always public.
 *
 * `require_relative` is the analogue of Python's relative import: its path is
 * file-relative, so the specifier is normalized to a './'-anchored path (ending
 * implicitly at the Ruby file). `require` is treated as an external module and
 * kept verbatim. Requires the 'ruby' grammar to be pre-loaded via loadLanguages().
 */
export function parseRubyFile(f: DiscoveredFile): ParsedFile {
  return parseRubySource(f.rel, f.module, f.isTest, readFileSync(f.abs, 'utf8'));
}

/** Parameter node variants whose inner name lives in a `name` field. */
const NAMED_PARAM_TYPES = new Set([
  'optional_parameter',
  'splat_parameter',
  'keyword_parameter',
  'hash_splat_parameter',
  'block_parameter',
]);

/** Identifier-like node types collapsed to 'ID' for the clone hash. */
const ID_TYPES = new Set(['identifier', 'constant']);
/** Literal node types collapsed to 'LIT' for the clone hash. */
const LIT_TYPES = new Set([
  'string', 'integer', 'float', 'simple_symbol', 'symbol', 'true', 'false', 'nil',
]);

export function parseRubySource(
  path: string,
  module: string,
  isTest: boolean,
  text: string,
): ParsedFile {
  const tree = parseWith('ruby', text);
  const root = tree.rootNode;

  const exports: ExportedSymbol[] = [];
  const imports: ImportRecord[] = [];
  const functions: FunctionRecord[] = [];
  // Methods whose visibility was flipped to private/protected by a bare marker.
  const internalMethodIds = new Set<number>();
  let internalFunctions = 0;

  for (const stmt of nkids(root)) {
    if (stmt.type === 'method') {
      // Top-level method: always public.
      exports.push(fnSymbol(fieldText(stmt, 'name'), stmt));
    } else if (stmt.type === 'class' || stmt.type === 'module') {
      const name = fieldText(stmt, 'name');
      exports.push({ name, kind: 'class', requiredParams: 0, totalParams: 0 });
      internalFunctions += scanContainerBody(stmt, exports, internalMethodIds);
    } else if (stmt.type === 'call') {
      const imp = readRequire(stmt, path);
      if (imp) imports.push(imp);
    }
  }

  collectFunctions(root, path, internalMethodIds, functions);

  return {
    path,
    module,
    isTest,
    isIndex: false, // Ruby has no __init__/index convention.
    codeLines: countCodeLines(text, '#'),
    exports,
    internalFunctions,
    functions,
    imports,
    // Ruby types are public by default, so every class/module span is
    // exported. `module` keeps its own kind rather than being labelled a
    // class it isn't.
    symbols: collectSymbolSpans(root, {
      kinds: { class: 'class', module: 'module' },
      exported: () => true,
    }),
    totalLines: totalLinesOf(text),
  };
}

// ── exports / symbols ──

/**
 * Walk a class/module body in source order. Bare `private`/`protected` markers
 * flip all following methods to non-exported. Public instance methods become
 * 'function' exports; private/protected ones count toward internalFunctions and
 * are recorded so collectFunctions can mark them exported=false.
 * Returns the count of private/protected methods found in this body.
 */
function scanContainerBody(
  container: Node,
  exports: ExportedSymbol[],
  internalMethodIds: Set<number>,
): number {
  const body = container.childForFieldName('body');
  if (!body) return 0;
  let priv = false;
  let internal = 0;
  for (const child of nkids(body)) {
    if (isVisibilityMarker(child)) {
      priv = true;
      continue;
    }
    if (child.type === 'method') {
      if (priv) {
        internalMethodIds.add(child.id);
        internal++;
      } else {
        exports.push(fnSymbol(fieldText(child, 'name'), child));
      }
    }
  }
  return internal;
}

/**
 * A bare `private` or `protected` with no arguments. Appears either as a plain
 * `identifier` node or as a `call` whose method identifier is 'private'/
 * 'protected' and which carries no argument_list (e.g. `private :foo` does NOT
 * count — it has an explicit argument and only affects that symbol).
 */
function isVisibilityMarker(node: Node): boolean {
  if (node.type === 'identifier') {
    return node.text === 'private' || node.text === 'protected';
  }
  if (node.type === 'call') {
    const method = node.childForFieldName('method');
    if (!method || (method.text !== 'private' && method.text !== 'protected')) return false;
    const args = node.childForFieldName('arguments');
    // No arguments at all → bare marker. An argument_list with children scopes
    // the visibility change to those symbols only.
    return !args || nkids(args).length === 0;
  }
  return false;
}

function fnSymbol(name: string, methodNode: Node): ExportedSymbol {
  const p = countParams(methodNode.childForFieldName('parameters'));
  return { name, kind: 'function', requiredParams: p.required, totalParams: p.total };
}

function countParams(params: Node | null): { required: number; total: number } {
  if (!params) return { required: 0, total: 0 };
  let required = 0;
  let total = 0;
  for (const p of nkids(params)) {
    if (p.type === 'identifier') {
      required++;
      total++;
    } else if (NAMED_PARAM_TYPES.has(p.type)) {
      total++;
    }
    // anonymous punctuation ( ) , are not named children, so excluded already
  }
  return { required, total };
}

function paramNames(params: Node): string[] {
  const names: string[] = [];
  for (const p of nkids(params)) {
    if (p.type === 'identifier') {
      names.push(p.text);
    } else if (NAMED_PARAM_TYPES.has(p.type)) {
      const id = p.childForFieldName('name');
      if (id) names.push(id.text);
    }
  }
  return names;
}

// ── functions (recursive, incl. methods in classes/modules) ──

function collectFunctions(
  node: Node,
  file: string,
  internalMethodIds: Set<number>,
  out: FunctionRecord[],
): void {
  if (node.type === 'method') {
    const params = node.childForFieldName('parameters');
    const body = node.childForFieldName('body');
    const { hash, tokens, literals, sketch } = body ? bodyHash(body, { idTypes: ID_TYPES, litTypes: LIT_TYPES }) : EMPTY_BODY;
    out.push({
      name: fieldText(node, 'name'),
      file,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      exported: !internalMethodIds.has(node.id),
      paramCount: params ? countParams(params).total : 0,
      paramNames: params ? paramNames(params) : [],
      bodyHash: hash,
      bodyTokens: tokens,
      ...(literals === undefined ? {} : { literalHash: literals }),
      ...(sketch === undefined ? {} : { ngramSketch: sketch }),
      ...deriveCalls(body ? collectCallSites(body) : []),
    });
  }
  for (const child of nkids(node)) {
    collectFunctions(child, file, internalMethodIds, out);
  }
}

/** `foo` is bare; `x.foo` carries a `receiver`, i.e. a member call. */
function collectCallSites(body: Node): CallSite[] {
  const sites: CallSite[] = [];
  const visit = (n: Node): void => {
    if (n.type === 'call') {
      const method = n.childForFieldName('method');
      if (method) {
        sites.push({ name: method.text, line: lineOf(method), member: n.childForFieldName('receiver') != null });
      }
    }
    for (const c of nkids(n)) visit(c);
  };
  visit(body);
  return sites;
}

// ── imports ──

/**
 * A top-level `require`/`require_relative` call with a single string argument.
 * Returns null for any other call. For require_relative the path is normalized
 * to a './'-anchored relative specifier; for require it is kept verbatim.
 */
function readRequire(call: Node, fromFile: string): ImportRecord | null {
  const method = call.childForFieldName('method');
  if (!method) return null;
  const kind = method.text;
  if (kind !== 'require' && kind !== 'require_relative') return null;

  const args = call.childForFieldName('arguments');
  if (!args) return null;
  const str = nkids(args).find((a) => a.type === 'string');
  if (!str) return null;
  const raw = stringContent(str);
  if (!raw) return null;

  const specifier = kind === 'require_relative' ? toRelative(raw) : raw;
  return { fromFile, line: lineOf(call), specifier, named: [lastSegment(raw, '/')], isTypeOnly: false };
}

/** Inner text of a Ruby string node (its `string_content` child), no quotes. */
function stringContent(str: Node): string {
  const content = ckids(str).find((c) => c.type === 'string_content');
  return content ? content.text : stripQuotes(str.text);
}

/** Anchor a require_relative path as JS-style relative: 'helper' → './helper'. */
function toRelative(p: string): string {
  if (p.startsWith('./') || p.startsWith('../')) return p;
  return `./${p}`;
}
