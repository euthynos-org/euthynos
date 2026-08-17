import { describe, expect, it, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callTool } from '../src/mcp/tools.js';
import { parseFile } from '../src/parse/ts.js';

/**
 * M2-found defect (M2-RESULTS.md finding 4): every valid blast-radius
 * session, both arms, found `client.ts:101` calling `serialize` — and the
 * engine's callers_of did not. Root cause: the class-member loop in
 * src/parse/ts.ts extracted method DECLARATIONS but skipped class
 * PROPERTIES initialized with arrow functions / function expressions
 * (`fetch = async (...) => { ... serialize(...) }` in hono's
 * ClientRequestImpl), so their bodies' calls never entered the graph.
 *
 * Contract pinned here BEFORE the fix:
 *  - a class-property arrow function is a call-graph node under its
 *    property name (Class.prop convention, same as methods);
 *  - its calls resolve through import edges like any function;
 *  - the EXPORT SURFACE is unchanged — property functions, like methods,
 *    are never added to `exports` (depth/leverage metrics keep their
 *    frozen definition);
 *  - private (`#x =` / `private x =`) property functions are non-exported
 *    nodes, mirroring the method rule.
 */

let repo: string;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'clsprop-'));
  writeFileSync(
    join(repo, 'util.ts'),
    'export function encodeThing(v: string): string {\n  return encodeURIComponent(v);\n}\n',
  );
  writeFileSync(
    join(repo, 'client.ts'),
    [
      "import { encodeThing } from './util'",
      'export class RequestImpl {',
      '  private url: string = \'\'',
      '  // the defect shape: property + arrow function, NOT a method',
      '  send = async (value: string): Promise<string> => {',
      '    const encoded = encodeThing(value)',
      '    return this.url + encoded',
      '  }',
      '  // function-expression variant',
      '  render = function (value: string): string {',
      '    return encodeThing(value)',
      '  }',
      '  // control: a method declaration (already worked pre-fix)',
      '  probe(value: string): string {',
      '    return encodeThing(value)',
      '  }',
      '  // private property fn: node exists, not exported',
      '  #inner = (value: string): string => {',
      '    return encodeThing(value)',
      '  }',
      '  useInner(value: string): string {',
      '    return this.#inner(value)',
      '  }',
      '}',
      '',
    ].join('\n'),
  );
});

function parseClient() {
  const abs = join(repo, 'client.ts');
  return parseFile({
    abs,
    rel: 'client.ts',
    module: 'client',
    isTest: false,
    lang: 'ts',
    size: 0,
    mtimeMs: 0,
  } as Parameters<typeof parseFile>[0]);
}

describe('class-property function extraction (M2 defect)', () => {
  // Naming convention is the FROZEN one class methods already use: the
  // bare member name (hono's `route` / `#dispatch`), not Class.member.
  it('callers_of finds the arrow-property caller the M2 sessions found by reading', () => {
    const r = callTool('callers_of', { path: repo, function: 'encodeThing' });
    expect(r.isError ?? false).toBe(false);
    expect(r.text).toContain('send');
    expect(r.text).toContain('client.ts');
  });

  it('function-expression properties are nodes too', () => {
    const r = callTool('callers_of', { path: repo, function: 'encodeThing' });
    expect(r.text).toContain('render');
  });

  it('method declarations still attributed (control, unchanged behavior)', () => {
    const r = callTool('callers_of', { path: repo, function: 'encodeThing' });
    expect(r.text).toContain('probe');
  });

  it('export surface is unchanged: property fns are not exports', () => {
    const parsed = parseClient();
    const exportNames = parsed.exports.map((e) => e.name);
    expect(exportNames).toContain('RequestImpl');
    expect(exportNames).not.toContain('send');
    expect(exportNames).not.toContain('render');
  });

  it('private property fns are non-exported graph nodes', () => {
    const parsed = parseClient();
    const inner = parsed.functions.find((f) => f.name === '#inner');
    expect(inner).toBeDefined();
    expect(inner!.exported).toBe(false);
  });

  it('the real-world shape end to end: callees_of the property fn', () => {
    const r = callTool('callees_of', { path: repo, function: 'send' });
    expect(r.isError ?? false).toBe(false);
    expect(r.text).toContain('encodeThing');
  });
});
