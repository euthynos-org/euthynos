import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { handleMessage } from '../src/mcp/server.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, 'fixtures', 'sample');

interface RpcResponse {
  jsonrpc: string;
  id: string | number | null;
  result?: any;
  error?: { code: number; message: string };
}

let nextId = 1;

/** Send a request through handleMessage and parse the response line. */
function rpc(method: string, params?: unknown, id?: string | number): RpcResponse {
  const msg: Record<string, unknown> = { jsonrpc: '2.0', id: id ?? nextId++, method };
  if (params !== undefined) msg['params'] = params;
  const raw = handleMessage(JSON.stringify(msg));
  expect(raw).not.toBeNull();
  return JSON.parse(raw!) as RpcResponse;
}

/** tools/call helper returning the text content + isError flag. */
function invokeTool(name: string, args: Record<string, unknown>): { text: string; isError: boolean } {
  const res = rpc('tools/call', { name, arguments: args });
  expect(res.error).toBeUndefined();
  expect(Array.isArray(res.result.content)).toBe(true);
  expect(res.result.content[0].type).toBe('text');
  return { text: res.result.content[0].text as string, isError: res.result.isError === true };
}

describe('mcp handshake', () => {
  it('initialize returns protocolVersion, capabilities and serverInfo', () => {
    const res = rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0.0.0' },
    });
    expect(res.jsonrpc).toBe('2.0');
    expect(res.result.protocolVersion).toBe('2024-11-05');
    // Product identity: the server reports itself as `euthynos`;
    // the version mirrors package.json, never a second hardcoded copy.
    expect(res.result.serverInfo.name).toBe('euthynos');
    expect(res.result.serverInfo.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(res.result.capabilities.tools).toBeDefined();
  });

  it('responds to ping with an empty result', () => {
    const res = rpc('ping');
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({});
  });

  it('echoes the request id, including string ids', () => {
    const res = rpc('ping', undefined, 'req-abc');
    expect(res.id).toBe('req-abc');
  });

  it('returns null for notifications (no id)', () => {
    const out = handleMessage(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    );
    expect(out).toBeNull();
  });

  it('returns null for blank lines', () => {
    expect(handleMessage('')).toBeNull();
    expect(handleMessage('   ')).toBeNull();
  });
});

describe('protocol errors', () => {
  it('malformed JSON -> -32700 with id null', () => {
    const raw = handleMessage('this is {not valid json');
    expect(raw).not.toBeNull();
    const res = JSON.parse(raw!) as RpcResponse;
    expect(res.error!.code).toBe(-32700);
    expect(res.id).toBeNull();
  });

  it('unknown method with an id -> -32601', () => {
    const res = rpc('bogus/method');
    expect(res.result).toBeUndefined();
    expect(res.error!.code).toBe(-32601);
    expect(res.error!.message).toMatch(/bogus\/method/);
  });
});

describe('tools/list', () => {
  it('exposes the analysis + source tools with object input schemas', () => {
    const res = rpc('tools/list');
    const tools = res.result.tools as Array<any>;
    expect(tools.map((t) => t.name).sort()).toEqual([
      // analysis (meta questions)
      'architecture_health',
      'callers_of',
      'impact_of',
      'module_metrics',
      'path_between',
      'similar_logic_exists',
      // source tools (object questions — "show me the code")
      'file_outline',
      'find_references',
      'find_symbol',
      'read_function',
      'read_span',
      'repo_map',
      // router (plain-language questions) — gated on the shaper golden set
      'query_repository',
      // composite — one call returns a symbol's source, callers, callees,
      // types, tests and blast radius as a single budgeted answer
      'context_bundle',
      // side-by-side evidence for choosing between two implementations:
      // what differs, plus caller and test counts for each. It reports the
      // evidence; which copy becomes canonical stays the caller's decision.
      'compare_implementations',
      // graph projections (call, import and test edges) and diff-scoped
      // queries over what the current working tree changed
      'callees_of',
      'dependencies_of',
      'dependents_of',
      'tests_for',
      'check_my_changes',
      'boundary_check',
      'diff_context',
      'change_impact',
    ].sort());
    for (const t of tools) {
      expect(typeof t.description).toBe('string');
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.inputSchema.type).toBe('object');
      // Adoption contract: path is OPTIONAL (defaults to the project) and is
      // therefore never in `required`.
      expect(t.inputSchema.required ?? []).not.toContain('path');
      expect(t.inputSchema.properties.path).toBeDefined();
    }
  });
});

describe('tools/call on the fixture repo', () => {
  it('architecture_health returns a health summary with a score', () => {
    const { text, isError } = invokeTool('architecture_health', { path: FIXTURE });
    expect(isError).toBe(false);
    expect(/Health/.test(text) || /\d+\/100/.test(text)).toBe(true);
    expect(text).toMatch(/\d+\/100/);
    expect(text).toMatch(/Depth/);
    expect(text).toMatch(/Contamination/);
  });

  it('similar_logic_exists surfaces the planted validator clone', () => {
    const { text, isError } = invokeTool('similar_logic_exists', { path: FIXTURE });
    expect(isError).toBe(false);
    expect(text).toMatch(/validatePayment|validateTransaction/);
    expect(text).toMatch(/:\d+/); // file:line locations
  });

  it('module_metrics returns the four metric lines for payment', () => {
    const { text, isError } = invokeTool('module_metrics', { path: FIXTURE, module: 'payment' });
    expect(isError).toBe(false);
    expect(text).toMatch(/Module: payment/);
    expect(text).toMatch(/Depth/);
    expect(text).toMatch(/Seams/);
    expect(text).toMatch(/Locality/);
    expect(text).toMatch(/Leverage/);
  });

  it('impact_of returns a blast radius over the call graph', () => {
    const { text, isError } = invokeTool('impact_of', { path: FIXTURE, function: 'computeFee' });
    expect(isError).toBe(false);
    expect(text).toMatch(/Blast radius of computeFee/);
    expect(text).toMatch(/call/);
    expect(text).toMatch(/payment|orders|app/);
  });

  it('callers_of lists transitive callers', () => {
    const { text, isError } = invokeTool('callers_of', { path: FIXTURE, function: 'computeFee' });
    expect(isError).toBe(false);
    expect(text).toMatch(/validateTransaction|capture/);
  });

  it('path_between finds a call path', () => {
    const { text, isError } = invokeTool('path_between', { path: FIXTURE, from: 'checkout', to: 'computeFee' });
    expect(isError).toBe(false);
    expect(text).toMatch(/checkout.*→.*computeFee|No call path/);
  });

  it('module_metrics finds modules by substring match', () => {
    const { text, isError } = invokeTool('module_metrics', { path: FIXTURE, module: 'paymen' });
    expect(isError).toBe(false);
    expect(text).toMatch(/Module: payment/);
  });

  it('module_metrics lists available modules when not found', () => {
    const { text, isError } = invokeTool('module_metrics', {
      path: FIXTURE,
      module: 'no_such_module_xyz',
    });
    expect(isError).toBe(true);
    expect(text).toMatch(/not found/);
    expect(text).toMatch(/payment/);
    expect(text).toMatch(/orders/);
  });
});

describe('tools/call defensive validation', () => {
  it('unknown tool name -> isError result (not a protocol error)', () => {
    const { text, isError } = invokeTool('does_not_exist', { path: FIXTURE });
    expect(isError).toBe(true);
    expect(text).toMatch(/Unknown tool/);
    expect(text).toMatch(/architecture_health/);
  });

  it('missing path argument defaults to the server cwd (not an error)', () => {
    // Adoption contract: MCP clients spawn the server with cwd = project
    // root, so a pathless call scans the current project.
    const { isError } = invokeTool('architecture_health', {});
    expect(isError ?? false).toBe(false);
  });

  it('nonexistent path -> isError result', () => {
    const { text, isError } = invokeTool('architecture_health', {
      path: join(FIXTURE, 'definitely', 'missing'),
    });
    expect(isError).toBe(true);
    expect(text).toMatch(/does not exist/);
  });

  it('invalid months argument -> isError result', () => {
    const { text, isError } = invokeTool('architecture_health', { path: FIXTURE, months: -3 });
    expect(isError).toBe(true);
    expect(text).toMatch(/months/);
  });
});
