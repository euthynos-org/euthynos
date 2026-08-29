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
  const { hash, tokens, literals, sketch, defHash } = body ? bodyHash(body, { idTypes: ID_TYPES, litTypes: LIT_TYPES }) : EMPTY_BODY;
  const p = countParams(params);
  const { calls, memberCalls, callSites } = body
    ? collectCalls(body)
    : { calls: [], memberCalls: [], callSites: [] };
  const typed = body ? collectTypedCallsCs(node, body) : [];
  const enclosing = enclosingTypeNameCs(node);
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
    ...(defHash === undefined ? {} : { defHash }),
    ...(enclosing === undefined ? {} : { enclosingType: enclosing }),
    calls,
    memberCalls,
    callSites,
    ...(typed.length > 0 ? { typedCalls: typed } : {}),
  };
}

const CS_TYPE_DECLS = new Set(['class_declaration', 'struct_declaration', 'record_declaration', 'interface_declaration']);

/** The class/struct/record/interface that lexically contains this method. */
function enclosingTypeNameCs(node: Node): string | undefined {
  let anc: Node | null = node.parent;
  while (anc && !CS_TYPE_DECLS.has(anc.type)) anc = anc.parent;
  return anc ? (anc.childForFieldName('name')?.text ?? undefined) : undefined;
}

/** Simple type name from a C# type node (drop qualifier, generics, nullable/array).
 * Null for predefined types (int/string), `var`, and shapes we can't name. */
function csTypeName(t: Node | null | undefined): string | null {
  if (!t) return null;
  let n: Node = t;
  // `Foo[]` is an array, NOT a Foo — declining avoids binding an array/LINQ method
  // call to a same-named method on the element type. (`Foo?` really is a Foo.)
  if (n.type === 'array_type') return null;
  if (n.type === 'nullable_type') {
    const inner = n.childForFieldName('type') ?? nkids(n)[0];
    if (inner) n = inner;
  }
  if (n.type === 'identifier') return n.text;
  if (n.type === 'qualified_name') return lastSegment(n.text, '.');
  if (n.type === 'generic_name') return (n.childForFieldName('name') ?? nkids(n).find((c) => c.type === 'identifier'))?.text ?? null;
  return null; // predefined_type / implicit_type
}

/**
 * Receiver-typed member calls in a C# method — the SOUND bridge (same graph-layer
 * class-scoping as Java/Kotlin). Types come from the enclosing type's fields and
 * properties, the method's parameters, and local declarations (explicit type, or
 * `new Foo()` for `var`). Records `recv.M()`, `this.field.M()`, and `new Foo().M()`
 * whose receiver type is known; a name declared with two types is dropped.
 */
function collectTypedCallsCs(fnNode: Node, body: Node): { method: string; type: string }[] {
  const varType = new Map<string, string>();
  const ambiguous = new Set<string>();
  const note = (name: string | undefined | null, tn: string | null): void => {
    if (!name || !tn) return;
    const prev = varType.get(name);
    if (prev !== undefined && prev !== tn) ambiguous.add(name);
    varType.set(name, tn);
  };
  const initOCE = (declarator: Node): Node | null => {
    for (const c of nkids(declarator)) {
      if (c.type === 'object_creation_expression') return c;
      if (c.type === 'equals_value_clause') {
        const oce = nkids(c).find((x) => x.type === 'object_creation_expression');
        if (oce) return oce;
      }
    }
    return null;
  };
  const noteVarDecl = (vd: Node): void => {
    const typeNode = vd.childForFieldName('type');
    const isVar = typeNode?.type === 'implicit_type';
    const declared = csTypeName(typeNode);
    for (const d of nkids(vd)) {
      if (d.type !== 'variable_declarator') continue;
      let tn = declared;
      if (isVar) {
        const oce = initOCE(d);
        if (oce) tn = csTypeName(oce.childForFieldName('type'));
      }
      // C# variable_declarator has no `name` field — the name is its first identifier.
      note(nkids(d).find((c) => c.type === 'identifier')?.text, tn);
    }
  };

  // Enclosing type: fields and properties.
  let cls: Node | null = fnNode.parent;
  while (cls && !CS_TYPE_DECLS.has(cls.type)) cls = cls.parent;
  const clsBody = cls?.childForFieldName('body') ?? (cls ? nkids(cls).find((c) => c.type === 'declaration_list') : undefined);
  if (clsBody) {
    for (const m of nkids(clsBody)) {
      if (m.type === 'field_declaration') {
        const vd = nkids(m).find((c) => c.type === 'variable_declaration');
        if (vd) noteVarDecl(vd);
      } else if (m.type === 'property_declaration') {
        note(m.childForFieldName('name')?.text, csTypeName(m.childForFieldName('type')));
      }
    }
  }
  // Parameters.
  const params = fnNode.childForFieldName('parameters');
  if (params) for (const p of nkids(params)) if (p.type === 'parameter') note(p.childForFieldName('name')?.text, csTypeName(p.childForFieldName('type')));
  // Local declarations.
  walkNamed(body, (n) => {
    if (n.type === 'variable_declaration') noteVarDecl(n);
  });
  for (const n of ambiguous) varType.delete(n);

  const out: { method: string; type: string }[] = [];
  const seen = new Set<string>();
  walkNamed(body, (n) => {
    if (n.type !== 'invocation_expression') return;
    const fnExpr = n.childForFieldName('function') ?? nkids(n)[0];
    if (fnExpr?.type !== 'member_access_expression') return;
    const method = fnExpr.childForFieldName('name')?.text;
    if (!method) return;
    const recv = fnExpr.childForFieldName('expression') ?? nkids(fnExpr)[0];
    let type: string | null = null;
    if (recv?.type === 'identifier') type = varType.get(recv.text) ?? null;
    else if (recv?.type === 'object_creation_expression') type = csTypeName(recv.childForFieldName('type'));
    else if (recv?.type === 'member_access_expression') {
      const inner = recv.childForFieldName('expression') ?? nkids(recv)[0];
      const fieldName = recv.childForFieldName('name')?.text;
      if (inner?.type === 'this_expression' && fieldName) type = varType.get(fieldName) ?? null;
    }
    if (!type) return;
    const key = `${method}|${type}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ method, type });
    }
  });
  return out;
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
