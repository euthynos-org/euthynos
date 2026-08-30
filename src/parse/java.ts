import { readFileSync } from 'node:fs';
import type { Node } from 'web-tree-sitter';
import type { DiscoveredFile } from '../discover.js';
import type { CallSite, ExportedSymbol, FunctionRecord, ImportRecord, ParsedFile, SymbolSpan } from '../types.js';
import { parseWith } from './treesitter/loader.js';
import {
  bodyHash, EMPTY_BODY, ckids, collectSymbolSpans, countCodeLines, deriveCalls, endLineOf, fieldText,
  lastSegment, lineOf, nkids, totalLinesOf, walkNamed,
} from './treesitter/util.js';

/**
 * Java parser → the parser-agnostic `ParsedFile` shape.
 *
 * Public-surface convention: Java has no top-level functions, only classes with
 * members. A member or type is part of the public interface iff its `modifiers`
 * include `public` (no modifiers = package-private = internal). Methods and
 * constructors are all collected as functions; only `public` ones are exports.
 * Imports are dotted FQNs (java.util.List) captured verbatim — no local module
 * resolution, since Java imports name packages, not files. Requires the 'java'
 * grammar to be pre-loaded via loadLanguages().
 */
export function parseJavaFile(f: DiscoveredFile): ParsedFile {
  return parseJavaSource(f.rel, f.module, f.isTest, readFileSync(f.abs, 'utf8'));
}

/** Identifier-like leaves collapsed to 'ID' for rename-insensitive clone hashing. */
const ID_TYPES = new Set(['identifier', 'type_identifier']);
/** Literal leaves collapsed to 'LIT'. */
const LIT_TYPES = new Set([
  'string_literal',
  'decimal_integer_literal',
  'hex_integer_literal',
  'octal_integer_literal',
  'decimal_floating_point_literal',
  'character_literal',
  'true',
  'false',
  'null_literal',
]);

const TYPE_DECLS = new Set(['class_declaration', 'interface_declaration', 'enum_declaration']);
const METHOD_DECLS = new Set(['method_declaration', 'constructor_declaration']);

/** Declaration spans for the outline. Records are classes; `@interface` is an interface. */
const SPAN_KINDS: Readonly<Record<string, SymbolSpan['kind']>> = {
  class_declaration: 'class',
  record_declaration: 'class',
  interface_declaration: 'interface',
  annotation_type_declaration: 'interface',
  enum_declaration: 'enum',
};

export function parseJavaSource(
  path: string,
  module: string,
  isTest: boolean,
  text: string,
): ParsedFile {
  const tree = parseWith('java', text);
  const root = tree.rootNode;

  const exports: ExportedSymbol[] = [];
  const imports: ImportRecord[] = [];
  let internalFunctions = 0;

  // Top-level imports and type declarations.
  for (const node of nkids(root)) {
    if (node.type === 'import_declaration') {
      const rec = readImport(node, path);
      if (rec) imports.push(rec);
    } else if (TYPE_DECLS.has(node.type)) {
      collectTypeExports(node, exports);
    }
  }

  // Count internal (non-public) methods/constructors across the whole file.
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
    symbols: [
      ...collectSymbolSpans(root, { kinds: SPAN_KINDS, exported: (_n, node) => isPublic(node) }),
      ...collectEnumConstants(root),
    ],
    totalLines: totalLinesOf(text),
  };
}

/**
 * Enum constants as `const` symbols, so `find_references` can locate the
 * DEFINITION of `P8_DOC_ID` (the enclosing enum's TYPE is already a symbol, but
 * the constant was invisible). Exported iff the enclosing enum is public.
 */
function collectEnumConstants(root: Node): SymbolSpan[] {
  const out: SymbolSpan[] = [];
  walkNamed(root, (n) => {
    if (n.type !== 'enum_declaration') return;
    const exported = isPublic(n);
    const body = n.childForFieldName('body');
    if (!body) return;
    for (const c of nkids(body)) {
      if (c.type !== 'enum_constant') continue;
      const name = c.childForFieldName('name')?.text;
      if (!name) continue;
      out.push({ name, kind: 'const', startLine: lineOf(c), endLine: endLineOf(c), exported });
    }
  });
  return out;
}

// ── exports / symbols ──

/**
 * A declaration is exported iff its `modifiers` child text contains the
 * `public` keyword. Missing modifiers ⇒ package-private ⇒ not exported.
 *
 * Grammar note: `modifiers` is a positional named child (always first when
 * present), NOT a field — `childForFieldName('modifiers')` returns null. So we
 * locate it by node type.
 */
function isPublic(node: Node): boolean {
  const mods = nkids(node).find((c) => c.type === 'modifiers');
  return mods != null && /\bpublic\b/.test(mods.text);
}

/**
 * Walk a type declaration's body: emit the type itself (if public) as a 'class'
 * symbol, plus each public method as a 'function' symbol. Recurses into nested
 * type declarations so inner public classes/methods surface too.
 */
function collectTypeExports(typeNode: Node, out: ExportedSymbol[]): void {
  if (isPublic(typeNode)) {
    out.push({ name: typeName(typeNode), kind: 'class', requiredParams: 0, totalParams: 0 });
  }
  const body = typeNode.childForFieldName('body');
  if (!body) return;
  for (const member of nkids(body)) {
    if (member.type === 'method_declaration' && isPublic(member)) {
      const total = countParams(member.childForFieldName('parameters'));
      out.push({ name: methodName(member), kind: 'function', requiredParams: total, totalParams: total });
    } else if (TYPE_DECLS.has(member.type)) {
      collectTypeExports(member, out);
    }
  }
}

function typeName(typeNode: Node): string {
  return fieldText(typeNode, 'name');
}

/** Method name via the `name` field; constructors fall back to a stable label. */
function methodName(node: Node): string {
  const name = node.childForFieldName('name');
  if (name) return name.text;
  return '(constructor)';
}

// ── functions ──

function fnRecord(node: Node, file: string): FunctionRecord {
  const params = node.childForFieldName('parameters');
  const body = node.childForFieldName('body');
  const { hash, tokens, literals, sketch, defHash } = body ? bodyHash(body, { idTypes: ID_TYPES, litTypes: LIT_TYPES }) : EMPTY_BODY;
  const typed = body ? collectTypedCalls(node, body) : [];
  const enclosing = enclosingTypeName(node);
  return {
    name: methodName(node),
    file,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    exported: isPublic(node),
    paramCount: countParams(params),
    paramNames: paramNames(params),
    bodyHash: hash,
    bodyTokens: tokens,
    ...(literals === undefined ? {} : { literalHash: literals }),
    ...(sketch === undefined ? {} : { ngramSketch: sketch }),
    ...(defHash === undefined ? {} : { defHash }),
    ...(enclosing === undefined ? {} : { enclosingType: enclosing }),
    ...deriveCalls(body ? collectCallSites(body) : []),
    ...(typed.length > 0 ? { typedCalls: typed } : {}),
    ...(() => {
      const refs = body ? collectFieldRefs(body) : [];
      return refs.length > 0 ? { fieldRefs: refs } : {};
    })(),
  };
}

/**
 * Non-call member accesses `X.Y` (`DedupKeyMode.P8_DOC_ID`, `obj.field`) as
 * occurrences of Y. A `field_access` node is a member access that is NOT a call
 * (method calls are `method_invocation`), so this never double-counts a call.
 * Deduped by name+line.
 */
function collectFieldRefs(body: Node): CallSite[] {
  const out: CallSite[] = [];
  const seen = new Set<string>();
  walkNamed(body, (n) => {
    if (n.type !== 'field_access') return;
    const field = n.childForFieldName('field');
    if (!field) return;
    const key = `${field.text}|${lineOf(field)}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name: field.text, line: lineOf(field), member: true });
  });
  return out;
}

/** The class/interface/enum whose body immediately contains this method. */
function enclosingTypeName(node: Node): string | undefined {
  let anc: Node | null = node.parent;
  while (anc && anc.type !== 'class_body' && anc.type !== 'interface_body' && anc.type !== 'enum_body') anc = anc.parent;
  const decl = anc?.parent; // *_body's parent is the *_declaration
  const name = decl?.childForFieldName('name')?.text;
  return name ?? undefined;
}

/** Simple type name from a Java type node: strip generics, package, array. Returns
 * null for primitives and shapes we can't name (so the resolver never guesses). */
function simpleTypeName(t: Node | null): string | null {
  if (!t) return null;
  let n: Node = t;
  if (n.type === 'array_type') {
    const el = n.childForFieldName('element');
    if (el) n = el;
  }
  if (n.type === 'generic_type') {
    const id = nkids(n).find((c) => c.type === 'type_identifier' || c.type === 'scoped_type_identifier');
    if (id) n = id;
  }
  if (n.type === 'scoped_type_identifier') return lastSegment(n.text, '.');
  if (n.type === 'type_identifier') return n.text;
  return null; // primitive (int/boolean) or unknown → no receiver type
}

/**
 * Receiver-typed member calls in a method body. Builds a var→type map from the
 * enclosing class's FIELDS, the method's PARAMETERS, and body LOCAL declarations
 * (including `var x = new Foo()`), then records each `recv.method()` /
 * `this.field.method()` / `new Foo().method()` whose receiver type is known. The
 * type is DECLARED, never inferred by name — an unknown/external receiver type
 * yields nothing, so no phantom edge is possible.
 */
function collectTypedCalls(methodNode: Node, body: Node): { method: string; type: string }[] {
  const varType = new Map<string, string>();
  // A name declared with two or more DIFFERENT types across the method (reused in
  // disjoint blocks, or a block-local shadowing a field of another type) cannot be
  // typed at a call site without block-scope tracking, so it is dropped entirely —
  // decline to type it rather than attribute the wrong declaration's type.
  const ambiguous = new Set<string>();
  const note = (name: string | undefined, tn: string | null): void => {
    if (!name || !tn) return;
    const prev = varType.get(name);
    if (prev !== undefined && prev !== tn) ambiguous.add(name);
    varType.set(name, tn); // last-seen; corrected below once ambiguity is known
  };
  // Fields are the weakest binding: a same-named parameter or local shadows the
  // field in Java. We seed fields first, then params/locals; any name that ends up
  // with conflicting types is removed after collection.
  const putField = note;
  const putLocal = note;

  // Enclosing class/interface/enum fields (weakest).
  let anc: Node | null = methodNode.parent;
  while (anc && anc.type !== 'class_body' && anc.type !== 'interface_body' && anc.type !== 'enum_body') anc = anc.parent;
  if (anc) {
    for (const m of nkids(anc)) {
      if (m.type !== 'field_declaration') continue;
      const tn = simpleTypeName(m.childForFieldName('type'));
      for (const d of nkids(m)) if (d.type === 'variable_declarator') putField(d.childForFieldName('name')?.text, tn);
    }
  }
  // Parameters and locals shadow fields.
  const params = methodNode.childForFieldName('parameters');
  if (params) {
    for (const p of nkids(params)) {
      if (p.type === 'formal_parameter') putLocal(p.childForFieldName('name')?.text, simpleTypeName(p.childForFieldName('type')));
    }
  }
  // Local declarations (walk the whole body; `var x = new Foo()` infers Foo).
  walkNamed(body, (n) => {
    if (n.type !== 'local_variable_declaration') return;
    const typeNode = n.childForFieldName('type');
    const declared = simpleTypeName(typeNode);
    for (const d of nkids(n)) {
      if (d.type !== 'variable_declarator') continue;
      let tn = declared;
      if (typeNode?.text === 'var') {
        const val = d.childForFieldName('value');
        if (val?.type === 'object_creation_expression') tn = simpleTypeName(val.childForFieldName('type'));
      }
      putLocal(d.childForFieldName('name')?.text, tn);
    }
  });
  for (const n of ambiguous) varType.delete(n); // conflicting types → untyped, no guess

  const out: { method: string; type: string }[] = [];
  const seen = new Set<string>();
  walkNamed(body, (n) => {
    if (n.type !== 'method_invocation') return;
    const obj = n.childForFieldName('object');
    const nameNode = n.childForFieldName('name');
    if (!obj || !nameNode) return;
    let type: string | null = null;
    if (obj.type === 'identifier') type = varType.get(obj.text) ?? null;
    else if (obj.type === 'object_creation_expression') type = simpleTypeName(obj.childForFieldName('type'));
    else if (obj.type === 'field_access') {
      // this.field.method() — resolve the field's declared type.
      const inner = obj.childForFieldName('object');
      const fieldName = obj.childForFieldName('field')?.text;
      if (inner?.type === 'this' && fieldName) type = varType.get(fieldName) ?? null;
    }
    if (!type) return;
    const method = nameNode.text;
    const key = `${method}|${type}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ method, type });
    }
  });
  return out;
}

/** Count formal + spread parameters. Java has no default params ⇒ required === total. */
function countParams(params: Node | null): number {
  if (!params) return 0;
  let n = 0;
  for (const p of nkids(params)) {
    if (p.type === 'formal_parameter' || p.type === 'spread_parameter') n++;
  }
  return n;
}

function paramNames(params: Node | null): string[] {
  if (!params) return [];
  const names: string[] = [];
  for (const p of nkids(params)) {
    if (p.type === 'formal_parameter') {
      const id = p.childForFieldName('name');
      if (id) names.push(id.text);
    } else if (p.type === 'spread_parameter') {
      // (spread_parameter (type) (variable_declarator name: (identifier)))
      const decl = nkids(p).find((c) => c.type === 'variable_declarator');
      const id = decl?.childForFieldName('name');
      if (id) names.push(id.text);
    }
  }
  return names;
}

/**
 * Best-effort call extraction: method invocations contribute their `name`,
 * `new X()` expressions contribute the constructed type's identifier.
 *
 * `x.foo()` carries an `object` field and counts as a MEMBER call; a bare
 * `foo()` inside the same class does not. Constructors are never member calls —
 * `new X()` names the type unambiguously.
 */
function collectCallSites(body: Node): CallSite[] {
  const sites: CallSite[] = [];
  walkNamed(body, (n) => {
    if (n.type === 'method_invocation') {
      const name = n.childForFieldName('name');
      if (name) sites.push({ name: name.text, line: lineOf(name), member: n.childForFieldName('object') != null });
    } else if (n.type === 'object_creation_expression') {
      const t = n.childForFieldName('type');
      if (t?.type === 'type_identifier') sites.push({ name: t.text, line: lineOf(t), member: false });
      else if (t) {
        // Generic / qualified types: grab the first type_identifier leaf.
        const id = nkids(t).find((c) => c.type === 'type_identifier');
        sites.push({ name: id ? id.text : t.text, line: lineOf(id ?? t), member: false });
      }
    }
  });
  return sites;
}

// ── imports ──

/**
 * `import a.b.C;` (and `import static a.b.C.m;`) → the scoped_identifier text is
 * the dotted FQN. specifier = FQN; named = last dotted segment. Wildcard imports
 * (`import a.b.*;`) keep '*' as the named binding.
 */
function readImport(node: Node, fromFile: string): ImportRecord | null {
  const scoped = nkids(node).find((c) => c.type === 'scoped_identifier' || c.type === 'identifier');
  if (!scoped) return null;
  const fqn = scoped.text;
  // `import a.b.*;` has an asterisk child after the scoped_identifier.
  const isWildcard = ckids(node).some((c) => c.type === 'asterisk' || c.text === '*');
  const named = isWildcard ? '*' : lastSegment(fqn, '.');
  return { fromFile, line: lineOf(node), specifier: fqn, named: [named], isTypeOnly: false };
}
