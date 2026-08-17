import { readFileSync } from 'node:fs';
import type { DiscoveredFile, Lang } from '../discover.js';
import type { ParsedFile } from '../types.js';
import { commentTokens } from '../query/comments.js';
import ts from 'typescript';
import { parseFile, parseTsSource } from './ts.js';
import { parsePythonSource } from './python.js';
import { parseGoSource } from './go.js';
import { parseJavaSource } from './java.js';
import { parseRubySource } from './ruby.js';
import { parseRustSource } from './rust.js';
import { parsePhpSource } from './php.js';
import { parseCSource } from './c.js';
import { parseCppSource } from './cpp.js';
import { parseCSharpSource } from './csharp.js';
import { parseDartSource } from './dart.js';
import { parseKotlinSource } from './kotlin.js';
import { parseSwiftSource } from './swift.js';
import { parseVueSource } from './vue.js';
import { parseCobolSource } from './cobol.js';
import { parsePythonFile } from './python.js';
import { parseGoFile } from './go.js';
import { parseJavaFile } from './java.js';
import { parseRubyFile } from './ruby.js';
import { parseRustFile } from './rust.js';
import { parsePhpFile } from './php.js';
import { parseCFile } from './c.js';
import { parseCppFile } from './cpp.js';
import { parseCSharpFile } from './csharp.js';
import { parseDartFile } from './dart.js';
import { parseKotlinFile } from './kotlin.js';
import { parseSwiftFile } from './swift.js';
import { parseVueFile } from './vue.js';
import { parseCobolFile } from './cobol.js';

/**
 * Tree-sitter grammar NAMES to preload before scanning a polyglot repo.
 * (These are grammar names, not file extensions — e.g. lang 'rb' uses 'ruby'.)
 * Vue (delegates to the TypeScript compiler API) and COBOL (deterministic
 * line parser) need NO grammar, so they're absent here.
 */
export const TREE_SITTER_LANGS = [
  'python', 'go', 'java', 'ruby', 'rust', 'php',
  'c', 'cpp', 'c_sharp', 'dart', 'kotlin', 'swift',
] as const;

/**
 * Parse a discovered file with the right parser for its language.
 * TS/JS uses the TypeScript compiler API (high-fidelity export/param
 * semantics); other languages use tree-sitter (grammar must be pre-loaded
 * via loadLanguages — otherwise the file is skipped by scan's try/catch).
 *
 * `opts.text` is purely an optimization: the incremental index has already
 * read the file to hash it, so it passes the bytes in rather than making us
 * read them twice. Callers without it (a one-shot scan) get one extra read,
 * which is the right trade for never having a code path that silently skips
 * the comment index.
 *
 * It is an OPTIONS OBJECT rather than a second positional argument on purpose:
 * `files.map(parseDiscovered)` hands every callback the array index as the
 * second argument, so a positional `text` would silently receive a number.
 * An object shape makes that harmless instead of a crash.
 */
export function parseDiscovered(f: DiscoveredFile, opts?: { text?: string }): ParsedFile {
  const text = typeof opts?.text === 'string' ? opts.text : readFileSync(f.abs, 'utf8');
  return attachCommentTokens(parseByLang(f), f.lang, text);
}

/**
 * Parse SOURCE TEXT without touching disk (D0 diff engine: old git blobs are
 * parsed in memory, never written into the subject repository). Dispatches
 * to the same per-language Source entry points the file parsers wrap, so
 * old-blob records and disk records are byte-equivalent for equal content —
 * pinned by the D0 equivalence test.
 */
export function parseSourceByLang(
  rel: string,
  module: string,
  isTest: boolean,
  lang: Lang,
  text: string,
): ParsedFile {
  const parsed = ((): ParsedFile => {
    switch (lang) {
      case 'py': return parsePythonSource(rel, module, isTest, text);
      case 'go': return parseGoSource(rel, module, isTest, text);
      case 'java': return parseJavaSource(rel, module, isTest, text);
      case 'rb': return parseRubySource(rel, module, isTest, text);
      case 'rs': return parseRustSource(rel, module, isTest, text);
      case 'php': return parsePhpSource(rel, module, isTest, text);
      case 'c': return parseCSource(rel, module, isTest, text);
      case 'cpp': return parseCppSource(rel, module, isTest, text);
      case 'cs': return parseCSharpSource(rel, module, isTest, text);
      case 'dart': return parseDartSource(rel, module, isTest, text);
      case 'kt': return parseKotlinSource(rel, module, isTest, text);
      case 'swift': return parseSwiftSource(rel, module, isTest, text);
      case 'vue': return parseVueSource(rel, module, isTest, text);
      case 'cob': return parseCobolSource(rel, module, isTest, text);
      default:
        // 'ts' (and any future default): mirror parseFile exactly
        // (scriptKind by extension) so old-blob and disk records are
        // equivalent for equal content.
        return parseTsSource(rel, module, isTest, text, {
          scriptKind: rel.endsWith('x') ? ts.ScriptKind.TSX : undefined,
        });
    }
  })();
  return attachCommentTokens(parsed, lang, text);
}

/**
 * Attach the file's comment vocabulary. Exported so that anything building a
 * ParsedFile from source text goes through the SAME step production does — a
 * second, slightly different attach path is how a fixture ends up proving
 * something the real pipeline does not do.
 */
export function attachCommentTokens(parsed: ParsedFile, lang: string, text: string): ParsedFile {
  const comments = commentTokens(lang, text);
  if (comments !== undefined) parsed.commentTokens = comments;
  return parsed;
}

function parseByLang(f: DiscoveredFile): ParsedFile {
  switch (f.lang) {
    case 'py': return parsePythonFile(f);
    case 'go': return parseGoFile(f);
    case 'java': return parseJavaFile(f);
    case 'rb': return parseRubyFile(f);
    case 'rs': return parseRustFile(f);
    case 'php': return parsePhpFile(f);
    case 'c': return parseCFile(f);
    case 'cpp': return parseCppFile(f);
    case 'cs': return parseCSharpFile(f);
    case 'dart': return parseDartFile(f);
    case 'kt': return parseKotlinFile(f);
    case 'swift': return parseSwiftFile(f);
    case 'vue': return parseVueFile(f);
    case 'cob': return parseCobolFile(f);
    default: return parseFile(f); // ts / js
  }
}
