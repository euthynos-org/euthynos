import { beforeAll, describe, expect, it } from 'vitest';
import { loadLanguages } from '../src/parse/treesitter/loader.js';
import { parseCppSource } from '../src/parse/cpp.js';
import { buildGraph } from '../src/graph/imports.js';
import { buildKnowledgeGraph } from '../src/graph/knowledge.js';
import type { CodeGraph, ParsedFile } from '../src/types.js';

/**
 * Wave 2: the SOUND receiver-type bridge extended to C++. Resolves `.`, `->`, and
 * `this->field.` member calls by the receiver's declared type (field / param /
 * local / `auto x = Foo()`); external/unknown receivers resolve to nothing. A
 * forward declaration (`class Foo;`) is not a definition and must not make a type
 * look ambiguous.
 */

beforeAll(async () => {
  await loadLanguages(['cpp']);
});

const P = (file: string, s: string): ParsedFile => parseCppSource(file, file.split('/')[0], false, s);
const fn = (g: CodeGraph, file: string, label: string) =>
  [...g.nodes.values()].find((n) => n.kind === 'function' && n.file.endsWith(file) && n.label === label);

const USER_SVC = `class UserService { public: void charge(const char* id) {} };`;

describe('C++ receiver-type bridge', () => {
  it('resolves obj., ptr->, and this->field receivers at 0.85, across a forward declaration', () => {
    const WEB = `class UserService;
class Web {
  UserService svc;
  void go(UserService param, UserService* ap) {
    UserService local;
    local.charge("a");
    param.charge("b");
    ap->charge("c");
    this->svc.charge("d");
  }
};`;
    const files = [P('svc/UserService.cpp', USER_SVC), P('web/Web.cpp', WEB)];
    const web = files[1]!;
    // The forward declaration must NOT appear as a class symbol.
    expect(web.symbols.map((s) => `${s.kind}:${s.name}`)).not.toContain('class:UserService');
    const g = buildKnowledgeGraph(files, buildGraph(files), {});
    const go = fn(g, 'Web.cpp', 'go')!;
    const charge = fn(g, 'UserService.cpp', 'charge')!;
    expect(go).toBeDefined();
    expect(g.callMeta.get(`${go.id}|${charge.id}`)).toEqual({ confidence: 0.85, reason: 'receiver-type' });
  });

  it('PHANTOM GUARD: a call on an external/unknown-type receiver resolves to nothing', () => {
    const WEB = `class Web { void go(SomeExternal ext) { ext.charge("x"); } };`;
    const files = [P('svc/UserService.cpp', USER_SVC), P('web/Web.cpp', WEB)];
    const g = buildKnowledgeGraph(files, buildGraph(files), {});
    const go = fn(g, 'Web.cpp', 'go')!;
    const charge = fn(g, 'UserService.cpp', 'charge')!;
    expect([...(g.callsIn.get(charge.id) ?? [])]).not.toContain(go.id);
  });
});
