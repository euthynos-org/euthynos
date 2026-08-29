import { beforeAll, describe, expect, it } from 'vitest';
import { loadLanguages } from '../src/parse/treesitter/loader.js';
import { parsePhpSource } from '../src/parse/php.js';
import { buildGraph } from '../src/graph/imports.js';
import { buildKnowledgeGraph } from '../src/graph/knowledge.js';
import type { CodeGraph, ParsedFile } from '../src/types.js';

/** Wave 2: SOUND receiver-type bridge for PHP ($this->field, typed param, $x = new Foo()).
 * External types resolve to nothing. */

beforeAll(async () => {
  await loadLanguages(['php']);
});

const P = (file: string, s: string): ParsedFile => parsePhpSource(file, file.split('/')[0], false, s);
const fn = (g: CodeGraph, file: string, label: string) =>
  [...g.nodes.values()].find((n) => n.kind === 'function' && n.file.endsWith(file) && n.label === label);

const USER_SVC = `<?php
class UserService { function charge(string $id): string { return $id; } }`;

describe('PHP receiver-type bridge', () => {
  it('resolves property, parameter, and $x = new Foo() receivers at 0.85', () => {
    const WEB = `<?php
class Web {
  private UserService $svc;
  function go(UserService $param) {
    $local = new UserService();
    $local->charge("a");
    $param->charge("b");
    $this->svc->charge("c");
  }
}`;
    const files = [P('svc/UserService.php', USER_SVC), P('web/Web.php', WEB)];
    const g = buildKnowledgeGraph(files, buildGraph(files), {});
    const go = fn(g, 'Web.php', 'go')!;
    const charge = fn(g, 'UserService.php', 'charge')!;
    expect(go).toBeDefined();
    expect(g.callMeta.get(`${go.id}|${charge.id}`)).toEqual({ confidence: 0.85, reason: 'receiver-type' });
  });

  it('UNION-TYPE GUARD: a union-typed receiver (A|B) binds to neither arm', () => {
    const OTHER = `<?php
class Other { function charge(string $id): string { return $id; } }`;
    const WEB = `<?php
class Web { function go(UserService|Other $x) { $x->charge("a"); } }`;
    const files = [P('svc/UserService.php', USER_SVC), P('svc/Other.php', OTHER), P('web/Web.php', WEB)];
    const g = buildKnowledgeGraph(files, buildGraph(files), {});
    const go = fn(g, 'Web.php', 'go')!;
    const uCharge = fn(g, 'UserService.php', 'charge')!;
    const oCharge = fn(g, 'Other.php', 'charge')!;
    // A union receiver may hold either type — bind to NEITHER, never guess one arm.
    expect([...(g.callsIn.get(uCharge.id) ?? [])]).not.toContain(go.id);
    expect([...(g.callsIn.get(oCharge.id) ?? [])]).not.toContain(go.id);
  });

  it('promoted constructor property $this->svc resolves (coverage)', () => {
    const WEB = `<?php
class Web {
  public function __construct(private UserService $svc) {}
  function go() { $this->svc->charge("a"); }
}`;
    const files = [P('svc/UserService.php', USER_SVC), P('web/Web.php', WEB)];
    const g = buildKnowledgeGraph(files, buildGraph(files), {});
    const go = fn(g, 'Web.php', 'go')!;
    const charge = fn(g, 'UserService.php', 'charge')!;
    expect(g.callMeta.get(`${go.id}|${charge.id}`)?.reason).toBe('receiver-type');
  });

  it('PHANTOM GUARD: an external/unknown-type receiver resolves to nothing', () => {
    const WEB = `<?php
class Web { function go(SomeExternal $ext) { $ext->charge("x"); } }`;
    const files = [P('svc/UserService.php', USER_SVC), P('web/Web.php', WEB)];
    const g = buildKnowledgeGraph(files, buildGraph(files), {});
    const go = fn(g, 'Web.php', 'go')!;
    const charge = fn(g, 'UserService.php', 'charge')!;
    expect([...(g.callsIn.get(charge.id) ?? [])]).not.toContain(go.id);
  });
});
