const ORIGIN = 'https://letterboxd.com';
const SECTIONS = ['diary', 'films', 'reviews'];
const PAGE_SIZES = { diary: 50, films: 72, reviews: 12 };

export function validateUsername(value) {
  if (!/^[a-zA-Z0-9_]{1,40}$/.test(value)) {
    throw new Error('Enter a Letterboxd username using letters, numbers or underscores.');
  }
  return value.toLowerCase();
}

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

// This function runs in the browser. Read the rendered public page, not private APIs.
function readSection(section) {
  const text = (el) => el?.textContent.trim() || null;
  const poster = (el) => {
    const p = el.querySelector('[data-component-class="LazyPoster"]');
    const id = p?.getAttribute('data-postered-identifier');
    return {
      filmId: id ? JSON.parse(id).uid : el.getAttribute('data-production-uid'),
      filmUrl: p?.getAttribute('data-item-link') ? new URL(p.getAttribute('data-item-link'), location.origin).href : null,
      name: p?.getAttribute('data-item-name'),
    };
  };
  const rating = (el) => {
    const match = el.querySelector('.rating')?.className.match(/\brated-(\d+)\b/);
    return match ? Number(match[1]) / 2 : null;
  };
  let rows;
  if (section === 'diary') {
    rows = Array.from(document.querySelectorAll('#diary-table tbody tr')).map((el) => {
      const datePath = el.querySelector('.daydate')?.getAttribute('href');
      const date = datePath?.match(/\/for\/(\d{4})\/(\d{2})\/(\d{2})\//);
      const link = el.querySelector('h2 a, h3 a');
      return {
        id: el.getAttribute('data-viewing-id'), ...poster(el),
        title: text(link), year: text(el.querySelector('.col-releaseyear')),
        entryUrl: link?.href || null,
        watchedDate: date ? `${date[1]}-${date[2]}-${date[3]}` : null,
        rating: rating(el), liked: !!el.querySelector('.col-like .icon-liked'),
        rewatch: el.querySelector('.col-rewatch') ? !el.querySelector('.col-rewatch').classList.contains('icon-status-off') : null,
        reviewUrl: el.querySelector('.col-review a')?.href || null,
      };
    });
  } else if (section === 'films') {
    rows = Array.from(document.querySelectorAll('li.griditem')).filter(el => el.querySelector('[data-component-class="LazyPoster"]')).map(el => ({
      ...poster(el), rating: rating(el), liked: !!el.querySelector('.icon-liked'),
    }));
  } else {
    rows = Array.from(document.querySelectorAll('article.js-production-viewing')).map(el => ({
      id: el.getAttribute('data-object-id'), ...poster(el),
      title: text(el.querySelector('h2 a, h3 a')),
      entryUrl: el.querySelector('h2 a, h3 a')?.href || null,
      watchedDate: el.querySelector('time')?.getAttribute('datetime') || null,
      text: el.querySelector('.js-review-body')?.innerText.trim() || null,
      truncated: !!el.querySelector('.js-review-body .collapsed-text'),
    }));
  }
  const pagination = document.querySelector('.pagination');
  const pageNumbers = Array.from(pagination?.querySelectorAll('.paginate-page') || []).map(el => Number(el.textContent.trim())).filter(Number.isInteger);
  const current = Number(pagination?.querySelector('.paginate-current')?.textContent.trim() || 1);
  const next = pagination?.querySelector('a.next')?.href || null;
  const heading = Array.from(document.querySelectorAll('#content h1')).map(el => el.textContent.trim()).join(' ');
  const body = document.querySelector('#content')?.innerText || '';
  // Empty pages must explicitly say so; a missing table is never treated as zero rows.
  const empty = /(?:hasn[’']t (?:logged|reviewed|watched|added)|haven[’']t (?:logged|reviewed|watched|added)|no (?:films|diary entries|reviews))/i.test(body);
  return { url: location.href, rows, current, next, last: Math.max(1, ...pageNumbers), heading, empty, hasPagination: !!pagination };
}

export function validatePage(snapshot, { username, section, number, last, seen }) {
  const prefix = `/${username}/${section}/`;
  const url = new URL(snapshot.url);
  const expectedPath = number === 1 ? prefix : `${prefix}${section === 'films' ? '' : 'films/'}page/${number}/`;
  requireValue(url.origin === ORIGIN && url.pathname === expectedPath, `${section}: unexpected page URL ${snapshot.url}`);
  requireValue(snapshot.current === number, `${section}: requested page ${number}, received page ${snapshot.current}`);
  requireValue(snapshot.last === last, `${section}: pagination changed (${last} to ${snapshot.last}); retry from the start`);
  requireValue(snapshot.heading.toLowerCase().includes(section === 'films' ? 'watched' : section), `${section}: missing section heading`);
  requireValue(snapshot.rows.length > 0 || (last === 1 && snapshot.empty), `${section}: missing rows without an explicit empty-state message`);
  requireValue(snapshot.rows.length <= PAGE_SIZES[section], `${section}: unexpected page size`);
  requireValue(snapshot.hasPagination || snapshot.rows.length < PAGE_SIZES[section], `${section}: full page without pagination; cannot establish completeness`);
  if (number < last) {
    requireValue(snapshot.rows.length === PAGE_SIZES[section], `${section}: page ${number} is short; refusing incomplete history`);
    const nextPath = `${prefix}${section === 'films' ? '' : 'films/'}page/${number + 1}/`;
    requireValue(snapshot.next === `${ORIGIN}${nextPath}`, `${section}: missing or skipped next page after ${number}`);
  } else {
    requireValue(!snapshot.next, `${section}: unexpected next page after advertised final page`);
  }
  for (const row of snapshot.rows) {
    const id = section === 'films' ? row.filmId : row.id;
    requireValue(id && row.filmId && row.filmUrl, `${section}: missing entry or film identifier`);
    requireValue(section !== 'diary' || (row.title && row.watchedDate && row.entryUrl), 'diary: missing title, watched date or entry URL');
    requireValue(section !== 'reviews' || (row.entryUrl && row.title && row.text), 'reviews: missing title, URL or review text');
    requireValue(!seen.has(id), `${section}: duplicate identifier ${id}; page may have repeated or shifted`);
    seen.add(id);
  }
}

async function rejectChallenge(page) {
  const challenged = await page.locator('.turnstile-dialog[open], #challenge-running, #challenge-stage').count();
  requireValue(!challenged && !/^Just a moment/i.test(await page.title()), `Letterboxd security verification required at ${page.url()}; unattended collection stopped. No challenge was solved.`);
}

async function navigate(page, url, readySelector, followNext = false) {
  let response;
  if (followNext) {
    await rejectChallenge(page);
    const link = page.locator('.pagination a.next');
    requireValue(await link.getAttribute('href') === new URL(url).pathname, `Next-page link changed before navigation: ${url}`);
    [response] = await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 45000 }),
      link.click({ timeout: 10000 }),
    ]);
  } else {
    const referer = page.url().startsWith(ORIGIN) ? page.url() : undefined;
    response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000, referer });
  }
  requireValue(!response || response.status() < 400, `HTTP ${response?.status()} at ${url}; public page unavailable or blocked`);
  await rejectChallenge(page);
  try {
    // A normal browser redirect may finish after DOMContentLoaded. No CAPTCHA interaction.
    await page.locator(readySelector).first().waitFor({ state: 'attached', timeout: 15000 });
  } catch {
    throw new Error(`Cannot read public page ${url} (HTTP ${response?.status() ?? 'unknown'}, title: ${await page.title()}). Blocked, unavailable, or page structure changed.`);
  }
  requireValue(new URL(page.url()).origin === ORIGIN, `Unexpected redirect from ${url}`);
  await rejectChallenge(page);
}

async function profileCount(page, username) {
  await navigate(page, `${ORIGIN}/${username}/`, `a[href="/${username}/films/"] .value`);
  const count = await page.locator(`a[href="/${username}/films/"] .value`).first().innerText();
  requireValue(/^[\d,]+$/.test(count.trim()), 'Cannot read profile film total');
  return Number(count.replaceAll(',', ''));
}

export function newResult(username) {
  return {
    schemaVersion: 1, username, status: 'incomplete', complete: false,
    scope: ['public diary entries', 'public watched films and current ratings', 'public written reviews'],
    startedAt: new Date().toISOString(), finishedAt: null, error: null,
    profileFilmCount: null, diary: [], films: [], reviews: [], checks: {},
  };
}

export async function collectHistory(page, result, { delayMs = 1000, onProgress = () => {} } = {}) {
  const { username } = result;
  result.profileFilmCount = await profileCount(page, username);
  const baselines = {};
  for (const section of SECTIONS) {
    const seen = new Set();
    let next = `${ORIGIN}/${username}/${section}/`;
    let last;
    let number = 0;
    const check = result.checks[section] = { complete: false, expectedPages: null, pages: [], entries: 0 };
    while (next) {
      number++;
      requireValue(number <= 10000, `${section}: page safety limit reached`);
      await navigate(page, next, '#content h1', number > 1);
      const snapshot = await page.evaluate(readSection, section);
      last ??= snapshot.last;
      check.expectedPages = last;
      validatePage(snapshot, { username, section, number, last, seen });
      baselines[section] ??= snapshot.rows.map(row => section === 'films' ? row.filmId : row.id);
      result[section].push(...snapshot.rows);
      check.pages.push(snapshot.url);
      check.entries += snapshot.rows.length;
      onProgress(`${section}: page ${number}/${last}, ${check.entries} entries`);
      next = snapshot.next;
      if (next && delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
    }
    requireValue(number === last, `${section}: did not reach every page`);
    check.complete = true;
  }
  requireValue(result.films.length === result.profileFilmCount, `Film total mismatch: profile ${result.profileFilmCount}, collected ${result.films.length}`);
  // Review-list pages abbreviate long text. Visit each individual entry instead of storing previews.
  result.checks.reviewText = { complete: false, resolved: 0 };
  for (const review of result.reviews.filter(row => row.truncated)) {
    requireValue(review.entryUrl.startsWith(`${ORIGIN}/${username}/film/`), 'Unexpected review detail URL');
    await navigate(page, review.entryUrl, '.js-review-body');
    const detail = await page.evaluate(() => ({
      text: document.querySelector('.js-review-body')?.innerText.trim(),
      truncated: !!document.querySelector('.js-review-body .collapsed-text'),
      id: document.querySelector('[data-object-id^="viewing:"]')?.getAttribute('data-object-id'),
    }));
    requireValue(page.url().split('?')[0] === review.entryUrl && detail.text && !detail.truncated, `Incomplete review text: ${review.entryUrl}`);
    if (detail.id) requireValue(detail.id === review.id, `Review identity changed: ${review.entryUrl}`);
    review.text = detail.text;
    review.truncated = false;
    result.checks.reviewText.resolved++;
    onProgress(`full review text: ${result.checks.reviewText.resolved}`);
    if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  result.checks.reviewText.complete = true;
  // Fail if entries were added/removed while offset-based pages were being collected.
  for (const section of SECTIONS) {
    await navigate(page, `${ORIGIN}/${username}/${section}/`, '#content h1');
    const snapshot = await page.evaluate(readSection, section);
    validatePage(snapshot, { username, section, number: 1, last: result.checks[section].expectedPages, seen: new Set() });
    const ids = snapshot.rows.map(row => section === 'films' ? row.filmId : row.id);
    requireValue(JSON.stringify(ids) === JSON.stringify(baselines[section]), `${section}: history changed during collection; retry`);
  }
  requireValue(await profileCount(page, username) === result.profileFilmCount, 'Profile film total changed during collection; retry');
  result.checks.stableBoundaries = true;
  result.complete = true;
  result.status = 'complete';
  return result;
}
