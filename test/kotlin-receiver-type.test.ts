import { beforeAll, describe, expect, it } from 'vitest';
import { loadLanguages } from '../src/parse/treesitter/loader.js';
import { parseKotlinSource } from '../src/parse/kotlin.js';
import { buildGraph } from '../src/graph/imports.js';
import { buildKnowledgeGraph } from '../src/graph/knowledge.js';
import type { CodeGraph, ParsedFile } from '../src/types.js';

/**
 * Wave 2: the SOUND receiver-type bridge extended to Kotlin. Same graph-layer
 * soundness as Java (class-scoped resolution, external/ambiguous → no edge); the
 * Kotlin parser supplies the receiver types from constructor properties, params,
 * and `val`/`var` declarations (explicit or `Foo()`-inferred).
 */

beforeAll(async () => {
  await loadLanguages(['kotlin']);
});

const P = (n: string, s: string): ParsedFile =>
  parseKotlinSource(`src/main/kotlin/com/acme/${n}`, 'com/acme', false, s);

const fn = (g: CodeGraph, file: string, label: string) =>
  [...g.nodes.values()].find((n) => n.kind === 'function' && n.file.endsWith(file) && n.label === label);

const USER_SVC = `package com.acme
class UserService { fun charge(id: String): String { return id } }`;

describe('Kotlin receiver-type bridge', () => {
  it('resolves constructor-property, parameter, and local receivers at 0.85', () => {
    const WEB = `package com.acme
class Web(val svc: UserService) {
  fun go(param: UserService) {
    val local = UserService()
    local.charge("a")
    param.charge("b")
    svc.charge("c")
  }
}`;
    const files = [P('UserService.kt', USER_SVC), P('Web.kt', WEB)];
    const g = buildKnowledgeGraph(files, buildGraph(files), {});
    const go = fn(g, 'Web.kt', 'go')!;
    const charge = fn(g, 'UserService.kt', 'charge')!;
    expect(go).toBeDefined();
    expect(g.callMeta.get(`${go.id}|${charge.id}`)).toEqual({ confidence: 0.85, reason: 'receiver-type' });
  });

  it('PHANTOM GUARD: a call on an external/unknown-type receiver resolves to nothing', () => {
    const WEB = `package com.acme
class Web {
  fun go(headers: SomeExternalType) {
    headers.charge("x")
    unknownVar.charge()
  }
}`;
    const files = [P('UserService.kt', USER_SVC), P('Web.kt', WEB)];
    const g = buildKnowledgeGraph(files, buildGraph(files), {});
    const go = fn(g, 'Web.kt', 'go')!;
    const charge = fn(g, 'UserService.kt', 'charge')!;
    expect([...(g.callsIn.get(charge.id) ?? [])]).not.toContain(go.id);
  });

  it('NESTED-TYPE GUARD: a receiver of nested type Order.Line binds to Line, never the outer Order', () => {
    const ORDER = `package com.acme
class Order { fun validate() {} }`;
    const LINE = `package com.acme
class Line { fun validate() {} }`;
    const USE = `package com.acme
class Use { fun go(item: Order.Line) { item.validate() } }`;
    const files = [P('Order.kt', ORDER), P('Line.kt', LINE), P('Use.kt', USE)];
    const g = buildKnowledgeGraph(files, buildGraph(files), {});
    const go = fn(g, 'Use.kt', 'go')!;
    const orderValidate = fn(g, 'Order.kt', 'validate')!;
    const lineValidate = fn(g, 'Line.kt', 'validate')!;
    // item is an Order.Line → the outer Order's validate() must NOT be wired.
    expect([...(g.callsIn.get(orderValidate.id) ?? [])]).not.toContain(go.id);
    expect([...(g.callsIn.get(lineValidate.id) ?? [])]).toContain(go.id);
  });

  it('ANON-OBJECT GUARD: a scope call s.run{} does not bind to an anonymous object’s run() mis-attributed to the receiver type', () => {
    const SVC = `package com.acme
class Service {
  fun make(): Runnable = object : Runnable { override fun run() { work() } }
  fun work() {}
}`;
    const CALLER = `package com.acme
class Caller { fun go(s: Service) { s.run { } } }`;
    const files = [P('Service.kt', SVC), P('Caller.kt', CALLER)];
    const g = buildKnowledgeGraph(files, buildGraph(files), {});
    const go = fn(g, 'Caller.kt', 'go')!;
    // The anonymous object's run() must NOT be attributed to Service, so s.run{}
    // must not produce a receiver-type edge.
    for (const [k, m] of g.callMeta) if (k.startsWith(`${go.id}|`)) expect(m.reason).not.toBe('receiver-type');
  });

  it('INHERITANCE/MULTI-CLASS GUARD: an inherited method is not wired to a sibling class in the same file', () => {
    const BASE = `package com.acme
open class Base { fun compute() {} }`;
    const MULTI = `package com.acme
class Sub : Base()
class Sibling { fun compute() { println("unrelated") } }`;
    const WEB = `package com.acme
class Web { fun go() { val s = Sub(); s.compute() } }`;
    const files = [P('Base.kt', BASE), P('Multi.kt', MULTI), P('Web.kt', WEB)];
    const g = buildKnowledgeGraph(files, buildGraph(files), {});
    const go = fn(g, 'Web.kt', 'go')!;
    const siblingCompute = fn(g, 'Multi.kt', 'compute')!;
    // Sub does not declare compute() (inherits it) → no edge, and never to Sibling.
    expect([...(g.callsIn.get(siblingCompute.id) ?? [])]).not.toContain(go.id);
    for (const [k, m] of g.callMeta) if (k.startsWith(`${go.id}|`)) expect(m.reason).not.toBe('receiver-type');
  });
});
