import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { collectEphemeralSnapshot } from './snapshot.js';
import { validateUsername } from './scraper.js';
import { createNightStore } from './night.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const assets = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'], '/night': ['night.html', 'text/html; charset=utf-8'], '/night.js': ['night.js', 'text/javascript; charset=utf-8'], '/night.css': ['night.css', 'text/css; charset=utf-8'] };
const send = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };

export function createApp({ collect = collectEphemeralSnapshot, nightOptions = {} } = {}) {
  let busy = false;
  const nights = createNightStore({ ...nightOptions, collect, startJob: job => {
    if (busy) return false;
    busy = true;
    void Promise.resolve().then(job).catch(() => {}).finally(() => { busy = false; });
    return true;
  } });
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      if (req.method === 'GET' && assets[url.pathname]) {
        const [file, contentType] = assets[url.pathname];
        const body = await readFile(path.join(root, 'public', file));
        res.writeHead(200, { 'Content-Type': contentType }); res.end(body); return;
      }
      if (url.pathname === '/api/night' || url.pathname.startsWith('/api/night/')) {
        const match = url.pathname.match(/^\/api\/night(?:\/([A-Za-z0-9_-]{32})(?:\/(join|start|nominate|vote|leave))?)?$/);
        if (!match) { send(res, 404, {error:'Not found.'}); return; }
        const [,id,action] = match;
        const key = req.headers.authorization?.replace(/^Bearer /,'');
        if (req.method === 'GET' && id && !action) { try {send(res,200,nights.peek(id,key));} catch(error) {send(res,error.status||500,{error:error.status?error.message:'Room unavailable.'});} return; }
        const origin = req.headers.origin;
        if (origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) {send(res,403,{error:'Submit from this website.'});return;}
        if (req.method !== 'POST') {send(res,405,{error:'Use POST.'});return;}
        let raw='';
        for await (const chunk of req) {raw+=chunk.toString();if(Buffer.byteLength(raw)>1024){send(res,413,{error:'Request is too large.'});return;}}
        let input;
        try {input=JSON.parse(raw);if(!input||typeof input!=='object'||Array.isArray(input))throw new Error();}catch{send(res,400,{error:'Invalid room request.'});return;}
        raw='';
        try {
          if (!id) send(res,201,nights.create(input));
          else if (action==='join') send(res,201,nights.join(id,input));
          else if (action==='start') send(res,202,nights.start(id,key));
          else if (action==='nominate') send(res,200,nights.nominate(id,key,input.filmId));
          else if (action==='vote') send(res,200,nights.vote(id,key,input.filmId));
          else if (action==='leave') {nights.end(id,key||input.token);send(res,200,{ended:true});}
          else send(res,404,{error:'Not found.'});
        } catch(error) {send(res,error.status||500,{error:error.status?error.message:'Room unavailable.'});}
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/collect') {
        const origin = req.headers.origin;
        if (origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) { send(res, 403, { error: 'Submit from this website.' }); return; }
        if (busy) { send(res, 429, { error: 'Another collection is running. Try again shortly.' }); return; }
        let raw = '';
        for await (const chunk of req) {
          raw += chunk.toString();
          if (Buffer.byteLength(raw) > 1024) { send(res, 413, { error: 'Request is too large.' }); return; }
        }
        let username;
        try { username = validateUsername(JSON.parse(raw).username); }
        catch { send(res, 400, { error: 'Enter a Letterboxd username using letters, numbers or underscores.' }); return; }
        raw = '';
        if (busy) { send(res, 429, { error: 'Another collection is running. Try again shortly.' }); return; }
        busy = true;
        const controller = new AbortController();
        const disconnect = () => { if (!res.writableEnded) controller.abort(); };
        res.once('close', disconnect);
        try {
          const result = await collect(username, { signal: controller.signal });
          if (!controller.signal.aborted && !res.destroyed) send(res, 200, result);
        } finally {
          res.off('close', disconnect);
          busy = false;
        }
        return;
      }
      // No history, saved-result or download endpoints exist.
      send(res, 404, { error: 'Not found.' });
    } catch {
      // Do not log request bodies, usernames, results, errors or stack traces.
      if (!res.headersSent && !res.destroyed) send(res, 500, { error: 'The collection could not be completed. Please try again.' });
      else if (!res.destroyed) res.end();
    }
  });
  server.on('close',()=>nights.close());
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createApp().listen(Number(process.env.PORT || 3000), '127.0.0.1');
}
