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
  const { hash, tokens, literals, sketch, defHash } = body ? bodyHash(body, { idTypes: ID_TYPES, litTypes: LIT_TYPES }) : EMPTY_BODY;
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
    ...(defHash === undefined ? {} : { defHash }),
    ...(enclosingTypeNamePhp(node) === undefined ? {} : { enclosingType: enclosingTypeNamePhp(node) }),
    ...deriveCalls(body ? collectCallSites(body) : []),
    ...(() => {
      const typed = body ? collectTypedCallsPhp(node, body) : [];
      return typed.length > 0 ? { typedCalls: typed } : {};
    })(),
  };
}

const PHP_TYPE_DECLS = new Set(['class_declaration', 'interface_declaration', 'trait_declaration', 'enum_declaration']);

/** The named class/interface/trait/enum that lexically contains this method, or
 * undefined if the method belongs to an ANONYMOUS class (`new class {…}`) — whose
 * members are not declared on any named type. */
function enclosingTypeNamePhp(node: Node): string | undefined {
  let anc: Node | null = node.parent;
  while (anc) {
    if (anc.type === 'object_creation_expression') return undefined; // anonymous class boundary
    if (PHP_TYPE_DECLS.has(anc.type)) return anc.childForFieldName('name')?.text ?? undefined;
    anc = anc.parent;
  }
  return undefined;
}

/** Simple type name from a PHP type node (strip namespace, unwrap nullable). A
 * UNION/INTERSECTION type is ambiguous — return null (decline) rather than bind
 * to one arm the value may never hold. */
function phpTypeName(t: Node | null | undefined): string | null {
  if (!t) return null;
  if (t.type === 'union_type' || t.type === 'intersection_type' || t.type === 'disjunctive_normal_form_type') return null;
  if (t.type === 'named_type') {
    const nm = nkids(t).find((c) => c.type === 'name' || c.type === 'qualified_name');
    return nm ? lastSegment(nm.text, '\\') : null;
  }
  if (t.type === 'name') return t.text;
  if (t.type === 'qualified_name') return lastSegment(t.text, '\\');
  // nullable_type / optional_type wrap a single named member.
  const inner = nkids(t).find((c) => c.type === 'named_type' || c.type === 'name' || c.type === 'qualified_name');
  return inner ? phpTypeName(inner) : null;
}

/** The constructed type of a `new X()` expression. */
function oceType(oce: Node): string | null {
  const nm = nkids(oce).find((c) => c.type === 'name' || c.type === 'qualified_name');
  return nm ? phpTypeName(nm) : null;
}

/**
 * Receiver-typed member calls in a PHP method (SOUND — shared graph-layer
 * class-scoping). Types from the class's typed properties, typed parameters, and
 * `$x = new Foo()` locals. Fields are keyed by their bare name (accessed as
 * `$this->name`); parameters/locals by their `$var` form. A name declared with two
 * types is dropped.
 */
function collectTypedCallsPhp(node: Node, body: Node): { method: string; type: string }[] {
  const varType = new Map<string, string>();
  const ambiguous = new Set<string>();
  const note = (key: string | undefined, tn: string | null): void => {
    if (!key || !tn) return;
    const prev = varType.get(key);
    if (prev !== undefined && prev !== tn) ambiguous.add(key);
    varType.set(key, tn);
  };

  // Class properties (fields) — keyed by bare name (`$this->svc` accesses `svc`).
  let cls: Node | null = node.parent;
  while (cls && !PHP_TYPE_DECLS.has(cls.type)) cls = cls.parent;
  const clsBody = cls?.childForFieldName('body') ?? cls;
  if (clsBody) {
    for (const m of nkids(clsBody)) {
      if (m.type === 'property_declaration') {
        const tn = phpTypeName(m.childForFieldName('type'));
        for (const pe of nkids(m)) {
          if (pe.type !== 'property_element') continue;
          const vn = nkids(pe).find((c) => c.type === 'variable_name');
          note(vn ? nkids(vn).find((c) => c.type === 'name')?.text : undefined, tn);
        }
      } else if (m.type === 'method_declaration' && (m.childForFieldName('name')?.text ?? '').toLowerCase() === '__construct') {
        // Constructor property promotion: `__construct(private UserService $svc)`
        // declares a field, accessed as `$this->svc` → register under the BARE name.
        const ctorParams = m.childForFieldName('parameters');
        if (ctorParams) {
          for (const p of nkids(ctorParams)) {
            if (p.type !== 'property_promotion_parameter') continue;
            const vn = p.childForFieldName('name');
            const bare = vn ? nkids(vn).find((c) => c.type === 'name')?.text : undefined;
            note(bare, phpTypeName(p.childForFieldName('type')));
          }
        }
      }
    }
  }
  // Parameters — keyed by `$var`.
  const params = node.childForFieldName('parameters');
  if (params) {
    for (const p of nkids(params)) {
      if (p.type !== 'simple_parameter' && p.type !== 'property_promotion_parameter') continue;
      note(p.childForFieldName('name')?.text, phpTypeName(p.childForFieldName('type')));
    }
  }
  // Locals: `$x = new Foo()`. Do NOT descend into nested closures/arrow functions
  // (their locals are a different scope and would pollute this method's var map).
  const walkNoNested = (n: Node, fn: (x: Node) => void): void => {
    fn(n);
    for (const c of nkids(n)) {
      if (c.type === 'anonymous_function' || c.type === 'anonymous_function_creation_expression' || c.type === 'arrow_function') continue;
      walkNoNested(c, fn);
    }
  };
  walkNoNested(body, (n) => {
    if (n.type !== 'assignment_expression') return;
    const lhs = n.childForFieldName('left') ?? nkids(n)[0];
    const rhs = n.childForFieldName('right') ?? nkids(n)[nkids(n).length - 1];
    if (lhs?.type === 'variable_name' && rhs?.type === 'object_creation_expression') note(lhs.text, oceType(rhs));
  });
  for (const k of ambiguous) varType.delete(k);

  const out: { method: string; type: string }[] = [];
  const seen = new Set<string>();
  walkNamed(body, (n) => {
    if (n.type !== 'member_call_expression' && n.type !== 'nullsafe_member_call_expression') return;
    const method = n.childForFieldName('name')?.text;
    const obj = n.childForFieldName('object');
    if (!method || !obj) return;
    let type: string | null = null;
    if (obj.type === 'variable_name') type = varType.get(obj.text) ?? null; // $local / $param
    else if (obj.type === 'object_creation_expression') type = oceType(obj); // (new Foo())->m()
    else if (obj.type === 'member_access_expression') {
      // $this->field->m() : object=$this, name=field (bare)
      const io = obj.childForFieldName('object');
      const field = obj.childForFieldName('name')?.text;
      if (io?.type === 'variable_name' && io.text === '$this' && field) type = varType.get(field) ?? null;
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
