# Invite-only signup in Supabase Auth

Research for [#2](https://github.com/Foifoif/movie_club_v2/issues/2) (map: [#1](https://github.com/Foifoif/movie_club_v2/issues/1)).

**Question:** how do we make Supabase Auth invite-only, so that only people we explicitly admit can create an account at all — including via Google OAuth?

**Context:** private movie club, ~3–10 members, hobby project, Supabase free tier, static SPA (no server framework), Supabase Edge Functions available.

**Date:** 2026-08-28. All source-code claims are pinned to `supabase/auth` commit
[`7691e96`](https://github.com/supabase/auth/tree/7691e9682e65347a3e8dc9420dca490e71cb6322)
(HEAD of `master` on 2026-08-28) and `supabase/cli` commit
[`7a16903`](https://github.com/supabase/cli/tree/7a16903c7b39fb7e4f01e03339c3c2b7dafc256b).
Supabase Auth is a hosted service that is upgraded without notice — re-verify before relying on any source-code claim in a year's time.

---

## TL;DR

1. **`enable_signup = false` ("Allow new users to sign up" off) is a real gate, and it *does* cover Google OAuth.** It is not an email/password-only setting. Verified in the GoTrue source: the OAuth callback checks it on the `CreateAccount` branch. [external.go:342–345](https://github.com/supabase/auth/blob/7691e9682e65347a3e8dc9420dca490e71cb6322/internal/api/external.go#L342-L345)
2. **Admitting someone = creating their `auth.users` row from the admin API.** Both `inviteUserByEmail` and `admin.createUser` bypass the `DisableSignup` check entirely — neither endpoint consults it.
3. **The invited person can then sign in with Google**, because GoTrue's automatic identity linking sees an existing user row with a matching verified email and returns `LinkAccount`, not `CreateAccount` — so the signup gate is never reached. [linking.go:147–158](https://github.com/supabase/auth/blob/7691e9682e65347a3e8dc9420dca490e71cb6322/internal/models/linking.go#L147-L158)
4. The **Before User Created hook** is a genuine second mechanism, is documented as available on **Free**, and *is* invoked on the OAuth path. It is strictly more expressive but strictly more moving parts.
5. The **DB trigger on `auth.users`** approach works mechanically but produces an opaque `500 Database error saving new user` and is not something Supabase documents as a supported gate. Not recommended.

Recommendation is in the [final section](#recommendation).

---

## Mechanism A — disable public signup + admin-created accounts

### What the setting is

Dashboard: **Authentication → Sign In / Providers → "Allow new users to sign up"**.

> **Allow new users to sign up**: Users will be able to sign up. If this config is disabled, only existing users can sign in.
> — [General configuration](https://supabase.com/docs/guides/auth/general-configuration)

CLI / `config.toml` equivalent, from the CLI's own template:

```toml
# Allow/disallow new user signups to your project.
enable_signup = true
```
— [`apps/cli-go/pkg/config/templates/config.toml:175-176`](https://github.com/supabase/cli/blob/7a16903c7b39fb7e4f01e03339c3c2b7dafc256b/apps/cli-go/pkg/config/templates/config.toml#L175-L176). Same key documented at [CLI config reference](https://supabase.com/docs/guides/local-development/cli/config) (`auth.enable_signup`, default `true`, "Allow/disallow new user signups to your project").

Note there are three separate `enable_signup` keys in `config.toml`: the top-level `[auth]` one (all providers), `[auth.email]`, and `[auth.sms]`. The top-level one is the one that maps to `DisableSignup` in GoTrue and is the one that covers OAuth.

### Every user-creation path it closes

Verified by reading every `config.DisableSignup` reference in the GoTrue source:

| Path | Endpoint | Gated? | Source |
|---|---|---|---|
| Email/password signup | `POST /signup` | Yes → `422 signup_disabled` | [signup.go:115-117](https://github.com/supabase/auth/blob/7691e9682e65347a3e8dc9420dca490e71cb6322/internal/api/signup.go#L115-L117) |
| Magic link / email OTP for a new user | `POST /otp` | Yes — delegates to `a.Signup` | [otp.go:164](https://github.com/supabase/auth/blob/7691e9682e65347a3e8dc9420dca490e71cb6322/internal/api/otp.go#L164), [otp.go:181](https://github.com/supabase/auth/blob/7691e9682e65347a3e8dc9420dca490e71cb6322/internal/api/otp.go#L181) |
| **Google OAuth redirect flow** (`signInWithOAuth`) | `GET /callback` | **Yes** → `422 signup_disabled` | [external.go:342-345](https://github.com/supabase/auth/blob/7691e9682e65347a3e8dc9420dca490e71cb6322/internal/api/external.go#L342-L345) |
| **Google ID-token flow** (`signInWithIdToken`, One Tap / native) | `POST /token?grant_type=id_token` | **Yes** — same `createAccountFromExternalIdentity` | [token_oidc.go:333](https://github.com/supabase/auth/blob/7691e9682e65347a3e8dc9420dca490e71cb6322/internal/api/token_oidc.go#L333) |
| Anonymous sign-in | `POST /signup` (anon) | Yes | [anonymous.go:18-20](https://github.com/supabase/auth/blob/7691e9682e65347a3e8dc9420dca490e71cb6322/internal/api/anonymous.go#L18-L20) |
| SAML SSO | — | Yes, via the same helper | [hooks.go:94-98](https://github.com/supabase/auth/blob/7691e9682e65347a3e8dc9420dca490e71cb6322/internal/api/hooks.go#L94-L98) |

The OAuth check, verbatim:

```go
case models.CreateAccount:
    if config.DisableSignup {
        return 0, nil, apierrors.NewUnprocessableEntityError(apierrors.ErrorCodeSignupDisabled, "Signups not allowed for this instance")
    }
```

Note the `case models.CreateAccount:` — the gate applies **only when GoTrue has decided a brand-new account is needed**. That is exactly the property we want, and it is the mechanism by which the invite works (below).

### What is *not* gated: the admin endpoints

Neither admin creation endpoint checks `DisableSignup`. This is not an oversight to work around — it is the intended way to admit people while signups are closed.

- `POST /invite` → [invite.go:20-107](https://github.com/supabase/auth/blob/7691e9682e65347a3e8dc9420dca490e71cb6322/internal/api/invite.go#L20-L107). No `DisableSignup` reference in the file. Creates an unconfirmed user + email identity and sends an invite email.
- `POST /admin/users` → [admin.go:388](https://github.com/supabase/auth/blob/7691e9682e65347a3e8dc9420dca490e71cb6322/internal/api/admin.go#L388). No `DisableSignup` reference. **Sends no email at all** — it only auto-confirms if you pass `email_confirm: true`.

Confirmed against the docs:

> Inviting a user is an admin action, so it must be performed from a trusted server environment using your secret key, or from the Dashboard. When you invite an email that doesn't yet belong to a user, a new unconfirmed user is created.
> — [Users guide, "Inviting users"](https://supabase.com/docs/guides/auth/users)

### Trade-offs

**For:**
- One boolean. Nothing to write, deploy, version, or keep alive.
- Covers every signup path in one place, verified in source.
- Returns a first-class, stable error code (`signup_disabled`) that the SPA can match on.
- Zero runtime cost; no hook to time out or 500.

**Against:**
- It is coarse: "nobody new, ever." There is no per-person policy, no expiry, no reason-for-rejection. For a 3–10 person club that is a feature, not a limitation.
- The gate lives in *project configuration*, not in the repo. It is invisible to a cold agent session reading the codebase and is not enforced by CI. **Mitigation: put `enable_signup = false` in `supabase/config.toml` in git** — the CLI supports pushing this to the linked project, so the setting is versioned and reviewable. (See "Unverified" below re: exact push command.)
- Admitting a person is a manual/admin step. Again, correct for this club.

---

## Mechanism B — the Before User Created auth hook

### What it is

> This hook runs before a new user is created. It allows developers to inspect the incoming user object and optionally reject the request. Use this to enforce custom signup policies that Supabase Auth does not handle natively […] If the hook returns an error object, the signup is denied and the user is not created.
> — [Before User Created Hook](https://supabase.com/docs/guides/auth/auth-hooks/before-user-created-hook)

Configured either as a **Postgres function** (`uri = "pg-functions://postgres/public/my_hook"`) or an **HTTP endpoint** (an Edge Function). [Auth Hooks](https://supabase.com/docs/guides/auth/auth-hooks)

Config key, from the CLI template:

```toml
# This hook runs before a new user is created and allows developers to reject the request based on the incoming user object.
# [auth.hook.before_user_created]
# enabled = true
# uri = "pg-functions://postgres/auth/before-user-created-hook"
```
— [`templates/config.toml:278-281`](https://github.com/supabase/cli/blob/7a16903c7b39fb7e4f01e03339c3c2b7dafc256b/apps/cli-go/pkg/config/templates/config.toml#L278-L281). The CLI can also push it to a linked project ([`auth.go:550-554`](https://github.com/supabase/cli/blob/7a16903c7b39fb7e4f01e03339c3c2b7dafc256b/apps/cli-go/pkg/config/auth.go#L550-L554)).

⚠️ The **CLI config reference page** ([supabase.com/docs/guides/local-development/cli/config](https://supabase.com/docs/guides/local-development/cli/config)) lists the valid hook names as `custom_access_token`, `send_sms`, `send_email`, `mfa_verification_attempt`, `password_verification_attempt` — it **omits** `before_user_created`. Likewise the "Using Hooks → Developing" table on the [Auth Hooks](https://supabase.com/docs/guides/auth/auth-hooks) page omits it. The CLI source above proves the key is supported; the reference pages are stale.

### It does fire for OAuth — verified

The hook has a dedicated OAuth-aware entry point, `triggerBeforeUserCreatedExternal`, called from:

- [external.go:207](https://github.com/supabase/auth/blob/7691e9682e65347a3e8dc9420dca490e71cb6322/internal/api/external.go#L207) — the OAuth redirect callback (`signInWithOAuth`)
- [token_oidc.go:326](https://github.com/supabase/auth/blob/7691e9682e65347a3e8dc9420dca490e71cb6322/internal/api/token_oidc.go#L326) — `signInWithIdToken`
- [samlacs.go:315](https://github.com/supabase/auth/blob/7691e9682e65347a3e8dc9420dca490e71cb6322/internal/api/samlacs.go#L315) — SAML
- [web3.go:143](https://github.com/supabase/auth/blob/7691e9682e65347a3e8dc9420dca490e71cb6322/internal/api/web3.go#L143), [web3.go:289](https://github.com/supabase/auth/blob/7691e9682e65347a3e8dc9420dca490e71cb6322/internal/api/web3.go#L289) — Web3

and from `triggerBeforeUserCreated` on the email/password ([signup.go:186](https://github.com/supabase/auth/blob/7691e9682e65347a3e8dc9420dca490e71cb6322/internal/api/signup.go#L186)), anonymous ([anonymous.go:33](https://github.com/supabase/auth/blob/7691e9682e65347a3e8dc9420dca490e71cb6322/internal/api/anonymous.go#L33)) and **invite** ([invite.go:61](https://github.com/supabase/auth/blob/7691e9682e65347a3e8dc9420dca490e71cb6322/internal/api/invite.go#L61)) paths.

Crucially, `triggerBeforeUserCreatedExternal` runs `DetermineAccountLinking` first and returns early if the decision isn't `CreateAccount` ([hooks.go:91-93](https://github.com/supabase/auth/blob/7691e9682e65347a3e8dc9420dca490e71cb6322/internal/api/hooks.go#L91-L93)) — so the hook only sees genuinely-new accounts, and existing members signing in with Google never hit it.

The docs explicitly document blocking OAuth signups with this hook, including a ready-made SQL example that reads `event->'user'->'app_metadata'->>'provider'`:

> Some applications want to **allow sign-ins with a provider like Discord only for users who already exist**, while blocking new account creation via that provider. This prevents unwanted signups through OAuth flows and enables tighter control over who can join the app.
> — [Before User Created Hook, "Block by OAuth Provider"](https://supabase.com/docs/guides/auth/auth-hooks/before-user-created-hook)

The docs also ship an allowlist-table example (`signup_email_domains` keyed by domain) that is trivially adaptable to an allowlist keyed by full email address.

### 🚩 Trap: an HTTP (Edge Function) hook must return **200**, not 400/403

The official docs' HTTP examples reject a signup with `{ status: 400 }` / `{ status: 403 }`. **Per the GoTrue source, that does not work** — the custom message is thrown away and the caller gets a generic 500:

```go
case http.StatusBadRequest:
    return nil, apierrors.NewInternalServerError("Invalid payload sent to hook")
case http.StatusUnauthorized:
    return nil, apierrors.NewInternalServerError("Hook requires authorization token")
default:
    return nil, apierrors.NewInternalServerError("Unexpected status code returned from hook: %d", rsp.StatusCode)
```
— [hookshttp.go:242-251](https://github.com/supabase/auth/blob/7691e9682e65347a3e8dc9420dca490e71cb6322/internal/hooks/hookshttp/hookshttp.go#L242-L251)

Only an HTTP **200 / 202** response is parsed for an `{"error": {...}}` body ([hookshttp.go:229-231](https://github.com/supabase/auth/blob/7691e9682e65347a3e8dc9420dca490e71cb6322/internal/hooks/hookshttp/hookshttp.go#L229-L231)). Upstream's own test suite asserts this, with a comment conceding the point:

```go
data: M{
    "error": M{
        // This is not propagated in current implementation
        "http_code": 500,
        "message":   "sentinel error",
    },
},
…
addCase(http.StatusBadRequest, http.StatusInternalServerError, "Invalid payload sent to hook")
```
— [hookshttp_test.go:225-258](https://github.com/supabase/auth/blob/7691e9682e65347a3e8dc9420dca490e71cb6322/internal/hooks/hookshttp/hookshttp_test.go#L225-L258)

**So: an HTTP hook must return `HTTP 200` with body `{"error": {"http_code": 403, "message": "…"}}`.** The Postgres-function variant has no such trap — it returns the JSON directly and goes through the same `hookserrors.Check` ([hookspgfunc.go:116](https://github.com/supabase/auth/blob/7691e9682e65347a3e8dc9420dca490e71cb6322/internal/hooks/hookspgfunc/hookspgfunc.go#L116)). **If we use this hook, use the Postgres-function form.**

Also note the docs' contradictory table on [Auth Hooks](https://supabase.com/docs/guides/auth/auth-hooks) ("Error handling → HTTP"), which itself says `403, 400` are "Treated as Internal Server Errors and return a 500 Error Code" — the *hook page's own examples* contradict the *hooks index page*. The source settles it.

### Other operational facts

- Postgres hooks: 2s timeout, not retryable. HTTP hooks: 5s budget, up to 3 retries on `429`/`503`, 20KB payload limit. [Auth Hooks](https://supabase.com/docs/guides/auth/auth-hooks)
- A Postgres hook must be granted to `supabase_auth_admin` and revoked from `anon`/`authenticated`/`public`; if it reads a table with RLS, that role needs a policy. [Auth Hooks, "Security model"](https://supabase.com/docs/guides/auth/auth-hooks)
- An Edge Function used as a hook must be served with JWT verification off (`--no-verify-jwt` locally) because the hook runs before a JWT exists. [Auth Hooks](https://supabase.com/docs/guides/auth/auth-hooks)
- The hook is labelled **BETA** in the dashboard nav ("Auth Hooks (BETA)"). [General configuration](https://supabase.com/docs/guides/auth/general-configuration)

### Trade-offs

**For:**
- Expressive: per-email allowlist, expiry, IP rules, provider rules, custom rejection message.
- Fires on every creation path including OAuth — a single choke point.
- As a Postgres function, the allowlist table lives in migrations, in git, under CI. That fits the map's "machine-enforced, not just documented" principle better than a dashboard toggle.

**Against:**
- Real moving parts: a function, grants, a table, RLS carve-outs for `supabase_auth_admin`, plus dashboard/`config.toml` wiring. Every one of those is a way for a cold agent session to break login.
- Beta, and its documentation is demonstrably wrong in two places (the HTTP status trap; two reference pages omit the config key). That is a bad property for the *one thing standing between the internet and our database*.
- A hook failure is a **login outage**, and the failure mode is a 500 with no useful message.
- It also fires on `POST /invite` ([invite.go:61](https://github.com/supabase/auth/blob/7691e9682e65347a3e8dc9420dca490e71cb6322/internal/api/invite.go#L61)) — so an allowlist hook must be written so that admin invites don't get rejected by our own gate, or the allowlist row must be inserted before the invite is issued.

---

## Mechanism C — allowlist table checked by a DB trigger on `auth.users`

Raise an exception from a `before insert on auth.users` trigger when the email isn't in an allowlist table.

**It does gate OAuth**, incidentally: user creation on the OAuth path happens inside a DB transaction ([external.go:374 `signupNewUser`](https://github.com/supabase/auth/blob/7691e9682e65347a3e8dc9420dca490e71cb6322/internal/api/external.go#L374)), so an exception aborts it.

**But the error surface is terrible.** Any DB failure on insert becomes:

```go
if terr = tx.Create(user); terr != nil {
    return apierrors.NewInternalServerError("Database error saving new user")
}
```
— [signup.go:385-387](https://github.com/supabase/auth/blob/7691e9682e65347a3e8dc9420dca490e71cb6322/internal/api/signup.go#L385-L387)

An opaque HTTP 500 with no error code. Our custom "you're not on the list" message is discarded. On the OAuth path it surfaces as `error=server_error` (see UX below). Supabase's own troubleshooting corpus is full of this string being a *bug report*, not a designed behaviour: [Database error saving new user](https://supabase.com/docs/guides/troubleshooting/database-error-saving-new-user-RU_EwB).

Supabase documents triggers on `auth.users` only for the *side-effect* case (populating `public.profiles`), and warns:

> To update your `public.profiles` table every time a user signs up, set up a trigger. If the trigger fails, it could block signups, so test your code thoroughly.
> — [User Management](https://supabase.com/docs/guides/auth/managing-user-data)

That is a warning about an accident, not an endorsement of doing it on purpose. Combined with the standing docs warning that "Columns, indices, constraints or other database objects managed by Supabase **may change at any time**" ([same page](https://supabase.com/docs/guides/auth/managing-user-data)), this mechanism is building a security control on an explicitly-unstable surface.

**Verdict: rejected.** It gates, but it fails as a 500 and it's the only one of the three that Supabase doesn't bless.

---

## The OAuth question (the crux)

**Q: Google OAuth auto-creates a user on first successful login. Does the gate hold?**

**A: Yes — for Mechanism A and Mechanism B, verified in source. Here is the exact chain.**

### 1. GoTrue decides *before* creating anything

Every OAuth entry point routes through `models.DetermineAccountLinking`, which returns one of `AccountExists`, `LinkAccount`, `CreateAccount`, `MultipleAccounts` ([linking.go:63](https://github.com/supabase/auth/blob/7691e9682e65347a3e8dc9420dca490e71cb6322/internal/models/linking.go#L63)).

For a Google identity with a **verified** email:

```go
if terr := tx.Q().Eager().Where("email = any (?) and is_sso_user = false", verifiedEmails).All(&similarUsers); terr != nil {
```
— [linking.go:130](https://github.com/supabase/auth/blob/7691e9682e65347a3e8dc9420dca490e71cb6322/internal/models/linking.go#L130)

```go
if len(similarUsers) == 1 {
    // no similarIdentities but a user with the same email exists
    // so we link this new identity to the user
    return AccountLinkingResult{ Decision: LinkAccount, User: similarUsers[0], … }
```
— [linking.go:149-158](https://github.com/supabase/auth/blob/7691e9682e65347a3e8dc9420dca490e71cb6322/internal/models/linking.go#L149-L158)

This matches the documented behaviour:

> Supabase Auth automatically links identities with the same email address to a single user. […] When a new user signs in with OAuth, Supabase Auth will attempt to look for an existing user that uses the same email address. If a match is found, the new identity is linked to the user.
> — [Identity Linking](https://supabase.com/docs/guides/auth/auth-identity-linking)

### 2. The signup gate only guards the `CreateAccount` branch

- **Invited person signs in with Google** → a user row already exists with that email (created by the admin invite) → `LinkAccount` → `DisableSignup` is **never consulted** → they get in, and their Google identity is linked to their existing row.
- **Stranger signs in with Google** → no matching row → `CreateAccount` → `DisableSignup` returns `422 signup_disabled`. No `auth.users` row is created. No stranger row is left behind.

The lookup is case-insensitive-ish only in that GoTrue lowercases the OAuth email (`strings.ToLower`, [linking.go:69-73](https://github.com/supabase/auth/blob/7691e9682e65347a3e8dc9420dca490e71cb6322/internal/models/linking.go#L69-L73)). **We must therefore invite the exact Gmail address the member signs in with.** A `jacob@gmail.com` invite will not match a Google account whose primary email is `jacob@amovieclub.com`.

### 3. The unconfirmed invited row is upgraded on Google sign-in

An invited-but-not-yet-accepted user is unconfirmed. On the `LinkAccount` path, GoTrue notices this and confirms them, after first stripping any other unconfirmed identity to prevent pre-account-takeover ([external.go:411-425](https://github.com/supabase/auth/blob/7691e9682e65347a3e8dc9420dca490e71cb6322/internal/api/external.go#L411-L425)):

> It would also be an insecure practice to automatically link an identity to a user with an unverified email address since that could lead to pre-account takeover attacks. To prevent this from happening, when a new identity can be linked to an existing user, Supabase Auth will remove any other unconfirmed identities linked to an existing user.
> — [Identity Linking](https://supabase.com/docs/guides/auth/auth-identity-linking)

So a member can be admitted and **never touch the invite email at all** — just click "Sign in with Google". That is the ideal UX for this club.

### Caveats on this claim

- The `LinkAccount` branch requires Google to report the email as **verified** (`email.Verified`, [linking.go:66-73](https://github.com/supabase/auth/blob/7691e9682e65347a3e8dc9420dca490e71cb6322/internal/models/linking.go#L66-L73)). Google returns `email_verified: true` for normal Gmail accounts. I did **not** empirically test a Google Workspace account with an unverified primary email.
- **I could not find a Supabase docs page that states the "admin-create the row, then let the user arrive via OAuth" pattern in so many words.** The two halves are each documented (signup disabling; automatic identity linking) and the composition is proven in source, but it is not a blessed, named recipe. This is a source-verified conclusion, not a docs-verified one.
- If Supabase ever changes automatic linking to be opt-in (there is a `GOTRUE_EXPERIMENTAL_PROVIDER_LINKING_DOMAINS` knob in the config, [linking.go:19-37](https://github.com/supabase/auth/blob/7691e9682e65347a3e8dc9420dca490e71cb6322/internal/models/linking.go#L19-L37)), invited members would suddenly hit `CreateAccount` and be locked out. Low risk, but worth an integration test.

---

## Free-tier availability

| Thing | Free? | Source |
|---|---|---|
| `enable_signup = false` | ✅ Yes — it's core auth config, no plan gate anywhere in the docs or source | [General configuration](https://supabase.com/docs/guides/auth/general-configuration) |
| `inviteUserByEmail` / `admin.createUser` | ✅ Yes — standard Auth Admin API | [Users](https://supabase.com/docs/guides/auth/users) |
| Before User Created hook | ⚠️ Docs say **"Free, Pro"** | [Auth Hooks](https://supabase.com/docs/guides/auth/auth-hooks) |
| MFA / Password Verification hooks | ❌ "Teams and Enterprise" | [Auth Hooks](https://supabase.com/docs/guides/auth/auth-hooks) |
| Edge Functions | ✅ Free plan includes **500,000 invocations** | [Pricing](https://supabase.com/pricing) |
| Auth MAUs | ✅ Free plan includes **50,000** | [Pricing](https://supabase.com/pricing) |
| Custom SMTP | ✅ "Included" on Free | [Pricing](https://supabase.com/pricing) |

### 🚩 Contradiction on the hook's free-tier status

The [Auth Hooks](https://supabase.com/docs/guides/auth/auth-hooks) table says **Before User Created → "Free, Pro"**. But the [pricing page](https://supabase.com/pricing) Authentication comparison row for **Auth Hooks** on the Free plan reads only:

> Custom Access Token (JWT), Send custom email/SMS

— which does **not** name Before User Created. One of these two pages is stale. The hook page is newer (its example payload is timestamped `2025-04-29`), so the pricing page is the likely stale one — but **I could not confirm this from a third primary source, and I could not test it against a live free-tier project.** If we pick the hook, verify in the dashboard before designing around it.

### 🚩 The free-tier email trap — this kills invite-by-email

The built-in SMTP server will not deliver to arbitrary addresses:

> Unless you configure a custom SMTP server for your project, Supabase Auth will refuse to deliver messages to addresses that are not part of the project's team. […] All other addresses will fail with the error message *Email address not authorized.*
>
> […] the number of messages your project can send is limited […] Currently this value is set to 2 messages per hour.
> — [Send emails with custom SMTP](https://supabase.com/docs/guides/auth/auth-smtp) (rate limit figure confirmed on the rendered [Rate limits](https://supabase.com/docs/guides/auth/rate-limits) page)

And in GoTrue, `sendInvite` runs **inside** the invite transaction ([invite.go:66-106](https://github.com/supabase/auth/blob/7691e9682e65347a3e8dc9420dca490e71cb6322/internal/api/invite.go#L66-L106)) — so if the email fails to send, **the whole transaction rolls back and no user row is created at all**. `inviteUserByEmail` on a bare free-tier project with a non-team-member email will therefore fail outright, not merely fail to deliver.

**Consequence:** on the free tier, either
- (a) wire up custom SMTP (Resend/Brevo free tiers are listed as supported: [auth-smtp](https://supabase.com/docs/guides/auth/auth-smtp)), or
- (b) **don't use `inviteUserByEmail` at all — use `admin.createUser`,** which sends no email ([admin.go:388+](https://github.com/supabase/auth/blob/7691e9682e65347a3e8dc9420dca490e71cb6322/internal/api/admin.go#L388), verified: no mailer call in the handler) and therefore needs no SMTP.

Option (b) is strictly better for a Google-OAuth club: there's nothing for the member to click in an email anyway. We tell them "you're in, go sign in with Google" over WhatsApp.

---

## What a non-invited person actually sees

This is the part that decides the login page design.

### Google OAuth (the main path)

GoTrue does **not** return a JSON error on the OAuth callback — the browser is mid-redirect. It redirects back to our app with error params in **both the query string and the URL fragment**:

```go
func getErrorQueryString(err error, errorID string, log logrus.FieldLogger, q url.Values) *url.Values {
    switch e := err.(type) {
    case *HTTPError:
        if e.ErrorCode == apierrors.ErrorCodeSignupDisabled {
            q.Set("error", "access_denied")
        …
        q.Set("error_description", e.Message)
        q.Set("error_code", e.ErrorCode)
```
— [external.go:847-870](https://github.com/supabase/auth/blob/7691e9682e65347a3e8dc9420dca490e71cb6322/internal/api/external.go#L847-L870), dispatched by [`redirectErrors`, external.go:821-845](https://github.com/supabase/auth/blob/7691e9682e65347a3e8dc9420dca490e71cb6322/internal/api/external.go#L821-L845)

So a stranger clicking "Sign in with Google" completes the Google consent screen, then lands back on our site at:

```
https://amovieclub.com/auth/callback
  ?error=access_denied
  &error_code=signup_disabled
  &error_description=Signups+not+allowed+for+this+instance
  #error=access_denied&error_code=signup_disabled&error_description=...&sb=
```

`signup_disabled` is explicitly special-cased to `access_denied` (rather than the generic status mapping in [errors.go:30-36](https://github.com/supabase/auth/blob/7691e9682e65347a3e8dc9420dca490e71cb6322/internal/api/errors.go#L30-L36)) — a stable, matchable contract.

Documented client-side handling:

> When authentication fails, the user will still be redirected to the redirect URL provided. However, the error details will be returned as query fragments in the URL. You can parse these query fragments and show a custom error message to the user.
> — [Redirect URLs, "Error handling"](https://supabase.com/docs/guides/auth/redirect-urls)

**Implementation note for the SPA:** `supabase-js` will detect this (its `parseParametersFromURL` reads both hash and query, search taking precedence — [helpers.ts:70-92](https://github.com/supabase/auth-js/blob/master/src/lib/helpers.ts#L70-L92)) and turn it into an `AuthImplicitGrantRedirectError` with `details.code = 'signup_disabled'` ([GoTrueClient.ts:1895-1903](https://github.com/supabase/auth-js/blob/master/src/GoTrueClient.ts#L1895-L1903)). But that error is raised inside the internal `_initialize()` and is **not** surfaced through `onAuthStateChange`. **Our callback route must read `error_code` off `window.location` itself.** Match on `error_code === 'signup_disabled'` — never on `error_description` string content ([Error Codes](https://supabase.com/docs/guides/auth/debugging/error-codes) advises matching on codes, not messages).

Note also the ugly middle of the flow: the stranger **still sees Google's consent screen and still grants our app access** before being bounced. We cannot prevent that; Supabase only learns who they are after Google hands back the token. The rejection is unavoidably *after* consent. What we *can* control is that no `auth.users` row is created and the landing message is ours.

**Recommended copy:** something honest and non-leaky, e.g. *"This is a private club. Ask a member to add you, then try again."* Do not confirm or deny whether the address is known.

### Email/password or magic link (if we ever enable it)

`POST /signup` returns **HTTP 422** with:

```json
{ "error_code": "signup_disabled", "msg": "Signups not allowed for this instance" }
```
— [signup.go:115-117](https://github.com/supabase/auth/blob/7691e9682e65347a3e8dc9420dca490e71cb6322/internal/api/signup.go#L115-L117), `NewUnprocessableEntityError` → 422

> `signup_disabled` — Sign ups (new account creation) are disabled on the server.
> — [Error Codes](https://supabase.com/docs/guides/auth/debugging/error-codes)

Surfaced as a normal `{ data, error }` from `supabase.auth.signUp()`; check `error.code === 'signup_disabled'`.

### If we used the hook instead

The hook's own message is propagated verbatim ("This response will block the user creation and return the error message to the client that attempted signup" — [Before User Created Hook](https://supabase.com/docs/guides/auth/auth-hooks/before-user-created-hook)) — **but `error_code` comes back empty**, because a hook error is constructed with only `HTTPStatus` and `Message`, no `ErrorCode` ([hookserrors.go:64-90](https://github.com/supabase/auth/blob/7691e9682e65347a3e8dc9420dca490e71cb6322/internal/hooks/hookserrors/hookserrors.go#L64-L90)). On the OAuth redirect the `error` param would then fall through to `oauthErrorMap[http_code]` — `403 → access_denied`, `400 → invalid_request` ([errors.go:30-36](https://github.com/supabase/auth/blob/7691e9682e65347a3e8dc9420dca490e71cb6322/internal/api/errors.go#L30-L36)).

So: **the hook buys you a nicer message but costs you a stable machine-readable code.** For our SPA — which wants to branch on the code and render its own copy — Mechanism A's stable `signup_disabled` is actually the better contract.

### If we used the DB trigger

`error=server_error`, HTTP 500, `Database error saving new user`. Indistinguishable from a real outage. Rejected on this basis alone.

---

## Where invites are issued from

### The constraint

> The secret key (`sb_secret_...`, which replaces the legacy `service_role` key) bypasses Row Level Security and must only be used in a secure server environment. **Never expose it in a browser or any publicly accessible client.**
> — [Users guide](https://supabase.com/docs/guides/auth/users)

> **Secret keys** […] **Only use in backend components of your app:** servers, already secured APIs (admin panels), Edge Functions, microservices, etc. They provide *full access* to your project's data, bypassing Row Level Security.
> — [Understanding API keys](https://supabase.com/docs/guides/getting-started/api-keys)

We are a static SPA. The only place the secret key can live is an **Edge Function** or the **dashboard**.

### Option 1 — dashboard, by hand

> 1. Go to **Authentication > Users** in the Dashboard.
> 2. Click **Add user** and select **Send invitation**.
> 3. Enter the user's email address and click **Invite user**.
> — [Users](https://supabase.com/docs/guides/auth/users)

There is also **Add user → Create new user** in the same menu, which is the no-email `admin.createUser` path — the one that works on free tier without SMTP. (I verified the API behaviour in source; **I did not verify the exact dashboard label for the create-without-invite option**, only the "Send invitation" one which is documented above.)

- **For:** zero code, zero secrets in our infrastructure, zero attack surface, works today.
- **Against:** requires a Supabase dashboard login, so only Jacob can admit people. For a 3–10 person club admitting maybe 10 people ever, this is not a real cost.

### Option 2 — admin-only Edge Function

Pattern: SPA calls `POST /functions/v1/admin-invite` with the caller's **user JWT** (not the secret key). The function verifies the caller is an admin, then uses the secret key (from `Deno.env`) to call `supabase.auth.admin.inviteUserByEmail` / `createUser`.

- **For:** admin UI in the app; any admin can admit; auditable; matches the map's "Supabase Edge Functions only, for the two operations needing a secret (TMDB proxy, **admin invite**)" line.
- **Against:** a function that holds the god key. It must verify the caller's admin role *itself* — the function's own JWT verification only proves *someone is logged in*, not that they're an admin. A bug here is total project compromise. That is real risk for a feature used ~10 times.

**⚠️ Note the map already lists "admin invite" as one of the two Edge Functions.** This research doesn't contradict that as a *destination* — but it does say the gate does not depend on it. The Edge Function is an ergonomics feature, and can land later, independently, without weakening the gate.

### Third option worth naming: a `sql/` migration

Since `admin.createUser` is only needed to get a row into `auth.users`, and we control migrations, we could also admit members by a one-line seed. **I did not verify that inserting directly into `auth.users` via SQL produces a row GoTrue's linker treats correctly** (password hash format, `instance_id`, `aud`, `confirmation_token` defaults, etc.) — Supabase does not document `auth.users` as a writable table and explicitly warns its schema may change. **Do not do this.** Named only so a future session doesn't rediscover it and think it's clever.

---

## What I could not verify

Flagged honestly, in rough order of how much it matters.

1. **Before User Created hook on the free tier.** [Auth Hooks](https://supabase.com/docs/guides/auth/auth-hooks) says "Free, Pro"; the [pricing page](https://supabase.com/pricing) Free column names only Custom Access Token and Send email/SMS. Unresolved. Must be checked in a real free-tier dashboard.
2. **The "admin-create + OAuth link" recipe is not documented as such.** Proven in source (`DetermineAccountLinking` → `LinkAccount` skips the `DisableSignup` check), and each half is documented separately, but Supabase never writes the composition down. **This should be covered by an integration test in the RLS test suite (map ticket #9 territory): invite a user, disable signups, assert Google OAuth succeeds for them and fails with `signup_disabled` for a stranger.**
3. **No empirical testing at all.** Everything here is docs + source reading. No live Supabase project was exercised. In particular: the exact query/fragment shape of the rejected-OAuth redirect, and whether `supabase-js` clears the params before our route reads them.
4. **The exact CLI command to push `enable_signup` to a linked project.** The CLI source clearly maps `config.toml` auth settings to Management API fields ([auth.go](https://github.com/supabase/cli/blob/7a16903c7b39fb7e4f01e03339c3c2b7dafc256b/apps/cli-go/pkg/config/auth.go)), and there is a `supabase config push` surface, but I did not verify the command name/flags against the CLI reference.
5. **Google Workspace / non-Gmail accounts** where the primary email may be reported unverified — automatic linking requires `email_verified`. Untested.
6. **Dashboard label** for creating a user without sending an invite email. The "Send invitation" flow is documented; the no-email flow's exact label is not.
7. **Whether `banned_until` is a better tool than deletion** for revoking a member. `ErrorCodeUserBanned` exists and is special-cased in the OAuth redirect alongside `signup_disabled` ([external.go:851-853](https://github.com/supabase/auth/blob/7691e9682e65347a3e8dc9420dca490e71cb6322/internal/api/external.go#L851-L853)), so it looks promising, but I did not research revocation — it's out of scope for #2 and worth its own look.

---

## Recommendation

**Mechanism A: turn off "Allow new users to sign up", and admit members with `admin.createUser` (no email needed).**

Concretely:

1. Set `enable_signup = false` in `supabase/config.toml`, committed to git, and mirrored in the dashboard. This is the entire gate.
2. Leave `[auth.hook.before_user_created]` **disabled**. Don't build it.
3. Admit a member by creating their `auth.users` row with their exact Google address — initially from the dashboard by hand (**Authentication → Users → Add user**), later from the admin Edge Function the map already plans.
4. Members sign in with Google. GoTrue's automatic identity linking matches their verified email to the row we created and links it — the signup gate is never reached because the decision is `LinkAccount`, not `CreateAccount`.
5. The SPA's OAuth callback route reads `error_code` from `window.location` and renders a "this is a private club" screen when it equals `signup_disabled`.

**Why this one:**

- **It is the only mechanism whose OAuth behaviour I could prove from the source in a single unambiguous branch** — [`case models.CreateAccount: if config.DisableSignup`](https://github.com/supabase/auth/blob/7691e9682e65347a3e8dc9420dca490e71cb6322/internal/api/external.go#L342-L345). No hook to deploy, time out, mis-configure, or return the wrong HTTP status from.
- **It genuinely closes signup.** A stranger's Google login leaves no `auth.users` row. The ticket's objection — "an account that exists but can do nothing is a poor answer" — is fully met.
- **It gives the best error surface.** `error_code=signup_disabled` is a stable, documented, machine-matchable code. The hook would give us a nicer default *message* but an *empty code* — worse for an SPA that renders its own copy.
- **It works on the free tier with certainty.** The hook's free-tier status is genuinely contradicted between two Supabase pages; `enable_signup` has no plan gate anywhere.
- **It sidesteps the free-tier SMTP trap entirely.** `inviteUserByEmail` would fail outright on a bare free-tier project (built-in SMTP refuses non-team addresses, and the send is inside the creating transaction, so a send failure rolls the user row back). `admin.createUser` sends no email and needs no SMTP. And for a Google-only club there's nothing to click in an invite email anyway.
- **Fewest moving parts is the right call for the smallest possible gate.** The map's principle is "if a convention can be a lint rule, it must be a lint rule" — but a security gate is not a convention. The gate should be the thing with the smallest surface area, and the CI integration test (item 2 in "could not verify") is what makes it machine-enforced.

**When to revisit:** if we ever want self-serve requests-to-join, expiring invites, or a per-person reason-for-rejection, the Before User Created hook (Postgres-function form, never HTTP) is the right upgrade path and the allowlist table it reads should live in migrations. Nothing in this recommendation forecloses that.
