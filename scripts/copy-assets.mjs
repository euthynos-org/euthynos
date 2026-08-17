// tsc compiles .ts only — copy the dashboard HTML template into dist so the
// built/published CLI can read it next to dashboard.js.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const assets = [['src/report/dashboard.html', 'dist/report/dashboard.html']];

for (const [from, to] of assets) {
  const dst = join(root, to);
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(join(root, from), dst);
  console.log(`copied ${from} → ${to}`);
}
