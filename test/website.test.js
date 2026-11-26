import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { access } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { collectEphemeralSnapshot, launchOwnedBrowser, parseRss } from '../src/snapshot.js';
import { createApp } from '../src/server.js';

async function assertNoRetainedFiles() {
  for (const name of ['output', '.browser-profile']) await assert.rejects(access(new URL('../' + name, import.meta.url)), { code: 'ENOENT' });
}

let uiBrowser;
before(async () => { uiBrowser = await launchOwnedBrowser(); });
after(async () => { await uiBrowser?.close(); });

const poster = id => `<div data-component-class="LazyPoster" data-item-name="Film ${id} (2020)" data-item-link="/film/movie-${id}/" data-item-slug="movie-${id}" data-item-full-display-name="Film ${id} (2020)" data-resolvable-poster-path="/film/movie-${id}/poster/" data-postered-identifier='{"uid":"film:${id}"}'></div>`;
function fixture(section, mode) {
  if (mode === 'challenge') return '<title>Just a moment...</title><dialog class="turnstile-dialog" open>Verify</dialog>';
  if (section === 'recent') {
    if (mode === 'malformed-rss') return '<rss><channel>';
    const count = mode === 'empty' || mode === 'stories-only' ? 0 : mode === 'few' ? 3 : 50;
    const rows = Array.from({ length: count }, (_, i) => `<item><guid>letterboxd-${i === 0 ? 'review' : 'watch'}-${mode === 'duplicate' ? 1 : i + 1}</guid><link>https://letterboxd.com/alice/film/movie-${i}/</link><pubDate>Wed, 01 Jan 2020 00:00:00 GMT</pubDate><letterboxd:filmTitle>Film ${i}</letterboxd:filmTitle><letterboxd:filmYear>2020</letterboxd:filmYear><letterboxd:watchedDate>${mode === 'missing-date' ? '' : mode === 'invalid-calendar-date' ? '2020-02-31' : '2020-01-01'}</letterboxd:watchedDate><letterboxd:memberRating>${mode === 'invalid-rating' ? '6' : '3.5'}</letterboxd:memberRating><letterboxd:memberLike>Yes</letterboxd:memberLike><letterboxd:rewatch>No</letterboxd:rewatch><tmdb:movieId>${i + 1}</tmdb:movieId><dc:creator>Alice</dc:creator><description><![CDATA[<p>A synthetic review.</p><img src="https://example.invalid/poster.jpg" alt="Synthetic poster">]]></description></item>`).join('');
    const lists = mode === 'empty' || mode === 'stories-only' ? '' : `<item><guid>letterboxd-list-1</guid><title>A synthetic list</title><link>https://letterboxd.com/${mode === 'foreign-list' ? 'other' : 'alice'}/list/example/</link><pubDate>Wed, 01 Jan 2020 00:00:00 GMT</pubDate><dc:creator>Alice</dc:creator><description><![CDATA[<p>A list description.</p><a href="https://letterboxd.com/film/example/">Example film</a>]]></description></item>`;
    const stories = ['story-rss','stories-only','foreign-story'].includes(mode) ? `<item><guid>letterboxd-story-1</guid><title>A synthetic story</title><link>https://letterboxd.com/${mode==='foreign-story'?'other':'alice'}/story/example/</link><pubDate>Wed, 01 Jan 2020 00:00:00 GMT</pubDate><dc:creator>Alice</dc:creator><description><![CDATA[<p>A story summary.</p><a href="https://letterboxd.com/film/example/">Example film</a>]]></description></item>` : '';
    return `<rss version="2.0" xmlns:letterboxd="https://letterboxd.com" xmlns:tmdb="https://www.themoviedb.org" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>Alice</title><link>https://letterboxd.com/${mode === 'wrong-feed' ? 'other' : 'alice'}/</link>${rows}${mode === 'duplicate' ? rows : ''}${lists}${stories}</channel></rss>`;
  }
  const header = '<section class="profile-header"><h1><a href="/alice/">Alice</a></h1><a class="avatar"><img src="https://example.invalid/avatar.jpg"></a><span class="badge -pro"></span></section><a href="/alice/diary/">Diary</a>';
  if (section === 'publicLists') {
    if (mode === 'no-lists-whitespace') return `<title>Alice’s lists</title><main id="content">${header}<p>No\n\tlists yet.</p></main>`;
    const count = mode === 'empty' ? 0 : mode === 'few' ? 2 : mode === 'short-lists' ? 11 : 12;
    return `<title>Alice’s lists</title><main id="content">${header}${Array.from({length:count},(_,i)=>`<article class="list-summary" data-film-list-id="${i+1}"><div class="masthead"><h2 class="name"><a href="/alice/list/example-${i}/">List ${i}</a></h2><div class="content-reactions-strip"><span class="value">3</span><a class="metadata" href="/alice/list/example-${i}/likes/">2 likes</a></div></div><div class="notes">Description</div><ul class="tags"><li><a href="/alice/tag/example/">example</a></li></ul><figure class="posterset">${poster(1)}</figure></article>`).join('')}${count===0?'<p>No public lists yet</p>':''}${mode==='empty'||mode==='few'?'':'<div class="pagination"><a class="next" href="/alice/lists/page/2/">Older</a></div>'}</main>`;
  }
  if (section === 'tags') {
    if (mode === 'no-film-tags' || mode === 'unknown-empty-tags') return `<title>Alice’s tags</title><main id="content">${header}<ul class="tags"></ul>${mode==='no-film-tags'?'<p>No film tags yet.</p>':''}</main>`;
    const count = mode === 'empty' ? 0 : mode === 'few' ? 2 : 120;
    return `<title>Alice’s tags</title><main id="content">${header}<ul class="tags">${Array.from({length:count},(_,i)=>`<li><a href="/alice/tag/${mode==='duplicate-tags'||mode==='tag-aliases'&&i<2?'same':i}/">${mode==='duplicate-tags'?'Tag':`Tag ${i}`}</a><span class="detail">3</span></li>`).join('')}</ul>${count===0?'<p>No tags yet</p>':''}${mode==='empty'||mode==='few'?'':'<div class="pagination"><a class="next" href="/alice/tags/films/page/2/">Older</a></div>'}</main>`;
  }
  if (section === 'diary') {
    const count = mode === 'empty' ? 0 : mode === 'few' ? 3 : 50;
    return `<title>Alice’s diary</title><main id="content">${header}<table id="diary-table"><tbody>${Array.from({length:count},(_,i)=>`<tr data-viewing-id="${i+1}"><td>${poster(i+1)}</td><td><a class="daydate" href="/alice/diary/films/for/2020/01/01/">1</a></td><td><span class="rating rated-7"></span></td><td class="col-rewatch icon-status-off"></td></tr>`).join('')}</tbody></table>${count===0?'<p>No diary entries</p>':''}${mode==='empty'||mode==='few'?'':'<div class="pagination"><a class="next" href="/alice/diary/films/page/2/">Older</a></div>'}</main>`;
  }
  const watched = section === 'watchedFilms';
  if (mode === 'private-watchlist' && !watched) return '<title>Alice’s Watchlist</title><main id="content"><a href="/alice/diary/">Diary</a><p>This watchlist is private.</p></main>';
  const count = mode === 'empty' || mode === 'public-empty-watchlist' && !watched ? 0 : mode === 'few' ? 2 : watched ? (mode === 'short-watched' ? 70 : 72) : 28;
  const more = mode !== 'empty' && mode !== 'few' && !(mode === 'public-empty-watchlist' && !watched);
  return `<title>Alice’s ${watched ? 'films' : 'Watchlist'}</title><main id="content">${header}${watched ? '' : `<h1>Alice wants to see ${mode === 'watchlist-total-mismatch' ? 1 : more ? 60 : count} films</h1>`}<ul>${Array.from({ length: count }, (_, i) => `<li class="posteritem">${watched && mode === 'missing-watched-poster' && i === 3 ? '' : poster(i + 1)}${watched ? '<span class="rating rated-7">★★★½</span>' : ''}</li>`).join('')}</ul>${count === 0 ? '<p>No films yet</p>' : ''}${mode==='public-empty-watchlist'&&!watched?'<button>Make private</button>':''}${more ? `<div class="pagination"><a class="next" href="/alice/${watched ? 'films' : 'watchlist'}/page/2/">Older</a></div>` : ''}</main>`;
}

async function launchFixtureBrowser(mode, requests = []) {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  return { newContext: async options => {
    const context = await browser.newContext(options);
    await context.route('https://letterboxd.com/**', route => {
      const pathname = new URL(route.request().url()).pathname;
      const section = pathname.includes('/rss/') ? 'recent' : pathname.includes('/watchlist/') ? 'watchlist' : pathname.includes('/lists/') ? 'publicLists' : pathname.includes('/tags/') ? 'tags' : pathname.includes('/diary/') ? 'diary' : 'watchedFilms';
      requests.push(section);
      const blocked = mode === 'blocked' || (mode === 'watched-blocked' && section === 'watchedFilms') || (mode === 'lists-blocked' && section === 'publicLists');
      const limited = mode === 'rate-limited' && section === 'watchedFilms';
      return route.fulfill({ status: mode === 'not-found' ? 404 : limited ? 429 : blocked ? 403 : 200, headers: limited ? { 'Retry-After': '30' } : {}, contentType: section === 'recent' && mode !== 'challenge' ? 'application/rss+xml; charset=utf-8' : 'text/html; charset=utf-8', body: fixture(section, mode) });
    });
    return context;
  }, close: () => browser.close() };
}

// RSS mode uses plain HTTP. This fake answers only the feed URL with the same fixtures.
function fakeFetch(mode, requests = []) {
  return async (url, options) => {
    assert.equal(new URL(url).pathname, '/alice/rss/');
    assert.equal(options.redirect, 'manual');
    requests.push('recent');
    return new Response(fixture('recent', mode), { status: mode === 'not-found' ? 404 : mode === 'blocked' ? 403 : 200,
      headers: { 'Content-Type': mode === 'challenge' ? 'text/html; charset=utf-8' : 'application/rss+xml; charset=utf-8' } });
  };
}
const noBrowser = async () => { throw new Error('RSS mode must not start a browser.'); };

async function withApp(mode, run, collectionMode = 'extended') {
  let activeCollection;
  const server = createApp({ collect: (username, options) => { const current = typeof mode === 'function' ? mode() : mode; activeCollection = collectEphemeralSnapshot(username, { ...options, mode: collectionMode, waitForRequest: async () => {}, launchBrowser: collectionMode === 'rss' ? noBrowser : () => launchFixtureBrowser(current), fetch: fakeFetch(current) }); return activeCollection; } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await run({ base }); }
  finally { await activeCollection?.catch(() => {}); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test('website renders an ephemeral lookup without saving or download controls', async () => {
  await withApp('success', async ({ base }) => {
    const page = await uiBrowser.newPage();
    try {
      await page.goto(base);
      await page.getByLabel('Your Letterboxd username', { exact: true }).fill('alice');
      const responsePromise = page.waitForResponse(r => r.url().endsWith('/api/collect'));
      await page.getByRole('button', { name: 'Collect my films' }).click();
      const response = await responsePromise;
      assert.equal(response.headers()['cache-control'], 'no-store');
      const result = await response.json();
      await page.locator('#results').waitFor({ state: 'visible' });
      assert.equal(result.complete, true);
      assert.equal(await page.locator('.recent').count(), 50);
      assert.equal(result.watchedFilms.length, 72);
      assert.equal(result.watchlist.length, 28);
      assert.equal(result.recentRatingHistogram.totalRatings, 50);
      assert.equal(await page.locator('.histogram-row').count(), 10);
      assert.equal(await page.locator('#watched-list .film-row').count(), 72);
      assert.equal(await page.locator('#watchlist-list .film-row').count(), 28);
      assert.equal(result.checks.watchedFilms.hasMore, true);
      assert.equal(result.checks.watchlist.hasMore, true);
      await page.locator('.film-collection').nth(0).locator('summary').click();
      assert.equal(await page.locator('#watched-list .film-row').first().isVisible(), true);
      assert.match(await page.locator('#watched-coverage').innerText(), /More films are available/);
      await page.locator('.film-collection').nth(1).locator('summary').click();
      assert.equal(await page.locator('#watchlist-list .film-row').first().isVisible(), true);
      assert.match(await page.locator('#watchlist-coverage').innerText(), /More films are available/);
      assert.equal(result.recent[0].rating, 3.5);
      assert.equal('id' in result || 'downloadUrl' in result || 'filename' in result, false);
      assert.equal(await page.locator('#download, #json-preview, [download]').count(), 0);
      assert.deepEqual(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length, cookies: document.cookie })), { local: 0, session: 0, cookies: '' });
      await assertNoRetainedFiles();
    } finally { await page.close(); }
  });
});

for (const [mode, recentCount, favoriteCount] of [['few', 3, 2], ['empty', 0, 0]]) {
  test(`handles an account with ${mode} entries without inventing data`, async () => {
    await withApp(mode, async ({ base }) => {
      const page = await uiBrowser.newPage();
      try {
        await page.goto(base);
        await page.getByLabel('Your Letterboxd username', { exact: true }).fill('alice');
        const responsePromise = page.waitForResponse(r => r.url().endsWith('/api/collect'));
        await page.getByRole('button', { name: 'Collect my films' }).click();
        const result = await (await responsePromise).json();
        await page.locator('#results').waitFor({ state: 'visible' });
        assert.equal(result.complete, true);
        assert.equal(result.recent.length, recentCount);
        assert.equal(result.watchedFilms.length, favoriteCount);
        assert.equal(result.watchlist.length, favoriteCount);
        assert.equal(result.recentRatingHistogram.totalRatings, mode === 'empty' ? 0 : 3);
        assert.equal(await page.locator('.recent').count(), recentCount);
      } finally { await page.close(); }
    });
  });
}

test('long film titles stay within the mobile viewport and are rendered as text', async () => {
  await withApp('success', async ({ base }) => {
    const page = await uiBrowser.newPage({ viewport: { width: 320, height: 700 } });
    const title = '<img src=x onerror=alert(1)>' + 'VeryLongFilmTitle'.repeat(12);
    const film = { title, filmUrl: 'https://letterboxd.com/film/test/', year: 2020, rating: 3.5 };
    await page.route('**/api/collect', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ username: 'alice', complete: true, recent: [{ ...film, watchedDate: '2020-01-01' }], watchedFilms: [film], watchlist: [film], recentRatingHistogram: { bins: Array.from({ length: 10 }, (_, i) => ({ rating: (i + 1) / 2, count: 1 })), totalRatings: 10 }, checks: {} }) }));
    try {
      await page.goto(base);
      await page.getByLabel('Your Letterboxd username', { exact: true }).fill('alice');
      await page.getByRole('button', { name: 'Collect my films' }).click();
      await page.locator('#results').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#results img').count(), 0);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.equal(await page.locator('#status').getAttribute('class'), 'status');
    } finally { await page.close(); }
  });
});

test('blocked collections remain transient and cannot be downloaded', async () => {
  await withApp('blocked', async ({ base }) => {
    const page = await uiBrowser.newPage();
    try {
      await page.goto(base);
      await page.getByLabel('Your Letterboxd username', { exact: true }).fill('alice');
      await page.getByRole('button', { name: 'Collect my films' }).click();
      await page.locator('#status.error').waitFor({ state: 'visible' });
      assert.match(await page.locator('#status').innerText(), /Collection incomplete/);
      assert.equal(await page.locator('#result-label').innerText(), 'Incomplete lookup');
      assert.equal(await page.locator('#watchlist-count').innerText(), 'Not requested');
      assert.equal(await page.locator('#download, [download]').count(), 0);
      await assertNoRetainedFiles();
    } finally { await page.close(); }
  });
});

for (const [mode, error] of [['duplicate', /duplicate|unrecognized/], ['malformed-rss', /verify/], ['missing-date', /watched date/], ['invalid-calendar-date', /watched date/], ['invalid-rating', /invalid rating/], ['wrong-feed', /different profile/], ['challenge', /security verification/], ['private-watchlist', /private/], ['short-watched', /missing entries/], ['missing-watched-poster', /missing required fields|missing entry ID/], ['watchlist-total-mismatch', /total count/], ['foreign-list', /list URL/], ['foreign-story', /story URL/], ['short-lists', /missing entries/], ['duplicate-tags', /duplicate/], ['unknown-empty-tags', /no readable entries/]]) {
  test(`snapshot fails closed: ${mode}`, async () => {
    await withApp(mode, async ({ base }) => {
      const response = await fetch(`${base}/api/collect`, { method: 'POST', body: JSON.stringify({ username: 'alice' }) });
      const result = await response.json();
      assert.equal(result.status, 'failed'); assert.equal(result.complete, false); assert.match(result.error, error);
      if (mode === 'private-watchlist' || mode === 'watchlist-total-mismatch') {
        assert.equal(result.recent.length, 50);
        assert.equal(result.watchedFilms.length, 72);
        assert.equal(result.checks.watchlist.complete, false);
      }
    });
  });
}

test('invalid usernames and foreign-origin submissions are rejected before launching Chrome', async () => {
  await withApp('success', async ({ base }) => {
    const invalid = await fetch(`${base}/api/collect`, { method: 'POST', body: JSON.stringify({ username: '../alice' }) });
    assert.equal(invalid.status, 400);
    await invalid.json();
    const foreign = await fetch(`${base}/api/collect`, { method: 'POST', headers: { Origin: 'https://other.example' }, body: JSON.stringify({ username: 'alice' }) });
    assert.equal(foreign.status, 403);
    await foreign.json();
    await assertNoRetainedFiles();
    const missing = await fetch(`${base}/api/results/invalid`);
    assert.equal(missing.status, 404);
    await missing.json();
  });
});

test('username pasted with surrounding spaces submits successfully', async () => {
  await withApp('success', async ({ base }) => {
    const page = await uiBrowser.newPage();
    try {
      await page.goto(base);
      await page.getByLabel('Your Letterboxd username', { exact: true }).fill(' alice ');
      assert.equal(await page.locator('#username').evaluate(el => el.validity.patternMismatch), false);
      const responsePromise = page.waitForResponse(r => r.url().endsWith('/api/collect'), { timeout: 15000 });
      await page.getByRole('button', { name: 'Collect my films' }).click();
      assert.equal((await (await responsePromise).json()).username, 'alice');
    } finally { await page.close(); }
  });
});

test('initial website load has no missing assets or browser errors', async () => {
  await withApp('success', async ({ base }) => {
    const page = await uiBrowser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    try {
      await page.goto(base);
      const icon = await page.locator('link[rel="icon"]').getAttribute('href', { timeout: 1000 });
      assert.equal((await fetch(new URL(icon, base))).status, 200);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
});

test('repeated submissions recover after a failed collection without retaining old films', async () => {
  const modes = ['success', 'blocked', 'success'];
  await withApp(() => modes.shift(), async ({ base }) => {
    const page = await uiBrowser.newPage();
    try {
      await page.goto(base);
      await page.getByLabel('Your Letterboxd username', { exact: true }).fill('alice');
      for (const complete of [true, false, true]) {
        const pending = page.waitForResponse(r => r.url().endsWith('/api/collect'));
        await page.getByRole('button', { name: 'Collect my films' }).click();
        const result = await (await pending).json();
        await page.waitForFunction(() => !document.querySelector('#submit').disabled);
        assert.equal('id' in result, false);
        assert.equal(result.complete, complete);
        assert.equal(await page.locator('.recent').count(), complete ? 50 : 0);
        assert.equal(await page.locator('#collect-form').getAttribute('aria-busy'), null);
      }
      await assertNoRetainedFiles();
    } finally { await page.close(); }
  });
});

test('malformed and oversized requests do not break subsequent collections', async () => {
  await withApp('success', async ({ base }) => {
    for (const [body, status] of [['not json', 400], ['x'.repeat(2048), 413], ['null', 400], ['{"username":42}', 400]]) {
      const response = await fetch(`${base}/api/collect`, { method: 'POST', body });
      assert.equal(response.status, status);
      assert.equal(typeof (await response.json()).error, 'string');
    }
    const response = await fetch(`${base}/api/collect`, { method: 'POST', body: JSON.stringify({ username: 'alice' }) });
    assert.equal((await response.json()).complete, true);
  });
});

test('concurrent collection returns busy and the server accepts another request afterward', async () => {
  let signalStarted, release;
  const started = new Promise(resolve => { signalStarted = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const server = createApp({ collect: async username => {
    calls++; signalStarted(); await gate;
    return { username, complete: true };
  } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/collect`;
  const post = () => fetch(url, { method: 'POST', body: '{"username":"alice"}' });
  try {
    const first = post(); await started;
    const second = await post();
    assert.equal(second.status, 429); assert.equal(calls, 1);
    await second.json();
    release();
    const firstResponse = await first;
    assert.equal(firstResponse.status, 200); await firstResponse.json();
    const thirdResponse = await post();
    assert.equal(thirdResponse.status, 200); await thirdResponse.json(); assert.equal(calls, 2);
  } finally { release(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('failed context startup still disposes the owned browser', async () => {
  let closed = false;
  const result = await collectEphemeralSnapshot('alice', { mode: 'extended', cleanupTimeoutMs: 10, launchBrowser: async () => ({
    newContext: async () => { throw new Error('Synthetic startup failure'); },
    close: async () => { closed = true; },
  }) });
  assert.equal(closed, true); assert.equal(result.complete, false);
});

test('stalled browser disposal returns incomplete instead of hanging', async () => {
  const result = await collectEphemeralSnapshot('alice', { mode: 'extended', cleanupTimeoutMs: 10, launchBrowser: async () => ({
    newContext: async () => { throw new Error('Synthetic startup failure'); },
    close: () => new Promise(() => {}),
  }) });
  assert.equal(result.complete, false);
  assert.equal(result.errors.some(error => /cleanup timed out/.test(error.message)), true);
});

test('Clear now removes all displayed data and the username without browser storage', async () => {
  await withApp('success', async ({ base }) => {
    const page = await uiBrowser.newPage();
    try {
      await page.goto(base);
      await page.getByLabel('Your Letterboxd username', { exact: true }).fill('alice');
      await page.getByRole('button', { name: 'Collect my films' }).click();
      await page.locator('#results').waitFor({ state: 'visible' });
      await page.getByRole('button', { name: 'Clear now', exact: true }).click();
      assert.equal(await page.locator('#results').isHidden(), true);
      assert.equal(await page.locator('.recent, .favorite, .film-row, .histogram-row').count(), 0);
      assert.equal(await page.locator('#username').inputValue(), '');
      assert.equal(await page.locator('#result-title').innerText(), '');
      assert.deepEqual(await page.evaluate(async () => ({ local: localStorage.length, session: sessionStorage.length, caches: await caches.keys(), cookies: document.cookie })), { local: 0, session: 0, caches: [], cookies: '' });
      await assertNoRetainedFiles();
    } finally { await page.close(); }
  });
});

test('results expire after two minutes', async () => {
  await withApp('success', async ({ base }) => {
    const page = await uiBrowser.newPage();
    try {
      await page.clock.install();
      await page.goto(base);
      await page.getByLabel('Your Letterboxd username', { exact: true }).fill('alice');
      await page.getByRole('button', { name: 'Collect my films' }).click();
      await page.locator('#results').waitFor({ state: 'visible' });
      await page.clock.fastForward(120001);
      assert.equal(await page.locator('#results').isHidden(), true);
      assert.equal(await page.locator('.recent, .favorite, .film-row, .histogram-row').count(), 0);
      assert.equal(await page.locator('#username').inputValue(), '');
      assert.match(await page.locator('#status').innerText(), /Results cleared/);
    } finally { await page.close(); }
  });
});

test('navigating away and back does not restore the previous lookup', async () => {
  await withApp('success', async ({ base }) => {
    const page = await uiBrowser.newPage();
    try {
      await page.goto(base);
      await page.getByLabel('Your Letterboxd username', { exact: true }).fill('alice');
      await page.getByRole('button', { name: 'Collect my films' }).click();
      await page.locator('#results').waitFor({ state: 'visible' });
      await page.goto(`${base}/favicon.svg`);
      await page.goBack();
      assert.equal(await page.locator('#results').isHidden(), true);
      assert.equal(await page.locator('.recent, .favorite, .film-row, .histogram-row').count(), 0);
      assert.equal(await page.locator('#username').inputValue(), '');
    } finally { await page.close(); }
  });
});

test('server errors do not log or expose the thrown error', async () => {
  const spies = ['log', 'info', 'warn', 'error', 'debug'].map(name => mock.method(console, name, () => {}));
  const server = createApp({ collect: async () => { throw new Error('Private test details'); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/collect`, { method: 'POST', body: '{"username":"alice"}' });
    assert.equal(response.status, 500);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.text()).includes('Private test details'), false);
    spies.forEach(spy => assert.equal(spy.mock.callCount(), 0));
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    spies.forEach(spy => spy.mock.restore());
  }
});

test('disconnecting the client cancels its collection and releases the busy state', { timeout: 10000 }, async () => {
  let started, cancelled;
  const begun = new Promise(resolve => { started = resolve; });
  const aborted = new Promise(resolve => { cancelled = resolve; });
  let calls = 0;
  const server = createApp({ collect: async (username, { signal }) => {
    calls++;
    if (calls === 1) {
      await new Promise(resolve => { signal.addEventListener('abort', () => { cancelled(); resolve(); }, { once: true }); started(); });
    }
    return { username, complete: !signal.aborted };
  } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/collect`;
  const controller = new AbortController();
  try {
    const pending = fetch(url, { method: 'POST', body: '{"username":"alice"}', signal: controller.signal }).catch(() => null);
    await begun; controller.abort(); await aborted; await pending;
    const response = await fetch(url, { method: 'POST', body: '{"username":"alice"}' });
    assert.equal(response.status, 200); await response.json();
    assert.equal(calls, 2);
  } finally { controller.abort(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('a cancelled collection returns no account data and does not launch Chrome', async () => {
  const controller = new AbortController(); controller.abort();
  let launched = false;
  const result = await collectEphemeralSnapshot('alice', { mode: 'extended', signal: controller.signal, launchBrowser: async () => { launched = true; } });
  assert.equal(launched, false);
  assert.equal(result.username, '');
  assert.deepEqual([result.recent, result.watchedFilms, result.watchlist], [[], [], []]);
  assert.equal(result.recentRatingHistogram, null);
  assert.deepEqual([result.feedLists, result.publicLists, result.tags, result.diary], [[], [], [], []]);
  assert.deepEqual(result.feedStories, []); assert.equal(result.feed, null); assert.equal(result.profile, null);
  assert.deepEqual(result.checks, {});
  await assertNoRetainedFiles();
});

test('extended collector preserves five-second gaps between all six page requests', { timeout: 40000 }, async () => {
  const navigations = [], times = [];
  const row = { id: 'letterboxd-watch-1', title: 'Synthetic film', entryUrl: 'https://letterboxd.com/alice/film/example/', watchedDate: '2020-01-01', rating: 4 };
  const page = {
    goto: async url => { navigations.push(url); times.push(Date.now()); return { status: () => 200, headers: () => ({}), text: async () => '<rss/>' }; },
    url: () => navigations.at(-1),
    evaluate: async (_, { section }) => section === 'recent' ? { recognized: true, channelLink: 'https://letterboxd.com/alice/', entries: [row], lists: [], stories: [] } : { recognized: true, entries: [], empty: true, next: null, totalAvailable: null },
  };
  const browser = { newContext: async () => ({ route: async () => {}, newPage: async () => page, close: async () => {} }), close: async () => {} };
  const result = await collectEphemeralSnapshot('alice', { mode: 'extended', launchBrowser: async () => browser });
  assert.equal(result.complete, true);
  assert.equal(navigations.length, 6);
  for (let i=1;i<times.length;i++) assert.ok(times[i] - times[i-1] >= 5000);
    assert.deepEqual(navigations.map(url => new URL(url).pathname), ['/alice/rss/', '/alice/films/', '/alice/lists/', '/alice/tags/', '/alice/diary/', '/alice/watchlist/']);
});

for (const mode of ['blocked', 'challenge', 'watched-blocked', 'rate-limited', 'lists-blocked']) {
  test(`stops requesting pages at the first block: ${mode}`, async () => {
    const requests = [];
    const result = await collectEphemeralSnapshot('alice', { mode: 'extended', waitForRequest: async () => {}, launchBrowser: () => launchFixtureBrowser(mode, requests) });
    assert.equal(result.complete, false);
    assert.deepEqual(requests, mode === 'blocked' || mode === 'challenge' ? ['recent'] : mode === 'lists-blocked' ? ['recent', 'watchedFilms', 'publicLists'] : ['recent', 'watchedFilms']);
    assert.equal(result.checks.watchlist.skipped, true);
    assert.equal(result.checks[requests.at(-1)].blocked, true);
    if (mode === 'rate-limited') assert.equal(result.checks.watchedFilms.retryAfterSeconds, 30);
    if (requests.length >= 2) assert.equal(result.recent.length, 50);
  });
}

test('RSS lists are excluded from movie entries and the histogram is only a recent sample', async () => {
  const requests = [];
  const result = await collectEphemeralSnapshot('alice', { mode: 'extended', waitForRequest: async () => {}, launchBrowser: () => launchFixtureBrowser('success', requests) });
  assert.deepEqual(requests, ['recent', 'watchedFilms', 'publicLists', 'tags', 'diary', 'watchlist']);
  assert.equal(result.schemaVersion, 6);
  assert.equal(result.recent.length, 50);
  assert.equal(result.recent[0].tmdbId, '1');
  assert.equal(result.recent[0].reviewText, 'A synthetic review.');
  assert.equal(result.recent[0].liked, true);
  assert.equal(result.recentRatingHistogram.totalRatings, 50);
  assert.match(result.recentRatingHistogram.coverage, /RSS.*only/);
  assert.equal(result.checks.recent.entireCollection, false);
  assert.equal('ratingHistogram' in result || 'favorites' in result || 'likedFilms' in result, false);
});

test('cancelling during pacing requests no subsequent page and discards partial data', async () => {
  const controller = new AbortController();
  const requests = [];
  let calls = 0;
  const result = await collectEphemeralSnapshot('alice', { mode: 'extended', signal: controller.signal,
    waitForRequest: async () => { if (++calls === 2) controller.abort(); },
    launchBrowser: () => launchFixtureBrowser('success', requests) });
  assert.deepEqual(requests, ['recent']);
  assert.equal(result.username, '');
  assert.deepEqual([result.recent, result.watchedFilms, result.watchlist], [[], [], []]);
  assert.equal(result.recentRatingHistogram, null);
  assert.deepEqual([result.feedLists, result.publicLists, result.tags, result.diary], [[], [], [], []]);
  assert.deepEqual(result.feedStories, []); assert.equal(result.feed, null); assert.equal(result.profile, null);
});


test('private watchlist renders verified partial sections and never shows collection success', async () => {
  await withApp('private-watchlist', async ({ base }) => {
    const page = await uiBrowser.newPage();
    try {
      await page.goto(base);
      await page.getByLabel('Your Letterboxd username', { exact: true }).fill('alice');
      await page.getByRole('button', { name: 'Collect my films' }).click();
      await page.locator('#status.error').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#result-label').innerText(), 'Incomplete lookup');
      assert.equal(await page.locator('#recent-list .recent').count(), 50);
      assert.equal(await page.locator('#watched-list .film-row').count(), 72);
      assert.equal(await page.locator('#watchlist-list .film-row').count(), 0);
      assert.match(await page.locator('#status').innerText(), /private/);
      assert.equal(await page.locator('#watchlist-count').innerText(), 'Unavailable');
      await page.locator('.film-collection').nth(1).locator('summary').click();
      assert.match(await page.locator('#watchlist-list').innerText(), /could not be collected/);
      await page.getByRole('button', { name: 'Clear now', exact: true }).click();
      assert.equal(await page.locator('#results').isHidden(), true);
      assert.equal(await page.locator('#username').inputValue(), '');
    } finally { await page.close(); }
  });
});


test('expanded metadata is collected in memory with explicit bounded coverage', async () => {
  const requests = [];
  const result = await collectEphemeralSnapshot('alice', { mode: 'extended', waitForRequest: async () => {}, launchBrowser: () => launchFixtureBrowser('success', requests) });
  assert.equal(result.complete, true);
  assert.equal(result.feed.title, 'Alice');
  assert.equal(result.profile.displayName, 'Alice');
  assert.equal(result.profile.membership, 'pro');
  assert.equal(result.profile.avatarUrl, 'https://example.invalid/avatar.jpg');
  assert.equal(result.feedLists.length, 1);
  assert.equal(result.feedLists[0].filmReferences[0].url, 'https://letterboxd.com/film/example/');
  assert.equal(result.recent[0].creatorName, 'Alice');
  assert.equal(result.recent[0].images[0].url, 'https://example.invalid/poster.jpg');
  assert.equal(result.watchedFilms[0].slug, 'movie-1');
  assert.equal(result.watchedFilms[0].posterPath, '/film/movie-1/poster/');
  assert.equal(result.publicLists.length, 12);
  assert.equal(result.publicLists[0].filmCount, 3);
  assert.equal(result.publicLists[0].previewFilms.length, 1);
  assert.equal(result.tags.length, 120);
  assert.equal(result.tags[0].count, 3);
  assert.equal(result.diary.length, 50);
  assert.equal(result.diary[0].watchedDate, '2020-01-01');
  assert.equal(result.checks.feedLists.entireCollection, false);
  for (const section of ['publicLists','tags','diary']) {
    assert.equal(result.checks[section].hasMore, true);
    assert.equal(result.checks[section].entireCollection, false);
    assert.ok(Number.isFinite(result.checks[section].durationMs));
  }
  assert.equal(requests.length, 6);
  await assertNoRetainedFiles();
});


for (const cancel of [false, true]) test(`default collector disposes its owned process once: cancel=${cancel}`, async () => {
  const fixture = await launchFixtureBrowser('success');
  let kills = 0;
  const newContext = fixture.newContext;
  fixture.newContext = async options => {
    const context = await newContext(options);
    context.close = async () => { throw new Error('Separate context disposal must not be used'); };
    return context;
  };
  const launch = mock.method(chromium, 'launch', async () => { throw new Error('Default must use an owned process'); });
  const ownedProcess = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, kill: () => { kills++; void fixture.close().then(() => { ownedProcess.signalCode = 'SIGKILL'; ownedProcess.emit('exit'); }); return true; } });
  const launchServer = mock.method(chromium, 'launchServer', async () => ({ process: () => ownedProcess, wsEndpoint: () => 'ws://synthetic', kill: () => new Promise(() => {}) }));
  const connect = mock.method(chromium, 'connect', async () => fixture);
  try {
    const controller = new AbortController(); let calls = 0;
    const result = await collectEphemeralSnapshot('alice', { mode: 'extended', cleanupTimeoutMs: 1000, signal: controller.signal, waitForRequest: async () => { if (cancel && ++calls === 2) controller.abort(); } });
    assert.equal(result.complete, !cancel);
    if (cancel) { assert.equal(result.username, ''); assert.deepEqual([result.recent, result.feedLists, result.diary, result.tags, result.publicLists], [[], [], [], [], []]); assert.deepEqual(result.feedStories, []); assert.equal(result.feed, null); assert.equal(result.profile, null); }
    assert.equal(kills, 1);
    assert.equal(launchServer.mock.calls[0].arguments[0].host, '127.0.0.1');
    assert.equal(launchServer.mock.calls[0].arguments[0].headless, true);
  } finally { launch.mock.restore(); launchServer.mock.restore(); connect.mock.restore(); await fixture.close().catch(() => {}); }
});


for (const mode of ['no-lists-whitespace','no-film-tags','tag-aliases','story-rss','stories-only']) {
  test(`varied-account regression: ${mode}`, async () => {
    const requests = [];
    const result = await collectEphemeralSnapshot('alice', { mode: 'extended', waitForRequest: async () => {}, launchBrowser: () => launchFixtureBrowser(mode, requests) });
    assert.equal(result.complete, true);
    assert.equal(requests.length, 6);
    assert.equal(result.checks.watchlist.complete, true);
    if (mode === 'no-lists-whitespace') assert.deepEqual(result.publicLists, []);
    if (mode === 'no-film-tags') assert.deepEqual(result.tags, []);
    if (mode === 'tag-aliases') { assert.equal(result.tags.length,120); assert.equal(result.tags[0].url,result.tags[1].url); assert.notEqual(result.tags[0].name,result.tags[1].name); }
    if (mode === 'story-rss' || mode === 'stories-only') {
      assert.equal(result.feedStories.length,1);
      assert.equal(result.feedStories[0].storyUrl,'https://letterboxd.com/alice/story/example/');
      assert.equal(result.feedStories[0].filmReferences.length,1);
      assert.equal(result.checks.feedStories.entireCollection,false);
      assert.equal(result.recent.length,mode==='stories-only'?0:50);
    }
  });
}


test('story-only RSS renders a verified empty movie window and keeps later collections', async () => {
  await withApp('stories-only', async ({base}) => {
    const page = await uiBrowser.newPage();
    try {
      await page.goto(base);
      await page.getByLabel('Your Letterboxd username', {exact:true}).fill('alice');
      const pending=page.waitForResponse(r=>r.url().endsWith('/api/collect'));
      await page.getByRole('button',{name:'Collect my films'}).click();
      const result=await (await pending).json();
      await page.locator('#results').waitFor({state:'visible'});
      assert.equal(result.complete,true);
      assert.equal(result.feedStories.length,1);
      assert.equal(result.recent.length,0);
      assert.equal(result.recentRatingHistogram.totalRatings,0);
      assert.equal(await page.locator('#status').innerText(),'Collection complete.');
      assert.match(await page.locator('#recent-list').innerText(),/No movie entries/);
      assert.equal(await page.locator('#watched-list .film-row').count(),72);
      assert.equal(await page.locator('#watchlist-list .film-row').count(),28);
    } finally { await page.close(); }
  });
});

test('an unavailable account shows incomplete and never invents empty collections', async () => {
  await withApp('not-found', async ({base}) => {
    const page=await uiBrowser.newPage();
    try {
      await page.goto(base);
      await page.getByLabel('Your Letterboxd username',{exact:true}).fill('alice');
      const pending=page.waitForResponse(r=>r.url().endsWith('/api/collect'));
      await page.getByRole('button',{name:'Collect my films'}).click();
      const result=await (await pending).json();
      await page.locator('#status.error').waitFor({state:'visible'});
      assert.equal(result.complete,false);
      assert.equal(result.checks.watchedFilms.skipped,true);
      assert.equal(await page.locator('#result-label').innerText(),'Incomplete lookup');
      assert.match(await page.locator('#recent-list').innerText(),/could not be collected/);
      assert.match(await page.locator('#status').innerText(),/404/);
      assert.deepEqual(result.feedStories,[]);
      await assertNoRetainedFiles();
    } finally { await page.close(); }
  });
});


test('an empty public watchlist is not made private by settings text', async () => {
  await withApp('public-empty-watchlist', async ({base}) => {
    const page=await uiBrowser.newPage();
    try {
      await page.goto(base);
      await page.getByLabel('Your Letterboxd username',{exact:true}).fill('alice');
      const pending=page.waitForResponse(r=>r.url().endsWith('/api/collect'));
      await page.getByRole('button',{name:'Collect my films'}).click();
      const result=await (await pending).json();
      await page.locator('#results').waitFor({state:'visible'});
      assert.equal(result.complete,true);
      assert.equal(result.checks.watchlist.complete,true);
      assert.deepEqual(result.watchlist,[]);
      assert.equal(await page.locator('#watchlist-count').innerText(),'0 films');
      assert.equal(await page.locator('#status').innerText(),'Collection complete.');
    } finally { await page.close(); }
  });
});


for (const [mode, expectedCode] of [['empty',0], ['not-found',3], ['blocked',2]]) {
  test(`unattended checker validates rendered state before exiting: ${mode}`, {timeout:30000}, async () => {
    await withApp(mode, async ({base}) => {
      const child=spawn(process.execPath,['scripts/test-live.mjs','alice'], {env:{...process.env,TEST_URL:base},stdio:'ignore'});
      const timeout=setTimeout(()=>child.kill('SIGTERM'),25000);
      try {
        const code=await new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject)});
        assert.equal(code,expectedCode);
      } finally {clearTimeout(timeout);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');}
    });
  });
}

for (const mode of ['success', 'watched-blocked', 'stories-only', 'empty']) {
  test(`reliable default has an explicit RSS-only scope: ${mode}`, async () => {
    const requests = [];
    const result = await collectEphemeralSnapshot('alice', {waitForRequest:async()=>{},launchBrowser:noBrowser,fetch:fakeFetch(mode,requests)});
    assert.deepEqual(requests,['recent']);
    assert.equal(result.complete,true);
    assert.equal(result.scope.mode,'rss');
    assert.equal('watchlist' in result.scope,false);
    for(const section of ['watchedFilms','publicLists','tags','diary','watchlist']) {
      assert.equal(result.checks[section].requested,false);
      assert.equal(result.checks[section].skipped,true);
      assert.deepEqual(result[section],[]);
    }
    assert.equal(result.checks.recent.complete,true);
  });
}


test('RSS-only website makes its reduced scope visible and hides omitted collections', async () => {
  await withApp('success',async({base})=>{
    const page=await uiBrowser.newPage();
    try {
      await page.goto(base);
      await page.getByLabel('Your Letterboxd username',{exact:true}).fill('alice');
      const pending=page.waitForResponse(r=>r.url().endsWith('/api/collect'));
      await page.getByRole('button',{name:'Collect my films'}).click();
      const result=await (await pending).json();
      await page.locator('#results').waitFor({state:'visible'});
      assert.equal(result.complete,true); assert.equal(result.scope.mode,'rss');
      assert.equal(await page.locator('#status').innerText(),'RSS feed collected.');
      assert.equal(await page.locator('.film-collection:visible').count(),0);
      assert.match(await page.locator('.lede').innerText(),/RSS.*not your full history/);
      await page.getByRole('button',{name:'Clear now',exact:true}).click();
      assert.equal(await page.locator('#results').isHidden(),true);
      assert.equal(await page.locator('#username').inputValue(),'');
    } finally {await page.close();}
  },'rss');
});

for (const [mode,code] of [['empty',0],['blocked',2],['not-found',3]]) {
  test(`RSS-only checker preserves honest outcomes: ${mode}`,{timeout:30000},async()=>{
    await withApp(mode,async({base})=>{
      const child=spawn(process.execPath,['scripts/test-live.mjs','alice'],{env:{...process.env,TEST_URL:base},stdio:'ignore'});
      const timer=setTimeout(()=>child.kill('SIGTERM'),25000);
      try {assert.equal(await new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject)}),code);}
      finally {clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');}
    },'rss');
  });
}


test('transport failure stays unsuccessful and its username/error expire', async () => {
  await withApp('success',async({base})=>{
    const page=await uiBrowser.newPage();
    try {
      await page.clock.install();
      await page.route('**/api/collect',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Service unavailable.'})}));
      await page.goto(base);
      await page.getByLabel('Your Letterboxd username',{exact:true}).fill('alice');
      await page.getByRole('button',{name:'Collect my films'}).click();
      await page.locator('#status.error').waitFor({state:'visible'});
      assert.equal(await page.locator('#results').isHidden(),true);
      assert.equal(await page.locator('#submit').isEnabled(),true);
      await page.clock.fastForward(120001);
      assert.equal(await page.locator('#username').inputValue(),'');
      assert.match(await page.locator('#status').innerText(),/Results cleared/);
    } finally {await page.close();}
  },'rss');
});


// The RSS fetch path must produce the same verified data as the browser parser.
for (const mode of ['success', 'few', 'story-rss', 'stories-only', 'empty']) {
  test(`plain-HTTP RSS parser matches the browser parser: ${mode}`, async () => {
    const viaBrowser = await collectEphemeralSnapshot('alice', { mode: 'extended', waitForRequest: async () => {}, launchBrowser: () => launchFixtureBrowser(mode) });
    const viaFetch = await collectEphemeralSnapshot('alice', { waitForRequest: async () => {}, launchBrowser: noBrowser, fetch: fakeFetch(mode) });
    assert.equal(viaFetch.complete, true);
    for (const key of ['recent', 'feedLists', 'feedStories', 'feed', 'recentRatingHistogram']) assert.deepEqual(viaFetch[key], viaBrowser[key], key);
  });
}

for (const [mode, error, blocked] of [['duplicate', /duplicate|unrecognized/, false], ['malformed-rss', /verify/, false], ['missing-date', /watched date/, false], ['invalid-rating', /invalid rating/, false], ['wrong-feed', /different profile/, false], ['foreign-list', /list URL/, false], ['foreign-story', /story URL/, false], ['challenge', /security verification/, true], ['blocked', /HTTP 403/, true], ['not-found', /HTTP 404/, false]]) {
  test(`plain-HTTP RSS rejects invalid or blocked feeds: ${mode}`, async () => {
    const result = await collectEphemeralSnapshot('alice', { waitForRequest: async () => {}, launchBrowser: noBrowser, fetch: fakeFetch(mode) });
    assert.equal(result.complete, false);
    assert.match(result.errors[0].message, error);
    assert.equal(result.checks.recent.blocked, blocked);
    assert.deepEqual(result.recent, []);
  });
}

test('plain-HTTP RSS decodes entities and rejects undeclared ones', () => {
  const feed = body => `<?xml version="1.0"?><rss><channel><link>https://letterboxd.com/alice/</link><item><guid>letterboxd-review-1</guid><link>https://letterboxd.com/alice/film/x/</link><letterboxd:filmTitle>${body}</letterboxd:filmTitle><description><![CDATA[<p>It&#8217;s &amp; it&rsquo;s <a href='/film/x/'>X&nbsp;film</a></p>]]></description></item></channel></rss>`;
  const parsed = parseRss(feed('Tom &amp; Jerry &#x2014; &lt;3'));
  assert.equal(parsed.recognized, true);
  assert.equal(parsed.entries[0].title, 'Tom & Jerry — <3');
  assert.equal(parsed.entries[0].reviewText, 'It’s & it’s X film');
  assert.deepEqual(parsed.entries[0].links, [{ url: 'https://letterboxd.com/film/x/', text: 'X film' }]);
  assert.equal(parseRss(feed('Tom &bogus; Jerry')).recognized, false);
  assert.equal(parseRss(feed('Tom & Jerry')).recognized, false);
  assert.equal(parseRss('<rss><channel><item></channel></rss>').recognized, false);
});

test('plain-HTTP RSS refuses redirects and oversized feeds without buffering them', async () => {
  const redirect = await collectEphemeralSnapshot('alice', { waitForRequest: async () => {}, launchBrowser: noBrowser,
    fetch: async () => new Response(null, { status: 301, headers: { Location: 'https://letterboxd.com/other/rss/' } }) });
  assert.equal(redirect.complete, false); assert.match(redirect.errors[0].message, /redirected/);
  let pulled = 0, cancelled = false;
  const chunk = new Uint8Array(1024 * 1024);
  const huge = new ReadableStream({ pull(controller) { pulled++; if (pulled > 50) controller.close(); else controller.enqueue(chunk); }, cancel() { cancelled = true; } });
  const oversized = await collectEphemeralSnapshot('alice', { waitForRequest: async () => {}, launchBrowser: noBrowser,
    fetch: async () => new Response(huge, { status: 200, headers: { 'Content-Type': 'application/rss+xml' } }) });
  assert.equal(oversized.complete, false); assert.match(oversized.errors[0].message, /exceeded the collection limit/);
  assert.ok(pulled <= 7, `read ${pulled} MiB before stopping`); assert.equal(cancelled, true);
});

test('cancelling a plain-HTTP RSS lookup aborts the request and scrubs the result', async () => {
  const controller = new AbortController();
  let requestSignal;
  const pending = collectEphemeralSnapshot('alice', { signal: controller.signal, waitForRequest: async () => {}, launchBrowser: noBrowser,
    fetch: (url, options) => new Promise((resolve, reject) => { requestSignal = options.signal; options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }); queueMicrotask(() => controller.abort()); }) });
  const result = await pending;
  assert.equal(requestSignal.aborted, true);
  assert.equal(result.complete, false); assert.equal(result.username, ''); assert.deepEqual(result.recent, []); assert.deepEqual(result.checks, {});
});
