-- Worker maintenance without granting the worker cross-tenant table access.
-- Expired idempotency keys are purged by an owner-defined function with a fixed body; the worker may only
-- execute it. search_path is pinned so the function cannot be hijacked by objects in other schemas.
set search_path = app;

create function app.purge_expired_idempotency_keys(max_rows integer default 1000)
  returns integer
  language sql
  security definer
  set search_path = app, pg_temp
as $$
  with doomed as (
    select org_id, operation, key from idempotency_keys
     where expires_at < now()
     order by expires_at
     limit greatest(1, least(max_rows, 10000))
  ), deleted as (
    delete from idempotency_keys k using doomed d
     where k.org_id = d.org_id and k.operation = d.operation and k.key = d.key
    returning 1
  )
  select count(*)::integer from deleted
$$;

revoke all on function app.purge_expired_idempotency_keys(integer) from public;
grant execute on function app.purge_expired_idempotency_keys(integer) to pb_worker;

-- Superseded by the function above: the worker no longer needs direct access.
revoke select, delete on idempotency_keys from pb_worker;
revoke select on organizations from pb_worker;
