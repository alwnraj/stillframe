// Platform-neutral request handler: Request in, Response out. The Node server
// (src/server.js) and the Cloudflare Durable Object (worker/index.js) both run
// this same code, so one in-memory state owns the busy lock, pacing and rooms.
import { collectEphemeralSnapshot } from './snapshot.js';
import { validateUsername } from './scraper.js';
import { createNightStore } from './night.js';

export const ASSETS = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'], '/night': ['night.html', 'text/html; charset=utf-8'], '/night.js': ['night.js', 'text/javascript; charset=utf-8'], '/night.css': ['night.css', 'text/css; charset=utf-8'] };
export const SECURITY_HEADERS = {
  'Cache-Control': 'no-store', Pragma: 'no-cache', Expires: '0', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};
const send = (status, body) => new Response(JSON.stringify(body), { status, headers: { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8' } });
const tooLarge = Symbol('too large');

// Reads at most 1 KiB of request body; larger bodies are rejected unread.
async function readBody(request) {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0, text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      size += value.byteLength;
      if (size > 1024) return tooLarge;
      text += decoder.decode(value, { stream: true });
    }
  } finally { reader.cancel().catch(() => {}); }
}
const foreignOrigin = (request, url) => { const origin = request.headers.get('origin'); return origin && origin !== `http://${url.host}` && origin !== `https://${url.host}`; };

export function createHandler({ collect = collectEphemeralSnapshot, nightOptions = {}, readAsset } = {}) {
  let busy = false;
  const nights = createNightStore({ ...nightOptions, collect, startJob: job => {
    if (busy) return false;
    busy = true;
    void Promise.resolve().then(job).catch(() => {}).finally(() => { busy = false; });
    return true;
  } });

  async function route(request) {
    const url = new URL(request.url);
    if (request.method === 'GET' && ASSETS[url.pathname] && readAsset) {
      const [file, contentType] = ASSETS[url.pathname];
      return new Response(await readAsset(file), { status: 200, headers: { ...SECURITY_HEADERS, 'Content-Type': contentType } });
    }
    if (url.pathname === '/api/night' || url.pathname.startsWith('/api/night/')) {
      const match = url.pathname.match(/^\/api\/night(?:\/([A-Za-z0-9_-]{32})(?:\/(join|start|nominate|vote|leave))?)?$/);
      if (!match) return send(404, { error: 'Not found.' });
      const [, id, action] = match;
      const key = request.headers.get('authorization')?.replace(/^Bearer /, '');
      if (request.method === 'GET' && id && !action) {
        try { return send(200, nights.peek(id, key)); } catch (error) { return send(error.status || 500, { error: error.status ? error.message : 'Room unavailable.' }); }
      }
      if (foreignOrigin(request, url)) return send(403, { error: 'Submit from this website.' });
      if (request.method !== 'POST') return send(405, { error: 'Use POST.' });
      const raw = await readBody(request);
      if (raw === tooLarge) return send(413, { error: 'Request is too large.' });
      let input;
      try { input = JSON.parse(raw); if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(); } catch { return send(400, { error: 'Invalid room request.' }); }
      try {
        if (!id) return send(201, nights.create(input));
        if (action === 'join') return send(201, nights.join(id, input));
        if (action === 'start') return send(202, nights.start(id, key));
        if (action === 'nominate') return send(200, nights.nominate(id, key, input.filmId));
        if (action === 'vote') return send(200, nights.vote(id, key, input.filmId));
        if (action === 'leave') { nights.end(id, key || input.token); return send(200, { ended: true }); }
        return send(404, { error: 'Not found.' });
      } catch (error) { return send(error.status || 500, { error: error.status ? error.message : 'Room unavailable.' }); }
    }
    if (request.method === 'POST' && url.pathname === '/api/collect') {
      if (foreignOrigin(request, url)) return send(403, { error: 'Submit from this website.' });
      if (busy) return send(429, { error: 'Another collection is running. Try again shortly.' });
      const raw = await readBody(request);
      if (raw === tooLarge) return send(413, { error: 'Request is too large.' });
      let username;
      try { username = validateUsername(JSON.parse(raw).username); }
      catch { return send(400, { error: 'Enter a Letterboxd username using letters, numbers or underscores.' }); }
      if (busy) return send(429, { error: 'Another collection is running. Try again shortly.' });
      busy = true;
      try {
        // request.signal aborts when the client disconnects; collection then stops and scrubs.
        const result = await collect(username, { signal: request.signal });
        return request.signal.aborted ? send(499, { error: 'Collection cancelled.' }) : send(200, result);
      } finally { busy = false; }
    }
    // No history, saved-result or download endpoints exist.
    return send(404, { error: 'Not found.' });
  }

  return {
    async handle(request) {
      // Do not log request bodies, usernames, results, errors or stack traces.
      try { return await route(request); }
      catch { return send(500, { error: 'The collection could not be completed. Please try again.' }); }
    },
    close: () => nights.close(),
  };
}
