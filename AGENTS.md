# Repository instructions

## User rules

- Do not use subagents.
- Do not overengineer; prefer small changes that fit the existing code.
- Do not change files when the user is only asking a question.
- Install only pinned package versions published at least 14 days ago, including transitive dependencies. Preserve `.npmrc` and the lockfile; never install `latest`.

## Non-retention requirement

All real account data is use-and-discard. This requirement supersedes the project's former JSON-saving behavior.

- Keep real usernames, film data, results and errors only in current-request/current-view memory. Do not persist them in files, databases, caches, browser storage, cookies, analytics, telemetry or application logs.
- Do not add download/export buttons, JSON previews, saved-result endpoints, stable lookup IDs or history features. JSON is permitted only as the transient HTTP transport format.
- Do not log request bodies, usernames, URLs containing usernames, results, error objects or stack traces. The application server is silent, including at startup and on failures.
- Do not save real-data screenshots, video, traces, HAR files or benchmark reports, including during live tests. Use synthetic fixtures for diagnostics. Test-runner pass/fail output must not dump real data.
- Responses must be `no-store`. Do not add localStorage, sessionStorage, IndexedDB, service workers or result caching.
- Clear the current page's results and username on a new lookup, Clear now, page navigation/restoration and after two minutes. Prevent late responses from restoring cleared results.
- Abort disconnected requests, stop collection, clear cancelled data, close browser contexts, and release the busy state. Never reuse a personal or persistent browser profile; collector downloads and service workers stay disabled.
- Do not recreate `output/` or `.browser-profile/`. Old generated collection files and the data-writing CLI/benchmarks have been removed intentionally.

Do not promise that users cannot copy visible data or inspect responses. App-level non-retention cannot guarantee forensic RAM/OS erasure or control Letterboxd, browser, proxy or hosting-provider logs. Verify provider-side logging separately before deployment. Do not enable debug logging that captures real requests or data.

## Temporary movie-night rooms

The user authorized shared rooms for 2–6 friends. This narrowly permits process-local room state and random temporary invitation/participant capabilities. Rooms expire two minutes from creation, never extend, and are destroyed on any member’s leave/navigation signal or server shutdown. Network loss/crashes fall back to expiry. Never persist or log rooms, keys, usernames, film data or votes. No recovery/history endpoints or browser storage. Joining requires explicit permission; a username is not authenticated ownership.

Use RSS-only sequential collection with the existing shared busy lock and pacing. Stop the room batch at the first failed feed; distinguish empty, blocked, unavailable and not-requested states. Show partial rooms explicitly. Merge only verified movie entries, deduplicate rewatches per participant and never infer unseen films from feed absence. The constellation shows at most 60 nodes; all collected films remain searchable. Up to six nominations, at most two per participant, and one changeable vote per participant. Declare winner/tie only after all participants voted. Authenticate room data and actions with each participant’s in-memory key; the fragment invite alone grants lobby joining, not data access or voting.

## Project and code map

Stillframe is a username-only Letterboxd website using Node.js 22+, ES modules, the built-in HTTP server, plain HTML/CSS/JavaScript and pinned Playwright with installed Google Chrome. Read `README.md` for operating details and `.impeccable.md` before design changes. Do not add frameworks, databases or queue services without a concrete task requirement.

| Location | Responsibility |
| --- | --- |
| `src/snapshot.js` | Ephemeral website collector (plain-HTTP RSS fetch and Node RSS parser), validation, coverage, cancellation and bounded cleanup |
| `src/night.js` | Fixed-lifetime in-memory shared rooms, feed merge, shortlist and votes |
| `src/app.js` | Platform-neutral `Request → Response` handler: routes, guards, busy lock and room endpoints |
| `src/server.js` | Thin silent Node adapter for local use and tests |
| `worker/index.js`, `wrangler.toml` | Cloudflare Worker: static assets with headers, one in-memory Durable Object for all `/api` state; no storage, alarms or observability |
| `public/` | Form, transient results, histogram, collection panels and clearing |
| `src/scraper.js` | Shared username validation and read-only full-history test helpers; no persistence |
| `test/`, `scripts/test-live.mjs` | Synthetic regression tests and a non-recording live browser check |

## Collection contract

The user now prioritizes reliability over data volume. Schema version 6 defaults to `scope.mode: "rss"` and requests only the public RSS feed. Production HTTP accepts a username only; do not expose the old extended mode without a new request.

| In-memory field | Scope |
| --- | --- |
| `recent` | Up to 50 RSS movie entries with provided metadata; preserve separate rewatches |
| `feed`, `feedLists`, `feedStories` | Verified RSS channel, list and story summaries/references, bounded by the 4 MiB feed; not full lists/articles |
| `recentRatingHistogram` | Only rated movie entries in the current RSS window |

Success requires all requested RSS fields and browser disposal to pass. A valid empty feed is distinct from unavailable or blocked data. Omitted collection arrays remain empty for compatibility, with `requested: false` and `skipped: true`, absent from scope and hidden in the UI. Never claim full account history or count a handled block as successful collection.

The previous six-page parser is retained internally as `mode: "extended"` for its existing fixture coverage. Tests for its page sizes, private notices, tag aliases and empty layouts must remain strict; production must not request those pages by default. The extended sources are watched films (72), public lists (12), tags (120), diary (50), watchlist (28), plus RSS.

Validate RSS identity, typed movie/list/story separation, duplicate IDs, owned URLs, dates and ratings. Stop on HTTP 403/429, verification, redirects, invalid data, unavailable feeds or timeouts. Honor Retry-After and five-second gaps without retries, stealth, proxies or challenge solving. Preserve only verified data in the current view. Do not follow external content links or add scraping routes without probing first. All nested fields must be scrubbed on cancellation.

Keep one active collection at a time, input validation and bounded request bodies. Close resources with deadlines; do not let stalled cleanup hold a request indefinitely. Render collected strings as text, not HTML. No prediction model is currently implemented; future prediction processing must preserve non-retention.

## Run and verify

```sh
npm ci --ignore-scripts --min-release-age=14
npm start
npm test
```

The silent server runs at `http://127.0.0.1:3000`. Reuse the project server where appropriate; restart only the task-owned server, never unrelated Chrome sessions or processes.

For live collection/UI changes, run sequentially with the server running:

```sh
node scripts/test-live.mjs dave
node scripts/test-live.mjs davidehrlich
node scripts/test-night-live.mjs dave davidehrlich
```

The live script produces no data output or artifacts; check its exit status. Account-specific counts and provider access can change. Use fixture tests to diagnose errors without recording live data. Verify the RSS-only production scope and separate extended regressions, RSS sample histogram, pacing/order and stop-on-block behavior, coverage, cancellation, clearing, expiry, browser storage absence, removed download endpoints, browser errors and mobile layouts.

Documentation-only changes need no browser tests. Update README and tests when changing scope or the in-memory response contract. Report observed local behavior accurately; do not promise reliability on every account or hosting provider. Preserve localhost binding for the Node server. The user requested deployment on Cloudflare Workers (free plan); keep its Durable Object free of storage/alarms and its observability disabled.

Production RSS lookups use one plain HTTPS `fetch` (manual redirects, streamed 4 MiB cap, honest user agent) and never start a browser; `parseRss` parses the feed in Node, with fixture and parity tests against the browser parser. Only extended mode, UI tests and live checkers use a browser: one owned headless browser process, exposed only on loopback for Playwright. Completion and cancellation disconnect the Playwright client, terminate that process and await its exit; they do not wait for a separate routed-context close handshake. A disposal deadline still makes the result incomplete. Fixture tests cover single disposal, cancellation scrubbing and natural process exit after repeated six-context sessions. Preserve bounded client cleanup and fail the unattended checker if leaked handles prevent exit.

Private-watchlist detection requires an explicit privacy notice, not a generic occurrence of “private” in page controls. Keep verified empty, unavailable and skipped states distinct in UI counts. Accept validated RSS-only story feeds without inventing movie entries. `feedStories` must be cleared with all other nested data on cancellation.
