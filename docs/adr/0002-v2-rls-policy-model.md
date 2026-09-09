---
status: accepted
---

# The v2 RLS policy model: a members-only club

v1's failure mode is that every table carries an `anon_all` policy — anyone on
the internet can read and write the database directly through the REST API,
without ever loading the site. v2 closes that by making the club **members-only
at two independent layers**: `anon` holds no privileges in the `v2` schema at
all, and every policy underneath is scoped `to authenticated`.

Resolves map ticket
[RLS policy model and the member/auth.users join](https://github.com/Foifoif/movie_club_v2/issues/9).
Builds on [ADR-0001](0001-v2-schema.md); vocabulary in [`CONTEXT.md`](../../CONTEXT.md).

## This overturns "public read"

The map settled *public read · authenticated write* at charting. **That is no
longer the model.** The club is twelve friends at a guessable domain, the site
has no audience beyond them, and public readability was never worth anything to
them — so v2 is **authenticated read · authenticated write · admin role**.

Consequences that reach outside this ADR: the first screen is a login screen,
there is no logged-out view of anything to design, and any prototype or
vertical slice must start from a session.

## What v1's openness means for v2 in the meantime

**The database is not locked down. Only the `v2` schema is.** v1 is live in
`public` with `anon_all` on every table, served by the same project and
reachable with the same publishable key. A client configured with
`db: { schema: 'v2' }` is a *convention*, not a boundary — dropping the
`Accept-Profile` header reaches `public` exactly as before.

So: the policies below must hold on their own merits, and nobody reading this
should conclude the project is secure. **Cutover is what closes v1's hole**, by
dropping `public`'s tables and taking their policies with them.

## Layer 1: `anon` gets nothing

The [#6 migration](https://github.com/Foifoif/movie_club_v2/issues/6) granted
`ALL` on all current *and future* `v2` tables to `anon`, following Supabase's
"Using Custom Schemas" doc verbatim. That is Supabase's documented posture —
grants are permissive, RLS is the gate — and it is a coherent one: a single
layer is easier to reason about than two.

We take the stricter path anyway, because under permissive grants **a single
forgotten `enable row level security` recreates `anon_all` exactly**. That is
the specific bug v2 exists to escape, and one forgotten line is too short a
distance to it.

```sql
-- anon has no business in v2: the club is members-only, and login runs
-- through GoTrue (/auth/v1/*), which does not touch these grants.
revoke all on schema v2                    from anon;
revoke all on all tables in schema v2      from anon;
revoke all on all routines in schema v2    from anon;
revoke all on all sequences in schema v2   from anon;

alter default privileges for role postgres in schema v2 revoke all on tables    from anon;
alter default privileges for role postgres in schema v2 revoke all on routines  from anon;
alter default privileges for role postgres in schema v2 revoke all on sequences from anon;
```

A denied `anon` now gets `42501 permission denied for table …` rather than a
silent empty array — a loud failure, and a sharper thing to assert in a test.

**The cost of diverging from the doc** is that an agent pasting Supabase's
snippet into a future migration silently re-grants `anon`. That is why
"`anon` holds zero privileges in schema `v2`" is a **CI assertion**, not a
convention (see Testing).

## Layer 2: the policies

All policies are `to authenticated`. `auth.uid()` is wrapped in a scalar
subquery throughout — `(select auth.uid())` — which lets Postgres cache it as
an InitPlan instead of re-evaluating per row.

### `v2.is_admin()`

Admin status is **a column on `members`**, read through one helper so that every
policy reads the same four words and the mechanism stays swappable.

```sql
alter table v2.members add column is_admin boolean not null default false;

create or replace function v2.is_admin()
returns boolean
language sql
stable
security definer            -- MUST be: called by policies ON v2.members,
set search_path = ''        -- so an invoker-rights read would recurse forever
as $$
  select coalesce(
    (select m.is_admin from v2.members m where m.id = (select auth.uid())),
    false
  );
$$;

revoke all on function v2.is_admin() from public, anon;
grant execute on function v2.is_admin() to authenticated;
```

`security definer` is load-bearing, not incidental: a policy on `members` that
queries `members` under invoker rights re-enters its own policy and errors with
infinite recursion. `set search_path = ''` (hence the fully-qualified names)
closes the search-path hijack that `security definer` otherwise opens.

**Rejected: a JWT claim** (via `app_metadata` or a Custom Access Token hook).
Both keep a revoked admin admin until their token refreshes — up to an hour.
A column is authoritative on the next query. Postgres roles don't fit
Supabase's connection model at all.

### Self-promotion is blocked at the grant layer

A member may rename themselves. **RLS gates rows, not columns**, so the policy
that permits that would equally permit `{"is_admin": true}` on the same row.
The fix is a column allowlist, not a policy:

```sql
revoke all     on v2.members                 from authenticated;
grant  select  on v2.members                 to   authenticated;
grant  update (display_name) on v2.members   to   authenticated;
```

Adding a member-editable column is now a deliberate act of extending that list.
The knock-on is that `updated_at` isn't member-writable either, so it moves by
trigger — which it should have done regardless.

### Per table

```sql
-- movies — the catalog. Any member may add or correct a film; the watchlist
-- feature (out of scope, but coming) needs exactly that. Delete is admin-only:
-- session_movies restricts on delete, so a stray delete is the only
-- destructive move available here.
alter table v2.movies enable row level security;
create policy movies_select on v2.movies for select to authenticated using (true);
create policy movies_insert on v2.movies for insert to authenticated with check (true);
create policy movies_update on v2.movies for update to authenticated using (true) with check (true);
create policy movies_delete on v2.movies for delete to authenticated using (v2.is_admin());

-- members — readable by the club, renameable only by yourself.
-- No insert policy: the trigger below is the only way in, and it is definer.
-- No delete policy: removing a member also means deleting the auth.users row,
-- which PostgREST cannot do at all. Removal is a service_role operation.
alter table v2.members enable row level security;
create policy members_select      on v2.members for select to authenticated using (true);
create policy members_update_self on v2.members for update to authenticated
  using      (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- sessions / session_movies — the club's schedule. One curator.
alter table v2.sessions enable row level security;
create policy sessions_select on v2.sessions for select to authenticated using (true);
create policy sessions_insert on v2.sessions for insert to authenticated with check (v2.is_admin());
create policy sessions_update on v2.sessions for update to authenticated using (v2.is_admin()) with check (v2.is_admin());
create policy sessions_delete on v2.sessions for delete to authenticated using (v2.is_admin());

alter table v2.session_movies enable row level security;
create policy session_movies_select on v2.session_movies for select to authenticated using (true);
create policy session_movies_insert on v2.session_movies for insert to authenticated with check (v2.is_admin());
create policy session_movies_update on v2.session_movies for update to authenticated using (v2.is_admin()) with check (v2.is_admin());
create policy session_movies_delete on v2.session_movies for delete to authenticated using (v2.is_admin());

-- ratings — you own your score completely, including retracting it.
-- An admin may DELETE someone's rating (housekeeping) but never UPDATE it:
-- silently rewriting a member's 4.99 is a trust problem the database can
-- simply make impossible.
alter table v2.ratings enable row level security;
alter table v2.ratings alter column member_id set default auth.uid();

create policy ratings_select on v2.ratings for select to authenticated using (true);
create policy ratings_insert on v2.ratings for insert to authenticated
  with check (member_id = (select auth.uid()));
create policy ratings_update on v2.ratings for update to authenticated
  using      (member_id = (select auth.uid()))
  with check (member_id = (select auth.uid()));
create policy ratings_delete on v2.ratings for delete to authenticated
  using (member_id = (select auth.uid()) or v2.is_admin());
```

`member_id default auth.uid()` means the client never sends its own identity.
Combined with the `with check`, forging another member's rating requires
actively passing the wrong id and being refused — **the lazy path is the
correct one**, which is the property that matters when agents write the client.

### The view

```sql
alter view v2.movie_scores set (security_invoker = true);
```

A view reads its underlying tables as its *owner* by default, and owners are
exempt from RLS — so `movie_scores` would average over every rating regardless
of policy. Today that is indistinguishable from the invoker behaviour, because
every member may read every rating. It is set anyway to keep Supabase's
database linter (`security_definer_view`) quiet: a standing warning that
everyone must remember is intentional costs more than one line.

The trade this forecloses: *"everyone sees the average, nobody sees who gave
what"* would require the owner-rights default. The club explicitly wants
attributed ratings, so nothing is lost.

## Membership: the trigger is the only door

`v2.members.id` **is** `auth.users.id` (ADR-0001). What that ADR left open was
who writes the member row. It is a trigger:

```sql
create or replace function v2.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into v2.members (id, display_name)
  values (
    new.id,
    coalesce(
      nullif(new.raw_user_meta_data ->> 'display_name', ''),
      nullif(new.raw_user_meta_data ->> 'full_name', ''),   -- Google
      nullif(new.raw_user_meta_data ->> 'name', ''),
      split_part(new.email, '@', 1)
    )
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function v2.handle_new_auth_user();
```

**This makes "an authenticated non-member" an impossible state**, which the
ticket asked to be settled explicitly rather than left undefined. The
alternative — the invite Edge Function making two calls — leaves a
half-admitted user behind any network blip, and a self-serve insert policy
reintroduces the very state the trigger deletes.

## The invite Edge Function

The one place holding the `service_role` key, and therefore the one place where
a bug means total compromise. It **must verify the caller is an admin itself**:
read the `Authorization` header, `getUser()`, check `v2.members.is_admin` for
that id, and reject before touching the service-role client. Supabase's
`verify_jwt` gate alone would make every member an admissions committee, which
would make `is_admin` pointless; a shared header secret would be v1's hardcoded
admin password rebuilt.

It should remain the **only** function holding that key, so the blast radius
stays one file.

## Testing

The CI gate's RLS suite. The first three are worth more than the rest combined,
because they are catalog queries and therefore cover **tables that do not exist
yet**:

1. `anon` holds zero privileges on every object in schema `v2`.
2. Every table in `v2` has RLS enabled.
3. Every `auth.users` row has a `v2.members` row.

**Anonymous** — cannot read or write any of the five tables or the view, including
with an explicit `Accept-Profile: v2`.

**Member (non-admin)** — reads all five and the view; inserts a rating with
`member_id` omitted and gets their own; is refused forging another's
`member_id`; updates and deletes their own rating but not another's; sees
`rated_at` hold still on update while `updated_at` moves; inserts and updates
`movies` but cannot delete; cannot write `sessions` or `session_movies`; renames
themselves; **cannot set `is_admin` on themselves**; cannot insert or delete
`members`.

**Admin** — full `sessions`/`session_movies` write; deletes any rating; **cannot
update another member's rating**; deletes `movies`.

**Admission** — signup disabled means a stranger is refused with no `auth.users`
row; `admin.createUser` followed by sign-in succeeds and yields a member row.

**Edge Function** — anon → 403; non-admin member → 403 and no user created;
admin → user plus member row. These cannot be written before the function
exists; they are an acceptance item on whichever ticket builds it.

### Known untested edge

[#2](https://github.com/Foifoif/movie_club_v2/issues/2) established from
`supabase/auth` source that an admin-created user can arrive via **OAuth** even
with `enable_signup = false`, because admin endpoints never consult
`DisableSignup`. **That composition is documented nowhere by Supabase and is
tested nowhere here.** CI runs a local Supabase with no Google provider, so the
suite covers the magic-link half only; testing the OAuth half would mean CI
writing to the database that serves v1, which is precisely the risk
[#15](https://github.com/Foifoif/movie_club_v2/issues/15) exists to contain.

If a GoTrue upgrade ever breaks this, the symptom is admitted members being
unable to log in with Google. It is recorded here so that is findable rather
than mysterious.

## Consequences

- **Two layers must both fail for a stranger to get in.** A forgotten
  `enable row level security` now yields a table `anon` still cannot see.
- **Triggers, not lint rules, hold the two data invariants.** `rated_at` is
  pinned on update by a `before update` trigger, and `updated_at` is moved by
  one. A lint rule cannot see an edit made through the Supabase dashboard or a
  `psql` session; ADR-0001 listed `rated_at` as a lint candidate for
  [#12](https://github.com/Foifoif/movie_club_v2/issues/12) — **it no longer
  needs one.**
- **Removing a member is a `service_role` operation**, not a UI action —
  `members.id` references `auth.users` with `on delete restrict`, so both rows
  must go, and PostgREST cannot delete an auth user.
- **Admin status is not in the JWT.** Client code must not branch on a token
  claim to decide what to render; it reads `members.is_admin` like any other
  row. Hiding a button is cosmetic anyway — the policies are the control.
- **Nothing renders without a session.** Data-layer hooks can assume an
  authenticated client; a logged-out user has no partial view to fall back to.
