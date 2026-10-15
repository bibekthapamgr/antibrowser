-- R6: the public readiness check reports whether the database schema is at least what the running API needs,
-- without giving the application role read access to the migration ledger itself (names and hashes only).
set search_path = app;

create function app.schema_version() returns text
  language sql stable security definer set search_path = app, pg_temp
as $$ select max(name) from public.schema_migrations $$;
revoke all on function app.schema_version() from public;
grant execute on function app.schema_version() to pb_app, pb_worker;
