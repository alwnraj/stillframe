# Data collection: checklist and agent handoff

Reviewed against the current source on 2026-11-26. Start with [AGENTS.md](AGENTS.md) and [README.md](README.md). This document contains no real account records, credentials or saved collection results.

## Working production scope

Checked means implemented and covered by tests, not guaranteed for every username or hosting provider. Production uses one plain HTTPS RSS request per username and parses the response in Node. Chrome is not required for the production RSS path.

- [x] Up to 50 recent movie entries: title, year, owned entry URL, watched/publication dates and supplied TMDB ID. Separate rewatches remain separate in the solo response.
- [x] Supplied per-entry ratings, liked/rewatch flags, creator names and plain-text descriptions/review excerpts. Missing optional flags remain unknown (`null`), including in movie-night summaries.
- [x] Safe link/image references from RSS descriptions, as metadata only. No image downloads, arbitrary external fetches or separate full-review requests.
- [x] RSS channel title, description and profile URL; not full profile details.
- [x] Up to 50 RSS list items with summaries/referenced films; not complete list contents or the public-list index.
- [x] RSS story summaries/references; not full articles. Story-only feeds can be valid with zero movie entries.
- [x] Ten-bin half-star histogram computed only from rated movie entries in this RSS window; not the account-wide distribution.

Mixed feeds may supply fewer than 50 movie entries. Schema 6 declares `scope.mode: "rss"`. Movies, lists and stories stay separate; do not add overlapping arrays to claim unique full history.

## Disabled or unsupported sources

Unchecked does not mean permanently broken. The extended parsers have fixture coverage, not fresh live certification from this publication task.

| Source | Current status |
| --- | --- |
| Watchlist | Disabled in production. Internal extended parser supports up to 28 first-page films. Earlier headless samples worked; it was removed to prioritize reliability, not because every watchlist was proven inaccessible. |
| Watched-film collection | Extended parser only: up to 72 first-page films. RSS absence never proves a film is unseen. |
| Public-list index | Extended parser only: up to 12 summaries/previews/tags/reactions; never full list contents. |
| Tags | Extended parser only: up to 120 first-page labels. Aliases may share a URL and must not be summed as unique activity. |
| Diary pages | Extended parser only: up to 50 first-page dated rows; separate from RSS dates. |
| Mini-profile | Extended collection headers may expose name, avatar and explicit membership badge. Not requested by the default RSS flow. |
| Four favorites, full liked-film collection, account-wide histogram | Not collected. Earlier sessions reported headless blocks; these sources were not re-probed for publication. RSS signals are not complete substitutes. |
| Full profile, bio, location, followers/following, social graph | Not collected. Movie-night participants join manually. |
| Full history, deeper pagination, full review/article/list content | Not supported by the production collector. Read-only full-history fixture helpers do not prove live full-history collection. |
| Predictions or proven unseen-film candidates | No model implemented. Current movie-night candidates are recently logged films. Watchlists may be useful future inputs but require separate probing before re-enabling. |

## Reliability and temporary data

- [x] Validate owner, owned URLs, required fields, dates, ratings, duplicate IDs and recognized feed item types; reject malformed/unknown data rather than silently succeed.
- [x] Distinguish verified empty, unavailable, blocked and skipped sources. Omitted compatibility arrays carry `requested: false` and `skipped: true`, not verified-empty coverage.
- [x] Stream the RSS body and stop above 4 MiB; reject an oversized declared Content-Length. Production no longer calls `response.text()` before size validation.
- [x] Stop on HTTP 403/429, challenges, redirects, invalid/unavailable responses or timeouts. Honor Retry-After; no retries, stealth, proxies or challenge solving.
- [x] One active collector across solo/room lookups. Collect friends sequentially, with five-second gaps between completed source requests within one process.
- [x] Six-session rooms support concurrent joins, duplicate-join recovery, shared shortlists, one changeable vote per participant and winner/tie results only after everyone votes.
- [x] First failed feed stops remaining room requests; only previously verified data appears in an explicitly partial room.
- [x] Fixed room expiry two minutes from creation, including joining/loading. Activity never extends it. Any participant's leave/navigation signal ends it; crashes/network loss fall back to expiry.
- [x] Expiry during loading aborts collection, skips later feeds and releases the collector lock. Late responses cannot restore cleared views.
- [x] Account data, rooms, keys and votes exist only in request/view/process memory. No saved JSON, exports, database, cookies, browser storage, application logs or real-data recordings. HTTP JSON is transient transport and responses are `no-store`.
- [x] Extended mode and UI tests use fresh nonpersistent Chrome contexts. Bounded client disposal and owned-process termination address the previously observed shutdown stall. Unattended checkers fail if leaked handles prevent exit.

## Limits that remain

- [ ] No guarantee of access for every account, network or hosting provider. A correctly handled block is not successful collection.
- [ ] Two-minute rooms can expire before six slow feeds finish; do not silently extend TTL or skip failures to report success.
- [ ] RSS does not prove complete watched/liked/rated history or that an absent film is unseen. Feed review text may be an excerpt.
- [ ] The local Node server binds to localhost. A Cloudflare Workers port (`worker/index.js`, `wrangler.toml`) keeps all `/api` state in one in-memory Durable Object, so the lock, pacing and rooms stay single-instance. Verified so far: the full app and live checkers in the local `wrangler dev` emulator; the RSS fetch from Cloudflare's network (probe Worker, 10/10 smoke test); and client-disconnect abort reaching a Durable Object in a synthetic production experiment. The full app has not yet been verified on a production deployment.
- [ ] Worker observability is disabled in config; account-level logging (e.g. Logpush) has not been checked. One global lock and five-second pacing cap the whole site at roughly ten lookups a minute, and there is no per-IP limit. App-level non-retention cannot control copying visible data, forensic RAM/OS recovery, browser/Letterboxd/provider logs or host temporary files.
- [ ] A username and permission checkbox are not authenticated account ownership. Invite holders can join the lobby; private participant keys authorize room data/actions.

## Verification and next-agent steps

Publication verification on 2026-11-26: `npm test` passed all 121 tests against the current direct-HTTP RSS implementation. No live account lookups were rerun merely to publish the source. An earlier headless-only iteration reported a six-session live expiry pass; that historical run does not certify the new HTTP transport on every account or host. This checklist contains no benchmark/account data.

1. Read `src/snapshot.js` (HTTP RSS/parser/extended mode), `src/night.js` (rooms/merging/votes), `src/server.js` (silent endpoints), and the frontend in `public/`.
2. Run `npm test`. Chrome is needed for UI/extended-parser tests. Fixtures cover Node/browser parser parity, size limits, validation, cancellation, empty/blocked/unavailable feeds and six-session lifecycle checks.
3. If live verification is authorized, run the existing silent checkers sequentially against the localhost server. Pass consenting usernames as arguments; never write their values or results to files. `scripts/test-night-live.mjs --expire` accepts 2–6 distinct usernames and waits for actual expiry.
4. Before expanding scope, probe one candidate source in isolation, distinguish private/empty/unavailable/blocked responses, and document its coverage. Do not enable every extended page just to probe a watchlist.
5. Preserve non-retention, conservative pacing, stop-on-block behavior, no subagents and pinned dependencies at least 14 days old. Do not add frameworks, databases, exports or storage without a concrete new requirement.

Useful next-session skills: `playwright` for UI checks and `diagnosing-bugs` for a reproduced failure. Read `.impeccable.md` before any design change.
