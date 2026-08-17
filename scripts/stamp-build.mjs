#!/usr/bin/env node
/**
 * Stamp the build: write dist/build-info.json with the package version and
 * the git commit the build was produced from. ENGINE_VERSION derives from
 * this stamp, so two different builds can never exchange `.euthynos` index
 * artifacts as though they were identical (launch-readiness §4.9) — the
 * hardcoded 'contexthub-0.1.0' string previously made exactly that possible.
 *
 * Runs as part of `npm run build`, after tsc. A dirty working tree is
 * stamped as such: behavior differences do not require a commit to exist.
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = process.argv[2] ? process.argv[2] : join(root, 'dist');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

let commit = 'nogit';
let dirty = false;
try {
  commit = execFileSync('git', ['-C', root, 'rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8' }).trim();
  dirty = execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' }).trim() !== '';
} catch {
  /* building outside git: stamped as nogit */
}

if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
const info = {
  name: pkg.name,
  version: pkg.version,
  commit: dirty ? `${commit}-dirty` : commit,
  builtAt: new Date().toISOString(),
};
writeFileSync(join(outDir, 'build-info.json'), JSON.stringify(info, null, 1));
console.log(`build stamped: ${info.name}@${info.version}+${info.commit}`);
