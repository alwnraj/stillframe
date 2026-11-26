import { randomBytes } from 'node:crypto';
import { validateUsername } from './scraper.js';

const token = () => randomBytes(24).toString('base64url');
const COLORS = ['green', 'amber', 'blue', 'rose', 'violet', 'teal'];
const fail = (status, message) => { const error = new Error(message); error.status = status; throw error; };

// This store is deliberately process-local. No room survives expiry or restart.
export function createNightStore({ collect, startJob, ttlMs = 120000, now = Date.now, maxRooms = 20 } = {}) {
  const rooms = new Map();
  function destroy(room) {
    rooms.delete(room.id); clearTimeout(room.timer); room.controller.abort();
    room.members.clear(); room.movies = []; room.nominations.clear(); room.votes.clear();
  }
  function live(id) {
    const room = rooms.get(id);
    if (!room || room.expiresAt <= now()) { if (room) destroy(room); fail(410, 'This room has ended or expired.'); }
    return room;
  }
  function member(room, key) {
    const value = Array.from(room.members.values()).find(person => person.key === key);
    if (!value) fail(403, 'Join this room before taking part.');
    return value;
  }
  function add(room, input) {
    if (input.consent !== true) fail(400, 'Confirm permission to share this public feed with the room.');
    let username;
    try { username = validateUsername(typeof input.username === 'string' ? input.username.trim() : ''); }
    catch { fail(400, 'Enter a Letterboxd username.'); }
    if (room.members.size >= 6) fail(409, 'This room already has six friends.');
    if (Array.from(room.members.values()).some(person => person.username === username)) fail(409, 'That username has already joined.');
    const person = { id: token(), key: token(), username, color: COLORS[room.members.size], feedState: 'waiting' };
    room.members.set(person.id, person); room.revision++;
    return person;
  }
  function view(room, key) {
    const person = member(room, key);
    const counts = new Map();
    for (const filmId of room.votes.values()) counts.set(filmId, (counts.get(filmId) || 0) + 1);
    const nominees = Array.from(room.nominations, ([filmId, by]) => ({ filmId, by, votes: counts.get(filmId) || 0 }));
    const maximum = Math.max(0, ...nominees.map(item => item.votes));
    const leaders = maximum ? nominees.filter(item => item.votes === maximum).map(item => item.filmId) : [];
    return { id: room.id, revision: room.revision, state: room.state, expiresInMs: Math.max(0, room.expiresAt - now()), selfId: person.id, hostId: room.hostId,
      members: Array.from(room.members.values(), ({ id, username, color, feedState }) => ({ id, username, color, feedState })),
      movies: room.movies.map(({aliases, ...movie}) => movie), nominations: nominees, ownVote: room.votes.get(person.id) || null, votesCast: room.votes.size,
      outcome: room.votes.size === room.members.size && leaders.length ? { kind: leaders.length === 1 ? 'winner' : 'tie', filmIds: leaders } : null };
  }
  function merge(room, person, entries) {
    const byKey = new Map();
    for (const movie of room.movies) for (const alias of movie.aliases) byKey.set(alias, movie);
    const logged = new Set();
    for (const entry of entries) {
      let slug;
      try {
        const url = new URL(entry.entryUrl);
        const parts = url.pathname.split('/').filter(Boolean);
        if (url.origin === 'https://letterboxd.com' && parts[0] === person.username && parts[1] === 'film') slug = parts[2];
      } catch {}
      const aliases = [slug ? `slug:${slug}` : null, entry.tmdbId ? `tmdb:${entry.tmdbId}` : null].filter(Boolean);
      if (!aliases.length) continue;
      let movie = aliases.map(alias => byKey.get(alias)).find(Boolean);
      if (!movie) {
        movie = { aliases: [], id: `film-${room.movies.length + 1}`, title: entry.title, year: entry.year, filmUrl: slug ? `https://letterboxd.com/film/${slug}/` : null, loggedBy: [] };
        room.movies.push(movie);
      }
      for (const alias of aliases) { byKey.set(alias, movie); if (!movie.aliases.includes(alias)) movie.aliases.push(alias); }
      if (logged.has(movie.id)) continue;
      logged.add(movie.id);
      movie.loggedBy.push({ memberId: person.id, rating: entry.rating, liked: entry.liked ?? null, rewatch: entry.rewatch ?? null, watchedDate: entry.watchedDate });
    }
  }
  async function run(room) {
    let verified = 0;
    try {
      for (const person of room.members.values()) {
        if (!rooms.has(room.id) || room.controller.signal.aborted) return;
        person.feedState = 'collecting'; room.revision++;
        const result = await collect(person.username, { signal: room.controller.signal });
        if (!rooms.has(room.id) || room.controller.signal.aborted) return;
        if (!result.complete) {
          person.feedState = Object.values(result.checks || {}).some(check => check.blocked) ? 'blocked' : 'unavailable';
          room.state = verified ? 'partial' : 'failed';
          for (const other of room.members.values()) if (other.feedState === 'waiting') other.feedState = 'not-requested';
          room.revision++;
          return;
        }
        person.feedState = result.recent.length ? 'available' : 'empty';
        merge(room, person, result.recent); verified++; room.revision++;
      }
      if (rooms.has(room.id)) {room.state = 'ready';room.revision++;}
    } catch {
      if (!rooms.has(room.id)) return;
      for (const person of room.members.values()) {
        if (person.feedState === 'collecting') person.feedState = 'unavailable';
        if (person.feedState === 'waiting') person.feedState = 'not-requested';
      }
      room.state = verified ? 'partial' : 'failed'; room.revision++;
    }
  }
  return {
    create(input) {
      for (const room of rooms.values()) if (room.expiresAt <= now()) destroy(room);
      if (rooms.size >= maxRooms) fail(503, 'All temporary rooms are in use. Try again later.');
      const room = { id: token(), expiresAt: now() + ttlMs, revision: 0, state: 'lobby', members: new Map(), movies: [], nominations: new Map(), votes: new Map(), controller: new AbortController() };
      const person = add(room, input); room.hostId = person.id;
      room.timer = setTimeout(() => destroy(room), ttlMs); room.timer.unref?.(); rooms.set(room.id, room);
      return { token: person.key, room: view(room, person.key) };
    },
    peek(id, key) {
      const room = live(id);
      return key ? view(room, key) : { state: room.state, memberCount: room.members.size, expiresInMs: room.expiresAt - now() };
    },
    join(id, input) {
      const room = live(id);
      if (room.state !== 'lobby') fail(409, 'This room has already started.');
      const person = add(room, input);
      return { token: person.key, room: view(room, person.key) };
    },
    start(id, key) {
      const room = live(id); const person = member(room, key);
      if (person.id !== room.hostId) fail(403, 'Only the host can collect the feeds.');
      if (room.state !== 'lobby') fail(409, 'This room has already started.');
      if (room.members.size < 2) fail(400, 'Two friends must join before collection starts.');
      if (!startJob(() => run(room))) fail(429, 'Another collection is running. Try again shortly.');
      room.state = 'collecting'; room.revision++;
      return view(room, key);
    },
    nominate(id, key, filmId) {
      const room = live(id); const person = member(room, key);
      if (!['ready', 'partial'].includes(room.state)) fail(409, 'Wait for collection to finish.');
      if (!room.movies.some(movie => movie.id === filmId)) fail(400, 'Choose a film from this room.');
      if (!room.nominations.has(filmId)) {
        if (room.nominations.size >= 6) fail(409, 'The shortlist already has six films.');
        if (Array.from(room.nominations.values()).filter(by => by === person.id).length >= 2) fail(409, 'Each friend can nominate two films.');
        room.nominations.set(filmId, person.id); room.revision++;
      }
      return view(room, key);
    },
    vote(id, key, filmId) {
      const room = live(id); const person = member(room, key);
      if (!['ready', 'partial'].includes(room.state)) fail(409, 'Wait for collection to finish.');
      if (!room.nominations.has(filmId)) fail(400, 'Vote for a shortlisted film.');
      if (room.votes.get(person.id) !== filmId) {room.votes.set(person.id, filmId); room.revision++;}
      return view(room, key);
    },
    end(id, key) { const room = live(id); member(room, key); destroy(room); },
    close() { for (const room of rooms.values()) destroy(room); },
  };
}
