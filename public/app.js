const form = document.querySelector('#collect-form');
const username = document.querySelector('#username');
const button = document.querySelector('#submit');
const status = document.querySelector('#status');
const results = document.querySelector('#results');
const empty = document.querySelector('#empty-state');
let currentRequest;
let expiryTimer;
let lookupVersion = 0;

function clearResults(clearInput = true) {
  lookupVersion++;
  currentRequest?.abort(); currentRequest = null;
  clearTimeout(expiryTimer);
  for (const selector of ['#recent-list', '#watched-list', '#watchlist-list', '#histogram']) document.querySelector(selector).replaceChildren();
  for (const selector of ['#result-title', '#recent-count', '#watched-count', '#watchlist-count', '#histogram-count', '#watched-coverage', '#watchlist-coverage']) document.querySelector(selector).textContent = '';
  results.hidden = true; empty.hidden = false;
  status.hidden = true; status.textContent = ''; status.className = 'status';
  button.disabled = false; username.disabled = false; form.removeAttribute('aria-busy');
  if (clearInput) username.value = '';
  document.querySelector('#result-label').textContent = 'Current lookup';
}

function scheduleClear() {
  clearTimeout(expiryTimer);
  expiryTimer = setTimeout(() => { clearResults(); status.hidden = false; status.textContent = 'Results cleared. Enter a username for a new lookup.'; }, 120000);
}

function node(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}
function filmLink(film, className) {
  const a = node('a', className, film.title);
  const url = film.filmUrl || film.entryUrl;
  if (url && /^https:\/\/letterboxd\.com\/(film\/|[a-zA-Z0-9_]+\/film\/)/.test(url)) a.href = url;
  a.target = '_blank'; a.rel = 'noopener noreferrer';
  return a;
}
function filmList(selector, films, section, verified) {
  const list = document.querySelector(selector); list.replaceChildren();
  films.forEach(film => {
    const item = node('li', section === 'recent' ? 'recent' : 'film-row');
    const info = node('div');
    info.append(filmLink(film, 'film-title'), node('div', 'film-meta', [film.year, film.watchedDate, film.rewatch ? 'Rewatch' : null, film.liked ? 'Liked' : null].filter(Boolean).join(' · ')));
    item.append(info);
    if (section !== 'watchlist') {
      const score = film.rating == null ? 'Unrated' : `${'★'.repeat(Math.floor(film.rating))}${film.rating % 1 ? '½' : ''}`;
      const rating = node('span', 'rating', score); rating.setAttribute('aria-label', film.rating == null ? 'Unrated' : `${film.rating} out of 5 stars`);
      item.append(rating);
    }
    list.append(item);
  });
  if (!films.length) list.append(node('li', 'no-data', verified ? (section === 'recent' ? 'No movie entries in the current RSS feed.' : section === 'watchedFilms' ? 'No watched films.' : 'Your public watchlist is empty.') : 'This section could not be collected.'));
}
function coverage(check) {
  if (check?.skipped) return 'Not requested because collection stopped.';
  if (!check?.complete) return 'Unavailable or unverified. See the collection error above.';
  return check.hasMore ? 'More films are available on Letterboxd.' : 'Entire public collection.';
}
function countLabel(check, count, singular, plural = singular + 's') {
  if (check?.skipped) return 'Not requested';
  if (!check?.complete) return 'Unavailable';
  return `${count} ${count === 1 ? singular : plural}`;
}
function render(data) {
  for (const panel of document.querySelectorAll('.film-collection')) panel.hidden = data.scope?.mode === 'rss';
  results.hidden = false; empty.hidden = true;
  document.querySelector('#result-title').textContent = `@${data.username}`;
  document.querySelector('#result-label').textContent = data.complete ? 'Current lookup' : 'Incomplete lookup';
  document.querySelector('#recent-count').textContent = countLabel(data.checks?.recent, data.recent.length, 'entry', 'entries');
  filmList('#recent-list', data.recent, 'recent', data.checks?.recent?.complete);
  filmList('#watched-list', data.watchedFilms || [], 'watchedFilms', data.checks?.watchedFilms?.complete);
  filmList('#watchlist-list', data.watchlist || [], 'watchlist', data.checks?.watchlist?.complete);
  document.querySelector('#watched-count').textContent = countLabel(data.checks?.watchedFilms, data.watchedFilms?.length || 0, 'film');
  document.querySelector('#watchlist-count').textContent = countLabel(data.checks?.watchlist, data.watchlist?.length || 0, 'film');
  document.querySelector('#watched-coverage').textContent = coverage(data.checks?.watchedFilms);
  document.querySelector('#watchlist-coverage').textContent = coverage(data.checks?.watchlist);
  const histogram = document.querySelector('#histogram'); histogram.replaceChildren();
  const distribution = data.recentRatingHistogram;
  document.querySelector('#histogram-count').textContent = distribution ? `${distribution.totalRatings.toLocaleString()} ratings` : 'Not collected';
  if (distribution) {
    const maximum = Math.max(1, ...distribution.bins.map(bin => bin.count));
    distribution.bins.forEach(bin => {
      const row = node('div', 'histogram-row');
      const bar = node('progress'); bar.max = maximum; bar.value = bin.count;
      bar.setAttribute('aria-label', `${bin.rating} stars: ${bin.count} ratings`);
      row.append(node('span', 'histogram-label', `${bin.rating} ★`), bar);
      histogram.append(row);
    });
  } else histogram.append(node('p', 'no-data', 'The recent rating sample could not be verified.'));
  scheduleClear();
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  const value = username.value.trim();
  if (!/^[a-zA-Z0-9_]{1,40}$/.test(value)) { username.setCustomValidity('Enter only the username: letters, numbers or underscores.'); username.reportValidity(); return; }
  clearResults(false);
  const version = lookupVersion;
  const request = new AbortController(); currentRequest = request;
  button.disabled = true; username.disabled = true; form.setAttribute('aria-busy', 'true');
  results.hidden = true; empty.hidden = true;
  status.hidden = false; status.className = 'status loading'; status.textContent = `Collecting @${value}’s films…`;
  try {
    const response = await fetch('/api/collect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: value }), cache: 'no-store', signal: AbortSignal.any([request.signal, AbortSignal.timeout(180000)]) });
    const data = await response.json();
    if (version !== lookupVersion) return;
    if (!response.ok) throw new Error(data.error || 'Collection failed. Please try again.');
    render(data);
    status.className = data.complete ? 'status' : 'status error';
    status.textContent = data.complete ? (data.scope?.mode === 'rss' ? 'RSS feed collected.' : 'Collection complete.') : `Collection incomplete. ${data.error}`;
  } catch (error) {
    if (version !== lookupVersion || error.name === 'AbortError') return;
    status.className = 'status error';
    status.textContent = error.name === 'TimeoutError' ? 'Collection timed out. Try again later.' : error.message;
    empty.hidden = false;
    scheduleClear();
  } finally {
    if (version !== lookupVersion) return;
    currentRequest = null;
    button.disabled = false; username.disabled = false; form.removeAttribute('aria-busy');
  }
});
username.addEventListener('input', () => username.setCustomValidity(''));

document.querySelector('#clear-results').addEventListener('click', () => clearResults());
window.addEventListener('pagehide', () => clearResults());
window.addEventListener('pageshow', () => clearResults());
