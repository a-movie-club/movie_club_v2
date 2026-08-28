# Research: Does the TMDB key need proxying, and is a Supabase Edge Function the right home?

Resolves [#4](https://github.com/Foifoif/movie_club_v2/issues/4). Part of the map, [#1](https://github.com/Foifoif/movie_club_v2/issues/1).

**Date:** 2026-08-28
**Ground truth:** v1 source at `../movie-club` @ `js/config.js`, `js/components.js`, `js/pages.js`, `js/db.js`; plus live probes against the TMDB API run on the date above.

---

## TL;DR

**Don't proxy.** Call TMDB directly from the browser with a rotated v3 key, exactly as v1 does.

The premise the map was chartered on — "the TMDB key is one of the two operations needing a secret" — does not survive contact with the primary sources. Three findings, in order of force:

1. **TMDB staff explicitly bless client-side keys.** Travis Bell (TMDB founder, STAFF badge): *"Putting it client side is fine."*
2. **TMDB rate-limits per IP, not per key.** A proxy therefore *concentrates* all club traffic onto shared Supabase egress IPs. It makes the stated risk **worse**, not better.
3. **TMDB serves `access-control-allow-origin: *` and `cache-control: public, max-age≈7h`** on search responses. The API is engineered for direct browser calls, and browsers cache those calls for hours. A naive proxy throws that caching away.

Cold starts and free-tier invocation limits both turn out to be **non-issues** — they are not the reason to decline. I want to be clear about that, because it is tempting to reject the proxy for the wrong reason. Supabase's current cold-start numbers are fine for a typeahead, and the free quota is ~1000x our need. The proxy should be declined because it is **actively counterproductive**, not because it is too slow or too expensive.

This contradicts a "settled at charting" row in map #1. Raised explicitly in [§8](#8-contradiction-with-the-charted-decision), per the map's own instruction.

---

## 1. The call sites

The ticket says 7. **I find 8 distinct `fetch()` calls** to `api.themoviedb.org` in v1:

```
$ grep -rn "api\.themoviedb\.org" js/ | wc -l
8
```

The discrepancy is almost certainly that `components.js:519` and `:524` are the two branches of a single `if/else` inside one function (`MovieSearch.fetchResults`) — one logical call site, two lines. I list them separately below and mark them as a pair.

`config.js:55` is a helper (`fetchTrailerUrl`) with three call sites of its own; I classify the helper by its callers.

### The table

| # | Location | Endpoint | Trigger | Path | Needs live TMDB in v2? |
|---|---|---|---|---|---|
| 1 | `js/components.js:519` | `/3/search/multi` | Typeahead, `multi` mode, keystroke (400ms debounce) | **WRITE** — admin adding a movie | **Yes** |
| 2 | `js/components.js:524` | `/3/search/movie` | Typeahead, movie mode, keystroke (400ms debounce) | **WRITE** — admin adding a movie | **Yes** |
| 3 | `js/components.js:578` | `/3/movie/{id}/watch/providers` | Admin clicks a search result | **WRITE** — result persisted to `movies.streaming` | **Yes** |
| 4 | `js/config.js:55` (`fetchTrailerUrl`) | `/3/movie/{id}/videos` | Called from `components.js:579`, `pages.js:1945-46`, `pages.js:2243` — **all three are admin write flows** | **WRITE** — result persisted to `movies.trailer_url` | **Yes** |
| 5 | `js/pages.js:789` | `/3/search/movie` | Bracket page render, when `matchup.aDesc` is missing | **READ** — public page load | **No** — see §5 |
| 6 | `js/pages.js:1654` | `/3/search/movie` | User expands a watchlist row | **READ** — public interaction | **No** — see §5 |
| 7 | `js/pages.js:1662` | `/3/movie/{id}/watch/providers` | Same watchlist expand | **READ** — public interaction | **No** — see §5 |
| 8 | `js/pages.js:2235` | `/3/search/movie` | Admin "fetch missing trailers" backfill button | **WRITE** — result persisted via `sb.from('movies').update(...)` | **Yes** |

**5 write-path, 3 read-path.** And all 3 read-path calls are removable by schema — see §5.

---

## 2. Does the v3 key actually need to be secret?

### 2.1 TMDB's own terms say nothing about it

I read the full [API Terms of Use](https://www.themoviedb.org/api-terms-of-use) looking specifically for a confidentiality clause. There is **none**:

- No clause requiring the API key be kept secret or confidential.
- No clause addressing embedding the key in a client application.
- The only nearby language is generic account hygiene — *"You are responsible for maintaining the confidentiality of your account, username/user id, and password"* — which is about the TMDB **account**, not the API key.

What the terms *do* require, and what v2 must honour regardless of the proxy decision:

- **Attribution:** *"You must use the TMDB logo to identify Your use of TMDB, the TMDB APIs, or TMDB Content"*, plus the disclaimer *"This [website...] uses TMDB and the TMDB APIs but is not endorsed, certified, or otherwise approved by TMDB."*
- **Cache ceiling:** you may not *"Cache, for longer than 6 months, any information obtained through or from TMDB or the TMDB APIs."* Relevant to us — v1 denormalises `description`, `poster`, `streaming`, `trailer_url` onto the `movies` row permanently. **That is arguably a terms violation** and is worth a follow-up ticket independent of this one.
- **Non-commercial only**, absent a separate written agreement. Fine — hobby site.

Source: <https://www.themoviedb.org/api-terms-of-use>

### 2.2 TMDB staff say client-side is fine — verbatim

From the "Api Key Security in JavaScript" thread, **Travis Bell (STAFF badge, TMDB founder)**:

> "Putting it client side is fine. I've seen lots of apps that do this. There isn't a ton of motivation to steal keys since our service is free. Anyone can sign up and grab their own."

Source: <https://www.themoviedb.org/talk/5b6b0e08925141406a1134de>

And in an older thread on API key security, the same staff member:

> "In my opinion, it's all about how much you're doing with the API. For some basic film retrieval stuff do whatever is easiest."

> "The only thing to remember is to properly set the users request IP and pass that through to the request your server makes."

Source: <https://www.themoviedb.org/talk/52c61af419c2952ac805bc31>

That second quote is the crux of this whole ticket. Read §3.

**Caveat on source quality:** these are forum posts, not documentation. They are first-party (TMDB's own site, staff badge, the founder) but they are not a documented policy and TMDB is free to contradict them. I weight them as strong evidence of TMDB's *position*, not as a guarantee.

### 2.3 The key is read-only in the way that matters

The v3 `api_key` alone **cannot** mutate anything. TMDB's user-write actions require an additional `session_id`:

> "User authentication is controlled with a `session_id` query parameter."

...which enables *"rate movies, maintain their favourite and watch lists as well as do things like create and edit custom lists."* A `session_id` is only obtainable through a request-token flow the account owner must approve. Confirmed against the `movie-add-rating` endpoint reference, which takes `session_id` / `guest_session_id` in addition to auth.

Sources: <https://developer.themoviedb.org/docs/authentication-user>, <https://developer.themoviedb.org/reference/movie-add-rating>

Worth noting the docs also state the v3 key and the v4 bearer token are equivalent in power — *"Both authentication methods provide the same level of access"* — so switching to a v4 token buys **no** security benefit, only a header instead of a query param. (<https://developer.themoviedb.org/docs/authentication-application>)

**So: exposure is not a data-leak vector and not an account-takeover vector.** The ticket's framing is right. The only vector is quota.

### 2.4 ...and the quota vector is per-IP, so it barely exists

See §3. But also: the remediation for a leaked key is 30 seconds of clicking, not an architecture.

**Travis Bell (STAFF)**, on a request to revoke an exposed key:

> "You can do this yourself by going to your API settings page and clicking the 'regenerate key' link."

Source: <https://www.themoviedb.org/talk/6825023d752abbbbf85a3944> (settings page: <https://www.themoviedb.org/settings/api>)

**Live probe — the v1 key is still active today:**

```
$ curl -s -o /dev/null -w "%{http_code}" \
    "https://api.themoviedb.org/3/search/movie?api_key=aeb55fbb...&query=heat"
200
```

It has been public in a public repo for the life of v1 and has not been abused into invalidation. That is weak evidence (absence of harm ≠ absence of risk), but it is *some* evidence about the real-world threat level for a key of this kind.

---

## 3. The finding that decides it: rate limiting is per-IP

This is the load-bearing fact and it inverts the ticket's premise.

**TMDB's rate-limiting doc** is vague and explicitly disclaims precision:

> Legacy rate limits were disabled as of **December 16, 2019**. Current upper limits exist to prevent excessive scraping, described as *"somewhere in the 40 requests per second range,"* and this *"could change at any time."*

The doc does **not** state whether the limit keys on the API key or the IP. Source: <https://developer.themoviedb.org/docs/rate-limiting>

**Travis Bell (STAFF)** supplies the missing detail:

> "50 requests per second and 20 connections per IP."

> "The original rate limiting (40 requests every 10 seconds) has indeed been disabled since December 2019."

Source: <https://www.themoviedb.org/talk/6558fa627f054018d5168d91>

### Why this kills the proxy

The ticket's stated motivation is: *"an exposed key is a denial-of-service vector against our own quota."* That motivation assumes a **per-key** quota. The evidence says the enforced limit is **per-IP** — 20 connections and ~40-50 req/s per IP.

Consequences:

- **Direct-from-browser:** each club member's requests come from their own residential IP. Each user independently has the entire 50 req/s budget. Our aggregate ceiling is effectively unbounded at 3-10 users. An attacker who steals the key gets rate-limited on *their own* IP, and does not consume anything of ours.
- **Behind an Edge Function proxy:** every request from every user collapses onto Supabase's egress IPs — which we do not control and which are **shared with other Supabase projects**. We would be pooling our traffic into a bucket alongside strangers, against a per-IP limit.

Travis Bell's warning to server-side integrators is exactly this failure mode: *"The only thing to remember is to properly set the users request IP and pass that through to the request your server makes."*

**A proxy is the configuration that creates the risk the proxy was proposed to mitigate.** That is the recommendation in one sentence.

**Unverified:** I could not confirm from primary sources whether TMDB honours `X-Forwarded-For` for rate-limit attribution, nor what Supabase's Edge Function egress IP allocation actually is (whether stable, shared, or per-project). Both would need testing before anyone overrides this recommendation. Flagged in §9.

---

## 4. Live probes: TMDB is built for the browser

Run 2026-08-28.

### CORS is fully open

```
$ curl -s -D - -o /dev/null -H "Origin: https://amovieclub.com" \
    "https://api.themoviedb.org/3/search/movie?api_key=...&query=heat"
HTTP/2 200
cache-control: public, max-age=25835
vary: Accept-Encoding
access-control-allow-origin: *
access-control-expose-headers: *
```

```
$ curl -s -X OPTIONS -D - -o /dev/null -H "Origin: https://amovieclub.com" \
    -H "Access-Control-Request-Method: GET" \
    "https://api.themoviedb.org/3/search/movie"
HTTP/2 200
access-control-allow-origin: *
access-control-allow-methods: GET,HEAD,PUT,POST,DELETE,OPTIONS
access-control-max-age: 600
```

`access-control-allow-origin: *` on a wildcard, with a working preflight, is a deliberate engineering decision to support direct browser consumption. This is not an API that wants to be proxied.

### Search responses are long-cacheable — and a proxy would discard that

`cache-control: public, max-age=25835` — roughly **7 hours**, on a search response. (A second sample returned `max-age=22486`, ~6.2h; the value appears to be a countdown to a fixed expiry.)

This matters more than it looks. The browser HTTP cache serves repeat typeahead queries for free — no network, no quota, no latency. An Edge Function proxy only preserves this if it deliberately forwards TMDB's cache headers, which the naive implementation does not. **The naive proxy increases total TMDB request volume** by turning cached browser hits into cache-missing origin hits.

### Latency baseline

```
sample 1: total=0.048s
sample 2: total=0.069s
sample 3: total=0.050s
```

**~50-70ms direct.** That is the number any proxy has to beat, or at least not embarrass. Hold onto it for §6.

---

## 5. Which call sites even need to be live — the read paths are removable

### v1 already persists everything the read path needs

Confirmed in `js/db.js`. `rowToMovie` (`db.js:4-20`) reads straight off the row:

```js
description: row.description,
poster: row.poster,
streaming: Array.isArray(row.streaming) ? row.streaming : [],
tmdbId: row.tmdb_id || null,
trailerUrl: row.trailer_url || null,
```

and `dbSaveMovies` (`db.js:88-100`) / `dbAddHistoryMovie` (`db.js:311-325`) write all five at **write time**.

Every read-side consumer — `TrailerButton` at `components.js:189`, and its uses at `components.js:247/284/355` and `pages.js:383/605/948/951` — renders `movie.trailerUrl` **from the database row**. Posters likewise.

**Confirmed: the ticket's hypothesis is correct.** Trailer and poster lookup is already a write-time concern in v1. No public page load makes a TMDB call to render a movie.

### So why do 3 read-path calls exist at all?

Because of two v1 schema defects, both of which map #1's core invariant already outlaws.

**Sites 6 and 7 (`pages.js:1654`, `:1662`) — the watchlist.** The `watchlist` table (schema comment at `db.js:378-390`) is:

```sql
create table watchlist (
  id bigint ..., member_name text not null, title text not null,
  year int, poster text, urgency text not null default 'want',
  watched boolean not null default false, added_at timestamptz ...
);
```

`title` is a bare string. There is **no** `description` column, **no** `streaming` column, and **no** foreign key to `movies`. So expanding a watchlist row has to go re-find the film on TMDB by title text and fetch its overview and providers live. These two calls exist purely because the watchlist doesn't reference the film catalog.

**Site 5 (`pages.js:789`) — the bracket.** The bracket stores `aDesc`/`bDesc` inside its `jsonb` blob at creation time (`pages.js:706`, `:708`). The fetch at `:789` is a **backfill** guarded by `if (!m.aDesc && m.a)` — it only fires for legacy brackets created before descriptions were captured. Same root cause: the bracket holds title strings, not `movie_id`s.

### The v2 architecture deletes all three by construction

Map #1, settled at charting:

> **`movies` is the canonical film catalog — one row per film, ever.** Every movie feature references `movie_id`; nothing ever copies `title`/`year`/`poster` into another table.

A watchlist row that is `(member_id, movie_id, urgency, watched)` joins to `movies` for description, poster and providers. A bracket that references `movie_id` does the same. **All three read-path TMDB calls disappear — not because we proxied them, but because the schema stopped losing the reference.**

**Therefore: in v2, zero TMDB calls occur on any public read path.** Every remaining call site (1, 2, 3, 4, 8) is behind admin auth, in a write flow, at a human's manual pace.

This is the single most important structural finding in this document, and it is worth noting that it shrinks the problem *before* the proxy question is even asked.

---

## 6. If we did proxy: is an Edge Function acceptable for a typeahead?

Answer: **yes, on current numbers** — cold start is no longer a good reason to say no. I'm reporting this against my own recommendation because the ticket asked, and because a wrong reason for a right decision will get us in trouble later.

### Cold start: much better than its reputation

Supabase's docs are hand-wavy — *"Even initial executions are fast (milliseconds)"*, and isolates *"can remain active for a period (plan-dependent)"* with no number given (<https://supabase.com/docs/guides/functions/architecture>).

The first-party engineering posts have real figures:

**"Edge Functions are now 2x smaller and boot 3x faster"** (2024-09-12) — boot time, before → after:

| Workload | Before | After |
|---|---|---|
| supabase-js | 275ms | **25ms** |
| OpenAI | 459ms | **57ms** |
| Drizzle / node-postgres | 301ms | **83ms** |

Source: <https://supabase.com/blog/edge-functions-faster-smaller>

**"Persistent Storage and 97% Faster Cold Starts"** (2025-07-18):

| Metric | Before | After |
|---|---|---|
| Average boot | 870ms | **42ms** |
| P95 | 8,502ms | **86ms** |
| P99 | 15,069ms | **460ms** |
| Worst case | 24,300ms | 1,630ms |
| Boots >1s | 47% | **4%** |

Root cause of the fix: workers still doing initial script evaluation were moved *"onto a dedicated blocking pool"*, so one worker's heavy init no longer blocks the shared Tokio thread pool.

Source: <https://supabase.com/blog/persistent-storage-for-faster-edge-functions>

### Verdict on typeahead specifically

A TMDB proxy is a bare `fetch` passthrough with **zero npm dependencies** — the lightest possible function, at the favourable end of those benchmarks. Expect boot at or below the 42ms average.

But the honest accounting is additive:

- **Direct:** ~50-70ms (measured, §4).
- **Proxied, warm:** browser → Supabase edge → TMDB → back. Roughly 2x the round trips, so ~100-150ms.
- **Proxied, cold:** add ~42ms typical, ~460ms at P99.

And v1 **already debounces at 400ms** (`components.js` `handleInput`, `setTimeout(..., 400)`) — it is *not* per-keystroke. So the ticket's worry ("per-keystroke search could be badly affected") is doubly mitigated: the debounce means few requests, and cold starts are now small relative to the debounce window.

**A P99 of 460ms on a request the user already waited 400ms to trigger is perceptible but not broken.** Cold start is a real cost, roughly a doubling of typeahead latency, but it is not disqualifying. The disqualifying argument is §3.

### Free-plan runtime limits (all comfortably fine)

| Limit | Free plan |
|---|---|
| Max memory | 256MB |
| Wall clock / worker active time | 150s (400s paid) |
| Max CPU time per request | 2s (excl. async I/O) |
| Request idle timeout | 150s → 504 |
| Functions per project | 100 |

Source: <https://supabase.com/docs/guides/functions/limits>

---

## 7. Free-tier invocation limits — not a constraint either

| Plan | Included invocations | Overage |
|---|---|---|
| **Free** | **500,000 / month** | — (grace period, not billed) |
| Pro | 2,000,000 / month | $2 per 1M |

Sources: <https://supabase.com/docs/guides/functions/pricing>, <https://supabase.com/docs/guides/platform/manage-your-usage/edge-function-invocations>

Billing details that matter:

> "You are charged for the number of times your functions get invoked, regardless of the response status code. **Preflight (OPTIONS) requests are not billed.**"

That last clause is a real relief for a browser-called function — CORS preflights are free.

On exceeding the Free quota: the org gets an email and enters a **grace period**, governed by the Fair Use Policy. The docs do **not** state plainly whether the outcome is throttling or disablement. *(Unverified — flagged in §9.)*

### The arithmetic

Post-§5, only admin write flows would proxy. Per movie added: ~4-6 debounced typeahead requests + 1 `watch/providers` + 1 `videos` ≈ **7 invocations**.

| Scenario | Invocations / month | % of 500k free quota |
|---|---|---|
| 4 movies added/month (realistic) | ~28 | 0.006% |
| 50 movies added/month (heavy) | ~350 | 0.07% |
| Every read path proxied too, 10 users browsing hard | ~2,000 | 0.4% |

We are **three orders of magnitude** below the free quota under every scenario, including scenarios we've already argued away. Egress is equally irrelevant: Free includes 5GB and TMDB JSON responses are single-digit KB (<https://supabase.com/docs/guides/platform/manage-your-usage/egress>).

**Search-as-you-type would not come close to blowing through the free tier.** Cost is not an argument in either direction. Anyone reasoning from "invocations are expensive" is reasoning from a false premise.

### One genuine free-tier hazard, though not proxy-specific

Free-plan projects are **paused after 7 days of low activity**, restorable for 90 days (<https://supabase.com/docs/guides/platform/free-project-pausing>). A paused project takes its Edge Functions down with it. But v2's database is on the same project, so a pause takes the whole site down regardless — this is **not** a differentiator between proxying and not, and shouldn't be scored against the proxy. It is, separately, a real operational risk worth its own ticket.

---

## 8. Do `image.tmdb.org` URLs need proxying?

**No. Definitively not, and proxying them would be actively harmful.**

Live probe, **no authentication of any kind**:

```
$ curl -s -o /dev/null -w "status=%{http_code} type=%{content_type} size=%{size_download}" \
    "https://image.tmdb.org/t/p/w500/1E5baAaEse26fej7uHcjOgEE2t2.jpg"
status=200 type=image/jpeg size=124727

$ curl -sI "https://image.tmdb.org/t/p/w500/1E5baAaEse26fej7uHcjOgEE2t2.jpg"
HTTP/2 200
content-type: image/jpeg
server: BunnyCDN-IL1-1068
cache-control: public, max-age=31919000
cdn-edgestorageid: 1069
```

Three reasons, in order:

1. **There is no key to protect.** The image CDN takes no `api_key` and no auth header. The URL is the whole credential, and it's a public path. Proxying would be hiding a secret that does not exist.
2. **It's a third-party CDN.** `server: BunnyCDN` — TMDB fronts images with BunnyCDN's global edge network. Routing posters through a Supabase Edge Function would replace a purpose-built image CDN with a single-region JS runtime. Strictly worse latency.
3. **`max-age=31919000` is ~369 days.** Posters are immutable, cached for a year by the browser. A proxy in front of that is pure loss — and would count every poster against our 5GB Supabase egress quota for no benefit whatsoever.

The URL construction is just `base_url` + `file_size` + `file_path`, per <https://developer.themoviedb.org/docs/image-basics>. v1 hardcodes `https://image.tmdb.org/t/p/w92` and `w500` (`components.js:571`, `:584`, `:612`) rather than reading `base_url` from `/configuration` — technically fragile if TMDB ever moves the CDN, but not a proxy concern.

**Ship image URLs straight to `<img src>`, as v1 does.**

---

## 9. Contradiction with the charted decision

Map #1 lists under "Settled at charting":

> | Server-side | **Supabase Edge Functions only**, for the two operations needing a secret (TMDB proxy, admin invite). No separate server host. |

**This research contradicts the "TMDB proxy" half of that row.** Raising it explicitly, as the map instructs, rather than quietly diverging.

To be precise about the scope of the disagreement:

- The **admin invite** function is untouched by this research. It genuinely needs a secret (a Supabase service-role key) and genuinely must not be in the client. That half of the row stands.
- The **TMDB proxy** half rests on the premise that the TMDB key is a secret. §2 shows TMDB's terms impose no confidentiality obligation and TMDB staff explicitly endorse client-side use; §3 shows the quota risk is per-IP and a proxy makes it worse.

If the row is amended, the "Server-side" decision becomes **Supabase Edge Functions for one operation (admin invite)** — which, notably, does not change the *stack*, only the surface area. No other charted decision depends on the TMDB proxy existing.

### On Vite and `VITE_` variables

Vite's docs warn:

> "`VITE_*` variables should *not* contain sensitive information such as API keys. The values of these variables are bundled into your source code at build time."

Source: <https://vite.dev/guide/env-and-mode>

This will read as an argument for proxying. It isn't, quite — the warning is about *sensitive* values, and §2 establishes the TMDB key is not one. But the tension is real enough that it should be handled deliberately rather than ignored: a `VITE_TMDB_API_KEY` in the bundle is *fine*, and the reason it's fine should be written down next to it, or a future agent will "fix" it by adding the proxy this document argues against. See the recommendation below.

---

## 10. Recommendation

### Don't proxy. Zero of the 8 call sites go through an Edge Function.

| # | Call site | Path | Disposition in v2 |
|---|---|---|---|
| 1 | `components.js:519` — `/search/multi` | WRITE | **Direct from browser.** Admin-only typeahead. |
| 2 | `components.js:524` — `/search/movie` | WRITE | **Direct from browser.** Admin-only typeahead. |
| 3 | `components.js:578` — `/watch/providers` | WRITE | **Direct from browser.** Persist to `movies`. |
| 4 | `config.js:55` — `/movie/{id}/videos` | WRITE | **Direct from browser.** Persist to `movies.trailer_url`. |
| 5 | `pages.js:789` — `/search/movie` (bracket desc) | READ | **Deleted.** Bracket references `movie_id`; join for description. |
| 6 | `pages.js:1654` — `/search/movie` (watchlist desc) | READ | **Deleted.** Watchlist references `movie_id`; join for description. |
| 7 | `pages.js:1662` — `/watch/providers` (watchlist) | READ | **Deleted.** Same join. |
| 8 | `pages.js:2235` — `/search/movie` (trailer backfill) | WRITE | **Direct**, or drop entirely — it's a one-off migration tool, better as a script than a UI button. |
| — | `image.tmdb.org` (`components.js:571/584/612`) | READ | **Direct `<img src>`.** Never proxy. §8. |

**Net: 5 direct browser calls, all behind admin auth. 3 calls deleted by schema. 0 Edge Functions.**

### Actions

1. **Rotate the v1 key** at <https://www.themoviedb.org/settings/api>. It is live and public today (§2.4). This is the actual remediation, and it is the one thing in this document that should happen regardless of every other decision. It's independent of v2 — do it for v1 now.
2. **Put the new key in `VITE_TMDB_API_KEY`**, and write a comment next to it explaining *why* a public key is correct here, citing §2 and §3. Without that comment a future agent will read Vite's warning and add the proxy.
3. **Amend the map #1 "Server-side" row** to reference the admin invite only.
4. **Gate the typeahead UI behind the `admin` role.** With no read-path calls, the key is only exercised by admins — which also means an attacker has to be *served* the bundle containing it, a small extra friction that costs nothing.
5. **Keep the 400ms debounce.** It is doing real work and should survive the rewrite.
6. **Follow-up ticket — TMDB 6-month cache ceiling.** v1 stores `description`/`poster`/`streaming`/`trailer_url` indefinitely. The terms cap caching at 6 months (§2.1). Needs a decision: refresh policy, or accept the risk knowingly. Genuinely out of scope here but should not be lost.
7. **Follow-up ticket — free-project pausing** (§7). Not proxy-related; real.

### What would change this answer

I'd revisit if any of these turn out true:

- TMDB documents a **per-key** quota (rather than per-IP), making key theft actually costly to us.
- We need a TMDB endpoint requiring a `session_id` — that credential *is* a real secret and must be server-side.
- The site goes commercial, requiring a licensed key with contractual protection obligations.

---

## 11. What I could NOT verify

Stated plainly, because these are the seams where this recommendation could be wrong:

1. **Whether the ~50 req/s limit is enforced per-IP or per-key.** The rate-limiting doc does not say. The per-IP figure is a **staff forum post** (Travis Bell), not documentation — and his exact phrasing, *"50 requests per second and 20 connections per IP,"* is grammatically ambiguous about whether "per IP" governs both clauses or only the connection count. **This is the weakest link in the argument**, and §3 is the strongest argument. Worth a deliberate test before anyone relies on it heavily.
2. **Whether TMDB honours `X-Forwarded-For`** for rate-limit attribution from a proxy. Travis Bell advises forwarding the user's IP; nothing documents whether TMDB acts on it.
3. **Supabase Edge Function egress IP behaviour** — whether egress IPs are shared across projects, stable, or per-project. My §3 claim that a proxy pools our traffic with strangers' assumes shared egress. Not documented; not tested.
4. **Exact consequence of exceeding the Free invocation quota.** Docs say "grace period" and defer to the Fair Use Policy without stating whether the end state is throttling or disablement. Moot at 0.07% utilisation, but unverified.
5. **How long a Supabase isolate stays warm.** Docs say only *"a period (plan-dependent)"* with no number, and give no Free-plan figure. This determines how *often* a typeahead would eat a cold start, which is the difference between "fine" and "annoying" in §6.
6. **Cold-start figures are Supabase's own benchmarks**, not independent measurement, and not measured from our users' geography. I did not stand up a function and measure it. If the proxy decision is ever revisited, measure it rather than trusting §6.
7. **Whether the club's use is definitely non-commercial** under TMDB's definition (*"primary purpose is to create revenue for the benefit of the owner"*). Near-certainly yes for a private hobby site, but I did not find a bright-line test.

---

## Sources

All accessed 2026-08-28.

**TMDB — official documentation**
- API Terms of Use — <https://www.themoviedb.org/api-terms-of-use>
- Rate Limiting — <https://developer.themoviedb.org/docs/rate-limiting>
- Application Authentication (v3 key vs v4 bearer) — <https://developer.themoviedb.org/docs/authentication-application>
- User Authentication (`session_id`) — <https://developer.themoviedb.org/docs/authentication-user>
- Movie Add Rating reference — <https://developer.themoviedb.org/reference/movie-add-rating>
- Image Basics — <https://developer.themoviedb.org/docs/image-basics>
- API settings / key regeneration — <https://www.themoviedb.org/settings/api>

**TMDB — first-party staff statements (forum, STAFF badge; weaker than docs)**
- "Api Key Security in JavaScript" — Travis Bell on client-side keys — <https://www.themoviedb.org/talk/5b6b0e08925141406a1134de>
- "API Key Security" — Travis Bell on forwarding user IP — <https://www.themoviedb.org/talk/52c61af419c2952ac805bc31>
- "Rate Limit" — Travis Bell, 50 req/s and 20 connections per IP — <https://www.themoviedb.org/talk/6558fa627f054018d5168d91>
- "Request to Revoke and Regenerate API Key" — Travis Bell on self-service regeneration — <https://www.themoviedb.org/talk/6825023d752abbbbf85a3944>

**Supabase — official documentation**
- Edge Functions Pricing — <https://supabase.com/docs/guides/functions/pricing>
- Manage Edge Function Invocations usage — <https://supabase.com/docs/guides/platform/manage-your-usage/edge-function-invocations>
- Edge Functions Limits — <https://supabase.com/docs/guides/functions/limits>
- Edge Functions Architecture — <https://supabase.com/docs/guides/functions/architecture>
- Manage Egress usage — <https://supabase.com/docs/guides/platform/manage-your-usage/egress>
- Free Project Pausing — <https://supabase.com/docs/guides/platform/free-project-pausing>

**Supabase — first-party engineering posts (benchmarks are vendor-run)**
- "Edge Functions are now 2x smaller and boot 3x faster" (2024-09-12) — <https://supabase.com/blog/edge-functions-faster-smaller>
- "Persistent Storage and 97% Faster Cold Starts for Edge Functions" (2025-07-18) — <https://supabase.com/blog/persistent-storage-for-faster-edge-functions>

**Vite**
- Env Variables and Modes — <https://vite.dev/guide/env-and-mode>

**v1 codebase (`../movie-club`)**
- `js/config.js:36` (key), `:52-60` (`fetchTrailerUrl`)
- `js/components.js:519`, `:524`, `:578`; `:571`, `:584`, `:612` (image URLs); `handleInput` 400ms debounce
- `js/pages.js:789`, `:1654`, `:1662`, `:2235`; `:706`, `:708` (bracket desc at write time)
- `js/db.js:4-20` (`rowToMovie`), `:88-100` (`dbSaveMovies`), `:311-325` (`dbAddHistoryMovie`), `:378-390` (watchlist schema)

**Live probes** — `curl` against `api.themoviedb.org` and `image.tmdb.org`, 2026-08-28, transcribed inline in §2.4, §4 and §8.
