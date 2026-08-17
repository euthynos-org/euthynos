import { readFileSync } from 'node:fs';
import type { Node } from 'web-tree-sitter';
import type { DiscoveredFile } from '../discover.js';
import type { CallSite, ExportedSymbol, FunctionRecord, ImportRecord, ParsedFile, SymbolSpan } from '../types.js';
import { parseWith } from './treesitter/loader.js';
import { bodyHash, EMPTY_BODY, countCodeLines, fieldText, lastSegment, nkids, walkNamed } from './treesitter/util.js';

/**
 * C# parser → the parser-agnostic `ParsedFile` shape.
 *
 * Public-surface convention: C# has no top-level functions — only type members.
 * A type or member is part of the public interface iff its `modifier`s include
 * `public` (members default to private, top-level types to internal; we treat
 * only `public` as exported, consistent with the Java parser). Every
 * method/constructor anywhere in the file is collected as a function; only the
 * `public` ones become exports. `using` directives are dotted namespace names
 * captured verbatim — C# imports name namespaces, not files, so they are not
 * resolved to local modules. Requires the 'c_sharp' grammar to be pre-loaded
 * via loadLanguages().
 */
export function parseCSharpFile(f: DiscoveredFile): ParsedFile {
  return parseCSharpSource(f.rel, f.module, f.isTest, readFileSync(f.abs, 'utf8'));
}

/** Identifier-like leaves collapsed to 'ID' for rename-insensitive clone hashing. */
const ID_TYPES = new Set(['identifier']);
/** Literal leaves collapsed to 'LIT'. */
const LIT_TYPES = new Set([
  'integer_literal',
  'real_literal',
  'string_literal',
  'verbatim_string_literal',
  'character_literal',
  'boolean_literal',
  'null_literal',
]);

/** Type declarations → `kind:'class'` symbols (their members become functions). */
const TYPE_DECLS = new Set([
  'class_declaration',
  'struct_declaration',
  'record_declaration',
  'interface_declaration',
]);
/** Member declarations collected as FunctionRecords. */
const METHOD_DECLS = new Set(['method_declaration', 'constructor_declaration']);

export function parseCSharpSource(
  path: string,
  module: string,
  isTest: boolean,
  text: string,
): ParsedFile {
  const tree = parseWith('c_sharp', text);
  const root = tree.rootNode;

  const exports: ExportedSymbol[] = [];
  const imports: ImportRecord[] = [];

  // `using` directives are top-level (and may also nest inside namespaces).
  walkNamed(root, (n) => {
    if (n.type === 'using_directive') {
      const rec = readUsing(n, path);
      if (rec) imports.push(rec);
    }
  });

  // Type declarations anywhere (namespace block, file-scoped namespace, or
  // top-level) contribute their public type + public methods to the surface.
  const symbols: SymbolSpan[] = [];
  walkNamed(root, (n) => {
    if (!TYPE_DECLS.has(n.type)) return;
    collectTypeExports(n, exports);
    symbols.push({
      name: fieldText(n, 'name'),
      kind: n.type === 'interface_declaration' ? 'interface' : n.type === 'record_declaration' ? 'type' : 'class',
      startLine: n.startPosition.row + 1,
      endLine: n.endPosition.row + 1,
      exported: isPublic(n),
    });
  });

  // Count non-public methods/constructors across the whole file.
  let internalFunctions = 0;
  walkNamed(root, (n) => {
    if (METHOD_DECLS.has(n.type) && !isPublic(n)) internalFunctions++;
  });

  // Every method/constructor anywhere in the file → a FunctionRecord.
  const functions: FunctionRecord[] = [];
  walkNamed(root, (n) => {
    if (METHOD_DECLS.has(n.type)) functions.push(fnRecord(n, path));
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
    symbols,
    totalLines: text.split('\n').length,
  };
}

// ── exports / symbols ──

/**
 * A declaration is exported iff its `modifier`s include `public`.
 *
 * Grammar note: `modifier` is a POSITIONAL named child (there can be several,
 * e.g. `public static`), NOT a field — `childForFieldName('modifier')` returns
 * null. So we collect every `modifier` child and check for `public`.
 */
function isPublic(node: Node): boolean {
  return modifiers(node).includes('public');
}

function modifiers(node: Node): string[] {
  return nkids(node)
    .filter((c) => c.type === 'modifier')
    .map((c) => c.text);
}

/**
 * Emit a type declaration's public surface: the type itself (if public) as a
 * 'class' symbol whose construction cost is its constructor's params, plus each
 * directly-contained public method as a 'function' symbol. Nested types are
 * picked up by the top-level walk, so this only handles direct members.
 */
function collectTypeExports(typeNode: Node, out: ExportedSymbol[]): void {
  if (isPublic(typeNode)) {
    const ctor = findConstructor(typeNode);
    const p = ctor ? countParams(ctor.childForFieldName('parameters')) : { required: 0, total: 0 };
    out.push({ name: fieldText(typeNode, 'name'), kind: 'class', requiredParams: p.required, totalParams: p.total });
  }
  const body = typeNode.childForFieldName('body');
  if (!body) return;
  for (const member of nkids(body)) {
    if (member.type === 'method_declaration' && isPublic(member)) {
      const p = countParams(member.childForFieldName('parameters'));
      out.push({ name: fieldText(member, 'name'), kind: 'function', requiredParams: p.required, totalParams: p.total });
    }
  }
}

/** The first constructor_declaration directly in a type's body (construction surface). */
function findConstructor(typeNode: Node): Node | null {
  const body = typeNode.childForFieldName('body');
  if (!body) return null;
  return nkids(body).find((c) => c.type === 'constructor_declaration') ?? null;
}

// ── functions ──

function fnRecord(node: Node, file: string): FunctionRecord {
  const params = node.childForFieldName('parameters');
  // Body is EITHER a `block` OR an `arrow_expression_clause` (`=> expr`).
  const body = node.childForFieldName('body');
  const { hash, tokens, literals, sketch } = body ? bodyHash(body, { idTypes: ID_TYPES, litTypes: LIT_TYPES }) : EMPTY_BODY;
  const p = countParams(params);
  const { calls, memberCalls, callSites } = body
    ? collectCalls(body)
    : { calls: [], memberCalls: [], callSites: [] };
  return {
    name: methodName(node),
    file,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    // C# records the declaration start already (modifiers + signature).
    declLine: node.startPosition.row + 1,
    exported: isPublic(node),
    paramCount: p.total,
    paramNames: paramNames(params),
    bodyHash: hash,
    bodyTokens: tokens,
    ...(literals === undefined ? {} : { literalHash: literals }),
    ...(sketch === undefined ? {} : { ngramSketch: sketch }),
    calls,
    memberCalls,
    callSites,
  };
}

/** Method/constructor name via the `name` field. */
function methodName(node: Node): string {
  return node.childForFieldName('name')?.text ?? '(anon)';
}

/**
 * Count parameters in a parameter_list. A `parameter` with an
 * `equals_value_clause` child has a default (`int tax = 0`) → optional, so it
 * counts toward total but not required.
 */
function countParams(params: Node | null): { required: number; total: number } {
  if (!params) return { required: 0, total: 0 };
  let required = 0;
  let total = 0;
  for (const p of nkids(params)) {
    if (p.type !== 'parameter') continue;
    total++;
    const hasDefault = nkids(p).some((c) => c.type === 'equals_value_clause');
    if (!hasDefault) required++;
  }
  return { required, total };
}

function paramNames(params: Node | null): string[] {
  if (!params) return [];
  const names: string[] = [];
  for (const p of nkids(params)) {
    if (p.type !== 'parameter') continue;
    const id = p.childForFieldName('name');
    if (id) names.push(id.text);
  }
  return names;
}

/**
 * Best-effort call extraction over a body (block or arrow): each
 * invocation_expression contributes its callee — a bare `identifier`, or the
 * trailing `name` of a `member_access_expression` (`obj.Method()` → `Method`).
 * Member calls are tracked separately: `list.Select()` must not resolve to a
 * repo function named `Select` on name alone. Deduped.
 */
function collectCalls(body: Node): { calls: string[]; memberCalls: string[]; callSites: CallSite[] } {
  const bare = new Set<string>();
  const member = new Set<string>();
  const sites: CallSite[] = [];
  walkNamed(body, (n) => {
    if (n.type !== 'invocation_expression') return;
    const fn = n.childForFieldName('function');
    if (!fn) return;
    if (fn.type === 'identifier') {
      bare.add(fn.text);
      sites.push({ name: fn.text, line: fn.startPosition.row + 1, member: false });
    } else if (fn.type === 'member_access_expression') {
      const name = fn.childForFieldName('name');
      if (name) {
        member.add(name.text);
        sites.push({ name: name.text, line: name.startPosition.row + 1, member: true });
      }
    }
  });
  return { calls: [...new Set([...bare, ...member])], memberCalls: [...member], callSites: sites };
}

// ── imports ──

/**
 * `using System;` / `using System.Collections.Generic;` → the name node is an
 * `identifier` or `qualified_name` whose `.text` is the full dotted namespace.
 * specifier = full dotted name; named = last dotted segment. (`using static` and
 * alias forms still surface the captured name.)
 */
function readUsing(node: Node, fromFile: string): ImportRecord | null {
  const name = nkids(node).find((c) => c.type === 'qualified_name' || c.type === 'identifier');
  if (!name) return null;
  const specifier = name.text;
  return {
    fromFile,
    line: node.startPosition.row + 1,
    specifier,
    named: [lastSegment(specifier, '.')],
    isTypeOnly: false,
  };
}
