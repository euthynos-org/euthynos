import { describe, expect, it } from 'vitest';
import { parseTsSource } from '../src/parse/ts.js';
import { buildGraph } from '../src/graph/imports.js';
import { buildKnowledgeGraph } from '../src/graph/knowledge.js';
import type { CodeGraph } from '../src/types.js';

/**
 * Cardinal-rule guard: a receiver call recv.method() must NOT be wired to a
 * same-named function just because the caller's file imports one. The receiver's
 * type is unknown (the parser records only the method name), so a name match is a
 * guess — `headers.get()` must not bind to an imported local `get()`. An earlier
 * "receiver bridge" did exactly that (an adversarial review caught it); safe
 * receiver resolution needs receiver-type inference and is deferred to Wave 2.
 */

const CONFIG = `export function get(key) { return process.env[key] }\n`;

const idOf = (g: CodeGraph, file: string, label: string) =>
  [...g.nodes.values()].find((n) => n.kind === 'function' && n.file === file && n.label === label)?.id;

describe('receiver calls do not invent name-only edges', () => {
  it('headers.get() invents no edge to an imported same-named local get()', () => {
    // Pure member call to get(): the caller imports a local get() from the SAME
    // module but calls the builtin Fetch Headers .get() on an unrelated receiver.
    // Binding on the name alone would be a phantom edge (the receiver is not the
    // imported function) — the resolver must wire NOTHING.
    const HANDLER = `import { get } from './config'\nexport function handle(headers) { return headers.get('content-type') }\n`;
    const files = [
      parseTsSource('api/config.ts', 'api', false, CONFIG),
      parseTsSource('api/handler.ts', 'api', false, HANDLER),
    ];
    const g = buildKnowledgeGraph(files, buildGraph(files), {});
    const handle = idOf(g, 'api/handler.ts', 'handle')!;
    const cfgGet = idOf(g, 'api/config.ts', 'get')!;
    expect(handle).toBeDefined();
    expect([...(g.callsIn.get(cfgGet) ?? [])]).not.toContain(handle); // no phantom edge
    for (const m of g.callMeta.values()) expect(m.reason).not.toBe('receiver-import'); // rule retired
  });
});
