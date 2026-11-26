// Thin Node adapter for local use and tests. All routing lives in src/app.js,
// which the Cloudflare Worker runs unchanged.
import http from 'node:http';
import { Readable } from 'node:stream';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHandler } from './app.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection', 'te', 'trailer', 'http2-settings']);

export function createApp(options = {}) {
  const app = createHandler({ ...options, readAsset: file => readFile(path.join(root, 'public', file)) });
  const server = http.createServer(async (req, res) => {
    const controller = new AbortController();
    // A disconnect before the response ends aborts collection and scrubs its data.
    res.once('close', () => { if (!res.writableEnded) controller.abort(); });
    let response;
    try {
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) if (!HOP_BY_HOP.has(name)) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      const hasBody = !['GET', 'HEAD'].includes(req.method);
      response = await app.handle(new Request(new URL(req.url, `http://${req.headers.host || 'localhost'}`), { method: req.method, headers, signal: controller.signal, ...(hasBody ? { body: Readable.toWeb(req), duplex: 'half' } : {}) }));
    } catch {
      response = new Response(JSON.stringify({ error: 'The collection could not be completed. Please try again.' }), { status: 500, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
    }
    if (controller.signal.aborted || res.destroyed) return;
    try {
      const body = Buffer.from(await response.arrayBuffer());
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(body);
    } catch { if (!res.destroyed) res.destroy(); }
  });
  server.on('close', () => app.close());
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createApp().listen(Number(process.env.PORT || 3000), '127.0.0.1');
}
