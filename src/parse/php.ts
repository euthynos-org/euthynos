import { readFileSync } from 'node:fs';
import type { Node } from 'web-tree-sitter';
import type { DiscoveredFile } from '../discover.js';
import type { CallSite, ExportedSymbol, FunctionRecord, ImportRecord, ParsedFile, SymbolSpan } from '../types.js';
import { parseWith } from './treesitter/loader.js';
import {
  bodyHash, EMPTY_BODY, ckids, collectSymbolSpans, countCodeLines, deriveCalls, fieldText,
  lastSegment, lineOf, nkids, totalLinesOf, walkNamed,
} from './treesitter/util.js';

/**
 * PHP parser → the parser-agnostic `ParsedFile` shape.
 *
 * Public-surface convention (PHP has no module-export keyword): every
 * top-level `function` and every class/interface/trait declaration is part of
 * the interface, plus every PUBLIC method. PHP methods default to public when
 * no visibility modifier is present, so a bare `function foo()` inside a class
 * counts as exported; `private`/`protected` methods are implementation detail.
 * Requires the 'php' grammar to be pre-loaded via loadLanguages().
 */
export function parsePhpFile(f: DiscoveredFile): ParsedFile {
  return parsePhpSource(f.rel, f.module, f.isTest, readFileSync(f.abs, 'utf8'));
}

/** Node types collapsed to 'ID' when hashing a body (rename-insensitive clones). */
const ID_TYPES = new Set(['name', 'variable_name']);
/** Node types collapsed to 'LIT' when hashing a body. */
const LIT_TYPES = new Set(['string', 'encapsed_string', 'integer', 'float', 'boolean', 'null']);

/** A trait is a reusable contract, so it sits in the interface slot. */
const SPAN_KINDS: Readonly<Record<string, SymbolSpan['kind']>> = {
  class_declaration: 'class',
  interface_declaration: 'interface',
  trait_declaration: 'interface',
  enum_declaration: 'enum',
};

export function parsePhpSource(
  path: string,
  module: string,
  isTest: boolean,
  text: string,
): ParsedFile {
  const tree = parseWith('php', text);
  const root = tree.rootNode;

  const exports: ExportedSymbol[] = [];
  const imports: ImportRecord[] = [];
  const functions: FunctionRecord[] = [];
  let internalFunctions = 0;

  // Walk the whole tree once: namespaces nest the declarations under a
  // namespace_definition body, so a flat scan of program children would miss
  // them. walkNamed visits every named node; we react to the kinds we care
  // about and let the recursion reach into namespace/class bodies.
  walkNamed(root, (node) => {
    switch (node.type) {
      case 'function_definition': {
        // Top-level function: always public/exported.
        const name = fieldText(node, 'name');
        exports.push(fnSymbol(name, node));
        functions.push(fnRecord(name, node, path, true));
        break;
      }
      case 'method_declaration': {
        const name = fieldText(node, 'name');
        const isPublic = methodIsPublic(node);
        if (isPublic) exports.push(fnSymbol(name, node));
        else internalFunctions++;
        functions.push(fnRecord(name, node, path, isPublic));
        break;
      }
      case 'class_declaration':
      case 'interface_declaration':
      case 'trait_declaration': {
        exports.push({
          name: fieldText(node, 'name'),
          kind: 'class',
          requiredParams: 0,
          totalParams: 0,
        });
        break;
      }
      case 'namespace_use_declaration': {
        imports.push(...readUse(node, path));
        break;
      }
    }
  });

  return {
    path,
    module,
    isTest,
    isIndex: false,
    codeLines: countCodeLines(text, '//'),
    exports,
    internalFunctions,
    functions,
    imports,
    // PHP type declarations carry no visibility modifier — they are reachable
    // from anywhere the file is included.
    symbols: collectSymbolSpans(root, { kinds: SPAN_KINDS, exported: () => true }),
    totalLines: totalLinesOf(text),
  };
}

// ── visibility ──

/**
 * PHP methods default to public. Exported iff there is no visibility_modifier
 * child, or it reads 'public'. 'private'/'protected' → not exported.
 */
function methodIsPublic(method: Node): boolean {
  const vis = ckids(method).find((c) => c.type === 'visibility_modifier');
  if (!vis) return true;
  return vis.text === 'public';
}

// ── exports / symbols ──

function fnSymbol(name: string, defNode: Node): ExportedSymbol {
  const p = countParams(defNode.childForFieldName('parameters'));
  return { name, kind: 'function', requiredParams: p.required, totalParams: p.total };
}

interface ParamCount {
  required: number;
  total: number;
}

/**
 * Count formal parameters. simple_parameter, property_promotion_parameter and
 * variadic_parameter all count toward the total. A simple_parameter (or
 * promoted property) carrying a default value (a child after a '=') is optional
 * and does not count toward `required`; variadic params are never required.
 */
function countParams(params: Node | null): ParamCount {
  if (!params) return { required: 0, total: 0 };
  let required = 0;
  let total = 0;
  for (const p of nkids(params)) {
    if (p.type === 'simple_parameter' || p.type === 'property_promotion_parameter') {
      total++;
      if (!hasDefault(p)) required++;
    } else if (p.type === 'variadic_parameter') {
      total++;
      // variadic ($...args) is always optional
    }
  }
  return { required, total };
}

/** A parameter has a default if it carries an '=' followed by a value child. */
function hasDefault(param: Node): boolean {
  return ckids(param).some((c) => c.type === '=');
}

// ── function records (incl. methods) ──

function fnRecord(name: string, node: Node, file: string, exported: boolean): FunctionRecord {
  const params = node.childForFieldName('parameters');
  const body = node.childForFieldName('body');
  const { hash, tokens, literals, sketch } = body ? bodyHash(body, { idTypes: ID_TYPES, litTypes: LIT_TYPES }) : EMPTY_BODY;
  return {
    name,
    file,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    exported,
    paramCount: params ? countParams(params).total : 0,
    paramNames: params ? paramNames(params) : [],
    bodyHash: hash,
    bodyTokens: tokens,
    ...(literals === undefined ? {} : { literalHash: literals }),
    ...(sketch === undefined ? {} : { ngramSketch: sketch }),
    ...deriveCalls(body ? collectCallSites(body) : []),
  };
}

/** Inner name of each parameter's variable_name, '$' stripped if present. */
function paramNames(params: Node): string[] {
  const names: string[] = [];
  for (const p of nkids(params)) {
    if (
      p.type === 'simple_parameter' ||
      p.type === 'property_promotion_parameter' ||
      p.type === 'variadic_parameter'
    ) {
      const vn = p.childForFieldName('name') ?? nkids(p).find((c) => c.type === 'variable_name');
      if (vn) names.push(varName(vn));
    }
  }
  return names;
}

/** variable_name → its inner `name` text (fallback to own text), leading '$' stripped. */
function varName(vn: Node): string {
  const inner = nkids(vn).find((c) => c.type === 'name');
  const raw = inner?.text ?? vn.text;
  return raw.startsWith('$') ? raw.slice(1) : raw;
}

// ── calls ──

/** `foo()` is bare; `$x->foo()` and `X::foo()` arrive through a receiver. */
function collectCallSites(body: Node): CallSite[] {
  const sites: CallSite[] = [];
  walkNamed(body, (n) => {
    if (n.type === 'function_call_expression') {
      const fn = n.childForFieldName('function');
      if (fn) sites.push({ name: lastNameSegment(fn), line: lineOf(fn), member: false });
    } else if (n.type === 'member_call_expression' || n.type === 'scoped_call_expression') {
      const m = n.childForFieldName('name');
      if (m) sites.push({ name: m.text, line: lineOf(m), member: true });
    }
  });
  return sites;
}

/** For a call target that is a name/qualified_name, use the last path segment. */
function lastNameSegment(fn: Node): string {
  if (fn.type === 'qualified_name') {
    const segs = nkids(fn).filter((c) => c.type === 'name');
    const last = segs[segs.length - 1];
    if (last) return last.text;
  }
  return fn.text;
}

// ── imports ──

/**
 * `use App\Auth\Login;` →
 *   namespace_use_declaration → namespace_use_clause → qualified_name
 *     (namespace_name_as_prefix (namespace_name App Auth)) (name Login)
 * specifier = full path with '\' → '/'; named = [last segment].
 */
function readUse(node: Node, fromFile: string): ImportRecord[] {
  const records: ImportRecord[] = [];
  for (const clause of nkids(node)) {
    if (clause.type !== 'namespace_use_clause') continue;
    const qn = nkids(clause).find((c) => c.type === 'qualified_name');
    if (!qn) continue;
    const full = qn.text.replace(/^\\+/, '').replace(/\\/g, '/');
    const named = nkids(qn).find((c) => c.type === 'name')?.text ?? lastSegment(full, '/');
    records.push({ fromFile, line: lineOf(clause), specifier: full, named: [named], isTypeOnly: false });
  }
  return records;
}
