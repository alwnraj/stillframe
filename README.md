# Stillframe — temporary Letterboxd lookups

The website now prioritizes reliability with a single public RSS request per lookup. Enter a username to collect up to 50 recent movie entries and whatever list/story summaries the feed supplies. This is a finite feed window, not full account history. Selected favorites, watched-film pages, watchlists, tags, diary pages and full-profile details are outside the website’s scope.

See [DATA_COLLECTION_CHECKLIST.md](DATA_COLLECTION_CHECKLIST.md) for collection scope, disabled sources and the fresh-agent checklist. Publishing this repository does not deploy the running Node server.

## Run

Node.js 22+ is required. Website lookups use one plain HTTPS request and do not start a browser. Installed Google Chrome is needed only for the test suite, the live checkers and the internal extended parser.

```sh
npm ci --ignore-scripts --min-release-age=14
npm start
```

Open [the local website](http://127.0.0.1:3000). The local server is silent and binds to localhost. Playwright is pinned to 1.58.2; no additional packages were installed for this change.

## Deploy on Cloudflare (free plan)

```sh
npx wrangler login
npx wrangler deploy
```

`worker/index.js` serves `public/` through the assets binding with the same no-store and CSP headers, and sends every `/api` request to one Durable Object. That object runs the same `src/app.js` handler as the Node server, so the collection lock, pacing, rooms and votes live in one in-memory state. It never uses Durable Object storage or alarms; eviction or a redeploy ends all rooms, like a server restart. Worker observability is disabled in `wrangler.toml`. A client disconnect aborts collection inside the Durable Object in production (`enable_request_signal`); the local `wrangler dev` emulator does not emulate this. Each room poll counts as a Worker request and a Durable Object request (about 720 per six-person room), within the free daily limits for modest use. The deployed site passed the header, live lookup, movie-night and dropped-request lock-release checks on `workers.dev`; run the live scripts with `TEST_URL` set to the deployed URL to recheck.

## Collection and outcomes

Schema version 6 declares `scope.mode: "rss"`. `recent`, `recentRatingHistogram`, `feed`, `feedLists` and `feedStories` are collected from the same verified RSS response. The body is streamed and the request is cancelled once it passes 4 MiB, so larger feeds are never buffered. Movie entries retain provided ratings, dates, likes, rewatches, creator names, review/description text, links, images and TMDB IDs. Lists and stories remain separate from movie entries; their descriptions and film references are not full list contents or articles. Histogram bins describe only rated movie entries in this feed.

`complete: true` means the requested RSS scope passed validation; any browser used by internal extended mode must also be disposed successfully. It does not mean the full account was collected. Compatibility arrays for omitted sources remain empty, with `checks[section].requested: false` and `skipped: true`; those sources are absent from `scope` and hidden in the website. They are never represented as verified empty collections.

A valid empty feed is successful and empty. A 404/unavailable feed, malformed response, wrong profile, invalid required fields, duplicate IDs or unsupported item type remains a failure. HTTP 403/429 and verification responses stop immediately. Retry-After is honored without retries or alternate routes. Waiting cannot guarantee Letterboxd access. Redirects are refused, not followed, and the request identifies itself honestly as an RSS reader. One active lookup and at least five seconds between completed source requests remain enforced within one server process.

The previous six-page parser remains available only through the internal `mode: "extended"` option for fixture regression/research work. The website API accepts only a username and does not expose that option. Its strict coverage and error tests remain intact.

## Data lifetime

Collected data stays in current-request/current-view memory. There are no saved JSON files, downloads, exports, saved-result IDs, history endpoints, application logs, analytics or database. Responses use `Cache-Control: no-store`. No browser storage, cookies, service workers, recordings, traces or screenshots are configured by the application.

Results and username clear after two minutes, on Clear now, a new lookup, navigation and back navigation. Late responses cannot restore cleared results. Disconnects cancel collection and scrub all nested data. Lookups hold the feed only in request memory; cancellation aborts the HTTPS request. The internal extended parser uses a fresh nonpersistent headless browser context with downloads/service workers disabled, and disconnects its Playwright client before terminating its owned browser process on completion or cancellation. Client disposal is bounded; a leaked listener makes the unattended checker fail rather than hang. Failed disposal is never a successful collection.

This is application-level non-retention, not forensic RAM/OS erasure. Chrome/OS operational temporary files and Letterboxd/hosting-provider logs are outside this guarantee. Provider logs require separate configuration. Visitors can still copy visible content or inspect responses.

## Film strip view

The home page shows the lookup on a strip of 35mm film that uses pictures, not numbers. The countdown leader sweeps and lands on a star; the span reads in words ("from mid October to late November"). "Every film, in order" is a film barcode with one stripe per film, darker for higher ratings, gold for liked, notched for a rewatch and ticked for a review, with a line in words ("liked most, reviewed some"). "How you rate" is ten stars from half a star to five, each sized by how often you used that rating. "Who's in the house" is a seating chart with one filled seat per film for each weekday and the busiest day named. Film cards show the title, marks for liked, rewatch and review, and the stars; the first six show and "Show the rest" reveals the others (four on phones). A fuse burns down until the page clears itself. Exact counts are kept only as screen-reader text. The strip fits one screen on desktop and phone. You can type a username, `@username` or a pasted Letterboxd profile link.

The main page (`/`) is a flat, hand-drawn poster on cream: a film reel that pops out, spins and unspools a strip, cinema doodles that drift around the headline and follow the pointer, oval buttons with hard ink shadows, and lots of motion that all stops under reduced motion. Its strip keeps only the countdown leader, the seating chart and the fuse; the habit pieces sit below. Motion is kept cheap: the reel's front spins as one composited layer, whole SVGs rather than their many parts are animated where possible, and the strip and pieces skip rendering while off screen. The former red page with the full strip (barcode, rating stars and film cards) is kept at the unrouted `/classic` route for tests.

Below the strip, "More from these films" reads habits from the same recent films, each as one picture with a plain sentence and no visible numbers: "Nights at the pictures" (a strip of frames, one per day, lit by how many films were watched, for runs, double bills and breaks), "The light meter" (a needle between harsh and generous at the typical rating, with a gold band over the middle half of ratings), "Then and now" (a balance scale with recent films in one pan and older films in the other, one film can per film; the side you rate higher sinks, and when nearly everything is recent the split moves closer in, from ten years to five, three, two or this year, so both pans still hold enough films to compare), and "Heart and stars" (liked films above the line and the rest below, placed by rating, to show whether likes follow stars). The main page adds "The deep end", an iceberg of release years: the newest films ride the tip above the water and older ones sink. The layers are cut from each person's own release years, up to seven runs of whole years holding film counts as even as possible, so the ice spreads out for someone who watches mostly new releases as well as for someone who watches mostly old films. Layers are named in words ("last year", "two to four years back", "the eighties and nineties", "the silent era"). Each film is a small frame sized by rating, red when liked, with its name beside it; the names pop in a layer at a time as you scroll down, and a sounding line drops from a boat to the oldest film. A single release year is never split, because the feed gives years only. Depth is only how long ago a film came out, never obscurity. Captions say "lately", need a minimum number of films before comparing, treat unknown likes as unknown and keep exact counts in screen-reader labels. They are static, live only in the page and clear with the rest of the lookup.

A cinema iceberg view (`public/iceberg.html`, `public/iceberg.css` and the iceberg code in `public/app.js`) is hidden while it is reworked: it has no route or navigation link, so `/iceberg` returns 404 (UI tests reach it through `HIDDEN_ASSETS`). The receipt renders all collected strings as text, uses no external images and follows the same two-minute clearing.

## Movie night

Movie night is hidden while it is reworked. Its page (`public/night.html`, `night.js`, `night.css`) has no route or navigation link, so `/night` returns 404; the room code and `/api/night` endpoints remain, and its UI tests load the page through the test-only `HIDDEN_ASSETS` list in `src/app.js`. `scripts/test-night-live.mjs` cannot run against a server until the page is routed again. When it returns: create a room with your username and permission checkbox, share its link, and have 1–5 friends join with their own usernames and permission. The host starts collection once everyone has joined. No additional collection sources are requested.

Feeds are collected sequentially using the same process-wide collector lock and conservative pacing as solo lookups. The constellation connects films to people whose current RSS feeds contain them. It displays up to 60 films; the searchable list contains all collected unique films, at most 300. Rewatches count once per person, using their most recent entry. A missing entry never means someone has not seen a film. This is a way to choose from recently logged films, not a prediction or unseen-film recommendation model.

Each friend can nominate two films, with six shortlist slots per room. Each participant has one changeable vote. Votes update through one-second room polling. A winner or explicit tie appears when everyone has voted. Empty feeds remain distinct from blocked/unavailable feeds. A failed feed stops the remaining requests; only previously verified films can be used for a clearly marked partial room.

Rooms, usernames, film summaries, nominations, voting credentials and votes exist only in server/browser memory. Each room expires **two minutes after creation**, including joining and collection time; activity never extends it. Ending the room or leaving/navigating away destroys it for everyone and aborts active collection. Browser crashes or network loss may prevent the leave signal; the fixed server expiry still applies. Reloading does not restore membership. Restarting the server clears every room.

The random invitation ID appears only in the URL fragment and grants permission to join the lobby, not to read member data or vote. Each joining browser receives a separate private voting key held only in page memory. Do not add room persistence, recovery, cookies or browser storage. Room identifiers are temporary capabilities, not saved lookup history. Anyone with the invitation can join before collection starts; usernames are permission-confirmed, not verified Letterboxd logins.

The local server binds to localhost; separate browser sessions on this computer can join. Friends on other devices need the Cloudflare deployment above. Check the Cloudflare account for Logpush or other account-level logging before inviting real users.

## Tests

```sh
npm test
node scripts/test-live.mjs dave
node scripts/test-live.mjs davidehrlich
node scripts/test-night-live.mjs dave davidehrlich
```

Fixture tests cover the RSS-only website, the separate extended parser, empty/unavailable/private/blocked responses, invalid feeds, coverage, exact request scope, pacing, cancellation, clearing, expiry, no storage/download features, responsive rendering, process disposal and natural process exit after repeated browser sessions.

Live checks run sequentially, save no account data or artifacts, and output only an exit status. Zero means the declared-scope flow passed. Nonzero stops a batch: 1 is a UI/contract/transport failure, 2 is a correctly handled upstream block, 3 is an RSS failure, and 6 is a lifecycle failure. Extended fixture checks also use source codes 4–5 and 7–9. Blocked/unavailable screens are inspected before returning their nonzero outcome. They are not counted as successful data collection.

Synthetic movie-night tests cover two and six isolated participants, simultaneous joins/votes, duplicate-join recovery, shared graph edges, nomination limits, changing votes, ties, authorization, the shared collector lock, empty/blocked/unavailable feeds, expiry across all six views and during unfinished collection, cancellation and lock release, delayed-response protection, navigation, storage absence and responsive layouts. The movie-night live script uses a separate nonpersistent browser context for each of 2–6 distinct usernames. It exercises concurrent joining, RSS collection, nominations, simultaneous voting, vote changes and clearing without output or artifacts. Add `--expire` to wait for the real fixed two-minute expiry and verify all sessions clear and stale votes are rejected. Exit codes: 0 pass, 2 upstream block, 3 unavailable feed, 6 cleanup failure, 10 joining failure, 11 loading failure, 12 voting failure, 13 expiry failure, 14 clearing failure. A handled upstream failure never counts as a complete six-feed run.

No prediction model or streaming results UI is implemented.
