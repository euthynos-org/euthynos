import { beforeAll, describe, expect, it } from 'vitest';
import { loadLanguages } from '../src/parse/treesitter/loader.js';
import { parseCSharpSource } from '../src/parse/csharp.js';
import { buildGraph } from '../src/graph/imports.js';
import { buildKnowledgeGraph } from '../src/graph/knowledge.js';
import type { CodeGraph, ParsedFile } from '../src/types.js';

/**
 * Wave 2: the SOUND receiver-type bridge extended to C#. Concrete-class receivers
 * resolve precisely (0.85) by declared type; interface-typed receivers are LEFT to
 * the module-scoped over-approximation (which reaches the implementations); an
 * external/unknown receiver type resolves to nothing.
 */

beforeAll(async () => {
  await loadLanguages(['c_sharp']);
});

const P = (file: string, s: string): ParsedFile => parseCSharpSource(file, file.split('/')[0], false, s);

const fn = (g: CodeGraph, file: string, label: string) =>
  [...g.nodes.values()].find((n) => n.kind === 'function' && n.file.endsWith(file) && n.label === label);

const USER_SVC = `namespace A { public class UserService { public string Charge(string id) { return id; } } }`;

describe('C# receiver-type bridge', () => {
  it('resolves field, parameter, local, and this.field receivers at 0.85', () => {
    const CTRL = `namespace A {
      public class Ctrl {
        private readonly UserService svc;
        public void Go(UserService param) {
          UserService local = new UserService();
          local.Charge("a");
          param.Charge("b");
          this.svc.Charge("c");
        }
      }
    }`;
    const files = [P('Services/UserService.cs', USER_SVC), P('Web/Ctrl.cs', CTRL)];
    const g = buildKnowledgeGraph(files, buildGraph(files), {});
    const go = fn(g, 'Ctrl.cs', 'Go')!;
    const charge = fn(g, 'UserService.cs', 'Charge')!;
    expect(go).toBeDefined();
    expect(g.callMeta.get(`${go.id}|${charge.id}`)).toEqual({ confidence: 0.85, reason: 'receiver-type' });
  });

  it('resolves var-typed receiver via new Foo()', () => {
    const CTRL = `namespace A { public class Ctrl { public void Go() { var made = new UserService(); made.Charge("x"); } } }`;
    const files = [P('Services/UserService.cs', USER_SVC), P('Web/Ctrl.cs', CTRL)];
    const g = buildKnowledgeGraph(files, buildGraph(files), {});
    const go = fn(g, 'Ctrl.cs', 'Go')!;
    const charge = fn(g, 'UserService.cs', 'Charge')!;
    expect(g.callMeta.get(`${go.id}|${charge.id}`)?.reason).toBe('receiver-type');
  });

  it('INTERFACE SKIP: an interface-typed receiver is NOT resolved by receiver-type (left to module-scoping)', () => {
    const IFACE = `namespace A { public interface ISvc { string Charge(string id); } }`;
    const IMPL = `namespace A { public class Svc : ISvc { public string Charge(string id) { return id; } } }`;
    const CTRL = `namespace A {
      public class Ctrl {
        private readonly ISvc svc;
        public void Go() { this.svc.Charge("x"); }
      }
    }`;
    const files = [P('A/ISvc.cs', IFACE), P('A/Svc.cs', IMPL), P('A/Ctrl.cs', CTRL)];
    const g = buildKnowledgeGraph(files, buildGraph(files), {});
    const go = fn(g, 'Ctrl.cs', 'Go')!;
    // Whatever resolves it, it must NOT be a receiver-type edge to the interface —
    // interface dispatch stays with the module-scoped over-approximation.
    for (const [k, m] of g.callMeta) {
      if (k.startsWith(`${go.id}|`)) expect(m.reason).not.toBe('receiver-type');
    }
  });

  it('ARRAY GUARD: a call on a Foo[] receiver does not bind to a Foo method', () => {
    const CTRL = `namespace A { public class Ctrl { public void Go(UserService[] arr) { arr.Charge("x"); } } }`;
    const files = [P('Services/UserService.cs', USER_SVC), P('Web/Ctrl.cs', CTRL)];
    const g = buildKnowledgeGraph(files, buildGraph(files), {});
    const go = fn(g, 'Ctrl.cs', 'Go')!;
    const charge = fn(g, 'UserService.cs', 'Charge')!;
    expect([...(g.callsIn.get(charge.id) ?? [])]).not.toContain(go.id);
  });

  it('PHANTOM GUARD: an external/unknown-type receiver resolves to nothing', () => {
    const CTRL = `namespace A { public class Ctrl { public void Go(SomeExternal headers) { headers.Charge("x"); } } }`;
    const files = [P('Services/UserService.cs', USER_SVC), P('Web/Ctrl.cs', CTRL)];
    const g = buildKnowledgeGraph(files, buildGraph(files), {});
    const go = fn(g, 'Ctrl.cs', 'Go')!;
    const charge = fn(g, 'UserService.cs', 'Charge')!;
    expect([...(g.callsIn.get(charge.id) ?? [])]).not.toContain(go.id);
  });
});
