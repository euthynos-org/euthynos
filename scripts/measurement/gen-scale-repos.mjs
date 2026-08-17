// Generate synthetic TS repos at several scales for architecture measurement.
// Writes ONLY under the scratchpad. Never touches the engine or pinned subjects.
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const BASE = process.env.EUTHYNOS_SCALE_FIXTURES
  ?? join(process.env.TEMP ?? '/tmp', 'euthynos-scale-fixtures');
const SCALES = [1500, 5000, 10000];

// A realistic-ish file: imports from 2 siblings, exports 3 functions, calls
// across module boundaries so the call graph has real work to do.
function fileSource(mod, i, peers) {
  const [a, b] = peers;
  return `import { helper${a} } from '../mod${a % 20}/file${a}';
import { compute${b} } from '../mod${b % 20}/file${b}';

export interface Shape${i} { id: string; value: number; tags: string[] }

export function helper${i}(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0) { return 'empty-${i}'; }
  return trimmed + helper${a}(trimmed);
}

export function compute${i}(shape: Shape${i}): number {
  let total = shape.value;
  for (const tag of shape.tags) { total += tag.length; }
  return total + compute${b}({ id: shape.id, value: 0, tags: [] });
}

export function orchestrate${i}(raw: string): number {
  const s = helper${i}(raw);
  return compute${i}({ id: s, value: s.length, tags: ['a', 'b'] });
}
`;
}

for (const n of SCALES) {
  const root = join(BASE, `repo-${n}`);
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  for (let m = 0; m < 20; m++) mkdirSync(join(root, 'src', `mod${m}`), { recursive: true });
  for (let i = 0; i < n; i++) {
    const peers = [(i * 7 + 3) % n, (i * 13 + 11) % n];
    writeFileSync(join(root, 'src', `mod${i % 20}`, `file${i}.ts`), fileSource(i % 20, i, peers));
  }
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: `scale-${n}`, version: '1.0.0' }, null, 1));
  // git init so diff-engine tools (check_my_changes/boundary_check) have a HEAD.
  execFileSync('git', ['init', '-q', root], { stdio: 'pipe' });
  const g = (...a) => execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { stdio: 'pipe' });
  g('add', '-A');
  g('commit', '-q', '-m', 'init', '--no-gpg-sign');
  console.log(`built ${root} (${n} files, committed)`);
}
