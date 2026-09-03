-- Create the v2 schema: the entire v2 application lives here, invisible to
-- v1 (which stays in `public` until cutover). See map issue #1, ticket #6.
--
-- The schema must also be added to Exposed Schemas in the dashboard
-- (Settings → API) before PostgREST will serve it — that step is not
-- expressible as SQL; scripts/setup-v2-schema.sh walks it.

create schema if not exists v2;

-- PostgREST grants for an exposed custom schema, per
-- https://supabase.com/docs/guides/api/using-custom-schemas
grant usage on schema v2 to anon, authenticated, service_role;
grant all on all tables in schema v2 to anon, authenticated, service_role;
grant all on all routines in schema v2 to anon, authenticated, service_role;
grant all on all sequences in schema v2 to anon, authenticated, service_role;

-- Later tables/functions/sequences inherit the same grants automatically,
-- so no migration ever needs to repeat them.
alter default privileges for role postgres in schema v2
  grant all on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema v2
  grant all on routines to anon, authenticated, service_role;
alter default privileges for role postgres in schema v2
  grant all on sequences to anon, authenticated, service_role;
