import { beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadLanguages } from '../src/parse/treesitter/loader.js';
import { scan } from '../src/scan.js';
import { buildRepoGraph } from '../src/graph/repo.js';
import { renderDashboard } from '../src/report/dashboard.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, 'fixtures', 'pysample');

beforeAll(async () => {
  await loadLanguages(['python']);
});

describe('dashboard generation', () => {
  it('produces a self-contained HTML with the scan data injected', () => {
    const report = scan(FIXTURE);
    const graph = buildRepoGraph(FIXTURE, { withMetrics: true, report });
    const html = renderDashboard(report, graph);

    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).not.toContain('__EUTHYNOS_DATA__'); // placeholder replaced
    expect(html).toContain('const DATA = {'); // data injected as an object literal
    expect(html).toContain('id="cv"'); // the graph canvas
    expect(html).toContain(`"score":${report.health.score}`); // health from the report
    expect(report.modules.length).toBeGreaterThan(0);
    expect(html).toContain(JSON.stringify(report.modules[0]!.name)); // a real module name
    expect(html).not.toMatch(/src="https?:/); // self-contained — no external assets
  });

  it('neutralizes </script> in the injected data', () => {
    const report = scan(FIXTURE);
    const graph = buildRepoGraph(FIXTURE, { withMetrics: true, report });
    const html = renderDashboard(report, graph);
    const start = html.indexOf('const DATA = {');
    const line = html.slice(start, html.indexOf('\n', start));
    expect(line).not.toContain('</script>'); // any literal < was escaped to <
  });
});
