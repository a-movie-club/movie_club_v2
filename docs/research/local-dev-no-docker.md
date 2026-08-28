# Research: local dev without Docker

**Ticket**: [#3](https://github.com/Foifoif/movie_club_v2/issues/3) · Part of map [#1](https://github.com/Foifoif/movie_club_v2/issues/1)
**Date**: 2026-08-28
**Status**: research complete, not merged (`research/` branches are primary sources, never merged to `main`)

> **Question**: What does a contributor run to get a working local dev environment, given Docker is off the table for the less-technical humans?

---

## Headline

The proposed shape — **each contributor gets their own free hosted Supabase project, migrations go up via `supabase db push`** — is **viable and verified**. Each contributor needs their **own Supabase account with their own Free organization**; a single shared org will not hold three free projects.

Two things the ticket did not anticipate:

1. **The Supabase CLI now has a Docker-free `--mode native`.** It is a first-class, non-experimental flag in the shipping CLI (v2.116.0) that runs Postgres + PostgREST + Auth as real native binaries. It is **not yet in the public docs**, ships for **darwin-arm64 / linux-amd64 / linux-arm64 only**, and `supabase db reset --local` is still Docker-only. Promising, but not yet safe as the default for less-technical humans.
2. **Branching is Pro-only and would cost real money.** Not justified. Details below.

---

## 1. Free Supabase projects per account/org

**Answer: 2 active free projects, and the quota is attached to the *user*, not just the org. One free hosted project per contributor is viable — but each contributor needs their own account and their own Free organization.**

Verbatim from the pricing page ([supabase.com/pricing](https://supabase.com/pricing)):

- "Limit of 2 active projects" on the Free plan
- "you can have as many paused projects as you want"
- "Free projects are paused after 1 week of inactivity"
- Free plan quotas: 500 MB database, 5 GB egress, 1 GB file storage, 50,000 MAU

The counting rule is the important part. From the [Billing FAQ](https://supabase.com/docs/guides/platform/billing-faq):

- "You are entitled to two active free projects."
- "Paused projects do not count towards your quota."
- "Note that within an organization, we count the free project limits from all members that are either Owner or Admin."
- "If you've got another organization member with the Admin or Owner role that has already exhausted their free project quota, you won't be able to launch another free project in that organization."
- "You can create another Free Plan organization or change the role of the affected member in your organization's team settings."

### What this means concretely

| Setup | Works? |
|---|---|
| One shared Free org, 3 contributor projects inside it | **No.** Hard cap of 2 active free projects per org. |
| Each contributor has their own Supabase account + own Free org + 1 project | **Yes.** Comfortably inside each person's 2-project entitlement. |
| Contributors invited as Members (not Owner/Admin) to a shared org | Doesn't help — the org still caps at 2 active free projects. |

**Recommendation: three separate Supabase accounts, three separate Free organizations, one project each.** No org sharing. This also means nobody can accidentally break anyone else's database, and the shared production project stays separate.

### The gotcha nobody will remember

**Free projects pause after 1 week of inactivity** ([supabase.com/pricing](https://supabase.com/pricing)). A contributor who takes a fortnight off comes back to a paused project and a confusing error. The onboarding docs must say: *if your project is paused, go to the dashboard and hit Restore, then re-run `supabase db push`.* This is a "restore from the dashboard" click, not a data loss event, but it will absolutely generate a support question. Worth putting in the wizard's output as a known-issue note.

---

## 2. `supabase db push` against a hosted project, without ever running `supabase start`

**Answer: yes, this works, and it does not touch Docker.**

### Verified from the CLI reference

[`supabase db push`](https://supabase.com/docs/reference/cli/supabase-db-push) — "Pushes all local migrations to a remote database." Flags:

- `--linked` — "Pushes to the linked project."
- `--db-url <string>` — "Pushes to the database specified by the connection string (must be percent-encoded)."
- `--dry-run` — "Print the migrations that would be applied, but don't actually apply them."
- `--include-all` — "Include all migrations not found on remote history table."
- `--include-seed` — "Include seed data from your config."
- `--include-roles` — "Include custom roles from supabase/roles.sql."

### Verified from the CLI source

Checked against `supabase/cli` at tag `v2.116.0` (latest release, published 2026-08-26):

- `apps/cli/src/legacy/commands/db/push/push.handler.ts` contains **no Docker reference at all**. It resolves the target flags and delegates to `legacyDbPushCore`.
- `apps/cli/src/legacy/shared/legacy-db-push-core.ts` references Docker only in `legacy-docker-ids.ts` naming helpers (string sanitisation for volume/container *ids*) — no container is spawned.
- `apps/cli/src/legacy/commands/db/push/push.layers.ts` does compose `legacyDockerRunLayer`, but solely as a dependency of `legacyEdgeRuntimeScriptLayer`. Effect layers are lazy, so the plain migration path never reaches a Docker spawn.

**Conclusion: `supabase link` + `supabase db push` is a Docker-free migration workflow.** A contributor never runs `supabase start`.

### What breaks or degrades without a local stack

This is the honest list. Everything here is a real loss, not a theoretical one.

| Command | Without local stack | Source |
|---|---|---|
| `supabase db push --linked` | **Works** | source-verified above |
| `supabase migration new <name>` | **Works** — just writes a timestamped empty `.sql` file | — |
| `supabase db pull` | Needs a shadow database → **Docker** | [local dev guide](https://supabase.com/docs/guides/local-development) |
| `supabase db diff` | "Compares a shadow built from `supabase/migrations` with a live database" — shadow DB is a Docker container | `apps/cli/src/legacy/commands/db/diff/diff.command.ts:105`; `diff.errors.ts` has explicit `docker_daemon` / `docker_not_running` failure modes |
| `supabase db reset --local` | **Docker only.** Asserts the local Postgres *container* is running via `docker container inspect` | `apps/cli/src/legacy/shared/db-bootstrap/local-db-running.ts:97-143` |
| `supabase test db` (pgTAP) | Needs local stack → **Docker** | [testing overview](https://supabase.com/docs/guides/local-development/testing/overview) |
| `supabase gen types --local` | "Requires the local development stack to be started by running `supabase start`" | [gen types reference](https://supabase.com/docs/reference/cli/supabase-gen-types) |
| RLS integration tests | **Cannot run locally.** See §7. | — |

**The single biggest degradation is `db diff`.** Without Docker, a contributor cannot auto-generate a migration by diffing their changed schema. They must **hand-write migration SQL** into `supabase/migrations/<timestamp>_name.sql`. For an agent-written codebase this is actually fine — writing DDL is exactly the kind of thing the agents do well, and hand-written migrations are more reviewable than generated ones. But it must be stated as the explicit convention, or a contributor will click around in the Studio UI, change the schema by hand, and produce drift that no migration file captures.

**Anti-drift rule worth making a convention:** schema changes are only ever made by writing a migration file and running `db push`. Never in the hosted Studio UI. There is a useful escape hatch if someone does drift: `supabase db reset --linked` — "Resets the linked project with local migrations" (`apps/cli/src/legacy/commands/db/reset/reset.command.ts:19`). Destructive, but it exists, and it is Docker-free, which makes it a genuinely good "un-break my project" button for the wizard.

---

## 3. Supabase Branching — free tier or Pro-only?

**Answer: Pro-only, and it costs real money per branch per hour. Do not use it. Plainly not justified for a hobby site.**

From [supabase.com/pricing](https://supabase.com/pricing):

- Branching is **not** included in the Free plan.
- Pro plan is "from $25/month".
- Branching is billed at **"$0.01344 per branch, per hour"**.

From [Manage Branching usage](https://supabase.com/docs/guides/platform/manage-your-usage/branching):

- "A branch running on the default Micro Compute size starts at $0.01344 per hour."
- Usage by Preview branches counts toward the subscription plan's quota.
- Branches are **not covered by the Spend Cap** — i.e. a forgotten branch keeps billing.

### The actual cost

| Scenario | Cost |
|---|---|
| Entry ticket (Pro plan, required before branching is even available) | **$25/month** |
| One preview branch left open for a 24h day | $0.32 |
| One preview branch open for a 30-day month | ~$9.68 |
| Three contributors, one open PR each, always-on | ~$29/month **on top of** the $25 Pro plan |

So the realistic floor is **$25/month** and the realistic running cost is **$30-55/month** for a private movie club site. Against a $0 alternative that works. **Declined.**

### Caveat on this finding — read before relying on it

There is a **discrepancy between two first-party Supabase pages**, and it should be re-checked before anyone acts on it:

- The **pricing page** states branching is a Pro-and-above add-on at $0.01344/branch/hour.
- The **[branching docs page](https://supabase.com/docs/guides/deployment/branching)** no longer states any plan requirement at all. It says "You can deploy directly from GitHub on any plan — connect your repository and changes pushed to `main` are automatically deployed to your project."

That "any plan" sentence is about **deploy-from-GitHub**, which is a *different and free* feature from **preview branches**. The branching page distinguishes them: "Preview branches are ephemeral... automatically deleted when a PR is merged or closed" vs "Persistent branches are long-lived and recommended for environments like staging, QA, or development."

I could not find a first-party page that states in one sentence "preview branches require Pro". The Pro-only claim rests on the pricing page and the usage/billing page. **Treat the plan gating as high-confidence but not bulletproof; treat the $0.01344/hour figure as well-sourced (it appears identically on two first-party pages).** Pricing changes often — re-verify before spending.

**Silver lining worth knowing:** the free "deploy directly from GitHub" integration — push to `main`, migrations auto-apply to the linked project — appears to be available on any plan. That is potentially a nice way to keep the *production* project in sync without a deploy step, and is worth a follow-up ticket. It is not a substitute for per-PR preview databases.

---

## 4. CI: spinning up local Supabase in GitHub Actions

**Answer: fully supported, boring, documented. GitHub-hosted Ubuntu runners have Docker preinstalled.**

### Docker on the runner — confirmed

From the `actions/runner-images` repo, `images/ubuntu/Ubuntu2404-Readme.md` (the image behind `ubuntu-latest`):

```
- Docker Compose 2.38.2
- Docker-Buildx 0.36.1
- Docker Client 28.0.4
- Docker Server 28.0.4
- Docker Amazon ECR Credential Helper 0.12.0
```

Docker client **and server** are preinstalled. No `docker/setup-*` action needed, no service container gymnastics.

**One trap:** GitHub also offers `ubuntu-slim` runners, which per the [GitHub-hosted runners reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) run "in unprivileged mode. This means that some operations requiring elevated privileges—such as mounting file systems, using Docker-in-Docker, or accessing low-level kernel features—are not supported." **Pin `runs-on: ubuntu-latest`, not `ubuntu-slim`.**

### The documented workflow shape

Supabase's own [testing overview](https://supabase.com/docs/guides/local-development/testing/overview) publishes this:

```yaml
name: Database Tests

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Setup Supabase CLI
        uses: supabase/setup-cli@v1
      - name: Start Supabase
        run: supabase start
      - name: Run Tests
        run: supabase test db
```

The [CI/CD testing guide](https://supabase.com/docs/guides/deployment/ci/testing) shows the same shape.

**Both official examples pin `supabase/setup-cli@v1`, which is stale.** The action's own [README](https://github.com/supabase/setup-cli) documents `supabase/setup-cli@v3` as current usage. Its only input is `version` — "Supabase CLI `latest`, `beta`, or fixed version", defaulting to "Root lockfile version or `latest`". Since the action auto-detects the version from `package-lock.json`/`pnpm-lock.yaml`/`bun.lock`, **installing `supabase` as a devDependency and letting the action read the lockfile keeps local and CI on the same CLI version for free.** That is a genuinely nice property and worth doing.

### Recommended workflow for this repo

`supabase test db` runs pgTAP, i.e. SQL-level tests. The map calls for **RLS integration tests**, which for a TanStack Query + `supabase-js` data layer are better written in TypeScript against the local stack, driving real auth'd clients. Supabase's testing overview explicitly blesses this second path: "Application-Level Testing: End-to-end verification through TypeScript/JavaScript code... this method cannot rely on transactions, so tests must use unique identifiers to remain independent."

```yaml
name: CI

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

jobs:
  verify:
    runs-on: ubuntu-latest   # NOT ubuntu-slim - no Docker-in-Docker there
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci

      # Reads the CLI version from package-lock.json, so CI and local match.
      - uses: supabase/setup-cli@v3

      - name: Start local Supabase
        run: supabase start

      # Applies every migration in supabase/migrations to a clean database,
      # then runs the seed. This is what proves the migrations are coherent
      # from zero - the hosted projects never test that path.
      - name: Apply migrations from scratch
        run: supabase db reset

      - name: Typecheck
        run: npm run typecheck

      - name: Lint
        run: npm run lint

      # Drift gate: the checked-in types must match the migrations.
      - name: Verify generated types are current
        run: |
          supabase gen types typescript --local > /tmp/database.types.ts
          diff -u src/lib/database.types.ts /tmp/database.types.ts

      - name: RLS integration tests
        run: npm run test:rls
        env:
          SUPABASE_URL: http://127.0.0.1:54321
          SUPABASE_PUBLISHABLE_KEY: sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH
          # The fixed local secret key - run `supabase status` to print it.
          # Not reproduced here: GitHub push protection blocks the literal.
          SUPABASE_SECRET_KEY: ${{ env.LOCAL_SECRET_KEY }}
```

**Those local keys are fixed constants, not secrets.** They are hardcoded in the CLI at `packages/stack/src/JwtGenerator.ts:5-6` as `defaultPublishableKey` / `defaultSecretKey`, and the same values appear in the `supabase status` output fixture at `apps/cli/src/legacy/commands/status/SIDE_EFFECTS.md:184-185`. **This means the CI job needs zero GitHub secrets.** A PR from a fork can run the full RLS suite. That is a real convenience and worth relying on.

**One practical wrinkle worth knowing before you write the workflow:** GitHub's push protection scans for the `sb_secret_` pattern and will **reject a push containing the literal local secret key**, even though it is a public constant shipped in the CLI source. It cannot tell the difference. The workable options are to read it at runtime (`supabase status -o json` after `supabase start`) rather than hardcoding it, or to store it as a repo secret purely to keep the scanner quiet. Prefer reading it from `supabase status` — it keeps the workflow honest and survives the CLI ever changing the constant. The publishable key is not flagged and can be inlined.

The local stack's fixed endpoints, from the same status fixture:

```
Project URL │ http://127.0.0.1:54321
REST        │ http://127.0.0.1:54321/rest/v1
DB URL      │ postgresql://postgres:postgres@127.0.0.1:54322/postgres
```

`supabase db reset` in CI is the step that earns its keep: it is the only place in the whole system where **migrations are proven to apply cleanly from an empty database**. Contributor hosted projects accrete migrations incrementally and will happily hide a migration that only works because of pre-existing state.

---

## 5. `.env.example` and pointing at your own project

### Key types — get the naming right, the old names are being retired

From [Understanding API keys](https://supabase.com/docs/guides/api/api-keys):

- **Publishable key** (`sb_publishable_...`): "Safe to expose online: web page, mobile or desktop app, GitHub actions, CLIs, source code."
- **Secret key** (`sb_secret_...`): elevated privileges, backend only. "You cannot use a secret key in the browser (matches on the `User-Agent` header) and it will always reply with HTTP 401 Unauthorized."
- The legacy JWT-format **`anon`** and **`service_role`** keys are **deprecated, with end-of-2026 as the stated horizon.**

Today is 2026-08-28. **v2 is a greenfield project and should use `sb_publishable_` / `sb_secret_` from commit one and never mention `anon`.** Any agent-generated code or doc that reaches for `SUPABASE_ANON_KEY` should be treated as stale. This is a good candidate for a lint rule per the map's standing principle.

This aligns exactly with the charted decision: "The Supabase publishable key is public by design; security lives in RLS."

### Proposed `.env.example`

```bash
# ─── Your own Supabase project ────────────────────────────────────────────────
# Each contributor has their OWN free Supabase project. Never share these,
# never point at production, never commit .env.local.
#
# Get these from: https://supabase.com/dashboard/project/_/settings/api
#
# Vite only exposes variables prefixed with VITE_ to browser code. That prefix
# is a promise that the value is public - never put a secret behind it.

VITE_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_xxxxxxxxxxxxxxxxxxxxxxxx

# ─── Local stack only (optional power path) ───────────────────────────────────
# If you run `supabase start`, use these instead. They are fixed, well-known
# development constants baked into the Supabase CLI - not secrets.
#
# VITE_SUPABASE_URL=http://127.0.0.1:54321
# VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH
```

The secret key (`sb_secret_...`) belongs to **Edge Function secrets** (`supabase secrets set`) and the CI environment. It must **never** appear in `.env.local`, because this is a static SPA — anything the Vite build can see, the browser can see.

### The contributor's first-run sequence

```bash
git clone <repo> && cd movie_club_v2
npm install                      # supabase CLI comes in as a devDependency

npx supabase login               # opens a browser, one time
npx supabase link --project-ref <their-own-ref>
npx supabase db push             # applies every migration to their project

cp .env.example .env.local       # then paste in their URL + publishable key
npm run dev
```

No Docker. Five commands, one browser login, one copy-paste of two values. **That is the answer to the ticket's question.** It is well within "`npm run dev` is the ceiling" if the wizard drives it.

---

## 6. Generated types: hosted vs local

From the [`supabase gen types` reference](https://supabase.com/docs/reference/cli/supabase-gen-types):

| Flag | Behaviour | Needs Docker? |
|---|---|---|
| `--local` | "Generate types from the local dev database" — "Requires the local development stack to be started by running `supabase start`" | **Yes** |
| `--linked` | "Generate types from the linked project" | **No** |
| `--project-id <ref>` | "Generate types from a project ID" | **No** |
| `--db-url <string>` | "Generate types from a database url" | **No** |

Other relevant flags: `--lang <typescript|go|swift|python>`, `-s, --schema <strings>` (comma-separated schemas to include), `--query-timeout <duration>`.

The `--linked` / `--project-id` / `--db-url` paths hit the Management API or connect directly to Postgres — no local stack, no container.

### Recommendation

```jsonc
// package.json
{
  "scripts": {
    // Default: works with no Docker, against the contributor's own project.
    "types:gen": "supabase gen types typescript --linked > src/lib/database.types.ts",
    // CI / power path: against the local stack.
    "types:gen:local": "supabase gen types typescript --local > src/lib/database.types.ts"
  }
}
```

**Check `src/lib/database.types.ts` into git**, and gate it in CI with the `--local` diff shown in §4. That combination is important and slightly subtle:

- Committing the file means agents and `tsc` always have types available with no generation step and no network.
- Generating with `--linked` locally means a contributor gets correct types right after `db push` with no Docker.
- Diffing against `--local` in CI means the committed types are verified against **the migrations**, not against whatever state one person's hosted project drifted into. If a contributor changed schema in the Studio UI and regenerated, CI catches it.

That last point makes the types check double as the **schema drift detector**, which is worth a lot given §2's warning. It is exactly the map's "if a convention can be a lint rule, it must be a lint rule" principle applied to schema.

---

## 7. The honest cost of the no-Docker default

**The ticket's framing is right — the loop becomes push → wait for CI — but the cost is smaller than it looks, for reasons specific to this project.**

### What actually cannot be done locally

Only one thing, but it is the important one: **RLS integration tests**. Those need multiple authenticated clients hitting real PostgREST with real JWTs, which needs the local stack.

Everything else in the inner loop stays local and fast: `npm run dev` against the hosted project, typecheck, lint, component tests, and — crucially — **manual verification of RLS by simply using the app while logged in as different users**. The hosted project has real RLS running. A policy that blocks the wrong thing shows up immediately in the browser as an empty list or a failed write. What you lose is the *automated regression proof*, not all feedback.

### Why the pain is bounded here

1. **RLS policy churn is front-loaded and rare.** Policies are written once per table, early. Day-to-day feature work — a new route, a chart, a filter — does not touch RLS at all, and its loop is unaffected.
2. **CI is fast.** `supabase start` + `db reset` + a small vitest suite is a few minutes on `ubuntu-latest`. That is a coffee, not a context switch.
3. **The two people who most need the fast loop can have it.** Jacob's machine and the agents running on it can use the Docker power path — or, increasingly, native mode (§8). The less-technical contributors are the ones least likely to be writing RLS policies in the first place.

### Where it genuinely hurts

**Agent iteration on a failing RLS test.** Agents fix RLS by trial and error — write policy, run test, read failure, adjust. At ~3 minutes per CI round trip that is a bad loop, and an agent will burn a lot of pushes on it. This is the real cost and it should not be waved away.

### Mitigations, in order of value

1. **The person writing RLS policies uses a stack.** Docker or native. RLS authoring is a power-path activity; make that explicit rather than pretending the no-Docker path covers everything.
2. **Native mode (§8) may erase this problem entirely for Apple Silicon and Linux contributors** — Postgres, PostgREST and Auth are precisely the three services RLS tests need.
3. **Split the CI workflow** so the RLS job runs independently of lint/typecheck, and fails fast with readable output. An agent reading a clean failure on the first CI run beats three fast local runs with a confusing error.
4. **Keep the RLS suite small and sharply named.** Its job is to prove "anon cannot write, authenticated can write only their own rows, admin can write everything" — the exact class of bug that made v1's `anon_all` a disaster. It is not a general integration suite.

### Verdict

**The no-Docker default is correct.** It is optimised for the contributors who would otherwise be blocked entirely, and the cost falls on an activity (RLS authoring) that is rare, front-loaded, and performed mostly by the person who has the power path anyway. The map's charted decision stands and does not need revisiting.

---

## 8. Unexpected finding: the CLI now has a Docker-free `--mode native`

This did not exist when the ticket was charted and may change the answer within months. Verified entirely from **source at tag `v2.116.0`** (latest release, 2026-08-26) because **it is not in the public documentation**.

### What it is

`supabase start --mode native` runs Supabase services as **native binaries**, no containers.

From `apps/cli/src/next/commands/start/start.command.ts:59`, the flag's own help text:

> "Stack startup mode. `native` requires native-compatible services and `docker` requires a usable Docker or Podman runtime."

And the command description (`start.command.ts:126`):

> "Starts the full local Supabase stack when Docker or Podman is usable; otherwise a supported host starts the native-capable service set. Use `--mode` to require one explicitly."

So **the fallback is already automatic**: on a supported host with no Docker, `supabase start` selects native mode by itself.

Corroborated by `packages/stack/README.md`:

> "When `mode` is omitted, creation uses Docker mode with a usable Docker or Podman service and otherwise selects native mode. An explicit mode never falls back to the other one."

And architecturally in `packages/stack/docs/architecture.md:260-265`:

> "`StackPreparation` resolves each enabled service to a verified native binary or a Docker image. Explicit `mode: "native"` uses the supported native services and rejects Docker-only services... that automatic fallback disables Docker-only services before ports or managed launch state are acquired."

ADR-0017 (`docs/adr/0017-simplified-managed-stack-architecture.md`, accepted 2026-08-17) confirms it is a persisted first-class concept: "Native launch state has `mode: "native"`; container launch state has `mode: "docker"`."

### Which services run natively

From `packages/stack/src/ServiceCatalog.ts`, each service carries `runtimeSupport: "native-preferred" | "docker-only"`:

| Native-preferred | Docker-only |
|---|---|
| `postgres`, `postgrest`, `auth` | `edge-runtime`, `realtime`, `storage`, `imgproxy`, `mailpit`, `pgmeta`, `studio`, `analytics`, `vector`, `pooler` |

**Postgres + PostgREST + Auth is exactly the set an RLS integration test needs.** No Studio, no Storage, no Edge Functions — but a `supabase-js` client authenticating a user and hitting PostgREST under RLS works with precisely these three.

### The binaries are real and actively published

`ServiceCatalog.ts:83-110` resolves native artifacts from `github.com/supabase/slim-services` releases (`.tar.zst` with `SHA256SUMS` and a per-asset manifest). That repo has frequent, current releases — `postgres-17.6.1.167` published 2026-08-28, `postgrest-v16.2`, plus `storage`, `realtime`, `studio` and `pooler` builds, 10 assets each. **This is a live, maintained artifact pipeline, not a prototype.**

Note that `slim-services` publishes native builds for services the CLI catalog *still* marks `docker-only` (storage, realtime, pooler, studio). Native coverage is clearly being expanded, and the docker-only list should be expected to shrink.

### Why it is not the recommendation *yet* — four hard blockers

1. **Platform coverage.** `packages/stack/src/Platform.ts:9-17`, with the code comment stating it outright:

   > "Native slim-service release targets. The release set intentionally has no windows or x64 macOS artifacts."

   Supported: `darwin-arm64`, `linux-amd64`, `linux-arm64`. **A contributor on Windows or an Intel Mac gets nothing.** Since the whole point is the less-technical contributors, and their hardware is currently unknown, this alone disqualifies it as the default.

2. **`supabase db reset --local` is still Docker-only.** `apps/cli/src/legacy/shared/db-bootstrap/local-db-running.ts:97-143` gates the reset on `docker container inspect` of the local Postgres container, falling back to Podman, and raises `LegacyResetLocalDbNotRunningError` otherwise. There is no `db reset` under `apps/cli/src/next/commands/` — only `start`, `stop`, `status`, `services`, `link`, `branches`, `functions` and friends have been ported. So in native mode the standard "apply all migrations to a clean local DB" command does not work. `supabase db push --local` is the likely workaround (push has no Docker dependency, per §2) but **I did not verify that push's `--local` target resolution works against a native-mode stack's ports** — see Unverified below.

3. **Undocumented.** [The local development guide](https://supabase.com/docs/guides/local-development) still states flatly: "A container manager compatible with Docker APIs is a prerequisite", listing Docker Desktop, Rancher Desktop, Podman and OrbStack. There is **no mention of native mode anywhere in the public docs.** A feature that exists in `--help` but not in the docs is one a vendor can still reshape without ceremony.

4. **Actively churning.** The `@supabase/stack` package is under heavy refactor right now — v2.117.0-beta.3 (2026-08-27) landed "**stack**: replace remote runtime protocol with Effect RPC", and ADR-0017 supersedes ADR-0015 wholesale after that design shipped nothing. This is a young subsystem being rebuilt in real time.

### How to treat it

**Not the default. A documented "try this" for Apple Silicon and Linux contributors, and a strong candidate to revisit in a few months.** If native mode gains Windows/Intel-Mac artifacts and a native `db reset`, it collapses the human-local and CI paths into one story and this entire ticket's tradeoff disappears. Worth a follow-up ticket to re-check, and worth watching `supabase/slim-services` for new platform targets.

**Do not put it in the wizard's happy path yet.** An undocumented flag that fails differently on three contributors' machines is precisely the kind of thing that burns the goodwill of a less-technical contributor on day one.

---

## Unverified / caveats

Flagging honestly, per the research discipline.

1. **Pricing and tier limits change often.** Every figure in §1 and §3 was read from `supabase.com/pricing` and the billing docs on **2026-08-28**. Re-verify before acting, especially before spending.

2. **Preview-branch plan gating has a first-party discrepancy** (detailed in §3). The pricing page says Pro-and-above; the branching docs page states no plan requirement and separately notes deploy-from-GitHub works "on any plan". The $0.01344/branch/hour figure is solid (two first-party pages agree). The *gating* is high-confidence, not certain.

3. **Whether a single shared Free org can hold 3 projects via different Owner/Admin members.** The FAQ wording — the quota is counted "from all members that are either Owner or Admin" — is genuinely ambiguous about whether entitlements pool. **I did not test this**, and the recommendation deliberately routes around the ambiguity by giving everyone their own org. Don't try to be clever here; the failure mode is a confused contributor on day one.

4. **`supabase db push --local` against a native-mode stack.** Push has no Docker dependency (source-verified), and native mode assigns ports through the managed stack document with sticky-port intent (`packages/stack/docs/service-versioning.md`). Whether push's `--local` target resolution picks up a native stack's actual port, or assumes the `config.toml` default of 54322, **I did not verify.** This matters only for the native power path, not the recommendation.

5. **I did not execute anything.** No `supabase start`, no `--mode native`, no `db push`, no CI run. Every claim is from official documentation or from reading `supabase/cli` at tag `v2.116.0`. The source-derived claims are strong (help text, service catalog, platform targets, key constants are all unambiguous in source) but a wizard-building session should smoke-test the five-command sequence in §5 on a real machine before shipping it to a human.

6. **Official CI examples pin `supabase/setup-cli@v1`** while the action's README documents `v3`. I recommend `v3` on the strength of the action's own README, but the docs pages have not been updated to match — a minor sign that these doc pages are not closely maintained.

7. **Contributor hardware is unknown.** Whether the two Codex-driving contributors are on Apple Silicon, Intel Macs, or Windows determines whether native mode is even a future option for them. **Worth asking before the wizard ticket.**

---

## RECOMMENDATION

### Human-local path (the default, no Docker)

**Three separate Supabase accounts, three separate Free organizations, one free project each.** Not a shared org — the 2-active-project cap makes that fail on the third contributor.

Contributor onboarding, to be automated by `/wizard`:

```bash
# One-time, per contributor
git clone <repo> && cd movie_club_v2
npm install                             # supabase CLI arrives as a devDependency

npx supabase login                      # browser, once
npx supabase link --project-ref <their-own-project-ref>
npx supabase db push                    # all migrations -> their project

cp .env.example .env.local              # paste in URL + sb_publishable_ key
npm run dev
```

Day-to-day:

```bash
npm run dev                             # against their own hosted project
npx supabase migration new <name>       # hand-write the SQL - no db diff without Docker
npx supabase db push                    # apply it
npm run types:gen                       # gen types typescript --linked
```

Conventions this path requires:
- **Migrations are hand-written.** `db diff` needs Docker. Never change schema in the hosted Studio UI.
- **`src/lib/database.types.ts` is committed**, generated with `--linked`, and drift-gated in CI against `--local`.
- **`sb_publishable_` / `sb_secret_` naming only.** Legacy `anon` / `service_role` are deprecated by end of 2026 — ban `SUPABASE_ANON_KEY` in lint.
- **Escape hatch for a drifted project:** `npx supabase db reset --linked` (destructive, Docker-free).
- **Known issue to document:** free projects pause after 1 week idle; restore from the dashboard.

The wizard must handle: creating the Supabase account, creating the project, finding the project ref, finding the publishable key, and writing `.env.local`. Those are the browser steps a human cannot avoid — and the only genuinely fiddly part of the whole path.

### Power path (optional, Jacob + agents)

```bash
supabase start          # Docker; full stack incl. Studio, Storage, Edge Functions
supabase db reset       # migrations from scratch + seed
npm run test:rls        # the fast RLS loop
```

Anyone authoring RLS policies should use this. On Apple Silicon or Linux, `supabase start --mode native` is worth trying as a Docker-free substitute — undocumented, no Windows/Intel-Mac support, and no working `db reset --local`, so treat it as experimental (§8).

### CI path (Docker, GitHub Actions)

`runs-on: ubuntu-latest` — **not `ubuntu-slim`**, which cannot do Docker-in-Docker. Docker client and server 28.0.4 are preinstalled; nothing extra to set up.

```
actions/checkout@v4
actions/setup-node@v4 + npm ci
supabase/setup-cli@v3        # reads CLI version from the lockfile - CI matches local
supabase start
supabase db reset            # proves migrations apply from an empty DB
npm run typecheck / lint
gen types --local + diff     # schema drift gate
npm run test:rls             # RLS integration tests
```

**Zero GitHub secrets required** — the local stack's publishable and secret keys are fixed constants baked into the CLI, so fork PRs run the full suite.

### Follow-ups worth their own tickets

1. **Ask what hardware the two Codex contributors are on.** Determines whether native mode is ever an option for them, and it blocks nothing else.
2. **Re-check native mode in ~3 months.** If Windows/Intel-Mac artifacts and a native `db reset` land, human-local and CI collapse into one story.
3. **Investigate free deploy-from-GitHub** for auto-applying migrations to production on merge to `main` — appears to be available on any plan (§3).
4. **Seed data** (already on the map's "not yet specified" list) — `supabase db push --include-seed` puts seed data in reach of the no-Docker path, which is a useful constraint for that ticket.

---

## Sources

All accessed 2026-08-28.

**Supabase docs & pricing (primary)**
- https://supabase.com/pricing
- https://supabase.com/docs/guides/platform/billing-faq
- https://supabase.com/docs/guides/platform/manage-your-usage/branching
- https://supabase.com/docs/guides/deployment/branching
- https://supabase.com/docs/guides/local-development
- https://supabase.com/docs/guides/local-development/testing/overview
- https://supabase.com/docs/guides/deployment/ci/testing
- https://supabase.com/docs/guides/api/api-keys
- https://supabase.com/docs/reference/cli/supabase-db-push
- https://supabase.com/docs/reference/cli/supabase-gen-types

**Source code (primary)**
- https://github.com/supabase/cli — read at tag `v2.116.0`
- https://github.com/supabase/slim-services — release list via GitHub API
- https://github.com/supabase/setup-cli — `action.yml` + `README.md` on `main`
- https://github.com/actions/runner-images — `images/ubuntu/Ubuntu2404-Readme.md`

**GitHub docs (primary)**
- https://docs.github.com/en/actions/reference/runners/github-hosted-runners

No blog posts or secondary write-ups were used.
