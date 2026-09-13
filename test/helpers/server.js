'use strict';

/**
 * The smallest static file server that can serve this repository to a browser.
 * Kept dependency-free so `npm test` needs nothing but node and a browser.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

/** Serve `root` on an ephemeral port. Resolves with { origin, close }. */
function serve(root) {
  const base = path.resolve(root);

  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.join(base, relative);

    // Never serve anything outside the root, whatever the request says.
    if (file !== base && !file.startsWith(base + path.sep)) {
      response.writeHead(403).end('forbidden');
      return;
    }

    fs.readFile(file, (error, body) => {
      if (error) {
        response.writeHead(404).end('not found');
        return;
      }
      response.writeHead(200, {
        'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-store'
      });
      response.end(body);
    });
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        origin: 'http://127.0.0.1:' + server.address().port,
        close: () => new Promise((done) => server.close(done))
      });
    });
  });
}

module.exports = { serve };
