import { beforeAll, describe, expect, it } from 'vitest';
import { loadLanguages } from '../src/parse/treesitter/loader.js';
import { parseJavaSource } from '../src/parse/java.js';
import { buildGraph } from '../src/graph/imports.js';
import { buildKnowledgeGraph } from '../src/graph/knowledge.js';
import type { CodeGraph, ParsedFile } from '../src/types.js';

/**
 * Wave 2: the SOUND receiver-type bridge. Same-package Java member calls carry no
 * import (a package doesn't import itself), so import-scoping can't resolve them
 * and they were unresolved. The bridge resolves `recv.method()` by the receiver's
 * DECLARED type — a typed local, a parameter, a field, or `new Foo()` — never by
 * the method name alone, so an external/unknown receiver type (the headers.get()
 * phantom that sank the Wave-1 name-only attempt) resolves to nothing.
 */

beforeAll(async () => {
  await loadLanguages(['java']);
});

const P = (n: string, s: string): ParsedFile =>
  parseJavaSource(`src/main/java/com/acme/${n}`, 'com/acme', false, s);

const fn = (g: CodeGraph, file: string, label: string) =>
  [...g.nodes.values()].find((n) => n.kind === 'function' && n.file.endsWith(file) && n.label === label);

const USER_SVC = `package com.acme;
public class UserService { public String charge(String id) { return id; } }`;
const AUDIT_SVC = `package com.acme;
public class AuditService { public void record(String id) {} }`;

describe('receiver-type bridge resolves same-package member calls soundly', () => {
  it('resolves typed local, parameter, and this.field receivers at 0.85', () => {
    const WEB = `package com.acme;
public class Web {
  private final AuditService audit = new AuditService();
  public void go(UserService param) {
    UserService local = new UserService();
    local.charge("a");
    param.charge("b");
    this.audit.record("c");
  }
}`;
    const g = buildKnowledgeGraph([P('UserService.java', USER_SVC), P('AuditService.java', AUDIT_SVC), P('Web.java', WEB)], buildGraph([P('UserService.java', USER_SVC), P('AuditService.java', AUDIT_SVC), P('Web.java', WEB)]), {});
    const go = fn(g, 'Web.java', 'go')!;
    const charge = fn(g, 'UserService.java', 'charge')!;
    const record = fn(g, 'AuditService.java', 'record')!;
    expect(go).toBeDefined();
    expect(g.callMeta.get(`${go.id}|${charge.id}`)).toEqual({ confidence: 0.85, reason: 'receiver-type' });
    expect(g.callMeta.get(`${go.id}|${record.id}`)).toEqual({ confidence: 0.85, reason: 'receiver-type' });
  });

  it('resolves new Foo().method() by the constructed type', () => {
    const WEB = `package com.acme;
public class Web { public void go() { new UserService().charge("x"); } }`;
    const files = [P('UserService.java', USER_SVC), P('Web.java', WEB)];
    const g = buildKnowledgeGraph(files, buildGraph(files), {});
    const go = fn(g, 'Web.java', 'go')!;
    const charge = fn(g, 'UserService.java', 'charge')!;
    expect(g.callMeta.get(`${go.id}|${charge.id}`)?.reason).toBe('receiver-type');
  });

  it('PHANTOM GUARD: a call on an external/unknown-type receiver resolves to nothing', () => {
    const WEB = `package com.acme;
public class Web {
  public void go(javax.servlet.http.HttpServletRequest req) {
    req.charge("x");     // req is an external type — no local file, no edge
    unknownVar.charge(); // undeclared receiver — no type, no edge
  }
}`;
    const files = [P('UserService.java', USER_SVC), P('Web.java', WEB)];
    const g = buildKnowledgeGraph(files, buildGraph(files), {});
    const go = fn(g, 'Web.java', 'go')!;
    const charge = fn(g, 'UserService.java', 'charge')!;
    // charge() is a UserService method, but neither receiver is a UserService, so
    // NO edge may form — the bridge binds by declared type, never by method name.
    expect([...(g.callsIn.get(charge.id) ?? [])]).not.toContain(go.id);
  });

  it('INHERITANCE/MULTI-CLASS GUARD: an inherited method is NOT wired to a sibling class’s same-named method in the same file', () => {
    // Base (own file) declares compute(). OrderFile.java holds TWO classes: Sub
    // (extends Base, declares NO compute — inherits it) and Sibling (declares its
    // OWN compute). A call s.compute() with s:Sub must bind to NOTHING (Sub does
    // not declare compute), and must NOT be wired to Sibling.compute().
    const BASE = `package com.acme;
public class Base { public void compute() {} }`;
    const ORDER = `package com.acme;
class Sub extends Base {}
class Sibling { public void compute() { System.out.println("unrelated"); } }`;
    const WEB = `package com.acme;
public class Web { public void go() { Sub s = new Sub(); s.compute(); } }`;
    const files = [P('Base.java', BASE), P('OrderFile.java', ORDER), P('Web.java', WEB)];
    const g = buildKnowledgeGraph(files, buildGraph(files), {});
    const go = fn(g, 'Web.java', 'go')!;
    const siblingCompute = fn(g, 'OrderFile.java', 'compute')!; // Sibling's compute (first in file)
    expect(go).toBeDefined();
    expect(siblingCompute).toBeDefined();
    // The inherited compute() is not declared on Sub, so no edge — and never to Sibling.
    expect([...(g.callsIn.get(siblingCompute.id) ?? [])]).not.toContain(go.id);
    for (const [k, m] of g.callMeta) {
      if (k.startsWith(`${go.id}|`)) expect(m.reason).not.toBe('receiver-type');
    }
  });

  it('BLOCK-SCOPE GUARD: a variable name reused with two different types is not typed at all', () => {
    // `x` is declared as UserService in one block and AuditService in another. A
    // flat last-wins map would misattribute; the parser drops the conflicting name.
    const WEB = `package com.acme;
public class Web {
  public void go() {
    { UserService x = new UserService(); x.charge("a"); }
    { AuditService x = new AuditService(); x.record("b"); }
  }
}`;
    const files = [P('UserService.java', USER_SVC), P('AuditService.java', AUDIT_SVC), P('Web.java', WEB)];
    const g = buildKnowledgeGraph(files, buildGraph(files), {});
    const go = fn(g, 'Web.java', 'go')!;
    const charge = fn(g, 'UserService.java', 'charge')!;
    const record = fn(g, 'AuditService.java', 'record')!;
    // Neither call is typed (x is ambiguous), so no receiver-type edge to either —
    // crucially, no WRONG edge (e.g. x.charge() → nothing, never AuditService).
    expect([...(g.callsIn.get(charge.id) ?? [])]).not.toContain(go.id);
    expect([...(g.callsIn.get(record.id) ?? [])]).not.toContain(go.id);
  });

  it('AMBIGUITY GUARD: a receiver whose type name is defined in two files resolves to nothing', () => {
    // Two different UserService classes (different packages/files). A receiver of
    // that type name cannot be pinned to one → no edge, never a guess.
    const svcA = parseJavaSource('src/main/java/a/UserService.java', 'a', false, USER_SVC.replace('com.acme', 'a'));
    const svcB = parseJavaSource('src/main/java/b/UserService.java', 'b', false, USER_SVC.replace('com.acme', 'b'));
    const web = parseJavaSource('src/main/java/c/Web.java', 'c', false, `package c;
public class Web { public void go() { UserService s = null; s.charge("x"); } }`);
    const files = [svcA, svcB, web];
    const g = buildKnowledgeGraph(files, buildGraph(files), {});
    const go = fn(g, 'c/Web.java', 'go')!;
    const chargeA = fn(g, 'a/UserService.java', 'charge')!;
    const chargeB = fn(g, 'b/UserService.java', 'charge')!;
    expect([...(g.callsIn.get(chargeA.id) ?? [])]).not.toContain(go.id);
    expect([...(g.callsIn.get(chargeB.id) ?? [])]).not.toContain(go.id);
  });
});
