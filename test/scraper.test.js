import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { launchOwnedBrowser } from '../src/snapshot.js';
import { collectHistory, newResult, validateUsername } from '../src/scraper.js';

let browser;
before(async () => { browser = await launchOwnedBrowser(); });
after(async () => { await browser?.close(); });

const base = 'https://letterboxd.com';
const sizes = { diary: 50, films: 72, reviews: 12 };
function pagination(section, number, mutation) {
  const url = n => `/alice/${section}/${section === 'films' ? '' : 'films/'}page/${n}/`;
  if (mutation === 'missing-pagination') return '';
  const next = number === 1 && mutation !== 'missing-next' ? `<a class="next" href="${url(mutation === 'skipped-next' ? 3 : 2)}">Older</a>` : '';
  return `<div class="pagination">${next}<span class="paginate-page paginate-current">${number}</span>${number === 1 ? `<span class="paginate-page"><a href="${url(2)}">2</a></span>` : ''}</div>`;
}
function poster(id) {
  return `<div data-component-class="LazyPoster" data-postered-identifier='{"uid":"film:${id}"}' data-item-name="Film ${id} (2020)" data-item-link="/film/movie-${id}/"></div>`;
}
function fixture(section, number, mutation, changed) {
  const size = sizes[section];
  const count = number === 1 ? size : 1;
  const rows = Array.from({ length: count }, (_, i) => {
    const id = (number - 1) * size + i + 1 + (changed ? 1000 : 0);
    const rowId = mutation === 'duplicate' && number === 2 ? 1 : id;
    if (section === 'diary') return `<tr data-viewing-id="${rowId}"><td>${poster(id)}</td><td class="col-daydate"><a class="daydate" href="/alice/diary/films/for/2020/01/01/">1</a></td><td><h2><a href="/alice/film/movie-${id}/">Film ${id}</a></h2></td><td class="col-releaseyear">2020</td><td class="col-rating"><span class="rating rated-7">★★★½</span></td><td class="col-rewatch icon-status-off"></td></tr>`;
    if (section === 'films') return `<li class="griditem">${poster(id)}<span class="rating rated-8">★★★★</span></li>`;
    const long = number === 2;
    return `<article class="js-production-viewing" data-object-id="viewing:${id}">${poster(id)}<h2><a href="/alice/film/review-${id}/">Film ${id}</a></h2><time datetime="2020-01-01"></time><div class="js-review-body">${long ? '<div class="collapsed-text">Preview…</div>' : `Review ${id}`}</div></article>`;
  }).join('');
  return `<main id="content"><h1>${section === 'films' ? 'Watched' : section}</h1>${section === 'diary' ? `<table id="diary-table"><tbody>${rows}</tbody></table>` : rows}${pagination(section, number, mutation)}</main>`;
}

async function collectFixture(mutation) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const result = newResult('alice');
  const visits = new Map();
  await page.route(`${base}/**`, async route => {
    const url = new URL(route.request().url());
    const count = (visits.get(url.pathname) || 0) + 1;
    visits.set(url.pathname, count);
    let body;
    let status = 200;
    if (url.pathname === '/alice/') {
      body = `<a href="/alice/films/"><span class="value">${mutation === 'count-mismatch' ? 74 : 73}</span></a>`;
    } else if (url.pathname.startsWith('/alice/film/review-')) {
      if (mutation === 'missing-review') { status = 404; body = 'Missing'; }
      else body = '<article data-object-id="viewing:13"><div class="js-review-body">Complete review, including the ending.</div></article>';
    } else {
      const match = url.pathname.match(/^\/alice\/(diary|films|reviews)\/(?:films\/)?(?:page\/(\d+)\/)?$/);
      if (!match) { status = 404; body = 'Unknown route'; }
      else {
        const [, section, n] = match;
        const number = Number(n || 1);
        if (mutation === 'missing-page' && section === 'diary' && number === 2) { status = 404; body = '<main id="content"><h1>Diary</h1></main>'; }
        else if (mutation === 'blocked' && section === 'diary') { status = 403; body = 'Security check'; }
        else {
          body = fixture(section, number, section === 'diary' ? mutation : null, mutation === 'changed-history' && section === 'diary' && number === 1 && count > 1);
          if (mutation === 'challenge' && section === 'diary') body += '<dialog open class="turnstile-dialog">Security verification</dialog>';
          if (mutation === 'empty-middle' && section === 'diary' && number === 2) body = '<main id="content"><h1>Diary</h1></main>';
        }
      }
    }
    await route.fulfill({ status, contentType: 'text/html', body });
  });
  try {
    await collectHistory(page, result, { delayMs: 0 });
    return result;
  } catch (error) {
    assert.equal(result.complete, false, 'a failed traversal must never claim success');
    throw error;
  } finally { await context.close(); }
}

test('collects every page, preserves ratings, resolves full reviews and verifies totals', async () => {
  const result = await collectFixture();
  assert.equal(result.complete, true);
  assert.equal(result.diary.length, 51);
  assert.equal(result.films.length, 73);
  assert.equal(result.reviews.length, 13);
  assert.equal(result.diary[0].rating, 3.5);
  assert.equal(result.diary[0].watchedDate, '2020-01-01');
  assert.equal(result.reviews.at(-1).text, 'Complete review, including the ending.');
  assert.equal(result.reviews.at(-1).truncated, false);
  assert.equal(result.checks.stableBoundaries, true);
});

for (const [mutation, message] of [
  ['missing-page', /HTTP 404/],
  ['missing-next', /missing or skipped next page/],
  ['skipped-next', /missing or skipped next page/],
  ['missing-pagination', /full page without pagination/],
  ['duplicate', /duplicate identifier/],
  ['blocked', /HTTP 403/],
  ['challenge', /security verification required/],
  ['empty-middle', /requested page 2, received page 1/],
  ['count-mismatch', /Film total mismatch/],
  ['missing-review', /HTTP 404/],
  ['changed-history', /history changed during collection/],
]) {
  test(`refuses success: ${mutation}`, async () => { await assert.rejects(collectFixture(mutation), message); });
}

test('validates usernames before constructing URLs', () => {
  assert.equal(validateUsername('Alice_123'), 'alice_123');
  for (const username of ['../alice', 'alice?x=1', 'https://letterboxd.com/alice/', '', 'a/b']) {
    assert.throws(() => validateUsername(username));
  }
});
