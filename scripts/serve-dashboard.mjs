// Tiny static server to preview the generated dashboard (verification only).
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const port = 5188;
createServer((_req, res) => {
  try {
    const html = readFileSync(new URL('../dashboard-preview.html', import.meta.url), 'utf8');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  } catch (e) {
    res.writeHead(500);
    res.end(String(e));
  }
}).listen(port, () => console.log('dashboard preview on http://localhost:' + port));
