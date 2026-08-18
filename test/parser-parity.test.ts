import { beforeAll, describe, expect, it } from 'vitest';
import type { ParsedFile } from '../src/types.js';
import { loadLanguages } from '../src/parse/treesitter/loader.js';
import { TREE_SITTER_LANGS } from '../src/parse/dispatch.js';
import { parseTsSource } from '../src/parse/ts.js';
import { parsePythonSource } from '../src/parse/python.js';
import { parseGoSource } from '../src/parse/go.js';
import { parseJavaSource } from '../src/parse/java.js';
import { parseRubySource } from '../src/parse/ruby.js';
import { parseRustSource } from '../src/parse/rust.js';
import { parsePhpSource } from '../src/parse/php.js';
import { parseCSource } from '../src/parse/c.js';
import { parseCppSource } from '../src/parse/cpp.js';
import { parseCSharpSource } from '../src/parse/csharp.js';
import { parseDartSource } from '../src/parse/dart.js';
import { parseKotlinSource } from '../src/parse/kotlin.js';
import { parseSwiftSource } from '../src/parse/swift.js';
import { parseVueSource } from '../src/parse/vue.js';
import { parseCobolSource } from '../src/parse/cobol.js';

/**
 * Cross-language parity: every parser must populate the same fields as every
 * other, so a tool's answer does not silently get worse depending on which
 * language the file happens to be written in.
 *
 * `find_references`, `file_outline` and `read_function` are language-agnostic
 * promises: whatever repo you point us at, a reference comes back with the line
 * it is written on and an outline says honestly how much of the file it mapped.
 * Before this suite those fields existed only for TypeScript and C#, so the
 * tools quietly degraded on every other language — a silent cap, which this
 * codebase treats as a defect.
 *
 * Expected line numbers are DERIVED FROM THE FIXTURE TEXT, never hardcoded: the
 * test looks up the line a statement is actually written on and demands the
 * parser report that exact line. A parser returning a plausible-but-wrong
 * number fails here instead of misleading an agent later.
 */

interface Case {
  lang: string;
  src: string;
  parse: (src: string) => ParsedFile;
  /** Substring identifying the line the import statement is written on. */
  importOn: string;
  /** Call whose site must be reported, and the line it is written on. */
  call: { name: string; on: string };
  /** Declaration expected in `symbols` — omitted for languages with no types. */
  type?: { name: string; on: string };
}

/** 1-based line of the first line containing `needle`. */
function lineWith(src: string, needle: string): number {
  const idx = src.split('\n').findIndex((l) => l.includes(needle));
  if (idx < 0) throw new Error(`fixture bug: no line contains ${JSON.stringify(needle)}`);
  return idx + 1;
}

const CASES: Case[] = [
  {
    lang: 'typescript',
    src: `import { helper } from './util'

export interface Shape {
  n: number
}

export function run(): number {
  return helper(1)
}
`,
    parse: (s) => parseTsSource('src/app/a.ts', 'app', false, s),
    importOn: "from './util'",
    call: { name: 'helper', on: 'return helper(1)' },
    type: { name: 'Shape', on: 'export interface Shape' },
  },
  {
    lang: 'python',
    src: `from .util import helper


class Shape:
    n = 1


def run():
    return helper(1)
`,
    parse: (s) => parsePythonSource('src/app/a.py', 'app', false, s),
    importOn: 'from .util import helper',
    call: { name: 'helper', on: 'return helper(1)' },
    type: { name: 'Shape', on: 'class Shape:' },
  },
  {
    lang: 'go',
    src: `package main

import "fmt"

type Shape struct {
\tN int
}

func Run() int {
\treturn helper(1)
}
`,
    parse: (s) => parseGoSource('src/app/a.go', 'app', false, s),
    importOn: 'import "fmt"',
    call: { name: 'helper', on: 'return helper(1)' },
    type: { name: 'Shape', on: 'type Shape struct' },
  },
  {
    lang: 'java',
    src: `package app;

import java.util.List;

public class Shape {
  public int run() {
    return helper(1);
  }
}
`,
    parse: (s) => parseJavaSource('src/app/A.java', 'app', false, s),
    importOn: 'import java.util.List;',
    call: { name: 'helper', on: 'return helper(1)' },
    type: { name: 'Shape', on: 'public class Shape' },
  },
  {
    lang: 'ruby',
    src: `require_relative 'util'

class Shape
  def run
    helper(1)
  end
end
`,
    parse: (s) => parseRubySource('src/app/a.rb', 'app', false, s),
    importOn: "require_relative 'util'",
    call: { name: 'helper', on: 'helper(1)' },
    type: { name: 'Shape', on: 'class Shape' },
  },
  {
    lang: 'rust',
    src: `use crate::util::helper;

pub struct Shape {
    pub n: i32,
}

pub fn run() -> i32 {
    helper(1)
}
`,
    parse: (s) => parseRustSource('src/app/a.rs', 'app', false, s),
    importOn: 'use crate::util::helper;',
    call: { name: 'helper', on: 'helper(1)' },
    type: { name: 'Shape', on: 'pub struct Shape' },
  },
  {
    lang: 'php',
    src: `<?php
namespace App;

use App\\Util\\Helper;

class Shape {
    public function run() {
        return helper(1);
    }
}
`,
    parse: (s) => parsePhpSource('src/app/A.php', 'app', false, s),
    importOn: 'use App\\Util\\Helper;',
    call: { name: 'helper', on: 'return helper(1)' },
    type: { name: 'Shape', on: 'class Shape {' },
  },
  {
    lang: 'c',
    src: `#include "util.h"

struct Shape { int n; };

int run(void) {
  return helper(1);
}
`,
    parse: (s) => parseCSource('src/app/a.c', 'app', false, s),
    importOn: '#include "util.h"',
    call: { name: 'helper', on: 'return helper(1)' },
    type: { name: 'Shape', on: 'struct Shape { int n; };' },
  },
  {
    lang: 'cpp',
    src: `#include "util.h"

class Shape {
public:
  int run() { return helper(1); }
};
`,
    parse: (s) => parseCppSource('src/app/a.cpp', 'app', false, s),
    importOn: '#include "util.h"',
    call: { name: 'helper', on: 'return helper(1)' },
    type: { name: 'Shape', on: 'class Shape {' },
  },
  {
    lang: 'csharp',
    src: `using App.Util;

namespace App {
  public class Shape {
    public int Run() {
      return Helper(1);
    }
  }
}
`,
    parse: (s) => parseCSharpSource('src/app/A.cs', 'app', false, s),
    importOn: 'using App.Util;',
    call: { name: 'Helper', on: 'return Helper(1)' },
    type: { name: 'Shape', on: 'public class Shape' },
  },
  {
    lang: 'dart',
    src: `import 'util.dart';

class Shape {
  int run() {
    return helper(1);
  }
}
`,
    parse: (s) => parseDartSource('src/app/a.dart', 'app', false, s),
    importOn: "import 'util.dart';",
    call: { name: 'helper', on: 'return helper(1)' },
    type: { name: 'Shape', on: 'class Shape {' },
  },
  {
    lang: 'kotlin',
    src: `import kotlin.math.max

class Shape {
    fun run(): Int {
        return helper(1)
    }
}
`,
    parse: (s) => parseKotlinSource('src/app/A.kt', 'app', false, s),
    importOn: 'import kotlin.math.max',
    call: { name: 'helper', on: 'return helper(1)' },
    type: { name: 'Shape', on: 'class Shape {' },
  },
  {
    lang: 'swift',
    src: `import Foundation

class Shape {
    func run() -> Int {
        return helper(1)
    }
}
`,
    parse: (s) => parseSwiftSource('src/app/A.swift', 'app', false, s),
    importOn: 'import Foundation',
    call: { name: 'helper', on: 'return helper(1)' },
    type: { name: 'Shape', on: 'class Shape {' },
  },
  {
    lang: 'vue',
    src: `<template><div/></template>

<script lang="ts">
import { helper } from './util'

export interface Shape {
  n: number
}

export function run(): number {
  return helper(1)
}
</script>
`,
    parse: (s) => parseVueSource('src/app/A.vue', 'app', false, s),
    importOn: "from './util'",
    call: { name: 'helper', on: 'return helper(1)' },
    type: { name: 'Shape', on: 'export interface Shape' },
  },
  {
    lang: 'cobol',
    src: `       IDENTIFICATION DIVISION.
       PROGRAM-ID. DEMO.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       COPY UTIL.
       PROCEDURE DIVISION.
       MAIN-PARA.
           PERFORM HELPER-PARA.
       HELPER-PARA.
           DISPLAY 'X'.
`,
    parse: (s) => parseCobolSource('src/app/a.cob', 'app', false, s),
    importOn: 'COPY UTIL.',
    call: { name: 'HELPER-PARA', on: 'PERFORM HELPER-PARA.' },
    // COBOL has no class/type declarations in our model.
  },
];

beforeAll(async () => {
  await loadLanguages([...TREE_SITTER_LANGS]);
});

describe.each(CASES)('$lang — Phase 2.0 parity', (c) => {
  const parsed = (): ParsedFile => c.parse(c.src);

  it('reports the exact line each import is written on', () => {
    const imports = parsed().imports;
    expect(imports.length).toBeGreaterThan(0);
    for (const imp of imports) {
      expect(imp.line, `import ${imp.specifier} has no line`).toBeTypeOf('number');
    }
    const want = lineWith(c.src, c.importOn);
    expect(imports.map((i) => i.line)).toContain(want);
  });

  it('reports the exact line each call is written on', () => {
    const sites = parsed().functions.flatMap((f) => f.callSites ?? []);
    expect(sites.length, 'no call sites recorded at all').toBeGreaterThan(0);
    const hit = sites.filter((s) => s.name === c.call.name);
    expect(hit.length, `no call site named ${c.call.name}`).toBeGreaterThan(0);
    expect(hit.map((s) => s.line)).toContain(lineWith(c.src, c.call.on));
  });

  it('every call site line is inside the file', () => {
    const total = c.src.split('\n').length;
    for (const s of parsed().functions.flatMap((f) => f.callSites ?? [])) {
      expect(s.line, `${s.name} at line ${s.line}`).toBeGreaterThanOrEqual(1);
      expect(s.line, `${s.name} at line ${s.line}`).toBeLessThanOrEqual(total);
    }
  });

  it('knows the true length of the file', () => {
    expect(parsed().totalLines).toBe(c.src.split('\n').length);
  });

  it('every recorded call name is also in `calls` (graph and references agree)', () => {
    for (const fn of parsed().functions) {
      for (const s of fn.callSites ?? []) {
        expect(fn.calls, `${fn.name} lists ${s.name} as a site but not a call`).toContain(s.name);
      }
    }
  });

  if (c.type) {
    const t = c.type;
    it(`records a span for ${t.name} at the line it is declared`, () => {
      const symbols = parsed().symbols;
      expect(symbols, 'symbols not indexed for this language').toBeDefined();
      const hit = symbols!.find((s) => s.name === t.name);
      expect(hit, `no symbol named ${t.name} in ${JSON.stringify(symbols)}`).toBeDefined();
      expect(hit!.startLine).toBe(lineWith(c.src, t.on));
      expect(hit!.endLine).toBeGreaterThanOrEqual(hit!.startLine);
      expect(hit!.endLine).toBeLessThanOrEqual(c.src.split('\n').length);
    });
  } else {
    it('leaves `symbols` absent rather than claiming the file has no types', () => {
      expect(parsed().symbols).toBeUndefined();
    });
  }
});

describe('the member-call distinction protects resolution', () => {
  /**
   * The most damaging failure this guards against is a phantom edge: a builtin
   * like `arr.every()` wired to a repo function that merely happens to share
   * the name `every`. It showed up in real use, not in a unit test — an agent
   * reading the graph was handed the wrong callee. That was fixed for
   * TypeScript by marking receiver calls; until now every other language was
   * still exposed to it, because its parser reported no `memberCalls` at all
   * and the graph therefore treated `x.count()` as a bare call eligible for a
   * unique-name match.
   */
  it('a builtin called on a receiver is not eligible for a unique-name match', () => {
    const py = parsePythonSource(
      'src/app/a.py',
      'app',
      false,
      'def count(items):\n    return len(items)\n\n\ndef run(items):\n    return items.count(3)\n',
    );
    const run = py.functions.find((f) => f.name === 'run');
    expect(run).toBeDefined();
    // It IS a call — we do not hide it...
    expect(run!.calls).toContain('count');
    // ...but it is marked as arriving through a receiver, which is what stops
    // the graph wiring it to the module's own `count`.
    expect(run!.memberCalls).toContain('count');
    expect(run!.callSites?.find((s) => s.name === 'count')?.member).toBe(true);
  });
});

describe('member vs bare calls are distinguished everywhere', () => {
  it('a receiver call is a member call, a bare call is not', () => {
    const cases: { lang: string; parsed: ParsedFile }[] = [
      { lang: 'go', parsed: parseGoSource('a.go', 'm', false, 'package m\nfunc R() {\n\tbare()\n\tx.Member()\n}\n') },
      { lang: 'python', parsed: parsePythonSource('a.py', 'm', false, 'def r():\n    bare()\n    x.member()\n') },
      { lang: 'java', parsed: parseJavaSource('A.java', 'm', false, 'class A {\n  void r() {\n    bare();\n    x.member();\n  }\n}\n') },
      { lang: 'ruby', parsed: parseRubySource('a.rb', 'm', false, 'def r\n  bare(1)\n  x.member(1)\nend\n') },
    ];
    for (const { lang, parsed } of cases) {
      const sites = parsed.functions.flatMap((f) => f.callSites ?? []);
      const bare = sites.find((s) => s.name === 'bare' || s.name === 'bare');
      const member = sites.find((s) => s.name.toLowerCase() === 'member');
      expect(bare, `${lang}: no bare call`).toBeDefined();
      expect(member, `${lang}: no member call`).toBeDefined();
      expect(bare!.member, `${lang}: bare call marked as member`).toBe(false);
      expect(member!.member, `${lang}: receiver call not marked as member`).toBe(true);
    }
  });
});
