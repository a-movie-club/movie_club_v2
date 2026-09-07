---
status: accepted
---

# The v2 schema: movies as the canonical catalog

v1's schema had no concept of the thing the club actually organises around — a
month, its theme, and the two films shown under it — so club data was smeared
across the `movies` table and a positional array in client source. v2 makes the
**Session** first-class, reduces `movies` to a pure film catalog with one row
per film ever, and derives everything that v1 stored redundantly. Five tables,
no enums, one view.

Resolves map ticket
[Schema redesign: movies as the canonical catalog](https://github.com/Foifoif/movie_club_v2/issues/8).
Vocabulary in [`CONTEXT.md`](../../CONTEXT.md).

## The schema

```sql
-- ─── movies ─────────────────────────────────────────────────────────────────
-- The canonical film catalog: one row per film, ever. Film facts only.
-- May hold films the club has never shown (watchlist, search).
create table v2.movies (
  id           bigint primary key generated always as identity,
  tmdb_id      integer unique,
  title        text not null,
  release_date date,
  description  text,
  poster_path  text,
  trailer_url  text,

  -- Deliberate exception: club flavour on the catalog. See "Consequences".
  rating_unit  text,

  search       tsvector generated always as (
                 to_tsvector('english', title || ' ' || coalesce(description, ''))
               ) stored,

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index movies_search_idx on v2.movies using gin (search);

-- ─── members ────────────────────────────────────────────────────────────────
-- A profile over auth.users. Every member logs in; there are no name-only
-- members. `id` IS the auth user id, so member_id and user_id never diverge.
create table v2.members (
  id           uuid primary key references auth.users(id) on delete restrict,
  display_name text not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- ─── sessions ───────────────────────────────────────────────────────────────
-- One club month. Upcoming/current/past is derived from `month` vs today —
-- there is no status column and no "is_current" flag.
create table v2.sessions (
  id         bigint primary key generated always as identity,
  month      date not null unique,     -- always the 1st; the natural key
  theme      text,                     -- nullable: scheduled before chosen
  trivia     text,
  meeting_at timestamptz,              -- may fall outside `month`
  join_url   text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint sessions_month_is_first_of_month
    check (extract(day from month) = 1)
);

-- ─── session_movies ─────────────────────────────────────────────────────────
-- Which films a session showed. Both FKs are in the primary key, which is what
-- makes PostgREST detect this as a many-to-many junction (see "Considered").
create table v2.session_movies (
  session_id bigint   not null references v2.sessions(id) on delete cascade,
  movie_id   bigint   not null references v2.movies(id)   on delete restrict,
  position   smallint not null,        -- stable display order only; siblings
  primary key (session_id, movie_id),
  unique (session_id, position)
);

-- ─── ratings ────────────────────────────────────────────────────────────────
-- One score per member per film, revisable. Attached to the Movie, not to a
-- showing: a rewatch does not create a second rating.
create table v2.ratings (
  member_id  uuid    not null references v2.members(id) on delete cascade,
  movie_id   bigint  not null references v2.movies(id)  on delete cascade,
  score      numeric(3,2) not null check (score >= 0 and score <= 5),
  rated_at   timestamptz not null default now(),  -- set on insert, NEVER on update
  updated_at timestamptz not null default now(),
  primary key (member_id, movie_id)
);

-- ─── derived ────────────────────────────────────────────────────────────────
-- avg_score is not stored. The all-time ranking reads this view so that
-- sort-and-paginate-by-score stays server-side.
create view v2.movie_scores as
  select movie_id,
         avg(score)::numeric(3,2) as avg_score,
         count(*)                 as rating_count
    from v2.ratings
   group by movie_id;
```

**No enums.** The ticket asked which enums v2 needs; the answer is none. Every
candidate dissolved — `movie_type` was a UI artifact, session status is derived
from the calendar, and `watchlist.urgency` belongs to a feature that is out of
scope.

## What this kills, and why

| v1 | Fate |
|---|---|
| `HISTORY_META` (client array, joined by insertion order) | Becomes `sessions` rows + `session_movies`. |
| per-movie *motif* (`Eggs`, `Yellow Cab`) | Dropped — no value, rendered poorly. |
| `movies.accent` (hex colour encoding `movie_type`) | Dropped. |
| `movies.movie_type` (`official`/`impromptu`) | Dropped. It never described a showing — it existed so a member could rate a film outside that month's session. Now answerable as a query: films rated in a month, joined against that month's `session_movies`. |
| `movies.avg_score` | Derived — `v2.movie_scores`. |
| `movies.archived` | Dropped. A catalog has no lifecycle; the *session* does, and it's derived. |
| `movies.session_theme`, `movies.shown_month` | Move to `sessions`. |
| `movies.streaming` | Dropped from the table. Volatile, and there is no server-side job to refresh it; fetched live from TMDB, which #4 already put in the browser. |
| `movies.rating_scale` | Kept as `rating_unit`, renamed. It is the club's name for the unit ("out of 5 yellow cabs"), not a scale — v1 also abused it as a theme fallback, which stops. |
| `monthly_events` | Renamed `sessions`. `movie_id_1`/`movie_id_2` become `session_movies`. |
| `monthly_events.is_current` | Dropped. `unique (month)` plus calendar math replaces it, removing an update that cleared the flag on every other row. |
| `settings.movie_night_join_url` | Dropped as a table. The real value already lived on the event and is now `sessions.join_url`; the settings key was only an admin-form prefill, which can read the previous session. |
| `settings.movie_night_override` | Dropped as legacy. |
| `members.sort_order` | Dropped. Only ever ordered one query, and was rewritten from array position on every member edit. Order by `display_name`. |
| `ratings.member_name` (text join) | Becomes `member_id uuid`. Renaming a member no longer orphans their ratings. |
| scores as float | `numeric(3,2)`, `check (score between 0 and 5)`. A 0–10 scale existed at some point and does not survive. Real data includes `3.3`, `4.25` and `4.99`, so this is neither integers nor half-stars. |

## Considered options

**Two FK columns (`movie_id_1`, `movie_id_2`) instead of `session_movies`.**
Preferred initially as lighter for a hobby app, with a plan to migrate to a
join table if a third film ever happened. Rejected on a PostgREST fact: two FKs
between the same pair of tables are ambiguous in *both* directions
(`PGRST201`), so every session read needs a `movies!movie_id_1` hint, and
"which sessions featured this movie" can only come back as **two separate
arrays** the client merges by hand — there is no documented OR-across-two-FKs
embed. That query is the roadmap's searchable-catalog feature. It also made the
deferred migration expensive: not a table change but a rewrite of every call
site. The junction shape is a single unambiguous embed
(`movies?select=*,sessions(*)`), and its composite primary key throws in
"the same film can't be added to one session twice" for free.

**`members` separate from `auth.users`, linked by a nullable `user_id`.**
Rejected once the live data was checked: all 12 distinct `member_name` values
in `ratings` are the 12 current members. There are no historical raters who
left, so the nullable link defended against a population that doesn't exist.
A two-step migration (add `email`, backfill, then move to auth) was also
considered and skipped for the same reason — #2 already established that
`admin.createUser` works and the OAuth gate holds, so the end state is
reachable in one step.

**Per-showing ratings.** Since a film may recur, ratings could attach to
`session_movies` rather than to the movie. Rejected: it makes "which showing's
average is the all-time ranking?" ambiguous, and rewatches are rare enough that
the ambiguity costs more than the feature is worth.

**Deferring full-text search to `ilike`.** Rejected as the cheapest thing on
the list to add up front and the most annoying to retrofit — a migration plus
rewriting whatever `ilike` queries got written meanwhile, and `ilike` can't
rank.

**A `slug` column on `movies`.** Rejected: a slug is a second identity for a
row, and the invariant is that a Movie has exactly one. Routes use the id.

## Consequences

- **`rating_unit` is the one club-specific column on `movies`**, and it is
  deliberate — it's per-film flavour with nowhere better to live, and it will
  be null for films the club never showed. It is an exception, not a
  precedent: nothing else club-specific goes on the catalog.
- **The all-time ranking reads `v2.movie_scores`, not `v2.movies`.** Anything
  sorting or filtering by score must go through the view or it will pull every
  rating to order one page.
- **`rated_at` must not be touched on update.** The "films rated in August"
  feature depends on it staying put while `updated_at` moves. This is a rule
  application code has to honour — a candidate lint rule or trigger for #12.
- **A Member cannot exist without an auth user.** Adding a member means an
  admin creating one. If someone's Google address differs from the email the
  admin entered, magic link is the recovery path.
- **Ordering members by `display_name`** loses the ability to hand-order the
  ratings grid. Accepted.
- **The v1 import cannot trust `HISTORY_META`.** Its join is positional over
  `movies.id` ascending, and September's films hold ids 1 and 2 — so id order
  is not insertion order and the mapping may already be wrong. The 40
  theme/month pairings need human verification, not a scripted port. Tracked
  on the map.
