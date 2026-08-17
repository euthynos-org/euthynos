import { readFileSync } from 'node:fs';
import type { Node } from 'web-tree-sitter';
import type { DiscoveredFile } from '../discover.js';
import type { CallSite, ExportedSymbol, FunctionRecord, ImportRecord, ParsedFile, SymbolSpan } from '../types.js';
import { parseWith } from './treesitter/loader.js';
import {
  bodyHash, EMPTY_BODY, ckids, collectSymbolSpans, countCodeLines, deriveCalls, fieldText,
  lastSegment, lineOf, nkids, totalLinesOf,
} from './treesitter/util.js';

/**
 * Rust parser → the parser-agnostic `ParsedFile` shape.
 *
 * Public-surface convention: an item is part of the interface iff it carries a
 * `visibility_modifier` child (i.e. `pub`). Functions are collected at every
 * level — top-level `function_item`s plus methods inside `impl` blocks — but
 * only `pub` items count toward the export surface; the rest are implementation.
 * Module interface files are `mod.rs` / `lib.rs` / `main.rs` (analogous to
 * Python's `__init__.py`). Requires the 'rust' grammar to be pre-loaded via
 * loadLanguages().
 */
export function parseRustFile(f: DiscoveredFile): ParsedFile {
  return parseRustSource(f.rel, f.module, f.isTest, readFileSync(f.abs, 'utf8'));
}

/** Identifier-like node types collapsed to 'ID' for clone hashing. */
const ID_TYPES = new Set(['identifier', 'type_identifier', 'field_identifier', 'scoped_identifier']);
/** Literal node types collapsed to 'LIT' for clone hashing. */
const LIT_TYPES = new Set([
  'string_literal', 'raw_string_literal', 'integer_literal', 'float_literal',
  'char_literal', 'boolean_literal',
]);

/** Rust item declarations that carry a span worth showing in an outline. */
const SPAN_KINDS: Readonly<Record<string, SymbolSpan['kind']>> = {
  struct_item: 'class',
  union_item: 'class',
  enum_item: 'enum',
  trait_item: 'interface',
  type_item: 'type',
  mod_item: 'module',
};

export function parseRustSource(
  path: string,
  module: string,
  isTest: boolean,
  text: string,
): ParsedFile {
  const tree = parseWith('rust', text);
  const root = tree.rootNode;

  const exports: ExportedSymbol[] = [];
  const imports: ImportRecord[] = [];
  let internalFunctions = 0;

  for (const node of nkids(root)) {
    switch (node.type) {
      case 'function_item': {
        if (isExported(node)) exports.push(fnSymbol(node));
        else internalFunctions++;
        break;
      }
      case 'struct_item':
      case 'enum_item':
      case 'trait_item': {
        if (isExported(node)) exports.push(typeSymbol(node));
        break;
      }
      case 'impl_item': {
        // Methods inside impl blocks count toward the interface like any other
        // function_item: pub methods are part of the export surface, non-pub
        // ones are implementation.
        for (const method of implMethods(node)) {
          if (isExported(method)) exports.push(fnSymbol(method));
          else internalFunctions++;
        }
        break;
      }
      case 'use_declaration': {
        const rec = readUse(node, path);
        if (rec) imports.push(rec);
        break;
      }
      default:
        break;
    }
  }

  const functions: FunctionRecord[] = [];
  collectFunctions(root, path, functions);

  return {
    path,
    module,
    isTest,
    isIndex: /(^|\/)(mod|lib|main)\.rs$/.test(path),
    codeLines: countCodeLines(text, '//'),
    exports,
    internalFunctions,
    functions,
    imports,
    symbols: collectSymbolSpans(root, { kinds: SPAN_KINDS, exported: (_n, node) => isExported(node) }),
    totalLines: totalLinesOf(text),
  };
}

// ── exports / symbols ──

/** Exported iff the item carries a `pub` visibility modifier. */
function isExported(node: Node): boolean {
  return nkids(node).some((c) => c.type === 'visibility_modifier');
}

function fnSymbol(node: Node): ExportedSymbol {
  // Rust has no default params → required === total.
  const total = countParams(node.childForFieldName('parameters'));
  return { name: fieldText(node, 'name'), kind: 'function', requiredParams: total, totalParams: total };
}

function typeSymbol(node: Node): ExportedSymbol {
  // struct/enum/trait expose a type, not a callable surface.
  return { name: fieldText(node, 'name'), kind: 'type', requiredParams: 0, totalParams: 0 };
}

/** Method `function_item`s inside an impl block's declaration_list. */
function implMethods(impl: Node): Node[] {
  const body = impl.childForFieldName('body');
  if (!body) return [];
  return nkids(body).filter((c) => c.type === 'function_item');
}

/** Count `parameter` children; `self_parameter` is skipped (it's the receiver). */
function countParams(params: Node | null): number {
  if (!params) return 0;
  let n = 0;
  for (const p of nkids(params)) {
    if (p.type === 'parameter') n++;
    // self_parameter and variadic/_ skipped
  }
  return n;
}

function paramNames(params: Node | null): string[] {
  if (!params) return [];
  const names: string[] = [];
  for (const p of nkids(params)) {
    if (p.type !== 'parameter') continue;
    const pat = p.childForFieldName('pattern');
    names.push(pat?.type === 'identifier' ? pat.text : '_');
  }
  return names;
}

// ── functions (recursive, incl. impl methods) ──

function collectFunctions(node: Node, file: string, out: FunctionRecord[]): void {
  if (node.type === 'function_item') {
    const params = node.childForFieldName('parameters');
    const body = node.childForFieldName('body');
    const { hash, tokens, literals, sketch } = body ? bodyHash(body, { idTypes: ID_TYPES, litTypes: LIT_TYPES }) : EMPTY_BODY;
    out.push({
      name: fieldText(node, 'name'),
      file,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      exported: isExported(node),
      paramCount: countParams(params),
      paramNames: paramNames(params),
      bodyHash: hash,
      bodyTokens: tokens,
      ...(literals === undefined ? {} : { literalHash: literals }),
      ...(sketch === undefined ? {} : { ngramSketch: sketch }),
      ...deriveCalls(body ? collectCallSites(body) : []),
    });
  }
  for (const child of nkids(node)) collectFunctions(child, file, out);
}

/**
 * Calls + macro invocations, each with its line. `foo()` is bare; `x.foo()`
 * (field) and `Type::foo()` (scoped) both need evidence beyond the name to
 * resolve, so both count as member calls. A macro keeps its `!` so it can
 * never collide with a function of the same name.
 */
function collectCallSites(body: Node): CallSite[] {
  const sites: CallSite[] = [];
  const visit = (n: Node): void => {
    if (n.type === 'call_expression') {
      const fn = n.childForFieldName('function');
      if (fn) {
        if (fn.type === 'identifier') {
          sites.push({ name: fn.text, line: lineOf(fn), member: false });
        } else if (fn.type === 'field_expression') {
          const field = fn.childForFieldName('field');
          if (field) sites.push({ name: field.text, line: lineOf(field), member: true });
        } else if (fn.type === 'scoped_identifier') {
          const name = fn.childForFieldName('name');
          if (name) sites.push({ name: name.text, line: lineOf(name), member: true });
        }
      }
    } else if (n.type === 'macro_invocation') {
      const macro = n.childForFieldName('macro');
      if (macro) sites.push({ name: `${macro.text}!`, line: lineOf(macro), member: false });
    }
    for (const c of ckids(n)) visit(c);
  };
  visit(body);
  return sites;
}

// ── imports ──

/**
 * `use_declaration` → an ImportRecord. The `argument` is typically a
 * `scoped_identifier` (e.g. `crate::auth::login`): specifier is the path with
 * `::` → `/` and `named` is the last segment. `use_as_clause` and `use_list`
 * get best-effort handling. Rust module imports are captured, not resolved.
 */
function readUse(node: Node, fromFile: string): ImportRecord | null {
  const arg = node.childForFieldName('argument');
  if (!arg) return null;

  if (arg.type === 'scoped_identifier' || arg.type === 'identifier') {
    const path = arg.text;
    return { fromFile, line: lineOf(node), specifier: path.replace(/::/g, '/'), named: [lastSegment(path, '::')], isTypeOnly: false };
  }

  if (arg.type === 'use_as_clause') {
    // `use a::b::c as d;` — specifier from the real path, name is the alias.
    const pathNode = arg.childForFieldName('path');
    const aliasNode = arg.childForFieldName('alias');
    const path = pathNode?.text ?? arg.text;
    const named = aliasNode?.text ?? lastSegment(path, '::');
    return { fromFile, line: lineOf(node), specifier: path.replace(/::/g, '/'), named: [named], isTypeOnly: false };
  }

  if (arg.type === 'scoped_use_list' || arg.type === 'use_list') {
    // `use a::b::{c, d};` — base path + the names in the list.
    const pathNode = arg.childForFieldName('path');
    const base = pathNode ? pathNode.text : '';
    const list = arg.type === 'use_list' ? arg : arg.childForFieldName('list') ?? arg;
    const named = useListNames(list);
    const specifier = (base ? base.replace(/::/g, '/') : arg.text.replace(/::/g, '/'));
    return { fromFile, line: lineOf(node), specifier, named: named.length ? named : [lastSegment(specifier.replace(/\//g, '::'), '::')], isTypeOnly: false };
  }

  // Fallback: capture the raw path, best-effort name = last identifier.
  const spec = arg.text.replace(/::/g, '/');
  return { fromFile, line: lineOf(node), specifier: spec, named: [lastSegment(arg.text, '::')], isTypeOnly: false };
}

/** Best-effort names from a use_list: each entry's last `::` segment. */
function useListNames(list: Node): string[] {
  const names: string[] = [];
  for (const c of nkids(list)) {
    if (c.type === 'identifier' || c.type === 'type_identifier') {
      names.push(c.text);
    } else if (c.type === 'scoped_identifier') {
      const name = c.childForFieldName('name');
      names.push(name ? name.text : lastSegment(c.text, '::'));
    } else if (c.type === 'use_as_clause') {
      const alias = c.childForFieldName('alias');
      const pathNode = c.childForFieldName('path');
      names.push(alias?.text ?? (pathNode ? lastSegment(pathNode.text, '::') : lastSegment(c.text, '::')));
    }
  }
  return names.filter(Boolean);
}

