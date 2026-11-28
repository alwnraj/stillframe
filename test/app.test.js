import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHandler } from '../src/app.js';

// The Cloudflare Durable Object calls handle() directly with Web Requests.
test('platform-neutral handler works with plain Requests, as on Cloudflare', async () => {
  let seenSignal;
  const app = createHandler({ collect: async (username, { signal }) => { seenSignal = signal; return { username, complete: true }; } });
  try {
    const post = (body, headers = {}) => app.handle(new Request('https://stillframe.example/api/collect', { method: 'POST', headers, body }));
    const ok = await post('{"username":"alice"}');
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('cache-control'), 'no-store');
    assert.match(ok.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal((await ok.json()).complete, true);
    assert.ok(seenSignal instanceof AbortSignal);
    assert.equal((await post('{"username":"alice"}', { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await post('x'.repeat(2000))).status, 413);
    assert.equal((await post('{"username":"bad name"}')).status, 400);
    // Without an asset reader (the Durable Object), pages are served by the Worker, not here.
    assert.equal((await app.handle(new Request('https://stillframe.example/'))).status, 404);
    const room = await app.handle(new Request('https://stillframe.example/api/night', { method: 'POST', body: '{"username":"alice","consent":true}' }));
    assert.equal(room.status, 201);
    const { token, room: view } = await room.json();
    const peek = await app.handle(new Request(`https://stillframe.example/api/night/${view.id}`, { headers: { Authorization: `Bearer ${token}` } }));
    assert.equal((await peek.json()).members.length, 1);
  } finally { app.close(); }
});

test('hidden pages are not routed in production', async () => {
  const app = createHandler({ readAsset: file => readFile(new URL(`../public/${file}`, import.meta.url)) });
  try {
    const get = path => app.handle(new Request(`https://stillframe.example${path}`));
    assert.equal((await get('/')).status, 200);
    assert.match(await (await get('/')).text(), /class="reel-pop"[\s\S]*id="collect-form"/);
    assert.equal((await get('/reel.css')).status, 200);
    assert.equal((await get('/reel')).status, 404);
    assert.equal((await get('/classic')).status, 404);
    assert.doesNotMatch(await (await get('/')).text(), /href="\/(night|iceberg)/);
    for (const path of ['/night', '/night.js', '/night.css', '/iceberg', '/iceberg.css']) assert.equal((await get(path)).status, 404);
  } finally { app.close(); }
});

test('a client abort reaches collection and the handler releases its lock', async () => {
  let release;
  const app = createHandler({ collect: (username, { signal }) => new Promise(resolve => { release = resolve; signal.addEventListener('abort', () => resolve({ username: '', complete: false }), { once: true }); }) });
  try {
    const controller = new AbortController();
    const pending = app.handle(new Request('https://stillframe.example/api/collect', { method: 'POST', body: '{"username":"alice"}', signal: controller.signal }));
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal((await app.handle(new Request('https://stillframe.example/api/collect', { method: 'POST', body: '{"username":"bob"}' }))).status, 429);
    controller.abort();
    assert.equal((await pending).status, 499);
    const next = app.handle(new Request('https://stillframe.example/api/collect', { method: 'POST', body: '{"username":"bob"}' }));
    await new Promise(resolve => setTimeout(resolve, 10)); release({ username: 'bob', complete: true });
    assert.equal((await next).status, 200);
  } finally { app.close(); }
});
