import { describe, expect, it } from 'vitest';
import { parseTsSource } from '../src/parse/ts.js';
import { buildGraph } from '../src/graph/imports.js';
import { contamination } from '../src/metrics/contamination.js';

/**
 * Regression fixture from the 2026-08-11 benchmark, where a real Claude Code
 * session wrote:
 *   "I read every adapter file rather than trusting the graph tool's output —
 *    most of its hits were name-only false positives (createWSContext ≈
 *    createCssContext are unrelated). Shared names like getConnInfo, handle,
 *    serveStatic are the intended adapter interface."
 * A name resemblance must never, on its own, produce a duplication finding.
 */

// Similar NAMES, structurally different bodies, different modules — plus
// near-identical import lists so the import-overlap modifier fires too
// (that combination is exactly what pushed these over the reporting bar).
const WS = `import { helper } from '../util'
import { other } from '../other'
export function createWSContext(raw) {
  const socket = helper(raw)
  socket.binaryType = 'arraybuffer'
  const listeners = new Map()
  socket.onmessage = (ev) => { for (const l of listeners.values()) l(ev.data) }
  socket.onclose = () => listeners.clear()
  return { send: (d) => socket.send(d), on: (k, f) => listeners.set(k, f), close: () => socket.close() }
}
`;

const CSS = `import { helper } from '../util'
import { other } from '../other'
export function createCssContext(sheet) {
  const rules = []
  const seen = new Set()
  for (const rule of sheet.rules) {
    if (seen.has(rule.selector)) continue
    seen.add(rule.selector)
    rules.push(helper(rule) + '{' + rule.body + '}')
  }
  return { toString: () => rules.join(''), size: rules.length, clear: () => rules.splice(0) }
}
`;

// The adapter-interface shape: IDENTICAL names, different runtimes.
const BUN = `export function getConnInfo(c) {
  const server = c.env.server
  const address = server.requestIP(c.req.raw)
  return { remote: { address: address?.address, port: address?.port, family: address?.family } }
}
`;

const DENO = `export function getConnInfo(c) {
  const info = c.env.remoteAddr
  const conn = info.transport === 'tcp' ? info : null
  return { remote: { address: conn?.hostname, port: conn?.port, family: 'IPv4' } }
}
`;

function findingsFor(files: { path: string; module: string; text: string }[]) {
  const parsed = files.map((f) => parseTsSource(f.path, f.module, false, f.text));
  return contamination(parsed, buildGraph(parsed)).findings;
}

describe('naming signals corroborate, never create, a finding', () => {
  it('createWSContext / createCssContext are not reported as duplication', () => {
    const findings = findingsFor([
      { path: 'ws/context.ts', module: 'ws', text: WS },
      { path: 'css/context.ts', module: 'css', text: CSS },
    ]);
    expect(findings).toHaveLength(0);
  });

  it('same-named adapter implementations are an interface, not a clone', () => {
    const findings = findingsFor([
      { path: 'adapter/bun/conninfo.ts', module: 'adapter/bun', text: BUN },
      { path: 'adapter/deno/conninfo.ts', module: 'adapter/deno', text: DENO },
    ]);
    expect(findings).toHaveLength(0);
  });

  it('a REAL structural clone is still reported, with its signal scores', () => {
    const findings = findingsFor([
      { path: 'a/dup.ts', module: 'a', text: WS },
      { path: 'b/dup.ts', module: 'b', text: WS }, // byte-identical body
    ]);
    expect(findings.length).toBeGreaterThan(0);
    const f = findings[0]!;
    expect(f.kind).toBe('clone');
    expect(f.signals).toContain('ast-clone');
    expect(f.signalScores?.ast).toBe(1);
    // The name signal may corroborate, but can never dominate.
    expect(f.signalScores?.name ?? 0).toBeLessThanOrEqual(1);
  });
});
