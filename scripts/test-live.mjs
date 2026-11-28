// Real account data is inspected only in memory. No screenshots, files or logs.
import { launchOwnedBrowser } from '../src/snapshot.js';
import assert from 'node:assert/strict';

const username = process.argv[2] || 'dave';
const base = process.env.TEST_URL || 'http://127.0.0.1:3000';
let browser, page;
const deadline = setTimeout(() => process.exit(1), 150000);
try {
  browser = await launchOwnedBrowser();
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  let browserError = false;
  page.on('pageerror', () => { browserError = true; });
  page.on('console', message => { if (message.type() === 'error') browserError = true; });
  await page.goto(base);
  await page.getByLabel('Your Letterboxd username', { exact: true }).fill(username);
  const pending = page.waitForResponse(response => response.url().endsWith('/api/collect') && response.request().method() === 'POST', { timeout: 180000 });
  await page.getByRole('button', { name: 'Look up', exact: true }).click();
  const response = await pending;
  assert.ok(response.status() === 200 && response.headers()['cache-control'] === 'no-store');
  const result = await response.json();
  const privateWatchlist = result.checks?.watchlist?.error === 'watchlist is private; it was not assumed empty.';
  const expectedPartial = !result.complete && privateWatchlist && result.checks?.recent?.complete && result.checks?.watchedFilms?.complete && ['publicLists','tags','diary'].every(section => result.checks?.[section]?.complete);
  if (!result.complete && !expectedPartial) {
    process.exitCode = Object.values(result.checks || {}).some(check => check.blocked) ? 2 :
      ({ recent: 3, watchedFilms: 4, watchlist: 5, publicLists: 7, tags: 8, diary: 9, collection: 6, cleanup: 6 }[result.errors?.[0]?.section] || 6);
  }
  assert.equal(result.schemaVersion, 6);
  const sections = [['recent', 50], ['watchedFilms', 72], ['publicLists', 12], ['tags', 120], ['diary', 50], ['watchlist', 28]];
  for (const [section, limit] of sections) {
    assert.ok(Array.isArray(result[section]) && result[section].length <= limit);
    if (result.checks[section]?.complete) assert.ok(!result.checks[section].hasMore || result[section].length === limit);
    else assert.equal(result[section].length, 0);
  }
  assert.ok(['rss','extended'].includes(result.scope.mode));
  const requested = result.scope.mode === 'rss' ? ['recent'] : sections.map(([section])=>section);
  assert.equal(result.complete, result.errors.length === 0 && requested.every(section => result.checks[section]?.complete) && !!result.checks.feedLists?.complete && !!result.checks.feedStories?.complete);
  if (result.scope.mode === 'rss') for (const [section] of sections.slice(1)) {
    assert.equal(section in result.scope,false);
    assert.equal(result.checks[section].requested,false);
    assert.equal(result.checks[section].skipped,true);
  }
  if (result.checks.recent?.complete) {
    assert.ok(result.recent.every(row => row.id && row.title && row.watchedDate && row.entryUrl));
    assert.ok(result.recentRatingHistogram.bins.length === 10 && result.recentRatingHistogram.bins.reduce((sum, bin) => sum + bin.count, 0) === result.recentRatingHistogram.totalRatings);
    assert.ok(result.feed && result.checks.feedLists.complete && result.feedLists.length <= 50);
    assert.ok(result.checks.feedStories.complete && result.feedStories.every(row => row.id && row.title && row.storyUrl));
    assert.ok(result.feedLists.every(row => row.id && row.title && row.listUrl));
    assert.ok(!result.checks.recent.entireCollection);
  } else {
    assert.equal(result.recentRatingHistogram, null);
    assert.equal(result.feed, null);
    assert.deepEqual([result.feedLists, result.feedStories], [[], []]);
  }
  assert.ok(result.profile === null || result.profile.username === result.username && result.profile.displayName);
  assert.ok(result.tags.every(row => row.name && row.url));
  assert.ok(result.diary.every(row => row.id && row.watchedDate && row.filmId));
  assert.ok(!('favorites' in result) && !('likedFilms' in result) && !('ratingHistogram' in result));
  assert.ok(!('id' in result) && !('downloadUrl' in result) && !('filename' in result));
  await page.locator('#results').waitFor({ state: 'visible' });
  // The main page shows no film list: each dated entry takes one seat, and each rated title one film can.
  const dated = result.recent.filter(row => !Number.isNaN(new Date(`${row.watchedDate}T00:00:00Z`).getTime())).length;
  assert.ok(await page.locator('#weekdays .seat.taken').count() === dated);
  if (dated) assert.ok((await page.locator('#rhythm-note').textContent()).length > 0 && (await page.locator('#meter-note').textContent()).length > 0);
  assert.ok(await page.locator('#result-label').innerText() === (result.complete ? 'Current lookup' : 'Incomplete lookup'));
  assert.equal(await page.locator('#status').getAttribute('class'), result.complete ? 'status' : 'status error');
  for (const [section, selector] of [['recent', '#recent-count'], ['watchedFilms', '#watched-count'], ['watchlist', '#watchlist-count']]) {
    if (result.scope.mode === 'rss' && section !== 'recent') continue;
    const label = await page.locator(selector).innerText();
    if (result.checks[section]?.skipped) assert.equal(label, 'Not requested');
    else if (!result.checks[section]?.complete) assert.equal(label, 'Unavailable');
    else assert.match(label, new RegExp('^' + result[section].length + ' '));
  }
  assert.ok(await page.locator('#download, #json-preview, [download]').count() === 0);
  for (const panel of await page.locator('.film-collection').all()) {
    if (result.scope.mode === 'rss') assert.equal(await panel.isVisible(),false);
    else await panel.locator('summary').click();
  }
  assert.ok(await page.locator('#watched-list .film-row').count() === result.watchedFilms.length);
  assert.ok(await page.locator('#watchlist-list .film-row').count() === result.watchlist.length);
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
  assert.ok(await page.evaluate(() => localStorage.length === 0 && sessionStorage.length === 0 && document.cookie === ''));
  const removedDownload = await page.request.get(`${base}/api/results/removed`);
  assert.ok(removedDownload.status() === 404); await removedDownload.dispose();
  await page.getByRole('button', { name: 'Clear now', exact: true }).click();
  assert.ok(await page.locator('#results').isHidden());
  assert.ok(await page.locator('.recent, .favorite, .histogram-row, .film-row, .seat, .scale-can, .floe-film, .heart-mark, .plain-mark, .rhythm-frame').count() === 0);
  assert.ok(await page.locator('#username').inputValue() === '');
  assert.ok(!browserError);
} catch {
  // Exit status is the only live-test output; never dump real account data.
  process.exitCode = 1;
} finally {
  try { await browser?.close(); } catch { process.exitCode = 1; }
  clearTimeout(deadline);
}
