-- Local development/test bootstrap. Run as a PostgreSQL superuser (docker-compose does this on first start).
-- Creates three least-privilege roles and the dev + test databases.
-- These passwords are LOCAL FIXTURES ONLY. Staging/prod roles are created by infrastructure with
-- generated secrets held in the secret manager (see docs/setup.md, "Environments").

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'pb_owner') then
    create role pb_owner login password 'pb_owner_dev';    -- owns schema, runs migrations
  end if;
  if not exists (select 1 from pg_roles where rolname = 'pb_app') then
    create role pb_app login password 'pb_app_dev';        -- API; subject to row-level security
  end if;
  if not exists (select 1 from pg_roles where rolname = 'pb_worker') then
    create role pb_worker login password 'pb_worker_dev';  -- outbox worker; subject to row-level security
  end if;
end
$$;

select 'create database pb_dev owner pb_owner'
where not exists (select 1 from pg_database where datname = 'pb_dev') \gexec
select 'create database pb_test owner pb_owner'
where not exists (select 1 from pg_database where datname = 'pb_test') \gexec
