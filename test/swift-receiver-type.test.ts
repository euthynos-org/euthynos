import { beforeAll, describe, expect, it } from 'vitest';
import { loadLanguages } from '../src/parse/treesitter/loader.js';
import { parseSwiftSource } from '../src/parse/swift.js';
import { buildGraph } from '../src/graph/imports.js';
import { buildKnowledgeGraph } from '../src/graph/knowledge.js';
import type { CodeGraph, ParsedFile } from '../src/types.js';

/** Wave 2: SOUND receiver-type bridge for Swift (property/param/local/self.field,
 * `Foo()`-inferred). External types resolve to nothing; protocols are interfaces. */

beforeAll(async () => {
  await loadLanguages(['swift']);
});

const P = (file: string, s: string): ParsedFile => parseSwiftSource(file, file.split('/')[0], false, s);
const fn = (g: CodeGraph, file: string, label: string) =>
  [...g.nodes.values()].find((n) => n.kind === 'function' && n.file.endsWith(file) && n.label === label);

const USER_SVC = `class UserService { func charge(_ id: String) {} }`;

describe('Swift receiver-type bridge', () => {
  it('resolves stored-property, parameter, local, and self.field receivers at 0.85', () => {
    const WEB = `class Web {
  let svc: UserService
  func go(param: UserService) {
    let local = UserService()
    local.charge("a")
    param.charge("b")
    self.svc.charge("c")
  }
}`;
    const files = [P('svc/UserService.swift', USER_SVC), P('web/Web.swift', WEB)];
    const g = buildKnowledgeGraph(files, buildGraph(files), {});
    const go = fn(g, 'Web.swift', 'go')!;
    const charge = fn(g, 'UserService.swift', 'charge')!;
    expect(go).toBeDefined();
    expect(g.callMeta.get(`${go.id}|${charge.id}`)).toEqual({ confidence: 0.85, reason: 'receiver-type' });
  });

  it('PHANTOM GUARD: an external/unknown-type receiver resolves to nothing', () => {
    const WEB = `class Web { func go(ext: SomeExternal) { ext.charge("x") } }`;
    const files = [P('svc/UserService.swift', USER_SVC), P('web/Web.swift', WEB)];
    const g = buildKnowledgeGraph(files, buildGraph(files), {});
    const go = fn(g, 'Web.swift', 'go')!;
    const charge = fn(g, 'UserService.swift', 'charge')!;
    expect([...(g.callsIn.get(charge.id) ?? [])]).not.toContain(go.id);
  });
});
