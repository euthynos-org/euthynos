import { beforeAll, describe, expect, it } from 'vitest';
import { loadLanguages } from '../src/parse/treesitter/loader.js';
import { parseJavaSource } from '../src/parse/java.js';
import { moduleOf } from '../src/discover.js';
import { buildGraph } from '../src/graph/imports.js';
import { buildKnowledgeGraph } from '../src/graph/knowledge.js';
import type { ParsedFile } from '../src/types.js';

// Regression for the Maven field defect: every file under src/main/java collapsed
// to one module named "main", so a module never imported itself and NO cross-class
// member call (obj.method()) could ever resolve. moduleOf now keys the module on
// the package, which restores import-scoped member-call resolution — the keystone
// that makes #3 (Java cross-class calls) and #4 (module detection) a single fix.
//
// The files are parsed with their REAL moduleOf(path), so this exercises the fix
// end-to-end: real Maven paths → package modules → import edge → resolved call.

beforeAll(async () => {
  await loadLanguages(['java']);
});

const CONTROLLER = `package com.acme.web;

import com.acme.service.UserService;

public class UserController {
    private final UserService userService;

    public UserController(UserService userService) {
        this.userService = userService;
    }

    public String pay(String id) {
        return userService.charge(id);
    }
}
`;

const SERVICE = `package com.acme.service;

public class UserService {
    public String charge(String id) {
        return "charged " + id;
    }
}
`;

// A second imported class that ALSO defines charge(), in a different package,
// to prove the ambiguity guard: two candidates in two modules ⇒ NO edge, never a guess.
const AUDIT = `package com.acme.audit;

public class AuditService {
    public String charge(String id) {
        return "audited " + id;
    }
}
`;

const CONTROLLER_AMBIG = `package com.acme.web;

import com.acme.service.UserService;
import com.acme.audit.AuditService;

public class UserController {
    private final UserService userService;
    private final AuditService auditService;

    public String pay(String id) {
        return userService.charge(id);
    }
}
`;

function parse(path: string, text: string): ParsedFile {
  return parseJavaSource(path, moduleOf(path), false, text);
}

const P_CTRL = 'src/main/java/com/acme/web/UserController.java';
const P_SVC = 'src/main/java/com/acme/service/UserService.java';
const P_AUDIT = 'src/main/java/com/acme/audit/AuditService.java';

describe('JVM package modules restore cross-package member-call resolution', () => {
  it('assigns package modules, not "main"', () => {
    expect(moduleOf(P_CTRL)).toBe('com/acme/web');
    expect(moduleOf(P_SVC)).toBe('com/acme/service');
  });

  it('wires the package→package import edge', () => {
    const files = [parse(P_CTRL, CONTROLLER), parse(P_SVC, SERVICE)];
    const g = buildGraph(files);
    expect([...(g.imports.get('com/acme/web') ?? [])]).toContain('com/acme/service');
  });

  it('resolves userService.charge() to UserService#charge (was unresolvable under flat "main")', () => {
    const files = [parse(P_CTRL, CONTROLLER), parse(P_SVC, SERVICE)];
    const graph = buildKnowledgeGraph(files, buildGraph(files), {});

    const idOf = (file: string, label: string) =>
      [...graph.nodes.values()].find((n) => n.kind === 'function' && n.file === file && n.label === label)?.id;
    const payer = idOf(P_CTRL, 'pay')!;
    const charge = idOf(P_SVC, 'charge')!;
    expect(payer).toBeDefined();
    expect(charge).toBeDefined();

    expect([...(graph.callsIn.get(charge) ?? [])]).toContain(payer);
    // `userService` is a field of declared type UserService, so the receiver-type
    // bridge resolves it precisely (0.85) — stronger than the import-scoped 0.7
    // that package modules alone would give. Either way it is a graded edge, not
    // proof; the point is that under flat "main" NOTHING resolved it.
    expect(graph.callMeta.get(`${payer}|${charge}`)?.reason).toBe('receiver-type');
    expect(graph.callMeta.get(`${payer}|${charge}`)?.confidence).toBe(0.85);
  });

  it('DISAMBIGUATION: userService.charge() binds to UserService#charge by the receiver’s type, not the same-named AuditService#charge', () => {
    const files = [
      parse(P_CTRL, CONTROLLER_AMBIG),
      parse(P_SVC, SERVICE),
      parse(P_AUDIT, AUDIT),
    ];
    const graph = buildKnowledgeGraph(files, buildGraph(files), {});
    const idOf = (file: string, label: string) =>
      [...graph.nodes.values()].find((n) => n.kind === 'function' && n.file === file && n.label === label)?.id;
    const payer = idOf(P_CTRL, 'pay')!;
    const svcCharge = idOf(P_SVC, 'charge')!;
    const auditCharge = idOf(P_AUDIT, 'charge')!;

    // `userService` is a field of type UserService; both UserService and
    // AuditService define charge(), but the receiver's DECLARED type resolves it
    // to the right one — and never to the AuditService twin.
    expect([...(graph.callsIn.get(svcCharge) ?? [])]).toContain(payer);
    expect(graph.callMeta.get(`${payer}|${svcCharge}`)?.reason).toBe('receiver-type');
    expect([...(graph.callsIn.get(auditCharge) ?? [])]).not.toContain(payer);
  });
});
