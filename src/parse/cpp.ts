import { readFileSync } from 'node:fs';
import type { Node } from 'web-tree-sitter';
import type { DiscoveredFile } from '../discover.js';
import type { CallSite, ExportedSymbol, FunctionRecord, ImportRecord, ParsedFile, SymbolSpan } from '../types.js';
import { parseWith } from './treesitter/loader.js';
import {
  basenameNoExt, bodyHash, EMPTY_BODY, collectSymbolSpans, countCodeLines, deriveCalls,
  lastSegment, lineOf, nkids, totalLinesOf, walkNamed,
} from './treesitter/util.js';

/**
 * C++ parser → the parser-agnostic `ParsedFile` shape.
 *
 * Public-surface convention: C++ has no `export` keyword (modules aside), so the
 * public surface is approximated structurally:
 *  - Free functions (`function_definition` directly under `translation_unit` or
 *    inside a `namespace_definition` body) are EXPORTED — they are the file's
 *    callable interface. Namespaces are recursed into.
 *  - Classes/structs (`class_specifier`/`struct_specifier` with a `name`) are
 *    EXPORTED as `kind:'class'`; their construction surface is the constructor's
 *    parameters (mirrors python.ts treating __init__ as the class's arity).
 *  - Member functions are EXPORTED iff they sit under `public:` access. Access is
 *    POSITIONAL: a `field_declaration_list` defaults to private for a class and
 *    public for a struct, and `access_specifier` nodes ('public:'/'private:'/
 *    'protected:') flip the mode for all following members (like Ruby's bare
 *    `private`). Member functions are still collected into `functions[]`.
 *
 * `#include` directives are captured as imports (system `<...>` and local
 * `"..."` alike). Requires the 'cpp' grammar pre-loaded via loadLanguages().
 */
export function parseCppFile(f: DiscoveredFile): ParsedFile {
  return parseCppSource(f.rel, f.module, f.isTest, readFileSync(f.abs, 'utf8'));
}

/** Identifier-like leaves collapsed to 'ID' for rename-insensitive clone hashing. */
const ID_TYPES = new Set(['identifier', 'field_identifier', 'type_identifier', 'namespace_identifier']);
/** Literal leaves collapsed to 'LIT'. */
const LIT_TYPES = new Set([
  'number_literal', 'string_literal', 'char_literal', 'true', 'false', 'concatenated_string',
]);

/** Class/struct definition node types (both produce a `field_declaration_list` body). */
const CLASS_LIKE = new Set(['class_specifier', 'struct_specifier']);

/** A namespace is a real declaration span, and calling it a class would lie. */
const SPAN_KINDS: Readonly<Record<string, SymbolSpan['kind']>> = {
  class_specifier: 'class',
  struct_specifier: 'class',
  union_specifier: 'class',
  enum_specifier: 'enum',
  namespace_definition: 'module',
  alias_declaration: 'type',
};

export function parseCppSource(
  path: string,
  module: string,
  isTest: boolean,
  text: string,
): ParsedFile {
  const tree = parseWith('cpp', text);
  const root = tree.rootNode;

  const exports: ExportedSymbol[] = [];
  const imports: ImportRecord[] = [];
  const functions: FunctionRecord[] = [];
  // Member functions found under non-public access — recorded so collectFunctions
  // marks them exported=false; everything else (free fns, public members) is exported.
  const privateMemberIds = new Set<number>();
  let internalFunctions = 0;

  // Top-level scan: includes, free functions (incl. namespace-nested), classes/structs.
  // `internalFunctions` counts only top-level non-exported functions — C++ free
  // functions are always exported, so this stays 0 (private members aren't top-level).
  const visitScope = (container: Node): void => {
    for (const stmt of nkids(container)) {
      const node = stmt.type === 'template_declaration' ? unwrapTemplate(stmt) : stmt;
      if (!node) continue;

      if (node.type === 'preproc_include') {
        const imp = readInclude(node, path);
        if (imp) imports.push(imp);
      } else if (node.type === 'function_definition') {
        // Free function at TU or namespace level → exported.
        exports.push(fnSymbol(node));
      } else if (CLASS_LIKE.has(node.type)) {
        const sym = classSymbol(node);
        if (sym) exports.push(sym);
        scanClassBody(node, privateMemberIds);
      } else if (node.type === 'namespace_definition') {
        // Recurse into the namespace body's declaration_list to find free fns/classes.
        const body = node.childForFieldName('body');
        if (body) visitScope(body);
      }
    }
  };
  visitScope(root);

  // Every function/method anywhere in the file → a FunctionRecord.
  collectFunctions(root, path, privateMemberIds, functions);

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
    // C++ type declarations carry no export keyword — a named type in a header
    // is reachable by every translation unit that includes it.
    symbols: collectSymbolSpans(root, {
      kinds: SPAN_KINDS,
      // A forward declaration (`class Foo;` — no body) is not a definition: it
      // must not appear in the outline, and must not make the type name look
      // like it is declared in two places (which would disable receiver-type
      // resolution for that type).
      name: (n) =>
        (n.type === 'class_specifier' || n.type === 'struct_specifier' || n.type === 'union_specifier') &&
        n.childForFieldName('body') == null
          ? undefined
          : n.childForFieldName('name')?.text,
      exported: () => true,
    }),
    totalLines: totalLinesOf(text),
  };
}

// ── exports / symbols ──

function fnSymbol(defNode: Node): ExportedSymbol {
  const decl = functionDeclarator(defNode);
  const p = countParams(decl?.childForFieldName('parameters') ?? null);
  return { name: declaratorName(defNode), kind: 'function', requiredParams: p.required, totalParams: p.total };
}

/**
 * A class/struct becomes a 'class' export; its construction surface ≈ the
 * constructor's params (mirrors python.ts using __init__). The constructor is the
 * member `function_definition` whose declarator name === the type name (it also
 * has no return type / a field_initializer_list, but the name match is the
 * reliable signal). No constructor ⇒ 0 params.
 */
function classSymbol(classNode: Node): ExportedSymbol | null {
  const nameNode = classNode.childForFieldName('name');
  if (!nameNode) return null; // anonymous class/struct: no symbol
  const name = nameNode.text;

  const body = classNode.childForFieldName('body');
  let required = 0, total = 0;
  if (body) {
    const ctor = nkids(body).find(
      (m) => m.type === 'function_definition' && declaratorName(m) === name,
    );
    if (ctor) {
      const decl = functionDeclarator(ctor);
      const p = countParams(decl?.childForFieldName('parameters') ?? null);
      required = p.required;
      total = p.total;
    }
  }
  return { name, kind: 'class', requiredParams: required, totalParams: total };
}

/**
 * Walk a class/struct body in source order, tracking the positional access mode.
 * Default access is private for `class_specifier`, public for `struct_specifier`.
 * `access_specifier` nodes flip the mode (their text may include the trailing
 * colon, so match on startsWith). Member `function_definition`s under non-public
 * access are recorded as private so they're marked exported=false later.
 */
function scanClassBody(classNode: Node, privateMemberIds: Set<number>): void {
  const body = classNode.childForFieldName('body');
  if (!body) return;
  let currentAccess = classNode.type === 'struct_specifier' ? 'public' : 'private';

  for (const member of nkids(body)) {
    if (member.type === 'access_specifier') {
      const t = member.text.trim();
      if (t.startsWith('public')) currentAccess = 'public';
      else if (t.startsWith('protected')) currentAccess = 'protected';
      else if (t.startsWith('private')) currentAccess = 'private';
      continue;
    }
    if (member.type === 'function_definition' && currentAccess !== 'public') {
      privateMemberIds.add(member.id);
    }
    // Nested class/struct members: recurse so their own members are tracked.
    if (CLASS_LIKE.has(member.type)) {
      scanClassBody(member, privateMemberIds);
    }
  }
}

/** Unwrap a `template_declaration` to its inner function/class declaration. */
function unwrapTemplate(node: Node): Node | null {
  return nkids(node).find(
    (n) => n.type === 'function_definition' || CLASS_LIKE.has(n.type),
  ) ?? null;
}

// ── functions (recursive, incl. methods + constructors) ──

const CPP_TYPE_DECLS = new Set(['class_specifier', 'struct_specifier']);

/** The class/struct that declares this method — lexical (in-class definition) or
 * the scope of a qualified out-of-class definition (`void Web::go() {…}`). */
function enclosingTypeNameCpp(fnNode: Node): string | undefined {
  let anc: Node | null = fnNode.parent;
  while (anc && !CPP_TYPE_DECLS.has(anc.type)) anc = anc.parent;
  if (anc) return anc.childForFieldName('name')?.text ?? undefined;
  // Out-of-class definition `Ret Web::go() {…}`: take the qualifier from the
  // function's DECLARATOR NAME only. Walking the whole node would wrongly pick a
  // qualifier from the RETURN TYPE or a parameter type (`ns::Ret Web::go()`).
  const decl = functionDeclarator(fnNode)?.childForFieldName('declarator');
  if (decl?.type === 'qualified_identifier') {
    const scope = decl.childForFieldName('scope');
    if (scope) return lastSegment(scope.text, '::');
  }
  return undefined;
}

/** Simple type name from a C++ type node (drop qualifier/generics; null for auto/primitives). */
function cppTypeName(t: Node | null | undefined): string | null {
  if (!t) return null;
  if (t.type === 'type_identifier') return t.text;
  if (t.type === 'qualified_identifier') return lastSegment(t.text, '::');
  if (t.type === 'template_type') return cppTypeName(t.childForFieldName('name') ?? nkids(t).find((c) => c.type === 'type_identifier' || c.type === 'qualified_identifier'));
  return null; // auto / primitive_type / sized types
}

/** Unwrap pointer/reference/array/init declarators down to the declared name. */
function cppDeclName(d: Node | null | undefined): string | undefined {
  if (!d) return undefined;
  if (d.type === 'identifier' || d.type === 'field_identifier') return d.text;
  const inner = d.childForFieldName('declarator') ?? nkids(d).find((c) => /_declarator$|^identifier$|^field_identifier$/.test(c.type));
  return cppDeclName(inner);
}

/**
 * Receiver-typed member calls in a C++ method (SOUND — same graph-layer
 * class-scoping as Java/Kotlin/C#). Types come from the enclosing class's fields,
 * the parameters, and local declarations (explicit type, or `auto x = Foo()`).
 * Handles `obj.m()`, `ptr->m()`, and `this->field.m()`; a name declared with two
 * types is dropped. Out-of-class member definitions have no lexical field access,
 * a safe under-approximation.
 */
function collectTypedCallsCpp(fnNode: Node, params: Node | null, body: Node): { method: string; type: string }[] {
  const varType = new Map<string, string>();
  const ambiguous = new Set<string>();
  const note = (name: string | undefined, tn: string | null): void => {
    if (!name || !tn) return;
    const prev = varType.get(name);
    if (prev !== undefined && prev !== tn) ambiguous.add(name);
    varType.set(name, tn);
  };
  const autoInit = (declNode: Node): string | null => {
    // `auto x = Foo();` / `auto x = new Foo();`
    let val: Node | undefined;
    walkNamed(declNode, (n) => {
      if (val) return;
      if (n.type === 'init_declarator') val = n.childForFieldName('value') ?? undefined;
    });
    if (!val) return null;
    if (val.type === 'call_expression') {
      const fnc = val.childForFieldName('function');
      // `auto x = Foo()` — a plain identifier callee IS the constructed type
      // (cppTypeName only recognises type_identifier, so use the text directly);
      // a same-named non-class falls out at the graph's typeToFile check.
      if (fnc?.type === 'identifier') return fnc.text;
      if (fnc?.type === 'qualified_identifier') return cppTypeName(fnc);
      return null;
    }
    if (val.type === 'new_expression') return cppTypeName(val.childForFieldName('type'));
    return null;
  };
  const noteDecl = (declNode: Node): void => {
    const typeNode = declNode.childForFieldName('type');
    const declared = cppTypeName(typeNode);
    const name = cppDeclName(declNode.childForFieldName('declarator') ?? nkids(declNode).find((c) => /_declarator$|^identifier$|^field_identifier$/.test(c.type)));
    note(name, declared ?? (typeNode?.type === 'auto' ? autoInit(declNode) : null));
  };

  // Enclosing class fields.
  let cls: Node | null = fnNode.parent;
  while (cls && !CPP_TYPE_DECLS.has(cls.type)) cls = cls.parent;
  const clsBody = cls?.childForFieldName('body');
  if (clsBody) for (const m of nkids(clsBody)) if (m.type === 'field_declaration') noteDecl(m);
  // Parameters.
  if (params) for (const p of nkids(params)) if (p.type === 'parameter_declaration') noteDecl(p);
  // Local declarations.
  walkNamed(body, (n) => {
    if (n.type === 'declaration') noteDecl(n);
  });
  for (const n of ambiguous) varType.delete(n);

  const out: { method: string; type: string }[] = [];
  const seen = new Set<string>();
  walkNamed(body, (n) => {
    if (n.type !== 'call_expression') return;
    const fe = n.childForFieldName('function');
    if (fe?.type !== 'field_expression') return;
    const method = fe.childForFieldName('field')?.text;
    if (!method) return;
    const recv = fe.childForFieldName('argument');
    let type: string | null = null;
    if (recv?.type === 'identifier') type = varType.get(recv.text) ?? null;
    else if (recv?.type === 'call_expression') {
      const c = recv.childForFieldName('function');
      if (c?.type === 'identifier') type = c.text; // Foo().m()
    } else if (recv?.type === 'field_expression') {
      // this->field.m() : argument is `this->field` (argument=this, field=name)
      const inner = recv.childForFieldName('argument');
      const fieldName = recv.childForFieldName('field')?.text;
      if (inner?.type === 'this' && fieldName) type = varType.get(fieldName) ?? null;
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

function collectFunctions(
  node: Node,
  file: string,
  privateMemberIds: Set<number>,
  out: FunctionRecord[],
): void {
  if (node.type === 'function_definition') {
    const decl = functionDeclarator(node);
    const params = decl?.childForFieldName('parameters') ?? null;
    const body = node.childForFieldName('body');
    const { hash, tokens, literals, sketch, defHash } = body ? bodyHash(body, { idTypes: ID_TYPES, litTypes: LIT_TYPES }) : EMPTY_BODY;
    const names = paramNames(params);
    const typed = body ? collectTypedCallsCpp(node, params, body) : [];
    const enclosing = enclosingTypeNameCpp(node);
    out.push({
      name: declaratorName(node),
      file,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      exported: !privateMemberIds.has(node.id),
      paramCount: names.length,
      paramNames: names,
      bodyHash: hash,
      bodyTokens: tokens,
      ...(literals === undefined ? {} : { literalHash: literals }),
      ...(sketch === undefined ? {} : { ngramSketch: sketch }),
      ...(defHash === undefined ? {} : { defHash }),
      ...(enclosing === undefined ? {} : { enclosingType: enclosing }),
      ...deriveCalls(body ? collectCallSites(body) : []),
      ...(typed.length > 0 ? { typedCalls: typed } : {}),
    });
  }
  for (const child of nkids(node)) {
    collectFunctions(child, file, privateMemberIds, out);
  }
}

/**
 * Descend a function_definition's `declarator` to the `function_declarator`,
 * peeling pointer/reference wrappers (`int* f()`, `int& g()`). Returns null if
 * none is found (defensive).
 */
function functionDeclarator(defNode: Node): Node | null {
  let d = defNode.childForFieldName('declarator');
  // Peel pointer_declarator / reference_declarator wrappers around the real one.
  while (d && d.type !== 'function_declarator') {
    const inner = d.childForFieldName('declarator');
    if (!inner) break;
    d = inner;
  }
  return d?.type === 'function_declarator' ? d : null;
}

/**
 * Function/method name = the `function_declarator`'s `declarator` field. It is an
 * `identifier` (free fn / constructor), `field_identifier` (member), or a
 * `destructor_name`/`operator_name`/qualified_identifier — all handled by reading
 * `.text`. Falls back to a stable placeholder.
 */
function declaratorName(defNode: Node): string {
  const fd = functionDeclarator(defNode);
  return fd?.childForFieldName('declarator')?.text ?? '(anon)';
}

/**
 * parameter_list children: `parameter_declaration` (required),
 * `optional_parameter_declaration` (has a default → optional), and
 * `variadic_parameter_declaration` (counted as total). A lone `void` parameter
 * (`f(void)`) is a parameter_declaration carrying only a `primitive_type` 'void'
 * and no declarator → arity 0.
 */
function countParams(params: Node | null): { required: number; total: number } {
  if (!params) return { required: 0, total: 0 };
  let required = 0, total = 0;
  for (const p of nkids(params)) {
    if (p.type === 'parameter_declaration') {
      if (isVoidOnly(p)) continue;
      required++; total++;
    } else if (p.type === 'optional_parameter_declaration') {
      total++;
    } else if (p.type === 'variadic_parameter_declaration') {
      total++;
    }
  }
  return { required, total };
}

/** `(void)` — a parameter_declaration whose only content is the `void` primitive type. */
function isVoidOnly(decl: Node): boolean {
  if (decl.childForFieldName('declarator')) return false;
  const type = decl.childForFieldName('type');
  return type?.type === 'primitive_type' && type.text === 'void';
}

/**
 * Param names = the declarator's leading identifier, peeling pointer/reference
 * wrappers. Unnamed params (`int`) and `(void)` contribute no name.
 */
function paramNames(params: Node | null): string[] {
  if (!params) return [];
  const names: string[] = [];
  for (const p of nkids(params)) {
    if (p.type !== 'parameter_declaration' && p.type !== 'optional_parameter_declaration'
      && p.type !== 'variadic_parameter_declaration') continue;
    if (p.type === 'parameter_declaration' && isVoidOnly(p)) continue;
    const id = declaratorIdentifier(p.childForFieldName('declarator'));
    if (id) names.push(id);
  }
  return names;
}

/** First identifier of a parameter declarator, descending pointer/reference wrappers. */
function declaratorIdentifier(decl: Node | null): string | null {
  let d = decl;
  while (d) {
    if (d.type === 'identifier') return d.text;
    const inner = d.childForFieldName('declarator');
    if (!inner) break;
    d = inner;
  }
  // Fallback: any identifier leaf within the declarator subtree.
  if (decl) {
    const id = nkids(decl).find((c) => c.type === 'identifier');
    if (id) return id.text;
  }
  return null;
}

/**
 * Best-effort call extraction: `call_expression` whose `function` is a plain
 * `identifier` (`foo()`) contributes that name; a `field_expression`
 * (`obj.m()` / `ptr->m()`) contributes its `field` field_identifier. Deduped.
 */
function collectCallSites(body: Node): CallSite[] {
  const sites: CallSite[] = [];
  const visit = (n: Node): void => {
    if (n.type === 'call_expression') {
      const fn = n.childForFieldName('function');
      if (fn?.type === 'identifier') {
        sites.push({ name: fn.text, line: lineOf(fn), member: false });
      } else if (fn?.type === 'field_expression') {
        const field = fn.childForFieldName('field');
        if (field) sites.push({ name: field.text, line: lineOf(field), member: true });
      }
    }
    for (const c of nkids(n)) visit(c);
  };
  visit(body);
  return sites;
}

// ── imports ──

/**
 * `#include <vector>` (system_lib_string) or `#include "engine.h"`
 * (string_literal). specifier = the path with `<>`/quotes stripped; named =
 * [basename without extension]. Includes name files/headers, not modules.
 */
function readInclude(node: Node, fromFile: string): ImportRecord | null {
  const pathNode = node.childForFieldName('path');
  if (!pathNode) return null;
  const specifier = stripInclude(pathNode.text);
  if (!specifier) return null;
  return { fromFile, line: lineOf(node), specifier, named: [basenameNoExt(specifier)], isTypeOnly: false };
}

/** Strip the surrounding `<...>` or `"..."` from an include path token. */
function stripInclude(s: string): string {
  return s.replace(/^[<"]/, '').replace(/[>"]$/, '');
}
