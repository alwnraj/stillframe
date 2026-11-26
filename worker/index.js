// Cloudflare entry point. Static files come from the assets binding with the
// same security headers as the Node server. Every /api request goes to one
// Durable Object, which holds the in-memory state a single Node process held:
// the collection lock, pacing, rooms and votes. It never uses ctx.storage or
// alarms, so nothing is persisted; eviction or redeploy simply ends all rooms.
import { DurableObject } from 'cloudflare:workers';
import { createHandler, ASSETS, SECURITY_HEADERS } from '../src/app.js';

export class StillframeState extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.app = createHandler();
  }
  fetch(request) { return this.app.handle(request); }
}

const notFound = () => new Response(JSON.stringify({ error: 'Not found.' }), { status: 404, headers: { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8' } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return env.STATE.get(env.STATE.idFromName('app')).fetch(request);
    const asset = ASSETS[url.pathname];
    if (request.method !== 'GET' || !asset) return notFound();
    const [file, contentType] = asset;
    const response = await env.ASSETS.fetch(new URL('/' + file, url));
    if (!response.ok) return notFound();
    return new Response(response.body, { status: 200, headers: { ...SECURITY_HEADERS, 'Content-Type': contentType } });
  },
};
