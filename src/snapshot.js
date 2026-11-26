import { setTimeout as delay } from 'node:timers/promises';
import { validateUsername } from './scraper.js';

const ORIGIN = 'https://letterboxd.com';
const PATHS = { recent: 'rss/', watchedFilms: 'films/', publicLists: 'lists/', tags: 'tags/', diary: 'diary/', watchlist: 'watchlist/' };
const sectionsFor = mode => mode === 'extended' ? Object.keys(PATHS) : ['recent'];
const LIMITS = { recent: 50, feedLists: 50, watchedFilms: 72, publicLists: 12, tags: 120, diary: 50, watchlist: 28 };
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
let nextRequestAt = 0; // A process-wide pacing timestamp, never account data.
async function pace(signal) {
  // Chunk long Retry-After waits to avoid overflowing Node's timer range.
  while (Date.now() < nextRequestAt) await delay(Math.min(60000, nextRequestAt - Date.now()), undefined, { signal });
  signal?.throwIfAborted();
}

async function within(promise, timeoutMs, message) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}
const closeWithin = (resource, ms) => resource ? within(resource.close(), ms, 'Browser session cleanup timed out. The attempt was not marked successful.') : Promise.resolve();

const FEED_LIMIT = 4 * 1024 * 1024;
const USER_AGENT = 'Stillframe/1.0 (public RSS reader)';
const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const HTML_ENTITIES = { ...XML_ENTITIES, nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»' };
const ENTITY = /&(#[xX][0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g;
function decodeEntities(text, table, strict) {
  if (strict && /&(?!(?:#[xX][0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);)/.test(text)) throw new Error('Invalid XML entity.');
  return text.replace(ENTITY, (whole, name) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      if (code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)) return String.fromCodePoint(code);
    } else if (Object.hasOwn(table, name)) return table[name];
    if (strict) throw new Error('Invalid XML entity.');
    return whole;
  });
}

// A small well-formedness-checking XML reader for the fixed RSS shape. Node has
// no DOMParser, and a browser is not needed to read a public feed.
const XML_TOKEN = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<\/([A-Za-z_][\w:.-]*)\s*>|<([A-Za-z_][\w:.-]*)((?:\s+[A-Za-z_][\w:.-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>|([^<]+)/y;
function parseXml(xml) {
  const root = { name: '#document', children: [], text: '' };
  const stack = [root];
  try {
    for (let index = 0; index < xml.length;) {
      XML_TOKEN.lastIndex = index;
      const match = XML_TOKEN.exec(xml);
      if (!match) return null;
      index = XML_TOKEN.lastIndex;
      const top = stack.at(-1);
      if (match[1] !== undefined) { if (top === root) return null; top.text += match[1]; }
      else if (match[2]) { if (top.name !== match[2]) return null; stack.pop(); }
      else if (match[3]) {
        if (top === root && root.children.length) return null;
        const element = { name: match[3], children: [], text: '' };
        top.children.push(element);
        if (!match[5]) stack.push(element);
      } else if (match[6] !== undefined) {
        if (top === root) { if (match[6].trim()) return null; }
        else top.text += decodeEntities(match[6], XML_ENTITIES, true);
      }
    }
  } catch { return null; }
  return stack.length === 1 && root.children.length === 1 ? root.children[0] : null;
}
const textOf = element => element ? element.text + element.children.map(textOf).join('') : '';
const safeUrl = value => {
  try { const url = new URL(value, ORIGIN + '/'); return value && ['http:', 'https:'].includes(url.protocol) ? url.href : null; } catch { return null; }
};
const htmlText = html => decodeEntities(html.replace(/<[^>]*>/g, ''), HTML_ENTITIES, false).trim();
function htmlAttribute(attributes, name) {
  const match = attributes.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i'));
  return match ? decodeEntities(match[1] ?? match[2] ?? match[3], HTML_ENTITIES, false) : null;
}
function htmlContent(html) {
  const clean = html.replace(/<!--[\s\S]*?-->/g, '');
  const links = Array.from(clean.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi), match => ({ url: safeUrl(htmlAttribute(match[1], 'href')), text: htmlText(match[2]) })).filter(link => link.url);
  const images = Array.from(clean.matchAll(/<img\b([^>]*)>/gi), match => ({ url: safeUrl(htmlAttribute(match[1], 'src')), alt: htmlAttribute(match[1], 'alt') || '' })).filter(image => image.url);
  return { descriptionText: htmlText(clean), links, images };
}

export function parseRss(xml) {
  const doc = parseXml(xml.replace(/^﻿/, ''));
  const channel = doc?.name === 'rss' ? doc.children.find(child => child.name === 'channel') : null;
  if (!channel) return { blocked: false, recognized: false, channelLink: '', entries: [], lists: [], stories: [], unknownItems: false, feed: null };
  const field = (element, name) => textOf(element.children.find(child => child.name === name)).trim();
  const entries = [], lists = [], stories = [], seen = new Set();
  let unknownItems = false;
  for (const item of channel.children.filter(child => child.name === 'item')) {
    const id = field(item, 'guid');
    if (!id || seen.has(id)) { unknownItems = true; continue; }
    seen.add(id);
    const shared = { id, publishedAt: field(item, 'pubDate'), creatorName: field(item, 'dc:creator') || null, ...htmlContent(field(item, 'description')) };
    if (id.startsWith('letterboxd-list-')) {
      lists.push({ ...shared, title: field(item, 'title'), listUrl: field(item, 'link'), filmReferences: shared.links.filter(link => link.url.startsWith('https://letterboxd.com/film/')) });
      continue;
    }
    if (id.startsWith('letterboxd-story-')) {
      stories.push({ ...shared, title: field(item, 'title'), storyUrl: field(item, 'link'), filmReferences: shared.links.filter(link => link.url.startsWith('https://letterboxd.com/film/')) });
      continue;
    }
    if (!/^letterboxd-(watch|review)-/.test(id)) { unknownItems = true; continue; }
    const rawRating = field(item, 'letterboxd:memberRating');
    const rawLike = field(item, 'letterboxd:memberLike');
    const rawRewatch = field(item, 'letterboxd:rewatch');
    entries.push({ ...shared, title: field(item, 'letterboxd:filmTitle'), feedTitle: field(item, 'title'), year: Number(field(item, 'letterboxd:filmYear')) || null,
      filmUrl: null, entryUrl: field(item, 'link'), tmdbId: field(item, 'tmdb:movieId') || null,
      watchedDate: field(item, 'letterboxd:watchedDate'),
      rating: rawRating === '' ? null : Number(rawRating), liked: rawLike === 'Yes' ? true : rawLike === 'No' ? false : null,
      rewatch: rawRewatch === 'Yes' ? true : rawRewatch === 'No' ? false : null,
      reviewText: id.startsWith('letterboxd-review-') ? shared.descriptionText : null,
      invalidFlags: !['', 'Yes', 'No'].includes(rawLike) || !['', 'Yes', 'No'].includes(rawRewatch) });
  }
  return { blocked: false, recognized: true, channelLink: field(channel, 'link'), entries, lists, stories, unknownItems,
    feed: { title: field(channel, 'title'), description: field(channel, 'description'), profileUrl: field(channel, 'link') } };
}

function blockedError(status, retry) {
  const error = new Error(`Letterboxd returned HTTP ${status}. Collection stopped; no further pages were requested.`);
  error.blocked = true;
  if (retry) {
    const seconds = /^\d+$/.test(retry) ? Number(retry) : Math.ceil((Date.parse(retry) - Date.now()) / 1000);
    if (Number.isFinite(seconds) && seconds > 0) error.retryAfterSeconds = seconds;
  }
  return error;
}

// Reads at most FEED_LIMIT bytes; larger bodies are cancelled, not buffered.
async function readLimited(body) {
  if (!body) return '';
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let size = 0, text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      size += value.byteLength;
      requireValue(size <= FEED_LIMIT, 'RSS response exceeded the collection limit.');
      text += decoder.decode(value, { stream: true });
    }
  } finally { reader.cancel().catch(() => {}); }
}

// One plain HTTPS request for the public feed. No browser, retries, redirects or stealth.
async function fetchFeed(username, { signal, fetchImpl }) {
  const timeout = AbortSignal.timeout(20000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const response = await fetchImpl(`${ORIGIN}/${username}/rss/`, { redirect: 'manual', signal: combined, cache: 'no-store', headers: { Accept: 'application/rss+xml, application/xml;q=0.9', 'User-Agent': USER_AGENT } });
    try {
      const status = response.status;
      if (status === 403 || status === 429 || response.headers.get('cf-mitigated')) throw blockedError(status, response.headers.get('retry-after'));
      requireValue(response.type !== 'opaqueredirect' && !(status >= 300 && status < 400), 'Letterboxd redirected away from the requested page. Collection stopped.');
      requireValue(status === 200, `Letterboxd returned HTTP ${status}. Collection stopped.`);
      requireValue(!(Number(response.headers.get('content-length')) > FEED_LIMIT), 'RSS response exceeded the collection limit.');
      const xml = await readLimited(response.body);
      if (/<title>\s*(?:Just a moment|Attention Required)|cf-turnstile|challenge-stage|challenge-running/i.test(xml)) return { blocked: true };
      requireValue(/\bxml\b/i.test(response.headers.get('content-type') || ''), 'Could not verify the public recent page.');
      return parseRss(xml);
    } finally { response.body?.cancel().catch(() => {}); }
  } catch (error) {
    if (signal?.aborted || !['AbortError', 'TimeoutError', 'TypeError'].includes(error.name)) throw error;
    throw new Error(timeout.aborted ? 'Letterboxd did not respond in time. Collection stopped.' : 'Could not reach Letterboxd. Collection stopped.');
  }
}

async function readPublicPage(page, username, section) {
  const url = `${ORIGIN}/${username}/${PATHS[section]}`;
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
  const status = response?.status();
  if (status === 403 || status === 429) {
    const error = new Error(`Letterboxd returned HTTP ${status}. Collection stopped; no further pages were requested.`);
    error.blocked = true;
    const retry = response.headers()['retry-after'];
    if (retry) {
      const seconds = /^\d+$/.test(retry) ? Number(retry) : Math.ceil((Date.parse(retry) - Date.now()) / 1000);
      if (Number.isFinite(seconds) && seconds > 0) error.retryAfterSeconds = seconds;
    }
    throw error;
  }
  requireValue(status === 200, `Letterboxd returned HTTP ${status ?? 'unknown'}. Collection stopped.`);
  requireValue(page.url() === url, 'Letterboxd redirected away from the requested page. Collection stopped.');
  const xml = section === 'recent' ? await within(response.text(), 5000, 'RSS response timed out.') : null;
  requireValue(!xml || Buffer.byteLength(xml) <= 4 * 1024 * 1024, 'RSS response exceeded the collection limit.');
  return within(page.evaluate(({ section, username, xml }) => {
    const blocked = !!document.querySelector('.turnstile-dialog[open], #challenge-stage, #challenge-running, .cf-turnstile') || /^Just a moment|^Attention Required/i.test(document.title);
    if (blocked) return { blocked: true };
    const safeUrl = value => {
      try { const url = new URL(value, location.origin); return value && ['http:', 'https:'].includes(url.protocol) ? url.href : null; } catch { return null; }
    };
    if (section === 'recent') {
      const doc = new DOMParser().parseFromString(xml, 'application/xml');
      const field = (el, name) => Array.from(el.children).find(child => child.tagName === name)?.textContent.trim() || '';
      const channel = doc.querySelector('channel');
      const items = Array.from(channel?.querySelectorAll(':scope > item') || []);
      const entries = [], lists = [], stories = [], seen = new Set();
      let unknownItems = false;
      const content = item => {
        const html = new DOMParser().parseFromString(field(item, 'description'), 'text/html');
        const links = Array.from(html.querySelectorAll('a[href]')).map(a => ({ url: safeUrl(a.getAttribute('href')), text: a.textContent.trim() })).filter(a => a.url);
        const images = Array.from(html.querySelectorAll('img[src]')).map(img => ({ url: safeUrl(img.getAttribute('src')), alt: img.getAttribute('alt') || '' })).filter(img => img.url);
        return { descriptionText: (html.body.textContent || '').trim(), links, images };
      };
      for (const item of items) {
        const id = field(item, 'guid');
        if (!id || seen.has(id)) { unknownItems = true; continue; }
        seen.add(id);
        const shared = { id, publishedAt: field(item, 'pubDate'), creatorName: field(item, 'dc:creator') || null, ...content(item) };
        if (id.startsWith('letterboxd-list-')) {
          const filmReferences = shared.links.filter(link => link.url.startsWith('https://letterboxd.com/film/'));
          lists.push({ ...shared, title: field(item, 'title'), listUrl: field(item, 'link'), filmReferences });
          continue;
        }
        if (id.startsWith('letterboxd-story-')) {
          stories.push({ ...shared, title: field(item, 'title'), storyUrl: field(item, 'link'), filmReferences: shared.links.filter(link => link.url.startsWith('https://letterboxd.com/film/')) });
          continue;
        }
        if (!/^letterboxd-(watch|review)-/.test(id)) { unknownItems = true; continue; }
        const rawRating = field(item, 'letterboxd:memberRating');
        const rawLike = field(item, 'letterboxd:memberLike');
        const rawRewatch = field(item, 'letterboxd:rewatch');
        entries.push({ ...shared, title: field(item, 'letterboxd:filmTitle'), feedTitle: field(item, 'title'), year: Number(field(item, 'letterboxd:filmYear')) || null,
          filmUrl: null, entryUrl: field(item, 'link'), tmdbId: field(item, 'tmdb:movieId') || null,
          watchedDate: field(item, 'letterboxd:watchedDate'),
          rating: rawRating === '' ? null : Number(rawRating), liked: rawLike === 'Yes' ? true : rawLike === 'No' ? false : null,
          rewatch: rawRewatch === 'Yes' ? true : rawRewatch === 'No' ? false : null,
          reviewText: id.startsWith('letterboxd-review-') ? shared.descriptionText : null,
          invalidFlags: !['', 'Yes', 'No'].includes(rawLike) || !['', 'Yes', 'No'].includes(rawRewatch) });
      }
      return { blocked: false, recognized: doc.documentElement.localName === 'rss' && !doc.querySelector('parsererror') && !!channel,
        channelLink: channel ? field(channel, 'link') : '', entries, lists, stories, unknownItems,
        feed: channel ? { title: field(channel, 'title'), description: field(channel, 'description'), profileUrl: field(channel, 'link') } : null };
    }
    const body = (document.querySelector('#content')?.textContent || '').replace(/\s+/g, ' ').trim();
    const member = !!document.querySelector(`a[href="/${username}/diary/"]`);
    const header = document.querySelector('.profile-header');
    const person = header?.querySelector('h1 a');
    const profile = person?.getAttribute('href') === `/${username}/` ? {
      username, profileUrl: `https://letterboxd.com/${username}/`, displayName: person.textContent.trim(),
      avatarUrl: safeUrl(header.querySelector('.avatar img')?.getAttribute('src')),
      membership: header.querySelector('.badge.-patron') ? 'patron' : header.querySelector('.badge.-pro') ? 'pro' : null,
      coverage: 'public mini-header only; bio, location, social links and follower counts are not included' } : null;
    const next = Array.from(document.querySelectorAll('.pagination a, .paginate-nextprev a')).find(a => a.classList.contains('next') || a.textContent.trim() === 'Older')?.href || null;
    const number = text => /^[\d,]+$/.test(text?.trim() || '') ? Number(text.trim().replaceAll(',', '')) : null;
    const film = el => {
      const p = el.matches('[data-component-class="LazyPoster"]') ? el : el.querySelector('[data-component-class="LazyPoster"]');
      const identifier = p?.getAttribute('data-postered-identifier');
      const name = p?.getAttribute('data-item-name') || '';
      const year = name.match(/\((\d{4})\)$/)?.[1];
      return { filmId: identifier ? JSON.parse(identifier).uid : null, title: year ? name.slice(0, -7).trim() : name,
        year: year ? Number(year) : null, filmUrl: safeUrl(p?.getAttribute('data-item-link')),
        slug: p?.getAttribute('data-item-slug') || null, fullDisplayName: p?.getAttribute('data-item-full-display-name') || null,
        posterPath: p?.getAttribute('data-resolvable-poster-path') || null };
    };
    const rating = el => { const score = el.querySelector('.rating')?.className.match(/\brated-(\d+)\b/); return score ? Number(score[1]) / 2 : null; };
    if (section === 'publicLists') {
      const all = Array.from(document.querySelectorAll('#content .list-summary'));
      return { blocked: false, recognized: member && document.title.toLowerCase().includes('lists'), profile, next, totalAvailable: null,
        empty: all.length === 0 && /no (?:public )?lists(?: yet)?|hasn[’']t (?:made|created|published|added) (?:any )?(?:public )?lists/i.test(body),
        entries: all.map(el => {
          const title = el.querySelector('.name a');
          const tags = Array.from(el.querySelectorAll('.tags a[href]')).map(a => ({ name: a.textContent.trim(), url: safeUrl(a.getAttribute('href')) }));
          const reactions = Array.from(el.querySelectorAll('.content-reactions-strip a.metadata:not(.show-for-owner)')).map(a => ({ url: safeUrl(a.getAttribute('href')), text: a.textContent.trim() }));
          return { id: el.getAttribute('data-film-list-id'), title: title?.textContent.trim(), listUrl: safeUrl(title?.getAttribute('href')),
            descriptionText: el.querySelector('.notes')?.textContent.trim() || '',
            filmCount: number(el.querySelector('.content-reactions-strip .value')?.textContent.trim().match(/^[\d,]+/)?.[0]),
            tags, reactions, previewFilms: Array.from(el.querySelectorAll('.posterset [data-component-class="LazyPoster"]')).map(film),
            coverage: 'public index summary and poster previews, not full list contents' };
        }) };
    }
    if (section === 'tags') {
      const all = Array.from(document.querySelectorAll('#content .tags li')).filter(el => el.querySelector(`a[href^="/${username}/tag/"]`));
      return { blocked: false, recognized: member && document.title.toLowerCase().includes('tags'), profile, next, totalAvailable: null,
        empty: all.length === 0 && /no (?:film )?tags(?: yet)?|hasn[’']t (?:added|used|created) (?:any )?tags|no tagged films/i.test(body),
        entries: all.map(el => { const a = el.querySelector(`a[href^="/${username}/tag/"]`); const usageText = el.querySelector('.detail')?.textContent.trim() || '';
          return { name: a.textContent.trim(), url: safeUrl(a.getAttribute('href')), usageText, count: number(usageText), description: a.getAttribute('title') || null }; }) };
    }
    if (section === 'diary') {
      const all = Array.from(document.querySelectorAll('#diary-table tbody tr'));
      return { blocked: false, recognized: member && (!!document.querySelector('#diary-table') || /hasn[’']t logged|no diary entries/i.test(body)), profile, next, totalAvailable: null,
        empty: all.length === 0 && /hasn[’']t logged|no diary entries/i.test(body),
        entries: all.map(el => { const date = el.querySelector('.daydate')?.getAttribute('href')?.match(/\/for\/(\d{4})\/(\d{2})\/(\d{2})\//);
          const review = el.querySelector('.col-review a[href]');
          const action = el.querySelector('[data-viewingable-link]');
          return { ...film(el), id: el.getAttribute('data-viewing-id'), watchedDate: date ? `${date[1]}-${date[2]}-${date[3]}` : null,
            rating: rating(el), liked: !!el.querySelector('.col-like .icon-liked'), rewatch: el.querySelector('.col-rewatch') ? !el.querySelector('.col-rewatch').classList.contains('icon-status-off') : null,
            entryUrl: safeUrl(action?.getAttribute('data-viewingable-link')), reviewUrl: safeUrl(review?.getAttribute('href')) }; }) };
    }
    const all = Array.from(document.querySelectorAll('#content li.griditem, #content li.posteritem'));
    const entries = all.map(el => ({ ...film(el), ...(section === 'watchedFilms' ? { rating: rating(el), liked: !!el.querySelector('.icon-liked') } : {}) }));
    const total = section === 'watchlist' ? body.match(/wants to see\s+([\d,]+)\s+films/i)?.[1] : null;
    return { blocked: false, recognized: member && document.title.toLowerCase().includes(section === 'watchlist' ? 'watchlist' : 'films'), profile, entries, next,
      empty: all.length === 0 && /no films yet|watchlist is empty|hasn[’']t watched|has not watched/i.test(body),
      privateCollection: section === 'watchlist' && all.length === 0 && /\bwatchlist (?:is|has been (?:made|set to)) private\b|\b(?:made|marked) (?:their |this |the )?watchlist (?:as )?private\b|\bnot publicly visible\b/i.test(body), totalAvailable: number(total) };
  }, { section, username, xml }), 5000, 'Page parsing timed out. Collection stopped.');
}

const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

function validateRows(rows, section, username) {
  if (section !== 'feedStories') requireValue(rows.length <= LIMITS[section], `${section}: unexpected number of entries.`);
  const seen = new Set();
  for (const row of rows) {
    const id = section === 'tags' ? JSON.stringify([row.name, row.url]) : ['recent', 'feedLists', 'feedStories', 'publicLists', 'diary'].includes(section) ? row.id : row.filmId;
    requireValue(id && !seen.has(id), `${section}: duplicate or missing entry ID.`); seen.add(id);
    if (section === 'tags') {
      requireValue(row.name && row.url?.startsWith(`${ORIGIN}/${username}/tag/`), 'tags: missing tag name or owned tag URL.');
      requireValue(row.count === null || Number.isSafeInteger(row.count) && row.count >= 0, 'tags: invalid usage count.');
      continue;
    }
    requireValue(row.title, `${section}: a film is missing required fields.`);
    if (section === 'feedLists' || section === 'feedStories' || section === 'publicLists') {
      const kind = section === 'feedStories' ? 'story' : 'list';
      const url = kind === 'story' ? row.storyUrl : row.listUrl;
      requireValue(url?.startsWith(`${ORIGIN}/${username}/${kind}/`), `${section}: missing or unexpected ${kind} URL.`);
      if (row.publishedAt) requireValue(!Number.isNaN(Date.parse(row.publishedAt)), 'RSS list has an invalid publication date.');
      if (section === 'publicLists') {
        requireValue(row.filmCount === null || Number.isSafeInteger(row.filmCount) && row.filmCount >= 0, 'publicLists: invalid film count.');
        validateRows(row.previewFilms, 'watchedFilms', username);
        requireValue(row.tags.every(tag => tag.name && tag.url?.startsWith(ORIGIN + '/') && new URL(tag.url).pathname.includes('/tag/')), 'publicLists: invalid tag.');
      }
      continue;
    }
    if (section === 'recent') {
      requireValue(row.entryUrl?.startsWith(`${ORIGIN}/${username}/film/`), 'RSS entry is missing a valid entry URL.');
      requireValue(validDate(row.watchedDate), 'RSS entry is missing a valid watched date.');
      requireValue(!row.invalidFlags, 'RSS entry contains invalid like or rewatch flags.'); delete row.invalidFlags;
    } else requireValue(row.filmUrl?.startsWith(`${ORIGIN}/film/`), `${section}: a film is missing required fields.`);
    if (section === 'diary') requireValue(validDate(row.watchedDate), 'diary: missing or invalid watched date.');
    if (row.rating !== undefined) requireValue(row.rating === null || (row.rating >= 0.5 && row.rating <= 5 && Number.isInteger(row.rating * 2)), `${section}: invalid rating.`);
  }
}

export async function collectSnapshot(browser, result, { signal, waitForRequest = pace, mode = 'rss', fetch: fetchImpl = fetch } = {}) {
  let page;
  const sections = sectionsFor(mode);
  try {
    if (mode === 'extended') {
      // The internal extended parser still reads server-rendered pages in a browser.
      // No images, scripts, fonts or tracking requests are needed.
      const context = await within(browser.newContext({ acceptDownloads: false, serviceWorkers: 'block' }), 5000, 'Browser context startup timed out.');
      await context.route('**/*', route => route.request().resourceType() === 'document' ? route.fallback() : route.abort());
      page = await within(context.newPage(), 5000, 'Browser page startup timed out.');
    }
    for (const section of sections) {
      signal?.throwIfAborted();
      await waitForRequest(signal);
      signal?.throwIfAborted();
      const started = performance.now();
      try {
        const data = page ? await readPublicPage(page, result.username, section) : await fetchFeed(result.username, { signal, fetchImpl });
        if (data.blocked) { const error = new Error('Letterboxd requires security verification. Collection stopped; no further pages were requested.'); error.blocked = true; throw error; }
        signal?.throwIfAborted();
        requireValue(data.recognized, `Could not verify the public ${section} page.`);
        validateRows(data.entries, section, result.username);
        if (section === 'recent') {
          requireValue(data.channelLink === `${ORIGIN}/${result.username}/`, 'RSS feed belongs to a different profile.');
          requireValue(!data.unknownItems, 'RSS feed contains duplicate or unrecognized items.');
          validateRows(data.lists, 'feedLists', result.username);
          validateRows(data.stories, 'feedStories', result.username);
          result.feed = data.feed;
          result.feedLists = data.lists;
          result.feedStories = data.stories;
          result.checks.feedStories = { complete: true, coverage: 'current RSS story summaries only, not full articles', maxFeedBytes: 4 * 1024 * 1024, collected: data.stories.length, entireCollection: false };
          result.checks.feedLists = { complete: true, coverage: 'current RSS list window and film references only, not all lists or full contents', limit: 50, collected: data.lists.length, entireCollection: false };
          result.recent = data.entries;
          result.checks.recent = { complete: true, requested: true, coverage: 'current RSS window; not full history', limit: 50, collected: data.entries.length, entireCollection: false };
          const bins = Array.from({ length: 10 }, (_, i) => ({ rating: (i + 1) / 2, count: data.entries.filter(row => row.rating === (i + 1) / 2).length }));
          result.recentRatingHistogram = { bins, totalRatings: bins.reduce((n, bin) => n + bin.count, 0), coverage: 'ratings in current RSS movie entries only' };
        } else {
          requireValue(!data.privateCollection, `${section} is private; it was not assumed empty.`);
          requireValue(data.entries.length > 0 || data.empty, `${section}: no readable entries and no verified empty state.`);
          requireValue(data.entries.length === LIMITS[section] || !data.next, `${section}: the page is missing entries; collection is incomplete.`);
          if (data.next) requireValue(data.next.startsWith(`${ORIGIN}/${result.username}/${PATHS[section]}page/`) || section === 'diary' && data.next.startsWith(`${ORIGIN}/${result.username}/diary/films/page/`) || section === 'tags' && data.next.startsWith(`${ORIGIN}/${result.username}/tags/films/page/`), `${section}: unexpected next-page URL.`);
          if (data.totalAvailable !== null) requireValue(data.next ? data.totalAvailable > data.entries.length : data.totalAvailable === data.entries.length, `${section}: total count and pagination disagree.`);
          if (data.profile) { result.profile ??= data.profile; result.checks.profile = { complete: true, coverage: 'public mini-header only' }; }
          result[section] = data.entries;
          result.checks[section] = { complete: true, requested: true, coverage: 'first public page', limit: LIMITS[section], collected: data.entries.length, hasMore: !!data.next, entireCollection: !data.next, totalAvailable: data.totalAvailable };
        }
      } catch (error) {
        if (error.retryAfterSeconds) nextRequestAt = Math.max(nextRequestAt, Date.now() + error.retryAfterSeconds * 1000);
        result.errors.push({ section, message: error.message });
        result.checks[section] = { complete: false, requested: true, blocked: !!error.blocked, ...(error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}), error: error.message };
        break; // Never retry or continue past a block, private page, timeout or invalid data.
      } finally {
        if (result.checks[section]) result.checks[section].durationMs = Math.round(performance.now() - started);
        nextRequestAt = Math.max(nextRequestAt, Date.now() + 5000);
      }
    }
  } finally {
    for (const section of Object.keys(PATHS)) result.checks[section] ??= { complete: false, skipped: true, requested: sections.includes(section), error: sections.includes(section) ? 'Not requested because collection stopped.' : 'Outside the requested RSS-only scope.' };
    // The owned parent browser is disposed in collectEphemeralSnapshot.
  }
}

// Extended mode and UI tests own one browser process; RSS lookups use none.
// A lookup owns one browser process. Dispose that process once rather than
// waiting separately for a routed context and then the same browser.
export async function launchOwnedBrowser() {
  const { chromium } = await import('playwright');
  const server = await chromium.launchServer({ channel: 'chrome', headless: true, host: '127.0.0.1', timeout: 15000 });
  let browser, closing;
  const close = () => closing ??= (async () => {
    // A connected Browser closes its client connection without waiting for a
    // separate context-close handshake. Do this before terminating Chrome so
    // the loopback BrowserServer cannot retain a disconnected client.
    let disconnectError;
    try { if (browser) await within(browser.close(), 5000, 'Browser connection cleanup timed out.'); }
    catch (error) { disconnectError = error; }
    await new Promise((resolve, reject) => {
      const ownedProcess = server.process();
      const detach = () => { ownedProcess.off('exit', exited); ownedProcess.off('error', failed); };
      const exited = () => { detach(); resolve(); };
      const failed = error => { detach(); reject(error); };
      ownedProcess.once('exit', exited); ownedProcess.once('error', failed);
      if (ownedProcess.exitCode !== null || ownedProcess.signalCode !== null) exited();
      else {
        try { if (!ownedProcess.kill('SIGKILL')) failed(new Error('Owned browser termination failed.')); }
        catch (error) { failed(error); }
      }
      void server.kill().catch(failed);
    });
    if (disconnectError) throw disconnectError;
  })();
  try {
    browser = await chromium.connect(server.wsEndpoint(), { timeout: 5000 });
    return { newContext: options => browser.newContext(options), newPage: options => browser.newPage(options), close };
  } catch (error) {
    await within(close(), 10000, 'Browser startup cleanup timed out.');
    throw error;
  }
}

export async function collectEphemeralSnapshot(input, { cleanupTimeoutMs = 10000, signal, waitForRequest, mode = 'rss', launchBrowser = launchOwnedBrowser, fetch: fetchImpl = fetch } = {}) {
  const username = validateUsername(input);
  requireValue(mode === 'rss' || mode === 'extended', 'Unsupported collection scope.');
  const result = { schemaVersion: 6, username, scope: { mode, feedStories: { coverage: 'current RSS story summaries', maxFeedBytes: 4 * 1024 * 1024 }, recent: { limit: 50, coverage: 'current RSS movie window' }, feedLists: { limit: 50, coverage: 'current RSS list window; references are not full list contents' }, ...(mode === 'extended' ? { watchedFilms: { limit: 72, coverage: 'first public page' }, publicLists: { limit: 12, coverage: 'first public index page' }, tags: { limit: 120, coverage: 'first public tags page' }, diary: { limit: 50, coverage: 'first public diary page' }, watchlist: { limit: 28, coverage: 'first public page' } } : {}) },
    status: 'incomplete', complete: false, recent: [], feedLists: [], feedStories: [], watchedFilms: [], publicLists: [], tags: [], diary: [], watchlist: [], feed: null, profile: null, recentRatingHistogram: null, checks: {}, errors: [], error: null };
  let browser;
  const cancel = () => { void browser?.close().catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    signal?.throwIfAborted();
    if (mode === 'extended') browser = await launchBrowser(); // RSS mode never starts Chrome.
    signal?.throwIfAborted();
    await collectSnapshot(browser, result, { signal, waitForRequest, mode, fetch: fetchImpl });
  } catch (error) {
    if (!signal?.aborted) result.errors.push({ section: 'collection', message: error.message === 'Browser session cleanup timed out. The attempt was not marked successful.' ? error.message : 'Collection timed out or failed. Collection stopped.' });
  } finally {
    signal?.removeEventListener('abort', cancel);
    try { await closeWithin(browser, cleanupTimeoutMs); }
    catch { result.errors.push({ section: 'cleanup', message: 'Browser cleanup timed out. The attempt was not marked successful.' }); }
    result.complete = !signal?.aborted && result.errors.length === 0 && sectionsFor(mode).every(section => result.checks[section]?.complete) && !!result.checks.feedLists?.complete && !!result.checks.feedStories?.complete;
    result.status = result.complete ? 'complete' : 'failed';
    result.error = result.complete ? null : signal?.aborted ? 'Collection cancelled.' : result.errors[0]?.message || 'Collection stopped before all sections were verified.';
    if (signal?.aborted) { result.username = ''; result.recent = []; result.feedLists = []; result.feedStories = []; result.watchedFilms = []; result.publicLists = []; result.tags = []; result.diary = []; result.watchlist = []; result.feed = null; result.profile = null; result.recentRatingHistogram = null; result.checks = {}; result.errors = []; }
  }
  return result;
}
