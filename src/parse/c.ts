import { readFileSync } from 'node:fs';
import type { Node } from 'web-tree-sitter';
import type { DiscoveredFile } from '../discover.js';
import type { CallSite, ExportedSymbol, FunctionRecord, ImportRecord, ParsedFile, SymbolSpan } from '../types.js';
import { parseWith } from './treesitter/loader.js';
import {
  basenameNoExt, bodyHash, EMPTY_BODY, ckids, collectSymbolSpans, countCodeLines, deriveCalls,
  lineOf, nkids, totalLinesOf,
} from './treesitter/util.js';

/**
 * C parser → the parser-agnostic `ParsedFile` shape.
 *
 * Public-surface convention: C has no `export` keyword — visibility is linkage.
 * A `function_definition` carrying a `static` storage_class_specifier has
 * internal linkage (file-private); anything else is externally linkable, i.e.
 * the public surface. So `int add(...)` is public, `static int helper(...)` is
 * implementation. Top-level struct/union/enum (named) and typedefs form the
 * public type surface. Requires the 'c' grammar pre-loaded via loadLanguages().
 */
export function parseCFile(f: DiscoveredFile): ParsedFile {
  return parseCSource(f.rel, f.module, f.isTest, readFileSync(f.abs, 'utf8'));
}

/** Node types collapsed to 'ID' in the body hash (rename-insensitive clones). */
const ID_TYPES = new Set(['identifier', 'field_identifier', 'type_identifier']);
/** Node types collapsed to 'LIT' in the body hash. */
const LIT_TYPES = new Set([
  'number_literal', 'string_literal', 'char_literal', 'concatenated_string',
  'true', 'false',
]);

/** Aggregates and typedefs — C's whole named-type surface. */
const SPAN_KINDS: Readonly<Record<string, SymbolSpan['kind']>> = {
  struct_specifier: 'class',
  union_specifier: 'class',
  enum_specifier: 'enum',
  type_definition: 'type',
};

/** A typedef names its type through the declarator, not a `name` field. */
const spanName = (n: Node): string | undefined =>
  n.type === 'type_definition' ? typedefName(n) ?? undefined : n.childForFieldName('name')?.text;

export function parseCSource(
  path: string,
  module: string,
  isTest: boolean,
  text: string,
): ParsedFile {
  const tree = parseWith('c', text);
  const root = tree.rootNode;

  const exports: ExportedSymbol[] = [];
  const imports: ImportRecord[] = [];
  const functions: FunctionRecord[] = [];
  let internalFunctions = 0;

  for (const stmt of nkids(root)) {
    if (stmt.type === 'function_definition') {
      const rec = fnRecord(stmt, path);
      if (!rec) continue; // malformed / abstract declarator with no name
      functions.push(rec);
      if (rec.exported) {
        exports.push({
          name: rec.name,
          kind: 'function',
          // C has no default/optional params, so required === total.
          requiredParams: rec.paramCount,
          totalParams: rec.paramCount,
        });
      } else {
        internalFunctions++;
      }
    } else if (
      stmt.type === 'struct_specifier' ||
      stmt.type === 'union_specifier' ||
      stmt.type === 'enum_specifier'
    ) {
      // A bare top-level struct/union/enum *with* a name is a public type.
      const name = stmt.childForFieldName('name');
      if (name) exports.push({ name: name.text, kind: 'type', requiredParams: 0, totalParams: 0 });
    } else if (stmt.type === 'type_definition') {
      // typedef: the *declarator* identifier is the new public type name.
      // (The `type:` may itself be a named struct_specifier, but that inner
      // name is the tag, not the typedef name — we take the declarator.)
      const decl = typedefName(stmt);
      if (decl) exports.push({ name: decl, kind: 'type', requiredParams: 0, totalParams: 0 });
    } else if (stmt.type === 'preproc_include') {
      const imp = readInclude(stmt, path);
      if (imp) imports.push(imp);
    }
  }

  return {
    path,
    module,
    isTest,
    isIndex: false, // C has no interface/index-file convention
    codeLines: countCodeLines(text, '//'),
    exports,
    internalFunctions,
    functions,
    imports,
    // C types have no visibility keyword: a named type in a translation unit
    // is reachable by anything that includes it.
    symbols: collectSymbolSpans(root, { kinds: SPAN_KINDS, name: spanName, exported: () => true }),
    totalLines: totalLinesOf(text),
  };
}

// ── functions ──

/** `static` linkage ⇒ file-private. Checked against direct children only. */
function isStatic(fn: Node): boolean {
  return ckids(fn).some((c) => c.type === 'storage_class_specifier' && c.text === 'static');
}

/**
 * The `declarator` of a function_definition is a `function_declarator`, but for
 * pointer-returning functions (`int *foo()`) it's wrapped in one or more
 * `pointer_declarator`s. Descend through those wrappers to the function_declarator.
 */
function findFunctionDeclarator(decl: Node | null): Node | null {
  let cur = decl;
  while (cur && cur.type === 'pointer_declarator') {
    cur = cur.childForFieldName('declarator');
  }
  return cur && cur.type === 'function_declarator' ? cur : null;
}

function fnRecord(fn: Node, file: string): FunctionRecord | null {
  const fdecl = findFunctionDeclarator(fn.childForFieldName('declarator'));
  if (!fdecl) return null;
  const nameNode = fdecl.childForFieldName('declarator');
  if (!nameNode) return null;
  const name = nameNode.text;

  const paramList = fdecl.childForFieldName('parameters');
  const names = paramList ? paramNames(paramList) : [];
  const body = fn.childForFieldName('body');
  const { hash, tokens, literals, sketch, defHash } = body
    ? bodyHash(body, { idTypes: ID_TYPES, litTypes: LIT_TYPES })
    : EMPTY_BODY;

  return {
    name,
    file,
    startLine: fn.startPosition.row + 1,
    endLine: fn.endPosition.row + 1,
    exported: !isStatic(fn),
    paramCount: names.length,
    paramNames: names,
    bodyHash: hash,
    bodyTokens: tokens,
    ...(literals === undefined ? {} : { literalHash: literals }),
    ...(sketch === undefined ? {} : { ngramSketch: sketch }),
    ...(defHash === undefined ? {} : { defHash }),
    ...deriveCalls(body ? collectCallSites(body) : []),
  };
}

/**
 * Parameter names across a parameter_list. Each `parameter_declaration` is one
 * param; its name is the declarator identifier, which may be wrapped in
 * `pointer_declarator`(s) for pointer params (`char *name`). The special case
 * `f(void)` is a single parameter_declaration whose type is `void` with NO
 * declarator → that's zero params, so we skip declarator-less declarations.
 * Unnamed params (`int f(int)`) are likewise declarator-less and skipped.
 */
function paramNames(paramList: Node): string[] {
  const names: string[] = [];
  for (const decl of nkids(paramList)) {
    if (decl.type !== 'parameter_declaration') continue;
    const id = declaratorIdentifier(decl.childForFieldName('declarator'));
    if (id) names.push(id);
  }
  return names;
}

/** Descend through pointer_declarator wrappers to the underlying identifier. */
function declaratorIdentifier(decl: Node | null): string | null {
  let cur = decl;
  while (cur && cur.type === 'pointer_declarator') {
    cur = cur.childForFieldName('declarator');
  }
  return cur && cur.type === 'identifier' ? cur.text : null;
}

/**
 * Calls invoked in a body. `call_expression.function` is either a plain
 * `identifier` (`foo()`) or a `field_expression` for member/arrow calls
 * (`obj.m()`, `ptr->m()`) — in which case the called name is its `field`
 * field_identifier. Deduped.
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

// ── typedefs ──

/**
 * The new type name of a `type_definition`. Normally a single `type_identifier`
 * declarator; can be wrapped in pointer_declarator (`typedef struct S *SPtr`).
 */
function typedefName(td: Node): string | null {
  const decl = td.childForFieldName('declarator');
  let cur = decl;
  while (cur && cur.type === 'pointer_declarator') {
    cur = cur.childForFieldName('declarator');
  }
  return cur && cur.type === 'type_identifier' ? cur.text : null;
}

// ── imports ──

/**
 * A `#include` directive. The `path` field is a `system_lib_string`
 * (`<stdio.h>`) or a `string_literal` (`"util.h"`). We strip the delimiters for
 * the specifier and use the basename-without-extension as the single `named`
 * binding. C includes are header references, not resolved here. isTypeOnly false.
 */
function readInclude(inc: Node, fromFile: string): ImportRecord | null {
  const pathNode = inc.childForFieldName('path');
  if (!pathNode) return null;
  const specifier = stripDelims(pathNode.text);
  return {
    fromFile,
    line: lineOf(inc),
    specifier,
    named: [basenameNoExt(specifier)],
    isTypeOnly: false,
  };
}

// ── helpers ──

/** Strip surrounding <…> or "…" delimiters from an include path. */
function stripDelims(s: string): string {
  return s.replace(/^[<"]|[>"]$/g, '');
}
