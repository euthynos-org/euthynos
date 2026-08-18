import { describe, expect, it } from 'vitest';
import { buildGraph } from '../src/graph/imports.js';
import type { ImportRecord, ParsedFile } from '../src/types.js';

// Module-path import resolution for Java, Go, Rust, PHP and C/C++. These
// languages name a package or a symbol file, not a path relative to the
// importer — buildGraph must still wire the module graph so
// leverage/seams/utilization count for them. The negative cases below pin
// where resolution must stop: a bare last segment (java.util.List), a suffix
// that matches two modules, and an external module with no local file all
// stay unresolved.

function file(path: string, module: string, imports: ImportRecord[] = [], exports: string[] = []): ParsedFile {
  return {
    path,
    module,
    isTest: false,
    isIndex: false,
    codeLines: 10,
    exports: exports.map((name) => ({ name, kind: 'function', requiredParams: 0, totalParams: 0 })),
    internalFunctions: 0,
    functions: [],
    imports,
  };
}

function imp(fromFile: string, specifier: string, named: string[]): ImportRecord {
  return { fromFile, specifier, named, isTypeOnly: false };
}

describe('module-path resolution wires the module graph', () => {
  it('Java: a dotted FQN import resolves to the owning module', () => {
    const checkout = 'src/main/java/com/acme/orders/Checkout.java';
    const engine = 'src/main/java/com/acme/payment/Engine.java';
    const g = buildGraph([
      file(checkout, 'orders', [imp(checkout, 'com.acme.payment.Engine', ['Engine'])]),
      file(engine, 'payment', [], ['Engine']),
    ]);
    expect([...(g.imports.get('orders') ?? [])]).toContain('payment');
    expect([...(g.importedBy.get('payment') ?? [])]).toContain('orders');
    expect([...(g.usedExports.get('payment') ?? [])]).toContain('Engine');
  });

  it('Go: a module-path import resolves to the package directory', () => {
    const checkout = 'internal/orders/checkout.go';
    const engine = 'internal/payment/engine.go';
    const g = buildGraph([
      file(checkout, 'orders', [imp(checkout, 'myrepo/internal/payment', ['payment'])]),
      file(engine, 'payment', [], ['ComputeFee']),
    ]);
    expect([...(g.imports.get('orders') ?? [])]).toContain('payment');
  });

  it('Rust: a crate path resolves, dropping the crate root', () => {
    const checkout = 'src/orders/checkout.rs';
    const engine = 'src/payment/engine.rs';
    const g = buildGraph([
      file(checkout, 'orders', [imp(checkout, 'crate/payment/engine', ['engine'])]),
      file(engine, 'payment', [], ['compute_fee']),
    ]);
    expect([...(g.imports.get('orders') ?? [])]).toContain('payment');
  });

  it('PHP: a namespace import (backslashes normalized) resolves', () => {
    const checkout = 'src/Orders/Checkout.php';
    const engine = 'src/Payment/Engine.php';
    const g = buildGraph([
      file(checkout, 'orders', [imp(checkout, 'App/Payment/Engine', ['Engine'])]),
      file(engine, 'payment', [], ['Engine']),
    ]);
    expect([...(g.imports.get('orders') ?? [])]).toContain('payment');
  });

  it('C/C++: a local include resolves by its path-with-extension', () => {
    const checkout = 'src/orders/checkout.cpp';
    const engine = 'src/payment/engine.h';
    const g = buildGraph([
      file(checkout, 'orders', [imp(checkout, 'payment/engine.h', ['engine'])]),
      file(engine, 'payment', [], ['compute']),
    ]);
    expect([...(g.imports.get('orders') ?? [])]).toContain('payment');
  });

  it('does NOT resolve a stdlib import that only matches a bare last segment', () => {
    const app = 'src/app/Main.java';
    const list = 'src/util/List.java'; // a coincidental local file named List
    const g = buildGraph([
      file(app, 'app', [imp(app, 'java.util.List', ['List'])]),
      file(list, 'util', [], ['List']),
    ]);
    // `java.util.List` must not grab src/util/List.java on the bare `List` tail.
    expect([...(g.imports.get('app') ?? [])]).not.toContain('util');
  });

  it('does NOT resolve when a suffix is ambiguous across modules', () => {
    const caller = 'src/a/Caller.java';
    const e1 = 'src/billing/Engine.java';
    const e2 = 'src/orders/Engine.java';
    const g = buildGraph([
      file(caller, 'a', [imp(caller, 'Engine', ['Engine'])]),
      file(e1, 'billing', [], ['Engine']),
      file(e2, 'orders', [], ['Engine']),
    ]);
    expect(g.imports.get('a') ?? new Set()).toEqual(new Set());
  });

  it('does NOT resolve an external module with no local match', () => {
    const a = 'src/ui/View.swift';
    const g = buildGraph([file(a, 'ui', [imp(a, 'Foundation', ['Foundation'])])]);
    expect(g.imports.get('ui')).toBeUndefined();
  });

  it('still resolves relative imports unchanged', () => {
    const checkout = 'lib/orders/checkout.ts';
    const engine = 'lib/payment/engine.ts';
    const g = buildGraph([
      file(checkout, 'orders', [imp(checkout, '../payment/engine', ['computeFee'])]),
      file(engine, 'payment', [], ['computeFee']),
    ]);
    expect([...(g.imports.get('orders') ?? [])]).toContain('payment');
  });
});
