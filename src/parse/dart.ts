import { readFileSync } from 'node:fs';
import type { Node } from 'web-tree-sitter';
import type { DiscoveredFile } from '../discover.js';
import type { CallSite, ExportedSymbol, FunctionRecord, ImportRecord, ParsedFile, SymbolSpan } from '../types.js';
import { parseWith } from './treesitter/loader.js';
import {
  bodyHash, EMPTY_BODY, collectSymbolSpans, countCodeLines, deriveCalls, lineOf, nkids,
  stripQuotes, totalLinesOf,
} from './treesitter/util.js';

/**
 * Dart parser → the parser-agnostic `ParsedFile` shape.
 *
 * Public-surface convention: Dart has no access keywords — a name beginning
 * with `_` is library-private (implementation); everything else is exported.
 * So `int computeFee(...)` / `class Engine` are the public surface; `_helper`
 * is internal. Requires the 'dart' grammar pre-loaded via loadLanguages().
 *
 * STRUCTURAL QUIRK: in tree-sitter-dart a function/method is TWO sibling nodes —
 * a `function_signature` (top level) or `method_signature` (in a class, wrapping
 * a `function_signature`), IMMEDIATELY FOLLOWED BY a separate `function_body`
 * sibling. Abstract methods appear as a bare `declaration(function_signature)`
 * with NO following body. We pair each signature with the next `function_body`
 * sibling to recover the body hash, call edges, and the real endLine.
 */
export function parseDartFile(f: DiscoveredFile): ParsedFile {
  return parseDartSource(f.rel, f.module, f.isTest, readFileSync(f.abs, 'utf8'));
}

/** Node types collapsed to 'ID' in the body hash (rename-insensitive clones). */
const ID_TYPES = new Set(['identifier', 'type_identifier']);
/** Node types collapsed to 'LIT' in the body hash. */
const LIT_TYPES = new Set([
  'decimal_integer_literal', 'decimal_floating_point_literal',
  'string_literal', 'true', 'false', 'null_literal',
]);

/** Dart visibility: a leading underscore means library-private. */
const isExported = (name: string): boolean => !name.startsWith('_');

/** A mixin is a reusable contract, so it takes the interface slot. */
const SPAN_KINDS: Readonly<Record<string, SymbolSpan['kind']>> = {
  class_definition: 'class',
  enum_declaration: 'enum',
  mixin_declaration: 'interface',
  extension_declaration: 'class',
};

export function parseDartSource(
  path: string,
  module: string,
  isTest: boolean,
  text: string,
): ParsedFile {
  const tree = parseWith('dart', text);
  const root = tree.rootNode;

  const exports: ExportedSymbol[] = [];
  const imports: ImportRecord[] = [];
  const functions: FunctionRecord[] = [];
  let internalFunctions = 0;

  const kids = nkids(root);
  for (let i = 0; i < kids.length; i++) {
    const node = kids[i]!;

    if (node.type === 'function_signature') {
      const body = nextBody(kids, i);
      const name = signatureName(node);
      const rec = fnRecord(name, node, body, path);
      functions.push(rec);
      if (rec.exported) exports.push(fnSymbol(name, node));
      else internalFunctions++;
    } else if (node.type === 'class_definition') {
      const name = fieldText(node, 'name');
      if (isExported(name)) exports.push(classSymbol(name, node));
      else internalFunctions++;
      collectClassMethods(node, path, functions);
    } else if (node.type === 'import_or_export') {
      const imp = readImport(node, path);
      if (imp) imports.push(imp);
    }
  }

  return {
    path,
    module,
    isTest,
    isIndex: false, // Dart has no interface-file convention
    codeLines: countCodeLines(text, '//'),
    exports,
    internalFunctions,
    functions,
    imports,
    symbols: collectSymbolSpans(root, { kinds: SPAN_KINDS, exported: isExported }),
    totalLines: totalLinesOf(text),
  };
}

// ── signature / body pairing ──

/** Scan forward from index i for the immediately-following `function_body` sibling. */
function nextBody(siblings: Node[], i: number): Node | null {
  const next = siblings[i + 1];
  return next && next.type === 'function_body' ? next : null;
}

/**
 * A `method_signature` wraps a `function_signature`; a `function_signature` is
 * itself. Either way the name lives on the inner `function_signature`'s `name`
 * field. Returns the identifier text, or '(anon)'.
 */
function signatureName(sig: Node): string {
  const fnSig = sig.type === 'method_signature'
    ? nkids(sig).find((n) => n.type === 'function_signature') ?? sig
    : sig;
  return fnSig.childForFieldName('name')?.text ?? '(anon)';
}

/** The inner `function_signature` (unwrapping a `method_signature`). */
function innerSignature(sig: Node): Node {
  if (sig.type === 'method_signature') {
    return nkids(sig).find((n) => n.type === 'function_signature') ?? sig;
  }
  return sig;
}

// ── classes ──

function classSymbol(name: string, classNode: Node): ExportedSymbol {
  // Construction surface ≈ the constructor's params (the public way to build it).
  const body = classNode.childForFieldName('body');
  let total = 0;
  if (body) {
    for (const member of nkids(body)) {
      const ctor = constructorOf(member);
      if (ctor) {
        const params = ctor.childForFieldName('parameters');
        total = params ? countParams(params).total : 0;
        break;
      }
    }
  }
  // Constructors have no optional-default surface we distinguish here → required = total.
  return { name, kind: 'class', requiredParams: total, totalParams: total };
}

/** A `declaration` directly containing a `constructor_signature`, or null. */
function constructorOf(member: Node): Node | null {
  if (member.type !== 'declaration') return null;
  return nkids(member).find((n) => n.type === 'constructor_signature') ?? null;
}

/**
 * Collect methods in a class_body, pairing each `method_signature` (or a bare
 * `declaration(function_signature)` for abstract methods) with the next
 * `function_body` sibling. Skips constructors, fields, and getters/setters that
 * carry no `function_signature`.
 */
function collectClassMethods(classNode: Node, file: string, out: FunctionRecord[]): void {
  const body = classNode.childForFieldName('body');
  if (!body) return;
  const members = nkids(body);
  for (let i = 0; i < members.length; i++) {
    const m = members[i]!;
    let sig: Node | null = null;
    if (m.type === 'method_signature') {
      sig = m;
    } else if (m.type === 'declaration') {
      // Abstract method: declaration wrapping a function_signature (no body).
      // Unwrap to the function_signature; skip constructors and fields (no
      // function_signature child).
      const fnSig = nkids(m).find((n) => n.type === 'function_signature');
      if (fnSig && !nkids(m).some((n) => n.type === 'constructor_signature')) sig = fnSig;
    }
    if (!sig) continue;
    const bodyNode = nextBody(members, i);
    const name = signatureName(sig);
    out.push(fnRecord(name, sig, bodyNode, file));
  }
}

// ── function records ──

function fnRecord(name: string, sig: Node, body: Node | null, file: string): FunctionRecord {
  const fnSig = innerSignature(sig);
  const params = fnSig.childForFieldName('parameters')
    ?? nkids(fnSig).find((n) => n.type === 'formal_parameter_list')
    ?? null;
  const { hash, tokens, literals, sketch } = body
    ? bodyHash(body, { idTypes: ID_TYPES, litTypes: LIT_TYPES })
    : EMPTY_BODY;
  const names = params ? paramNames(params) : [];
  return {
    name,
    file,
    startLine: sig.startPosition.row + 1,
    endLine: (body ?? sig).endPosition.row + 1,
    exported: isExported(name),
    paramCount: names.length,
    paramNames: names,
    bodyHash: hash,
    bodyTokens: tokens,
    ...(literals === undefined ? {} : { literalHash: literals }),
    ...(sketch === undefined ? {} : { ngramSketch: sketch }),
    ...deriveCalls(body ? collectCallSites(body) : []),
  };
}

function fnSymbol(name: string, sig: Node): ExportedSymbol {
  const fnSig = innerSignature(sig);
  const params = fnSig.childForFieldName('parameters')
    ?? nkids(fnSig).find((n) => n.type === 'formal_parameter_list')
    ?? null;
  const p = params ? countParams(params) : { required: 0, total: 0 };
  return { name, kind: 'function', requiredParams: p.required, totalParams: p.total };
}

// ── params ──

/**
 * `formal_parameter_list` holds required `formal_parameter`s directly, plus an
 * `optional_formal_parameters` (named `{...}`) and/or
 * `optional_positional_parameter_list` (`[...]`) wrapper whose inner
 * `formal_parameter`s are optional. requiredParams = formal_parameters directly
 * in the list; totalParams adds the ones nested in optional wrappers.
 */
function countParams(list: Node): { required: number; total: number } {
  let required = 0, total = 0;
  for (const child of nkids(list)) {
    if (child.type === 'formal_parameter') {
      required++; total++;
    } else if (
      child.type === 'optional_formal_parameters' ||
      child.type === 'optional_positional_parameter_list'
    ) {
      for (const inner of nkids(child)) {
        if (inner.type === 'formal_parameter') total++;
      }
    }
  }
  return { required, total };
}

/** Parameter names in declaration order, including the required + optional groups. */
function paramNames(list: Node): string[] {
  const names: string[] = [];
  const pushName = (fp: Node): void => {
    const named = fp.childForFieldName('name');
    if (named) { names.push(named.text); return; }
    // `this.rate` → constructor_param(this)(identifier): take the last identifier.
    const ids = nkids(fp).flatMap((n) =>
      n.type === 'identifier' ? [n]
        : n.type === 'constructor_param' ? nkids(n).filter((g) => g.type === 'identifier')
        : []);
    const last = ids[ids.length - 1];
    if (last) names.push(last.text);
  };
  for (const child of nkids(list)) {
    if (child.type === 'formal_parameter') pushName(child);
    else if (
      child.type === 'optional_formal_parameters' ||
      child.type === 'optional_positional_parameter_list'
    ) {
      for (const inner of nkids(child)) {
        if (inner.type === 'formal_parameter') pushName(inner);
      }
    }
  }
  return names;
}

// ── calls ──

/**
 * Dart calls surface as an `identifier` (or a navigation segment) IMMEDIATELY
 * FOLLOWED BY a `selector` containing an `argument_part`. We walk named nodes and,
 * for every selector-with-argument_part, inspect its previous named sibling:
 *   - a bare `identifier`  → that's the callee  (`foo()`, `_helper(x)`)
 *   - a `selector` carrying an (un)conditional_assignable_selector → the callee
 *     is the identifier inside it (`obj.method()`, `this.other()`, `a.b().c()`)
 * Nested calls (`g(h(a))`) are caught because the walk recurses into arguments.
 * Deduped.
 */
function collectCallSites(body: Node): CallSite[] {
  const sites: CallSite[] = [];
  const visit = (n: Node): void => {
    const kids = nkids(n);
    for (let i = 0; i < kids.length; i++) {
      const k = kids[i]!;
      if (k.type === 'selector' && nkids(k).some((g) => g.type === 'argument_part')) {
        const prev = kids[i - 1];
        if (prev) {
          if (prev.type === 'identifier') {
            sites.push({ name: prev.text, line: lineOf(prev), member: false });
          } else if (prev.type === 'selector') {
            const navSel = nkids(prev).find(
              (g) => g.type === 'unconditional_assignable_selector' ||
                     g.type === 'conditional_assignable_selector',
            );
            const id = navSel ? nkids(navSel).find((g) => g.type === 'identifier') : undefined;
            if (id) sites.push({ name: id.text, line: lineOf(id), member: true });
          }
        }
      }
    }
    for (const c of kids) visit(c);
  };
  visit(body);
  return sites;
}

// ── imports ──

/**
 * `import_or_export → library_import → import_specification → configurable_uri →
 * uri → string_literal`. We extract the URI string (quotes stripped). The
 * specifier is kept verbatim — relative `../x.dart` so the resolver can map it,
 * `dart:`/`package:` captured as-is. `named` = the basename without `.dart`.
 */
function readImport(node: Node, fromFile: string): ImportRecord | null {
  const str = findFirst(node, 'string_literal');
  if (!str) return null;
  const specifier = stripQuotes(str.text);
  if (!specifier) return null;
  return { fromFile, line: lineOf(node), specifier, named: [basename(specifier)], isTypeOnly: false };
}

/** First descendant of a given type (depth-first). */
function findFirst(node: Node, type: string): Node | null {
  for (const c of nkids(node)) {
    if (c.type === type) return c;
    const found = findFirst(c, type);
    if (found) return found;
  }
  return null;
}

// ── helpers ──

function fieldText(node: Node, field: string): string {
  return node.childForFieldName(field)?.text ?? '(anon)';
}

/** Last path segment with a trailing `.dart` removed (e.g. material, engine, async). */
function basename(spec: string): string {
  const tail = spec.split('/').pop() ?? spec;
  // `dart:async` has no slash — strip the `dart:` scheme too.
  const noScheme = tail.includes(':') ? tail.slice(tail.indexOf(':') + 1) : tail;
  return noScheme.replace(/\.dart$/, '');
}
