// Shared by the receipt page (/) and the iceberg page (/iceberg). Each page has
// the same form and status elements; render() draws whichever view the page has.
const $ = selector => document.querySelector(selector);
const form = $('#collect-form');
const username = $('#username');
const button = $('#submit');
const status = $('#status');
const results = $('#results');
const empty = $('#empty-state');
const LIFETIME = 120000;
let currentRequest;
let expiryTimer;
let clockTimer;
let lookupVersion = 0;
const buttonLabel = button.textContent;
const emptyText = empty.querySelector('p');
const emptyPrompt = emptyText.textContent;

// Busy state: the button says what is happening.
function setBusy(busy) {
  button.disabled = busy; username.disabled = busy;
  button.textContent = busy ? button.dataset.busy || 'Working…' : buttonLabel;
  if (busy) form.setAttribute('aria-busy', 'true'); else form.removeAttribute('aria-busy');
  document.body.classList.toggle('showtime', busy);
}
// Accept "@name" or a pasted Letterboxd profile link, and use just the username.
function normalizeUsername(text) {
  const value = text.trim().replace(/^@/, '');
  return value.match(/^(?:https?:\/\/)?(?:www\.)?letterboxd\.com\/([^/?#\s]+)/i)?.[1] ?? value;
}

function clearResults(clearInput = true) {
  lookupVersion++;
  currentRequest?.abort(); currentRequest = null;
  clearTimeout(expiryTimer); clearInterval(clockTimer);
  for (const selector of ['#recent-list', '#watched-list', '#watchlist-list', '#histogram', '#receipt-totals', '#receipt-footer', '#receipt-span', '#iceberg', '#berg-list', '#era', '#rhythm', '#meter', '#hearts', '#weekdays', '#barcode']) $(selector)?.replaceChildren();
  for (const selector of ['#result-title', '#recent-count', '#watched-count', '#watchlist-count', '#histogram-count', '#watched-coverage', '#watchlist-coverage', '#receipt-clock', '#berg-tip', '#leader-count', '#house-note', '#rhythm-note', '#meter-note', '#hearts-note', '#era-note']) { const el = $(selector); if (el) el.textContent = ''; }
  $('#berg-tip')?.setAttribute('hidden', '');
  $('#receipt')?.classList.remove('rolling');
  $('#keep-rolling')?.setAttribute('hidden', '');
  $('#extras')?.setAttribute('hidden', ''); $('#weekdays')?.removeAttribute('aria-label'); for (const id of ['#rhythm', '#meter', '#hearts', '#era']) $(id)?.removeAttribute('aria-label'); $('#barcode')?.removeAttribute('aria-label'); $('#receipt-totals') && ($('#receipt-totals').textContent = ''); $('#receipt-footer') && ($('#receipt-footer').textContent = '');
  results.hidden = true; empty.hidden = false;
  status.hidden = true; status.textContent = ''; status.className = 'status';
  setBusy(false);
  emptyText.textContent = emptyPrompt;
  if (clearInput) username.value = '';
  $('#result-label').textContent = 'Current lookup';
}

function scheduleClear() {
  clearTimeout(expiryTimer); clearInterval(clockTimer);
  const ends = Date.now() + LIFETIME;
  const clock = $('#receipt-clock');
  const tick = () => { const left = Math.max(0, Math.ceil((ends - Date.now()) / 1000)); if (clock) clock.textContent = `Clears in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`; const fuse = $('#fuse'); if (fuse) fuse.style.width = `${(left * 1000 / LIFETIME) * 100}%`; };
  if (clock) { tick(); clockTimer = setInterval(tick, 1000); }
  expiryTimer = setTimeout(() => { clearResults(); status.hidden = false; status.textContent = 'Results cleared. Enter a username for a new lookup.'; }, LIFETIME);
}

function node(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}
const SVG = 'http://www.w3.org/2000/svg';
function svg(parent, tag, attributes = {}, text) {
  const el = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attributes)) el.setAttribute(name, value);
  if (text !== undefined) el.textContent = text;
  parent.append(el);
  return el;
}
function filmLink(film, className) {
  const a = node('a', className, film.title);
  const url = film.filmUrl || film.entryUrl;
  if (url && /^https:\/\/letterboxd\.com\/(film\/|[a-zA-Z0-9_]+\/film\/)/.test(url)) a.href = url;
  a.target = '_blank'; a.rel = 'noopener noreferrer';
  return a;
}
// Server messages name the feed format; the page never shows it.
const plain = text => String(text || '').replace(/\bRSS(-only)?\s*/g, '').replace(/^./, c => c.toUpperCase());
const stars = rating => rating == null ? 'Unrated' : `${rating} out of 5 stars`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const day = text => { const date = new Date(`${text}T00:00:00Z`); return Number.isNaN(date.getTime()) ? null : date; };
const shortDate = date => `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;

function filmList(selector, films, section, verified) {
  const list = $(selector); if (!list) return;
  list.replaceChildren();
  films.forEach(film => {
    const item = node('li', section === 'recent' ? 'recent' : 'film-row');
    const info = node('div');
    const when = section === 'recent' && day(film.watchedDate) ? shortDate(day(film.watchedDate)) : film.watchedDate;
    const meta = section === 'recent'
      ? [film.liked ? '♥' : null, film.rewatch ? '↻' : null, film.reviewText ? '✎' : null]
      : [film.year, film.watchedDate, film.rewatch ? 'Rewatch' : null, film.liked ? 'Liked' : null];
    const link = filmLink(film, 'film-title'); link.title = film.title || '';
    info.append(link, node('div', 'film-meta', meta.filter(Boolean).join(section === 'recent' ? ' ' : ' · ')));
    item.append(info);
    if (section !== 'watchlist') {
      const score = section === 'recent'
        ? (film.rating == null ? 'unrated' : `${'★'.repeat(Math.floor(film.rating))}${film.rating % 1 ? '½' : ''}`)
        : film.rating == null ? 'Unrated' : `${'★'.repeat(Math.floor(film.rating))}${film.rating % 1 ? '½' : ''}`;
      const rating = node('span', 'rating', score); rating.setAttribute('aria-label', stars(film.rating));
      item.append(rating);
    }
    list.append(item);
  });
  if (!films.length) list.append(node('li', 'no-data', verified ? (section === 'recent' ? 'No recent films found.' : section === 'watchedFilms' ? 'No watched films.' : 'Your public watchlist is empty.') : 'This section could not be collected.'));
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

// The leader sweeps frame by frame like a projected academy leader, with no
// numbers, then lands on a star. Reduced motion shows the star at once.
function startCountdown(count) {
  const receipt = $('#receipt'), number = $('#leader-count'), hand = $('.countdown .hand');
  const version = lookupVersion;
  const finish = () => { if (version !== lookupVersion) return; receipt.classList.remove('rolling'); number.textContent = '★'; };
  receipt.classList.remove('rolling');
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return finish();
  number.textContent = '';
  void receipt.offsetWidth;
  receipt.classList.add('rolling');
  hand.addEventListener('animationend', finish, { once: true });
}

// Facts the receipt prints. Everything is counted from this feed window only.
function summarize(films) {
  const dates = films.map(film => day(film.watchedDate)).filter(Boolean).sort((a, b) => a - b);
  const unique = [...new Set(dates.map(date => date.getTime()))];
  let streak = unique.length ? 1 : 0;
  for (let i = 1, run = 1; i < unique.length; i++) { run = unique[i] - unique[i - 1] === 86400000 ? run + 1 : 1; streak = Math.max(streak, run); }
  const weekdays = Array(7).fill(0); dates.forEach(date => weekdays[date.getUTCDay()]++);
  const rated = films.filter(film => film.rating != null);
  return {
    first: dates[0], last: dates.at(-1), streak,
    busiest: dates.length ? DAYS[weekdays.indexOf(Math.max(...weekdays))] : null,
    refills: films.filter(film => film.rewatch === true).length,
    picks: films.filter(film => film.liked === true).length,
    reviews: films.filter(film => film.reviewText).length,
    comps: films.length - rated.length,
    average: rated.length ? rated.reduce((sum, film) => sum + film.rating, 0) / rated.length : null,
  };
}
function receiptLine(parent, label, value, className = 'receipt-line') {
  const line = node('div', className);
  line.append(node('span', '', label), node('span', '', String(value)));
  parent.append(line);
}
// Words instead of numbers for how much of the window something covers.
function share(count, total) {
  if (!count) return 'none of them';
  if (count === total) return 'all of them';
  if (count === 1) return 'a single one';
  if (count === 2) return 'a couple';
  const ratio = count / total;
  return ratio >= 0.85 ? 'nearly all' : ratio >= 0.6 ? 'most' : ratio >= 0.4 ? 'about half' : count <= 4 ? 'a few' : 'some';
}
const FULL_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const partOf = date => `${date.getUTCDate() <= 10 ? 'early' : date.getUTCDate() <= 20 ? 'mid' : 'late'} ${FULL_MONTHS[date.getUTCMonth()]}`;
function window_(first, last) {
  if (!first) return 'No dated entries';
  if (first.getUTCMonth() === last.getUTCMonth() && first.getUTCFullYear() === last.getUTCFullYear()) return `Across ${FULL_MONTHS[last.getUTCMonth()]}`;
  return `From ${partOf(first)} to ${partOf(last)}`;
}
// Film barcode: one stripe per film in watch order, darker for higher ratings.
function drawBarcode(films) {
  const code = $('#barcode'); if (!code) return;
  const ordered = films.map((film, i) => ({ film, date: day(film.watchedDate), i })).sort((a, b) => (a.date ?? 0) - (b.date ?? 0) || b.i - a.i);
  const light = [234, 215, 179], dark = [74, 11, 20];
  ordered.forEach(({ film }) => {
    const bar = node('span', `code-bar${film.liked ? ' liked' : ''}${film.reviewText ? ' reviewed' : ''}${film.rewatch ? ' rewatch' : ''}${film.rating == null ? ' unrated' : ''}`);
    if (film.rating != null) { const t = film.rating / 5; bar.style.backgroundColor = `rgb(${light.map((c, k) => Math.round(c + (dark[k] - c) * t)).join(',')})`; }
    bar.title = film.title || 'Untitled';
    code.append(bar);
  });
  code.setAttribute('aria-label', `${films.length} films in watch order, shaded by rating`);
}
function renderReceipt(data) {
  const films = data.recent || [];
  const facts = summarize(films);
  startCountdown(films.length);
  const span = $('#receipt-span');
  span.append(node('div', 'receipt-user', `@${data.username}`));
  span.append(node('div', 'receipt-small', window_(facts.first, facts.last)));
  const list = $('#recent-list'), roll = $('#keep-rolling'), more = films.length - 6;
  if (list && roll) {
    list.classList.toggle('rolled-up', more > 0);
    roll.hidden = more <= 0;
    roll.textContent = 'Show the rest';
  }
  drawBarcode(films);
  const habits = [`Liked ${share(facts.picks, films.length)}`, `reviewed ${share(facts.reviews, films.length)}`, `rewatched ${share(facts.refills, films.length)}`];
  if (facts.comps) habits.push(`left ${share(facts.comps, films.length)} unrated`);
  const totals = $('#receipt-totals'); if (totals) totals.textContent = films.length ? `${habits.join(', ')}.` : '';
  $('#receipt-footer').textContent = 'This print fades when the fuse burns out.';
}

// Extra pieces, drawn from the same recent films and cleared with them.
const WEEK = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function drawHouse(dated) {
  const art = $('#weekdays');
  const counts = Array(7).fill(0); dated.forEach(({ date }) => counts[(date.getUTCDay() + 6) % 7]++);
  const seats = Math.max(8, ...counts), width = 300, seat = Math.min(22, (width - 60) / seats);
  art.setAttribute('viewBox', `0 0 ${width} 250`);
  const ink = svg(art, 'g', { filter: 'url(#sketch)' });
  svg(ink, 'path', { d: `M30 30Q${width / 2} 8 ${width - 30} 30`, class: 'screen' });
  svg(art, 'text', { x: width / 2, y: 44, class: 'screen-label' }, 'screen');
  counts.forEach((count, row) => {
    const y = 72 + row * 25;
    svg(art, 'text', { x: 8, y: y + 12, class: 'row-label' }, WEEK[row].slice(0, 3));
    for (let i = 0; i < seats; i++) {
      const x = 44 + (width - 52 - seats * seat) / 2 + i * seat, mid = (i - (seats - 1) / 2) / seats;
      const yy = y + mid * mid * 18;
      svg(ink, 'path', { d: `M${x + 2} ${yy + 16}v-10q0-5 5-5h${seat - 12}q5 0 5 5v10z`, class: i < count ? 'seat taken' : 'seat' });
    }
  });
  const best = Math.max(...counts);
  art.setAttribute('aria-label', WEEK.map((name, i) => `${name} ${counts[i]}`).join(', '));
  const top = WEEK.filter((_, i) => counts[i] === best);
  $('#house-note').textContent = !best ? 'No dated entries.' : top.length > 2 ? 'Busy most of the week' : `Busiest on ${top.map(name => `${name}s`).join(' and ')}`;
}

// Habit pieces: each is one picture with a plain sentence about these recent films only.
const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
const say = n => NUMBER_WORDS[n] ?? 'more than twenty';
const starWords = rating => `${say(Math.floor(rating))}${rating % 1 ? ' and a half' : ''} ${rating === 1 ? 'star' : 'stars'}`;
const starMarks = rating => `${'★'.repeat(Math.floor(rating))}${rating % 1 ? '½' : ''}`;
const byTitle = films => films.filter((film, i) => films.findIndex(other => other.title === film.title && other.year === film.year) === i);
const DAY_MS = 86400000;

// Nights at the pictures: a strip of frames, one per day, lit by how many films were watched.
function drawRhythm(films) {
  const art = $('#rhythm');
  const counts = new Map();
  films.forEach(film => { const date = day(film.watchedDate); if (date) counts.set(date.getTime(), (counts.get(date.getTime()) || 0) + 1); });
  if (!counts.size) { $('#rhythm-note').textContent = 'No watch dates in these films.'; return; }
  const days = [...counts.keys()].sort((a, b) => a - b), last = days.at(-1);
  const monday = time => time - ((new Date(time).getUTCDay() + 6) % 7) * DAY_MS;
  const weeks = Math.min(12, (monday(last) - monday(days[0])) / (7 * DAY_MS) + 1), start = monday(last) - (weeks - 1) * 7 * DAY_MS;
  const cell = 22, step = 26, left = 30, top = 22, width = left + weeks * step + 12, height = top + 7 * step + 20;
  art.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg(art, 'rect', { x: left - 8, y: 0, width: weeks * step + 14, height, rx: 6, class: 'rhythm-base' });
  for (let w = 0; w < weeks; w++) for (const y of [7, height - 13]) svg(art, 'rect', { x: left + w * step + 6, y, width: 10, height: 6, rx: 1.5, class: 'rhythm-hole' });
  ['M', 'T', 'W', 'T', 'F', 'S', 'S'].forEach((letter, d) => svg(art, 'text', { x: 10, y: top + d * step + 16, class: 'rhythm-day' }, letter));
  for (let w = 0; w < weeks; w++) for (let d = 0; d < 7; d++) {
    const time = start + (w * 7 + d) * DAY_MS;
    if (time > last) continue;
    const count = counts.get(time) || 0;
    const frame = svg(art, 'rect', { x: left + w * step, y: top + d * step, width: cell, height: cell, rx: 3, class: `rhythm-frame lit-${Math.min(count, 3)}` });
    svg(frame, 'title', {}, `${shortDate(new Date(time))}: ${count} ${count === 1 ? 'film' : 'films'}`);
  }
  let run = 1, longest = 1, longestBreak = 0;
  for (let i = 1; i < days.length; i++) {
    const apart = (days[i] - days[i - 1]) / DAY_MS;
    run = apart === 1 ? run + 1 : 1; longest = Math.max(longest, run); longestBreak = Math.max(longestBreak, apart - 1);
  }
  const busiestDay = Math.max(...counts.values()), doubles = [...counts.values()].filter(n => n >= 2).length;
  const spread = days.length / ((last - days[0]) / DAY_MS + 1);
  const notes = [spread >= .6 ? 'Something on almost every night lately.' : spread <= .25 ? 'You spread your films out lately, with quiet nights in between.' : 'A steady few nights a week lately.'];
  if (longest >= 3) notes.push(`Your longest run was ${say(longest)} nights in a row.`);
  else if (busiestDay >= 3) notes.push(busiestDay >= 4 ? 'Some days became marathons.' : 'Some days became triple bills.');
  else if (doubles >= 2) notes.push('Now and then you make it a double bill.');
  else if (longestBreak >= 14) notes.push('There was one long break of more than two weeks.');
  art.setAttribute('aria-label', `${days.length} days with films across ${weeks} weeks shown; longest run ${longest} days; most in one day ${busiestDay}`);
  $('#rhythm-note').textContent = notes.join(' ');
}

// The light meter: where your ratings sit between harsh and generous.
function drawMeter(films) {
  const art = $('#meter');
  const rated = byTitle(films).map(film => film.rating).filter(rating => rating != null).sort((a, b) => a - b);
  const cx = 120, cy = 124, radius = 92;
  art.setAttribute('viewBox', '0 0 240 150');
  const point = (rating, r) => { const angle = Math.PI * (1 - (rating - .5) / 4.5); return [cx + r * Math.cos(angle), cy - r * Math.sin(angle)]; };
  const arc = (from, to, r) => { const [x0, y0] = point(from, r), [x1, y1] = point(to, r); return `M${x0} ${y0}A${r} ${r} 0 0 1 ${x1} ${y1}`; };
  svg(art, 'path', { d: arc(.5, 5, radius), class: 'meter-face' });
  const q = p => rated[Math.round(p * (rated.length - 1))];
  if (rated.length >= 3) svg(art, 'path', { d: arc(Math.max(.5, q(.25) - .12), Math.min(5, q(.75) + .12), radius), class: 'meter-band' });
  for (let r = .5; r <= 5; r += .5) { const [x0, y0] = point(r, radius - 14), [x1, y1] = point(r, radius - (r % 1 ? 20 : 26)); svg(art, 'path', { d: `M${x0} ${y0}L${x1} ${y1}`, class: 'meter-tick' }); }
  svg(art, 'text', { x: cx - radius, y: cy + 20, class: 'meter-end' }, 'harsh');
  svg(art, 'text', { x: cx + radius, y: cy + 20, class: 'meter-end' }, 'generous');
  if (!rated.length) { $('#meter-note').textContent = 'No ratings in these films.'; return; }
  const median = q(.5), [nx, ny] = point(median, radius - 30);
  svg(art, 'path', { d: `M${cx} ${cy}L${nx} ${ny}`, class: 'meter-needle' });
  svg(art, 'circle', { cx, cy, r: 6, class: 'meter-hub' });
  art.setAttribute('aria-label', `Typical rating ${median} of 5 across ${rated.length} rated films; middle half from ${q(.25)} to ${q(.75)}`);
  if (rated.length < 5) { $('#meter-note').textContent = 'Rate a few more films to read the meter.'; return; }
  const notes = [median >= 4 ? 'A generous critic lately: at least half your films get four stars or more.' : median <= 2.5 ? 'A tough crowd lately: at least half your films get two and a half stars or fewer.' : `Even-handed lately: your films tend to land around ${starWords(median)}.`];
  const spread = q(.75) - q(.25);
  const mean = list => list.reduce((sum, film) => sum + film.rating, 0) / list.length;
  const reviewed = byTitle(films).filter(film => film.rating != null && film.reviewText), quiet = byTitle(films).filter(film => film.rating != null && !film.reviewText);
  if (spread <= .5) notes.push('You rarely stray far from it.');
  else if (spread >= 2) notes.push('Your ratings swing widely.');
  else if (reviewed.length >= 4 && quiet.length >= 4 && Math.abs(mean(reviewed) - mean(quiet)) >= .5) notes.push(mean(reviewed) > mean(quiet) ? 'You tend to write about the ones you love.' : 'You tend to write about the ones that let you down.');
  $('#meter-note').textContent = notes.join(' ');
}

// Heart and stars: liked films above the line, the rest below, each placed by its rating.
function drawHearts(films) {
  const art = $('#hearts');
  const known = byTitle(films).filter(film => film.rating != null && film.liked != null);
  const narrow = innerWidth < 560, perRow = narrow ? 3 : 5, width = narrow ? 360 : 600, left = narrow ? 40 : 70, column = (width - left - 14) / 10;
  const counts = new Map(); known.forEach(film => { const key = `${film.liked}-${film.rating}`; counts.set(key, Math.min(35, (counts.get(key) || 0) + 1)); });
  const rows = liked => Math.max(1, ...known.filter(film => film.liked === liked).map(film => Math.ceil(counts.get(`${liked}-${film.rating}`) / perRow)));
  const above = 18 + rows(true) * 11, below = above + 30, height = below + 14 + rows(false) * 11;
  art.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg(art, 'path', { d: `M${left - 6} ${above}H${width - 8}M${left - 6} ${below}H${width - 8}`, class: 'hearts-axis' });
  const icon = left / 2;
  svg(art, 'path', { d: `M${icon} ${above - 2}l-9-9a5.5 5.5 0 0 1 9-6a5.5 5.5 0 0 1 9 6z`, class: 'hearts-lane liked' });
  svg(art, 'circle', { cx: icon, cy: below + 10, r: 7, class: 'hearts-lane' });
  for (let star = 1; star <= 5; star++) svg(art, 'text', { x: left + (star * 2 - 1) * column + column / 2, y: above + 19, class: 'hearts-stars' }, '★'.repeat(star));
  const slots = new Map();
  known.forEach(film => {
    const key = `${film.liked}-${film.rating}`, k = slots.get(key) || 0; slots.set(key, k + 1);
    if (k >= 35) return;
    const x = left + (film.rating * 2 - 1) * column + 6 + (k % perRow) * 9, rowOffset = 9 + Math.floor(k / perRow) * 11;
    const y = film.liked ? above - rowOffset : below + rowOffset;
    const mark = film.liked ? svg(art, 'path', { d: `M${x} ${y + 3}l-4-4a2.4 2.4 0 0 1 4-2.6a2.4 2.4 0 0 1 4 2.6z`, class: 'heart-mark' }) : svg(art, 'circle', { cx: x, cy: y, r: 3.2, class: 'plain-mark' });
    svg(mark, 'title', {}, `${film.title || 'Untitled'} · ${starMarks(film.rating)}`);
  });
  const liked = known.filter(film => film.liked), plain = known.filter(film => !film.liked);
  art.setAttribute('aria-label', `${liked.length} liked and ${plain.length} not liked among ${known.length} rated films`);
  if (known.length < 4) { $('#hearts-note').textContent = byTitle(films).some(film => film.liked != null) ? 'Too few rated films to compare hearts and stars.' : 'Likes were not in this feed.'; return; }
  const mean = list => list.reduce((sum, film) => sum + film.rating, 0) / list.length;
  const likedShare = liked.length / known.length, guilty = liked.filter(film => film.rating <= 2.5), admired = plain.filter(film => film.rating >= 4.5);
  const notes = [];
  if (likedShare >= .8) notes.push('You hand out hearts freely: nearly every film gets one.');
  else if (likedShare <= .2) notes.push('You save your hearts for very few films.');
  else if (liked.length >= 3 && plain.length >= 3) notes.push(mean(liked) - mean(plain) >= .75 ? 'Your heart follows your stars: the films you like are the ones you rate highest.' : 'Your heart and your stars only loosely agree.');
  if (guilty.length) notes.push(guilty.length === 1 ? 'One guilty pleasure: a film you liked but rated low.' : 'A few guilty pleasures: films you liked but rated low.');
  else if (admired.length) notes.push(admired.length === 1 ? 'One film you admired without loving.' : 'Some films you admired without loving.');
  $('#hearts-note').textContent = notes.join(' ') || 'Your hearts land all over the star range.';
}

// Then and now: a balance scale. Recent films go in one pan and older films in the other, one film can per film.
// The side you rate higher weighs more and sinks. When nearly everything is recent, the split moves closer in
// (five, three, two years, then this year against everything before) so both pans still say something.
const SPLITS = [[10, 'last ten years', 'older'], [5, 'last five years', 'older'], [3, 'last three years', 'older'], [2, 'last two years', 'older'], [1, 'this year', 'earlier']];
function drawEra(films) {
  const art = $('#era');
  const rated = byTitle(films).filter(film => film.rating != null && Number.isInteger(film.year) && film.year <= NOW_YEAR + 1);
  const age = film => Math.max(0, NOW_YEAR - film.year);
  const enough = count => count >= Math.max(3, Math.ceil(rated.length * .15));
  const index = SPLITS.findIndex(([years]) => enough(rated.filter(film => age(film) >= years).length) && enough(rated.filter(film => age(film) < years).length));
  const [cutoff, newerLabel, olderLabel] = SPLITS[index < 0 ? SPLITS.length - 1 : index];
  const older = rated.filter(film => age(film) >= cutoff), newer = rated.filter(film => age(film) < cutoff);
  const mean = list => list.length ? list.reduce((sum, film) => sum + film.rating, 0) / list.length : null;
  const gap = index >= 0 ? mean(older) - mean(newer) : 0;
  const angle = Math.abs(gap) < .25 ? 0 : Math.max(-.21, Math.min(.21, -gap * .3));
  const px = 150, py = 60, arm = 100;
  art.setAttribute('viewBox', '0 0 300 198');
  svg(art, 'path', { d: `M${px} ${py}V178M132 178h36l12 10h-60z`, class: 'scale-stand' });
  const ends = [[px - arm * Math.cos(angle), py - arm * Math.sin(angle)], [px + arm * Math.cos(angle), py + arm * Math.sin(angle)]];
  // The beam, pans and cans hang together so they can rock as one around the pivot.
  const swing = svg(art, 'g', { class: 'scale-arm' });
  svg(swing, 'path', { d: `M${ends[0][0]} ${ends[0][1]}L${ends[1][0]} ${ends[1][1]}`, class: 'scale-beam' });
  svg(swing, 'circle', { cx: px, cy: py, r: 5, class: 'scale-pivot' });
  [[older, olderLabel], [newer, newerLabel]].forEach(([group, label], side) => {
    const [ex, ey] = ends[side], rim = ey + 44;
    svg(swing, 'path', { d: `M${ex} ${ey}L${ex - 40} ${rim}M${ex} ${ey}L${ex + 40} ${rim}`, class: 'scale-string' });
    let r = 6, perRow, rows;
    do { perRow = Math.max(1, Math.floor(76 / (2 * r))); rows = Math.ceil(group.length / perRow); if (rows * r * 1.8 <= 34) break; r -= .25; } while (r > 2.4);
    group.forEach((film, i) => {
      const row = Math.floor(i / perRow), inRow = Math.min(perRow, group.length - row * perRow), col = i % perRow;
      const cx = ex + (col - (inRow - 1) / 2) * 2 * r + (row % 2 ? r * .5 : 0), cy = rim - r - row * r * 1.8;
      const can = svg(swing, 'g', { class: film.liked ? 'scale-can liked' : 'scale-can' });
      svg(can, 'circle', { cx, cy, r }); svg(can, 'circle', { cx, cy, r: r * .35, class: 'scale-hub' });
      svg(can, 'title', {}, `${film.title || 'Untitled'} (${film.year}) · ${starMarks(film.rating)}`);
    });
    svg(swing, 'path', { d: `M${ex - 44} ${rim}Q${ex} ${rim + 24} ${ex + 44} ${rim}z`, class: 'scale-pan' });
    svg(swing, 'text', { x: ex, y: rim + 34, class: 'scale-label' }, label);
    if (group.length) svg(swing, 'text', { x: ex, y: rim + 46, class: 'scale-stars' }, starMarks(Math.round(mean(group) * 2) / 2));
  });
  art.setAttribute('aria-label', `${newer.length} rated films from the ${newerLabel}${newer.length ? ` averaging ${mean(newer).toFixed(1)}` : ''}; ${older.length} ${olderLabel}${older.length ? ` averaging ${mean(older).toFixed(1)}` : ''}`);
  const note = $('#era-note');
  if (rated.length < 5) { note.textContent = 'Too few rated films with release years to weigh old against new.'; return; }
  if (index < 0) { note.textContent = 'Nearly every film here comes from the same stretch, so there is nothing to weigh yet.'; return; }
  const olderShare = older.length / rated.length;
  const notes = [index ? `Nearly everything here is recent, so the scale weighs the ${newerLabel} against ${olderLabel === 'earlier' ? 'everything before' : 'anything older'}.` : olderShare >= .5 ? 'You travel back in time more often than not.' : olderShare <= .3 ? 'Mostly recent films lately, with a few older ones.' : 'A mix of recent and older films lately.'];
  if (Math.abs(gap) < .25) notes.push('The scale stays level: you rate both sides about the same.');
  else if (gap > 0) notes.push(cutoff === 1 ? 'Films from before this year weigh more with you: they earn more stars.' : 'Older films weigh more with you: they earn more stars.');
  else notes.push(cutoff === 1 ? 'This year’s films weigh more with you: they earn more stars.' : `The ${newerLabel} weigh more with you: their films earn more stars.`);
  note.textContent = notes.join(' ');
}

function renderExtras(data) {
  const section = $('#extras'); if (!section) return;
  const films = data.recent || [];
  section.hidden = !films.length;
  if (!films.length) return;
  const dated = films.map(film => ({ film, date: day(film.watchedDate) })).filter(entry => entry.date);
  drawHouse(dated);
  drawRhythm(films);
  drawMeter(films);
  drawHearts(films);
  drawEra(films);

}

// Iceberg: depth is release year only. It never claims obscurity or popularity.
const NOW_YEAR = new Date().getUTCFullYear();
const BANDS = [
  { label: 'Above water · new releases', top: 40, bottom: 120, test: year => year >= NOW_YEAR - 1, from: NOW_YEAR, to: NOW_YEAR - 1 },
  { label: '2020s', top: 120, bottom: 224, test: year => year >= 2020, from: NOW_YEAR - 2, to: 2020 },
  { label: '2000s and 2010s', top: 224, bottom: 328, test: year => year >= 2000, from: 2019, to: 2000 },
  { label: '1980s and 1990s', top: 328, bottom: 432, test: year => year >= 1980, from: 1999, to: 1980 },
  { label: '1960s and 1970s', top: 432, bottom: 536, test: year => year >= 1960, from: 1979, to: 1960 },
  { label: 'Before 1960', top: 536, bottom: 640, test: () => true, from: 1959, to: 1900 },
];
const WATER = ['#9fc6e8', '#5b9bd5', '#2f6fae', '#1c4f86', '#0f335c'];
const GREENS = ['#c0dd97', '#97c459', '#639922', '#3b6d11', '#27500a'];
const half = y => y < 120 ? 14 + (y - 40) * 0.6 : y < 330 ? 62 + (y - 120) * 0.56 : Math.max(112, 180 - (y - 330) * 0.3);
const hash = text => { let h = 2166136261; for (const char of text) h = Math.imul(h ^ char.charCodeAt(0), 16777619); return (h >>> 0) / 4294967295; };

function renderIceberg(data) {
  const films = (data.recent || []).filter(film => film.year);
  const art = $('#iceberg');
  const tip = $('#berg-tip');
  art.setAttribute('viewBox', '0 0 500 640');
  svg(art, 'rect', { x: 0, y: 0, width: 500, height: 120, fill: '#e9f2fa' });
  svg(art, 'circle', { cx: 430, cy: 44, r: 20, fill: '#f6c36b' });
  WATER.forEach((fill, i) => svg(art, 'rect', { x: 0, y: 120 + i * 104, width: 500, height: 104, fill }));
  const left = [], right = [];
  for (let y = 40; y <= 630; y += 10) { const w = half(y) * (0.92 + 0.08 * Math.sin(y / 23)); left.push(`${250 - w},${y}`); right.unshift(`${250 + w * (0.9 + 0.1 * Math.cos(y / 31))},${y}`); }
  svg(art, 'polygon', { points: [...left, ...right].join(' '), fill: '#eef5fb', opacity: '0.94' });
  svg(art, 'polygon', { points: ['250,40', ...right.slice(0, -1)].join(' '), fill: '#c6dcf1', opacity: '0.9' });
  svg(art, 'path', { d: 'M0 120 q25 -7 50 0 t50 0 t50 0 t50 0 t50 0 t50 0 t50 0 t50 0 t50 0 t50 0', fill: 'none', stroke: '#ffffff', 'stroke-width': 2.5 });
  svg(art, 'path', { d: 'M70 110 h46 l-8 10 h-30 z', fill: '#5f5e5a' });
  svg(art, 'line', { x1: 93, y1: 110, x2: 93, y2: 88, stroke: '#5f5e5a', 'stroke-width': 2 });
  svg(art, 'path', { d: 'M93 89 l16 7 -16 6 z', fill: '#d85a30' });
  BANDS.forEach((band, i) => svg(art, 'text', i ? { x: 486, y: band.top + 22, class: `band-label end${i > 1 ? ' deep' : ''}` } : { x: 14, y: 30, class: 'band-label' }, band.label));
  const placed = [], labelBoxes = [];
  const labels = films.filter(film => film.rating >= 4.5).slice(0, 6);
  films.forEach((film, index) => {
    const band = BANDS.find(b => b.test(film.year));
    const share = Math.min(1, Math.max(0, (band.from - film.year) / Math.max(1, band.from - band.to)));
    const r = film.rating == null ? 6 : 5 + film.rating * 1.6;
    let x, y;
    for (let attempt = 0; attempt < 12; attempt++) {
      y = band.top + 16 + share * (band.bottom - band.top - 32) + (attempt ? (hash(`${film.id}${attempt}y`) - 0.5) * 24 : 0);
      x = 250 + (hash(`${film.id}${index}${attempt}`) * 2 - 1) * half(y) * 0.72;
      const onLabel = BANDS.some((b, i) => i && x + r > 360 && y - r < b.top + 30 && y + r > b.top + 6);
      if (!onLabel && !placed.some(p => Math.hypot(p.x - x, p.y - y) < p.r + r + 2)) break;
    }
    placed.push({ x, y, r });
    const label = `${film.title}, ${film.year}. ${stars(film.rating)}${film.liked ? '. Liked' : ''}${film.rewatch ? '. Rewatch' : ''}.`;
    const dot = svg(art, 'g', { class: 'berg-film', tabindex: 0, role: 'img', 'aria-label': label });
    if (film.rewatch) svg(dot, 'circle', { cx: x, cy: y, r: r + 4, fill: 'none', stroke: '#ffffff', 'stroke-width': 1.5, 'stroke-dasharray': '3 2' });
    svg(dot, 'circle', { cx: x, cy: y, r, fill: film.rating == null ? '#b4b2a9' : GREENS[Math.max(0, Math.ceil(film.rating) - 1)], stroke: film.liked ? '#d4537e' : '#ffffff', 'stroke-width': film.liked ? 3 : 1.5 });
    if (labels.includes(film)) {
      // Labels point toward the centre and are skipped when they would collide.
      const width = film.title.length * 6.4, flip = x > 250, lx = flip ? x - r - 5 : x + r + 5;
      const box = { left: flip ? lx - width : lx, right: flip ? lx : lx + width, top: y - 10, bottom: y + 6 };
      const clash = labelBoxes.some(b => b.left < box.right && box.left < b.right && b.top < box.bottom && box.top < b.bottom)
        || box.left < 4 || box.right > 496 || BANDS.some((b, i) => i && box.right > 360 && box.top < b.top + 28 && box.bottom > b.top + 8);
      if (!clash) { labelBoxes.push(box); svg(art, 'text', { x: lx, y: y + 4, class: 'berg-label', 'text-anchor': flip ? 'end' : 'start' }, film.title); }
    }
    const show = () => {
      tip.replaceChildren(node('strong', '', film.title), node('span', '', ` · ${film.year}`), node('br'), node('span', '', `${film.rating == null ? 'Unrated' : `${film.rating} ★`}${film.liked ? ' · liked' : ''}${film.rewatch ? ' · rewatch' : ''}`));
      tip.hidden = false;
      const box = art.getBoundingClientRect(), mark = dot.getBoundingClientRect();
      tip.style.left = `${Math.min(box.width - 180, Math.max(0, mark.right - box.left + 8))}px`;
      tip.style.top = `${mark.top - box.top - 6}px`;
    };
    const hide = () => { tip.hidden = true; };
    dot.addEventListener('mouseenter', show); dot.addEventListener('focus', show);
    dot.addEventListener('mouseleave', hide); dot.addEventListener('blur', hide);
  });
  svg(art, 'text', { x: 14, y: 628, class: 'band-label deep' }, 'Deeper = older');
  // The same films as text, band by band, for screen readers and quick reading.
  const list = $('#berg-list');
  BANDS.forEach(band => {
    const inBand = films.filter(film => BANDS.find(b => b.test(film.year)) === band);
    if (!inBand.length) return;
    const item = node('li');
    item.append(node('h3', '', `${band.label} · ${inBand.length}`));
    const names = node('p');
    names.textContent = inBand.map(film => `${film.title} (${film.year})${film.rating == null ? '' : ` ${film.rating}★`}`).join(' · ');
    item.append(names);
    list.append(item);
  });
  if (!films.length) list.append(node('li', 'no-data', 'No recent films found.'));
}

function render(data) {
  for (const panel of document.querySelectorAll('.film-collection')) panel.hidden = data.scope?.mode === 'rss';
  results.hidden = false; empty.hidden = true;
  $('#result-title').textContent = `@${data.username}`;
  $('#result-label').textContent = data.complete ? 'Current lookup' : 'Incomplete lookup';
  if ($('#receipt')) {
    const recentCount = $('#recent-count'); if (recentCount) recentCount.textContent = countLabel(data.checks?.recent, data.recent.length, 'entry', 'entries');
    filmList('#recent-list', data.recent, 'recent', data.checks?.recent?.complete);
    filmList('#watched-list', data.watchedFilms || [], 'watchedFilms', data.checks?.watchedFilms?.complete);
    filmList('#watchlist-list', data.watchlist || [], 'watchlist', data.checks?.watchlist?.complete);
    $('#watched-count').textContent = countLabel(data.checks?.watchedFilms, data.watchedFilms?.length || 0, 'film');
    $('#watchlist-count').textContent = countLabel(data.checks?.watchlist, data.watchlist?.length || 0, 'film');
    $('#watched-coverage').textContent = coverage(data.checks?.watchedFilms);
    $('#watchlist-coverage').textContent = coverage(data.checks?.watchlist);
    renderReceipt(data);
    renderExtras(data);
    const histogram = $('#histogram'), distribution = data.recentRatingHistogram;
    if (histogram) histogram.replaceChildren();
    if (histogram) $('#histogram-count').textContent = distribution ? `${distribution.totalRatings.toLocaleString()} rated` : 'Not collected';
    if (histogram && distribution) {
      const maximum = Math.max(1, ...distribution.bins.map(bin => bin.count));
      distribution.bins.forEach(bin => {
        const star = node('span', `histogram-row${bin.count ? '' : ' empty'}`, '★');
        star.setAttribute('role', 'img'); star.setAttribute('aria-label', `${bin.rating} stars: ${bin.count} ratings`);
        star.style.setProperty('--s', bin.count ? Math.sqrt(bin.count / maximum).toFixed(3) : '0');
        histogram.append(star);
      });
    } else if (histogram) histogram.append(node('p', 'no-data', 'Ratings could not be read this time.'));
  }
  if ($('#iceberg')) renderIceberg(data);
  scheduleClear();
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  const value = normalizeUsername(username.value);
  username.value = value;
  if (!/^[a-zA-Z0-9_]{1,40}$/.test(value)) { username.setCustomValidity('Enter only the username: letters, numbers or underscores.'); username.reportValidity(); return; }
  clearResults(false);
  const version = lookupVersion;
  const request = new AbortController(); currentRequest = request;
  setBusy(true);
  results.hidden = true; empty.hidden = true;
  status.hidden = false; status.className = 'status loading'; status.textContent = `Collecting @${value}’s films…`;
  try {
    const response = await fetch('/api/collect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: value }), cache: 'no-store', signal: AbortSignal.any([request.signal, AbortSignal.timeout(180000)]) });
    const data = await response.json();
    if (version !== lookupVersion) return;
    if (!response.ok) throw new Error(data.error || 'Collection failed. Please try again.');
    render(data);
    status.className = data.complete ? 'status' : 'status error';
    status.textContent = data.complete ? (data.scope?.mode === 'rss' ? 'Films collected.' : 'Collection complete.') : `Collection incomplete. ${plain(data.error)}`;
    $('#result-title').focus();
  } catch (error) {
    if (version !== lookupVersion || error.name === 'AbortError') return;
    status.className = 'status error';
    status.textContent = error.name === 'TimeoutError' ? 'Collection timed out. Try again later.' : error.message;
    emptyText.textContent = 'No films collected.';
    empty.hidden = false;
    scheduleClear();
  } finally {
    if (version !== lookupVersion) return;
    currentRequest = null;
    setBusy(false);
  }
});
username.addEventListener('input', () => username.setCustomValidity(''));

// A sparse field of drifting dots under the headline.
const dots = $('.dots');
if (dots) for (let i = 0, seed = 7; i < 70; i++) {
  const next = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
  const dot = node('i');
  dot.style.left = `${next() * 100}%`; dot.style.top = `${next() * 100}%`;
  dot.style.opacity = (0.25 + next() * 0.6).toFixed(2); dot.style.animationDelay = `${(-next() * 7).toFixed(2)}s`;
  dots.append(dot);
}
$('#keep-rolling')?.addEventListener('click', event => { $('#recent-list').classList.remove('rolled-up'); event.currentTarget.hidden = true; });
$('#clear-results').addEventListener('click', () => { clearResults(); username.focus(); });
window.addEventListener('pagehide', () => clearResults());
window.addEventListener('pageshow', () => clearResults());

// The film band: hand-inked doodles on a strip that keeps running. Decorative only.
const DOODLES = [
  'M30 6l6 13 14 1-11 9 4 14-13-8-13 8 4-14-11-9 14-1z',
  'M10 20h40v20H10z M10 20l3-10h38l-1 10 M22 10l-4 10 M34 10l-4 10 M46 10l-4 10',
  'M18 22l4 20h16l4-20z M26 22l1 20 M34 22l-1 20 M18 22c-5-7 4-12 8-6 1-7 10-7 10-1 4-5 12 0 6 7',
  'M8 22h30v18H8z M38 27l12-6v20l-12-6 M12 15a6 6 0 1 0 12 0a6 6 0 1 0-12 0 M26 15a5 5 0 1 0 10 0a5 5 0 1 0-10 0',
  'M30 40C14 30 9 19 17 14c5-3 10 0 13 5 3-5 8-8 13-5 8 5 3 16-13 26z',
  'M10 14h40v7a4 4 0 0 0 0 8v7H10v-7a4 4 0 0 0 0-8z M23 14v22',
  'M37 8a17 17 0 1 0 13 25A13 13 0 1 1 37 8z',
  'M8 24c10-13 34-13 44 0-10 13-34 13-44 0z M26 24a4 4 0 1 0 8 0a4 4 0 1 0-8 0',
  'M13 24a17 17 0 1 0 34 0a17 17 0 1 0-34 0 M26 15a4 4 0 1 0 8 0a4 4 0 1 0-8 0 M26 33a4 4 0 1 0 8 0a4 4 0 1 0-8 0 M17 24a4 4 0 1 0 8 0a4 4 0 1 0-8 0 M35 24a4 4 0 1 0 8 0a4 4 0 1 0-8 0',
  'M8 20h44 M10 20l3 13h13l3-10h2l3 10h13l3-13',
];
const track = $('.filmband-track');
if (track) for (let round = 0; round < 2; round++) for (let i = 0; i < 2 * DOODLES.length; i++) {
  const frame = node('div', 'filmband-frame');
  const art = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  art.setAttribute('viewBox', '0 0 60 48');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', DOODLES[(i * 3) % DOODLES.length]);
  art.append(path); frame.append(art); track.append(frame);
}

// Pointer position for the projector light (red page) or the hero's parallax (main page). It lives only in CSS
// variables on the one element that uses them, so a move restyles that element's subtree, not the whole page.
if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
  const host = document.querySelector('.bake-hero') || document.body;
  let frame = 0, x = 0, y = 0;
  window.addEventListener('pointermove', event => {
    x = event.clientX; y = event.clientY;
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      host.style.setProperty('--mx', `${x}px`);
      host.style.setProperty('--my', `${y}px`);
    });
  }, { passive: true });
}
