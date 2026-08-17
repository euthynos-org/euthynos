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
    symbols: collectSymbolSpans(root, { kinds: SPAN_KINDS, exported: (_n, node) => isPublic(node) }),
    totalLines: totalLinesOf(text),
  };
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
  const { hash, tokens, literals, sketch } = body ? bodyHash(body, { idTypes: ID_TYPES, litTypes: LIT_TYPES }) : EMPTY_BODY;
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
    ...deriveCalls(body ? collectCallSites(body) : []),
  };
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
