/**
 * Static server for local testing and the e2e suite.
 *   node scripts/serve.mjs [port] [dir]
 * Defaults: port 4173, dir docs/app
 */

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2] || 4173);
const baseDir = resolve(ROOT, process.argv[3] || 'docs/app');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

const server = createServer((request, response) => {
  const url = new URL(request.url, `http://localhost:${port}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname.endsWith('/')) pathname += 'index.html';

  const target = resolve(baseDir, `.${normalize(pathname)}`);
  if (!target.startsWith(baseDir)) {
    response.writeHead(403).end('Forbidden');
    return;
  }

  let file = target;
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!existsSync(file)) {
    // SPA fallback for hash-less deep links.
    file = join(baseDir, 'index.html');
    if (!existsSync(file)) {
      response.writeHead(404).end('Not found');
      return;
    }
  }

  const headers = {
    'content-type': MIME[extname(file)] || 'application/octet-stream',
    'cache-control': 'no-store',
    'service-worker-allowed': '/',
  };
  response.writeHead(200, headers);
  createReadStream(file).pipe(response);
});

server.listen(port, () => {
  process.stdout.write(`Khata dev server: http://localhost:${port}/ (serving ${baseDir})\n`);
});
