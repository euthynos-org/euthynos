import { readFileSync } from 'node:fs';
import ts from 'typescript';
import type { DiscoveredFile } from '../discover.js';
import type { CallSite, ExportedSymbol, FunctionRecord, ImportRecord, ParsedFile, SymbolSpan } from '../types.js';

/** Parse one TS/JS file into the parser-agnostic shape the metrics consume. */
export function parseFile(f: DiscoveredFile): ParsedFile {
  const text = readFileSync(f.abs, 'utf8');
  return parseTsSource(f.rel, f.module, f.isTest, text, {
    scriptKind: f.rel.endsWith('x') ? ts.ScriptKind.TSX : undefined,
  });
}

/**
 * Parse a TS/JS source STRING into the parser-agnostic shape. Split out from
 * `parseFile` so non-file callers can reuse the TypeScript compiler API with
 * full fidelity — notably the Vue parser, which extracts a `<script>` block and
 * feeds it here. `opts.scriptKind` picks TS/TSX/JS/JSX; `opts.isIndex` overrides
 * the index-file heuristic for synthetic paths (e.g. `.vue`).
 */
export function parseTsSource(
  path: string,
  module: string,
  isTest: boolean,
  text: string,
  opts: { scriptKind?: ts.ScriptKind; isIndex?: boolean } = {},
): ParsedFile {
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, opts.scriptKind);

  const exports: ExportedSymbol[] = [];
  const functions: FunctionRecord[] = [];
  const imports: ImportRecord[] = [];
  const symbols: SymbolSpan[] = [];
  let internalFunctions = 0;
  const lineOf = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const endLineOf = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getEnd()).line + 1;
  const addSymbol = (n: ts.Node, name: string, kind: SymbolSpan['kind'], exported: boolean): void => {
    symbols.push({ name, kind, startLine: lineOf(n), endLine: endLineOf(n), exported });
  };

  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt)) {
      imports.push(readImport(stmt, path, lineOf(stmt)));
      continue;
    }
    if (ts.isExportDeclaration(stmt)) {
      // export { a, b } from './x'  |  export * from './x'
      if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        for (const el of stmt.exportClause.elements) {
          exports.push({ name: el.name.text, kind: 'reexport', requiredParams: 0, totalParams: 0 });
        }
      } else {
        exports.push({ name: '*', kind: 'reexport', requiredParams: 0, totalParams: 0 });
      }
      continue;
    }

    const exported = hasExportModifier(stmt);

    if (ts.isFunctionDeclaration(stmt)) {
      const name = stmt.name?.text ?? '(default)';
      if (exported) exports.push(fnSymbol(name, 'function', stmt.parameters));
      else internalFunctions++;
      if (stmt.body) {
        functions.push(fnRecord(name, stmt.parameters, stmt.body, sf, path, exported, lineOf(stmt), stmt.type));
      }
      continue;
    }
    if (ts.isClassDeclaration(stmt)) {
      const name = stmt.name?.text ?? '(class)';
      if (exported) {
        const ctor = stmt.members.find(ts.isConstructorDeclaration);
        exports.push(fnSymbol(name, 'class', ctor?.parameters ?? emptyParams()));
      } else internalFunctions++;
      addSymbol(stmt, name, 'class', exported);
      // Class METHODS are call-graph nodes. Without them the calls made by
      // every method in a class-based codebase are invisible (hono's
      // Hono.route()/#dispatch() calling compose() went unseen). The export
      // SURFACE is deliberately unchanged — methods are not added to
      // `exports`, so depth/leverage metrics keep their current definition.
      for (const member of stmt.members) {
        // Class PROPERTIES initialized with arrow functions / function
        // expressions are call-graph nodes exactly like methods. The M2
        // benchmark caught their absence: hono's ClientRequestImpl
        // `fetch = async (...) => { ... serialize(...) }` — every session
        // in both arms found the serialize call by reading; callers_of
        // did not (M2-RESULTS.md finding 4).
        if (ts.isPropertyDeclaration(member)) {
          const init = member.initializer;
          if (!init || (!ts.isArrowFunction(init) && !ts.isFunctionExpression(init)) || !init.body) continue;
          const nameNode = member.name;
          const isPrivate =
            ts.isPrivateIdentifier(nameNode) ||
            (ts.getModifiers(member)?.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword) === true);
          functions.push(
            fnRecord(
              memberName(member, name),
              init.parameters,
              init.body,
              sf,
              path,
              exported && !isPrivate,
              lineOf(member),
              init.type,
            ),
          );
          continue;
        }
        if (!ts.isMethodDeclaration(member) && !ts.isConstructorDeclaration(member) &&
            !ts.isGetAccessor(member) && !ts.isSetAccessor(member)) continue;
        if (!member.body) continue; // overload signature / abstract
        const nameNode = member.name; // undefined on constructors
        const isPrivate =
          (nameNode !== undefined && ts.isPrivateIdentifier(nameNode)) ||
          (ts.canHaveModifiers(member) &&
            ts.getModifiers(member)?.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword) === true);
        functions.push(
          fnRecord(
            memberName(member, name),
            member.parameters,
            member.body,
            sf,
            path,
            exported && !isPrivate,
            lineOf(member),
            member.type,
          ),
        );
      }
      continue;
    }
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        const name = ts.isIdentifier(decl.name) ? decl.name.text : '(pattern)';
        const init = decl.initializer;
        const fnLike = init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init));
        if (fnLike) {
          if (exported) exports.push(fnSymbol(name, 'function', init.parameters));
          else internalFunctions++;
          const body = init.body;
          functions.push(fnRecord(name, init.parameters, body, sf, path, exported, lineOf(stmt), init.type));
        } else if (exported) {
          exports.push({ name, kind: 'const', requiredParams: 0, totalParams: 0 });
          addSymbol(decl, name, 'const', true);
        }
      }
      continue;
    }
    if (ts.isTypeAliasDeclaration(stmt) || ts.isInterfaceDeclaration(stmt) || ts.isEnumDeclaration(stmt)) {
      if (exported) exports.push({ name: stmt.name.text, kind: 'type', requiredParams: 0, totalParams: 0 });
      addSymbol(
        stmt,
        stmt.name.text,
        ts.isInterfaceDeclaration(stmt) ? 'interface' : ts.isEnumDeclaration(stmt) ? 'enum' : 'type',
        exported,
      );
      continue;
    }
    if (ts.isExportAssignment(stmt)) {
      exports.push({ name: '(default)', kind: 'const', requiredParams: 0, totalParams: 0 });
    }
  }

  return {
    path,
    module,
    isTest,
    isIndex: opts.isIndex ?? /(^|\/)index\.(ts|tsx|js|jsx|mts|mjs)$/.test(path),
    codeLines: countCodeLines(text),
    exports,
    internalFunctions,
    functions,
    imports,
    symbols,
    totalLines: text.split('\n').length,
  };
}

function emptyParams(): ts.NodeArray<ts.ParameterDeclaration> {
  return ts.factory.createNodeArray<ts.ParameterDeclaration>([]);
}

/** Method name for the call graph: `#dispatch` keeps its hash, ctor takes the class name. */
function memberName(member: ts.ClassElement, className: string): string {
  if (ts.isConstructorDeclaration(member)) return className;
  const n = member.name;
  if (n === undefined) return '(anon)';
  if (ts.isIdentifier(n) || ts.isPrivateIdentifier(n)) return n.text;
  if (ts.isStringLiteral(n) || ts.isNumericLiteral(n)) return n.text;
  return '(computed)';
}

function hasExportModifier(node: ts.Statement): boolean {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return !!mods?.some(
    (m) => m.kind === ts.SyntaxKind.ExportKeyword,
  );
}

function fnSymbol(
  name: string,
  kind: 'function' | 'class',
  params: ts.NodeArray<ts.ParameterDeclaration>,
): ExportedSymbol {
  let required = 0;
  for (const p of params) {
    if (!p.questionToken && !p.initializer && !p.dotDotDotToken) required++;
  }
  return { name, kind, requiredParams: required, totalParams: params.length };
}

function fnRecord(
  name: string,
  params: ts.NodeArray<ts.ParameterDeclaration>,
  body: ts.Node,
  sf: ts.SourceFile,
  file: string,
  exported: boolean,
  declLine?: number,
  returnType?: ts.TypeNode,
): FunctionRecord {
  const { hash, tokens, defHash, sketch } = normalizedBodyHash(body, sf);
  const { calls, memberCalls, callSites } = callees(body, sf);
  const typeRefs = signatureTypeRefs(params, returnType);
  return {
    name,
    file,
    startLine: sf.getLineAndCharacterOfPosition(body.getStart(sf)).line + 1,
    endLine: sf.getLineAndCharacterOfPosition(body.getEnd()).line + 1,
    ...(declLine === undefined ? {} : { declLine }),
    exported,
    paramCount: params.length,
    paramNames: params.map((p) => (ts.isIdentifier(p.name) ? p.name.text : '_')),
    bodyHash: hash,
    bodyTokens: tokens,
    literalHash: literalsHash(body, sf),
    ...(defHash === undefined ? {} : { defHash }),
    ...(sketch === undefined ? {} : { ngramSketch: sketch }),
    calls,
    memberCalls,
    callSites,
    ...(typeRefs.length > 0 ? { typeRefs } : {}),
  };
}

/**
 * Named types referenced in a signature (parameters + return) — what
 * context_bundle's "types touched" section resolves to spans. Only TYPE
 * REFERENCES count (Request, TokenClaims, Map<K,V>'s K/V arguments included
 * via the walk); primitive keywords (string, number...) are keyword nodes,
 * not references, so they are excluded structurally rather than by a list.
 * Deduped in first-appearance order, capped so a pathological signature
 * cannot bloat every artifact. TS-only today: FunctionRecord.typeRefs is
 * ABSENT for other languages, and the bundle says so instead of guessing.
 */
function signatureTypeRefs(
  params: ts.NodeArray<ts.ParameterDeclaration>,
  returnType: ts.TypeNode | undefined,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (ts.isTypeReferenceNode(n)) {
      const name = ts.isQualifiedName(n.typeName) ? n.typeName.right.text : n.typeName.text;
      if (!seen.has(name) && out.length < 12) {
        seen.add(name);
        out.push(name);
      }
    }
    ts.forEachChild(n, visit);
  };
  for (const p of params) if (p.type) visit(p.type);
  if (returnType) visit(returnType);
  return out;
}

/**
 * Collect callee names from a function body — the call-graph edge source.
 * `foo()` / `new Baz()` are BARE calls; `obj.bar()` is a MEMBER call, tracked
 * separately because a member name is frequently a built-in (`arr.every()`,
 * `p.then()`) that must not resolve to a same-named repo function on name
 * alone. Resolution happens later in the graph builder, scoped by imports.
 */
function callees(
  body: ts.Node,
  sf: ts.SourceFile,
): { calls: string[]; memberCalls: string[]; callSites: CallSite[] } {
  const bare = new Set<string>();
  const member = new Set<string>();
  const sites: CallSite[] = [];
  const at = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const e = n.expression;
      if (ts.isIdentifier(e)) {
        bare.add(e.text);
        sites.push({ name: e.text, line: at(e), member: false });
      } else if (ts.isPropertyAccessExpression(e)) {
        member.add(e.name.text);
        sites.push({ name: e.name.text, line: at(e.name), member: true });
      }
    } else if (ts.isNewExpression(n) && ts.isIdentifier(n.expression)) {
      bare.add(n.expression.text);
      sites.push({ name: n.expression.text, line: at(n.expression), member: false });
    }
    n.forEachChild(visit);
  };
  visit(body);
  // `calls` stays the full set (existing consumers/metrics), `memberCalls`
  // marks which arrived through a receiver, `callSites` keeps every
  // occurrence with its line (reference locations).
  return { calls: [...new Set([...bare, ...member])], memberCalls: [...member], callSites: sites };
}

/**
 * FNV-1a over the body's literal VALUES in source order. Empty bodies and
 * literal-free bodies hash to the same constant, which is correct: they have
 * no literal content to disagree about.
 */
function literalsHash(body: ts.Node, sf: ts.SourceFile): number {
  let h = 0x811c9dc5;
  const mix = (s: string): void => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    h ^= 31;
    h = Math.imul(h, 0x01000193) >>> 0;
  };
  const visit = (n: ts.Node): void => {
    if (
      ts.isStringLiteral(n) ||
      ts.isNoSubstitutionTemplateLiteral(n) ||
      ts.isNumericLiteral(n) ||
      ts.isRegularExpressionLiteral(n)
    ) {
      mix(n.text);
    }
    n.forEachChild(visit);
  };
  visit(body);
  void sf;
  return h >>> 0;
}

/**
 * Contamination cascade, step 1 (AST structural clone):
 * hash the body's token stream with identifiers and literals collapsed,
 * so renamed copies still collide.
 */
function normalizedBodyHash(
  body: ts.Node,
  sf: ts.SourceFile,
): { hash: number; tokens: number; defHash?: number; sketch?: number[] } {
  let h = 0x811c9dc5; // FNV-1a
  let def = 0x811c9dc5; // rename-SENSITIVE companion (identifier/literal text kept)
  let count = 0;
  // Bottom-K 4-gram sketch over the SAME normalized stream — the near-clone
  // tier's structural-similarity signal. Semantics must match the shared
  // tree-sitter bodyHash exactly: sketches are compared across languages.
  const window: string[] = [];
  const grams = new Set<number>();
  const fnv = (seed: number, s: string): number => {
    let x = seed;
    for (let i = 0; i < s.length; i++) {
      x ^= s.charCodeAt(i);
      x = Math.imul(x, 0x01000193) >>> 0;
    }
    x ^= 31;
    return Math.imul(x, 0x01000193) >>> 0;
  };
  const mix = (s: string): void => {
    count++;
    h = fnv(h, s);
    window.push(s);
    if (window.length > 4) window.shift();
    if (window.length === 4) grams.add(fnv(0x811c9dc5, window.join('|')));
  };
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n) || ts.isPrivateIdentifier(n)) {
      mix('ID');
      def = fnv(def, n.text); // rename-sensitive: identifier text
    } else if (ts.isStringLiteralLike(n) || ts.isNumericLiteral(n)) {
      mix('LIT');
      def = fnv(def, n.text); // rename-sensitive: literal text
    } else if (ts.isRegularExpressionLiteral(n)) {
      // Structural hash (h/sketch) unchanged — regex stays its kind token — but
      // def sees the regex TEXT so a /a/ -> /b/ edit is detected. (literalsHash
      // also captures regex, so the diff signature is covered either way.)
      const kind = ts.SyntaxKind[n.kind] ?? String(n.kind);
      mix(kind);
      def = fnv(def, n.text);
    } else if (n.getChildCount(sf) === 0) {
      const kind = ts.SyntaxKind[n.kind] ?? String(n.kind);
      mix(kind);
      def = fnv(def, kind);
    }
    n.forEachChild(visit);
  };
  visit(body);
  const out: { hash: number; tokens: number; defHash?: number; sketch?: number[] } = {
    hash: h >>> 0,
    tokens: count,
    defHash: def >>> 0,
  };
  if (count >= 12 && grams.size > 0) out.sketch = [...grams].sort((a, b) => a - b).slice(0, 24);
  return out;
}

function readImport(stmt: ts.ImportDeclaration, fromFile: string, line: number): ImportRecord {
  const spec = ts.isStringLiteral(stmt.moduleSpecifier) ? stmt.moduleSpecifier.text : '';
  const named: string[] = [];
  let isTypeOnly = stmt.importClause?.isTypeOnly ?? false;
  const bindings = stmt.importClause?.namedBindings;
  if (bindings && ts.isNamedImports(bindings)) {
    for (const el of bindings.elements) named.push(el.name.text);
    // Inline form: `import { type A, type B } from 'x'`. When EVERY named
    // binding is type-only and there is no default binding, the whole
    // statement is erased at compile time exactly like `import type` —
    // it is not a runtime crossing and must not be judged as one. A mixed
    // list (`{ type A, b }`) keeps a runtime binding and stays runtime.
    // `import {} from 'x'` (no elements) is left to the statement-level flag.
    if (
      bindings.elements.length > 0 &&
      !stmt.importClause?.name &&
      bindings.elements.every((el) => el.isTypeOnly)
    ) {
      isTypeOnly = true;
    }
  }
  if (stmt.importClause?.name) named.push(stmt.importClause.name.text);
  return { fromFile, line, specifier: spec, named, isTypeOnly };
}

function countCodeLines(text: string): number {
  let n = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) continue;
    n++;
  }
  return n;
}
