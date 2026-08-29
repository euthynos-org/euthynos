import { readFileSync } from 'node:fs';
import type { Node } from 'web-tree-sitter';
import type { DiscoveredFile } from '../discover.js';
import type { CallSite, ExportedSymbol, FunctionRecord, ImportRecord, ParsedFile, SymbolSpan } from '../types.js';
import { parseWith } from './treesitter/loader.js';
import {
  bodyHash, EMPTY_BODY, collectSymbolSpans, countCodeLines, deriveCalls, fieldText, lastSegment,
  lineOf, nkids, stripQuotes, totalLinesOf,
} from './treesitter/util.js';

/**
 * Go parser → the parser-agnostic `ParsedFile` shape.
 *
 * Public-surface convention: Go has no `export` keyword — visibility is the
 * case of the identifier's first letter. A Capitalized name is exported, a
 * lowercase one is package-private. So `func Foo` / `type Bar struct` are the
 * public surface; `func foo` is implementation. Methods (with a receiver) count
 * the same as functions. Requires the 'go' grammar pre-loaded via loadLanguages().
 */
export function parseGoFile(f: DiscoveredFile): ParsedFile {
  return parseGoSource(f.rel, f.module, f.isTest, readFileSync(f.abs, 'utf8'));
}

/** Node types collapsed to 'ID' in the body hash (rename-insensitive clones). */
const ID_TYPES = new Set(['identifier', 'field_identifier', 'type_identifier', 'package_identifier']);
/** Node types collapsed to 'LIT' in the body hash. */
const LIT_TYPES = new Set([
  'interpreted_string_literal', 'raw_string_literal', 'int_literal',
  'float_literal', 'rune_literal', 'imaginary_literal',
]);

/** Go visibility: exported iff the first letter is uppercase. */
const isExported = (name: string): boolean => /^[A-Z]/.test(name);

/**
 * `type_spec` covers every named type, so the kind comes from its `type` child:
 * `type F struct{}` is a class-like aggregate, `type R interface{}` an
 * interface, and everything else (aliases, defined primitives) a plain type.
 */
const SPAN_KINDS: Readonly<Record<string, (n: Node) => SymbolSpan['kind']>> = {
  type_spec: (n) => {
    const t = n.childForFieldName('type')?.type;
    return t === 'struct_type' ? 'class' : t === 'interface_type' ? 'interface' : 'type';
  },
};

export function parseGoSource(
  path: string,
  module: string,
  isTest: boolean,
  text: string,
): ParsedFile {
  const tree = parseWith('go', text);
  const root = tree.rootNode;

  const exports: ExportedSymbol[] = [];
  const imports: ImportRecord[] = [];
  const functions: FunctionRecord[] = [];
  let internalFunctions = 0;

  for (const stmt of nkids(root)) {
    if (stmt.type === 'function_declaration' || stmt.type === 'method_declaration') {
      const name = fieldText(stmt, 'name');
      const rec = fnRecord(name, stmt, path);
      functions.push(rec);
      if (rec.exported) exports.push(fnSymbol(name, stmt));
      else internalFunctions++;
    } else if (stmt.type === 'type_declaration') {
      for (const spec of nkids(stmt)) {
        if (spec.type !== 'type_spec') continue;
        const name = fieldText(spec, 'name');
        if (isExported(name)) {
          exports.push({ name, kind: 'type', requiredParams: 0, totalParams: 0 });
        }
      }
    } else if (stmt.type === 'import_declaration') {
      imports.push(...readImports(stmt, path));
    }
  }

  return {
    path,
    module,
    isTest,
    isIndex: false, // Go has no interface-file convention
    codeLines: countCodeLines(text, '//'),
    exports,
    internalFunctions,
    functions,
    imports,
    symbols: collectSymbolSpans(root, { kinds: SPAN_KINDS, exported: isExported }),
    totalLines: totalLinesOf(text),
  };
}

// ── functions / methods ──

function fnRecord(name: string, decl: Node, file: string): FunctionRecord {
  const params = decl.childForFieldName('parameters');
  const body = decl.childForFieldName('body');
  const { hash, tokens, literals, sketch, defHash } = body ? bodyHash(body, { idTypes: ID_TYPES, litTypes: LIT_TYPES }) : EMPTY_BODY;
  const names = params ? paramNames(params) : [];
  return {
    name,
    file,
    startLine: decl.startPosition.row + 1,
    endLine: decl.endPosition.row + 1,
    exported: isExported(name),
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

function fnSymbol(name: string, decl: Node): ExportedSymbol {
  const params = decl.childForFieldName('parameters');
  const total = params ? paramNames(params).length : 0;
  // Go has no default/optional params, so required === total.
  return { name, kind: 'function', requiredParams: total, totalParams: total };
}

/**
 * Identifier names across a parameter_list. A single parameter_declaration may
 * group several names sharing one type (`a, b int`) — those appear as multiple
 * `identifier` named children (the first via the `name` field, the rest bare),
 * so we collect every `identifier` under each declaration. Handles
 * variadic_parameter_declaration (`args ...T`) the same way.
 */
function paramNames(paramList: Node): string[] {
  const names: string[] = [];
  for (const decl of nkids(paramList)) {
    if (decl.type !== 'parameter_declaration' && decl.type !== 'variadic_parameter_declaration') continue;
    for (const child of nkids(decl)) {
      if (child.type === 'identifier') names.push(child.text);
    }
  }
  return names;
}

/**
 * `foo()` is a bare call; `x.Foo()` / `pkg.Foo()` is a selector, i.e. a member
 * call — Go's package-qualified calls are indistinguishable from method calls
 * at this level, and both need import evidence to resolve, so both are members.
 */
function collectCallSites(body: Node): CallSite[] {
  const sites: CallSite[] = [];
  const visit = (n: Node): void => {
    if (n.type === 'call_expression') {
      const fn = n.childForFieldName('function');
      if (fn?.type === 'identifier') {
        sites.push({ name: fn.text, line: lineOf(fn), member: false });
      } else if (fn?.type === 'selector_expression') {
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
 * An import_declaration holds either an import_spec_list (grouped
 * `import ( ... )`) or a single import_spec (`import "x"`). Each import_spec has
 * a `path` string and an optional alias `name`. We capture the module path with
 * quotes stripped; `named` is the last '/'-segment (or the alias if present).
 * Go import paths are module paths, not local files — captured, not resolved.
 */
function readImports(decl: Node, fromFile: string): ImportRecord[] {
  const records: ImportRecord[] = [];
  const addSpec = (spec: Node): void => {
    const pathNode = spec.childForFieldName('path');
    if (!pathNode) return;
    const specifier = stripQuotes(pathNode.text);
    const alias = spec.childForFieldName('name')?.text;
    records.push({
      fromFile,
      line: lineOf(spec),
      specifier,
      named: [alias ?? lastSegment(specifier, '/')],
      isTypeOnly: false,
    });
  };
  for (const child of nkids(decl)) {
    if (child.type === 'import_spec') addSpec(child);
    else if (child.type === 'import_spec_list') {
      for (const spec of nkids(child)) {
        if (spec.type === 'import_spec') addSpec(spec);
      }
    }
  }
  return records;
}

