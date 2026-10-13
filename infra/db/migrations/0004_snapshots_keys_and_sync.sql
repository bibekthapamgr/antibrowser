-- Milestone 07: encrypted snapshots, organization key versions, synchronization state, backup policy and trash.
-- ADR-0014. Envelope encryption: a root key (key provider) wraps per-organization key versions; each snapshot's data
-- key is wrapped by an organization key version and stored with the manifest. Plain data keys are never stored.
set search_path = app;

-- ------------------------------------------------------------------ organization key versions
create table organization_key_versions (
  id            text primary key check (app.valid_id('okv', id)),
  org_id        text not null references organizations(id) on delete cascade,
  version       integer not null check (version >= 1),
  kms_provider  text not null check (kms_provider ~ '^[a-z0-9-]{1,32}$'),
  -- The root key that wraps this version (re-wrapped when the root key rotates).
  kms_key_id    text not null check (kms_key_id ~ '^[A-Za-z0-9_:/.-]{1,200}$'),
  wrapped_key   bytea check (wrapped_key is null or length(wrapped_key) between 44 and 4096),
  status        text not null check (status in ('active', 'retired', 'destroyed')),
  created_at    timestamptz not null default now(),
  retired_at    timestamptz,
  destroy_after timestamptz,
  destroyed_at  timestamptz,
  unique (org_id, version),
  unique (org_id, id),
  check ((status = 'destroyed') = (wrapped_key is null)),
  check ((status = 'destroyed') = (destroyed_at is not null)),
  check (status = 'active' or retired_at is not null)
);
create unique index organization_key_versions_one_active on organization_key_versions (org_id) where status = 'active';

-- ------------------------------------------------------------------ backup policy (per organization)
alter table organizations
  add column backup_retention_days integer not null default 7 check (backup_retention_days between 1 and 90),
  add column trash_days integer not null default 30 check (trash_days between 1 and 90),
  -- Cost limits, set by the service operator (milestone 11 ties them to plans).
  add column backup_quota_bytes bigint not null default 21474836480 check (backup_quota_bytes > 0),
  add column max_snapshot_bytes bigint not null default 4294967296 check (max_snapshot_bytes > 0);

-- ------------------------------------------------------------------ profiles: snapshot head
alter table profiles
  add column snapshot_version integer not null default 0 check (snapshot_version >= 0),
  add column head_snapshot_id text,
  add column last_snapshot_at timestamptz;
create index profiles_trash_idx on profiles (org_id, deleted_at) where deleted_at is not null;

-- ------------------------------------------------------------------ snapshot manifests
-- Manifests committed through the milestone 01 contract had no stored object: they become 'legacy' and are never
-- offered for restore.
alter table snapshot_manifests
  alter column sha256 drop not null,
  alter column size_bytes drop not null,
  add column status text not null default 'legacy'
    check (status in ('pending', 'verifying', 'committed', 'failed', 'canceled', 'expired', 'deleted', 'legacy')),
  add column version integer check (version >= 1),
  add column base_version integer check (base_version >= 0),
  add column plaintext_size bigint check (plaintext_size >= 0),
  add column schema_version integer check (schema_version >= 1),
  -- The key version that wraps the data key now (changes when keys rotate) and the one recorded in the sealed file's
  -- header at upload (never changes; restores check the header against it).
  add column key_version_id text,
  add column sealed_key_version text check (sealed_key_version ~ '^okv_[0-9A-HJKMNP-TV-Z]{26}$'),
  add column wrapped_dek bytea check (wrapped_dek is null or length(wrapped_dek) between 44 and 1024),
  add column upload_id text check (length(upload_id) between 1 and 1024),
  add column part_size integer check (part_size > 0),
  add column device_id text references devices(id),
  add column committed_at timestamptz,
  add column deleted_at timestamptz,
  add column purge_after timestamptz,
  add column object_deleted_at timestamptz,
  add column error_code text check (error_code ~ '^[A-Z_]{1,64}$');
alter table snapshot_manifests alter column status drop default;
alter table snapshot_manifests add constraint snapshot_manifests_org_id_id_key unique (org_id, id);
alter table snapshot_manifests add constraint snapshot_manifests_profile_same_org
  foreign key (org_id, profile_id) references profiles (org_id, id) on delete cascade;
alter table snapshot_manifests add constraint snapshot_manifests_key_version_same_org
  foreign key (org_id, key_version_id) references organization_key_versions (org_id, id);
alter table snapshot_manifests add constraint snapshot_manifests_committed_complete check (
  status not in ('committed', 'deleted')
  or (version is not null and sha256 is not null and size_bytes is not null and wrapped_dek is not null
      and key_version_id is not null and committed_at is not null));
alter table snapshot_manifests add constraint snapshot_manifests_new_rows_have_keys check (
  status = 'legacy' or (wrapped_dek is not null and key_version_id is not null and sealed_key_version is not null
                        and base_version is not null and schema_version is not null));
create unique index snapshot_manifests_version_uq on snapshot_manifests (org_id, profile_id, version)
  where version is not null;
create index snapshot_manifests_status_idx on snapshot_manifests (status, purge_after)
  where status in ('failed', 'canceled', 'expired', 'deleted');
create index snapshot_manifests_key_idx on snapshot_manifests (org_id, key_version_id) where wrapped_dek is not null;

-- ------------------------------------------------------------------ synchronization operations
create table sync_operations (
  id              text primary key check (app.valid_id('syn', id)),
  org_id          text not null references organizations(id) on delete cascade,
  profile_id      text not null,
  snapshot_id     text not null unique,
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9_-]{8,128}$'),
  -- Replays of init must be the same request (digest of user, profile and body); the data key is never stored.
  request_digest  text not null check (request_digest ~ '^[0-9a-f]{64}$'),
  base_version    integer not null check (base_version >= 0),
  state           text not null check (state in ('uploading', 'verifying', 'committed', 'failed', 'canceled', 'expired')),
  error_code      text check (error_code ~ '^[A-Z_]{1,64}$'),
  user_id         text not null references users(id),
  device_id       text references devices(id),
  attempts        integer not null default 0 check (attempts >= 0),
  locked_until    timestamptz,
  expires_at      timestamptz not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (org_id, idempotency_key),
  foreign key (org_id, profile_id) references profiles (org_id, id) on delete cascade,
  foreign key (org_id, snapshot_id) references snapshot_manifests (org_id, id) on delete cascade
);
create index sync_operations_work_idx on sync_operations (state, locked_until) where state in ('uploading', 'verifying');
create index sync_operations_profile_idx on sync_operations (org_id, profile_id, created_at desc);

-- ------------------------------------------------------------------ row-level security
alter table organization_key_versions enable row level security;
alter table sync_operations           enable row level security;
create policy tenant_isolation on organization_key_versions
  using (org_id = app.current_org()) with check (org_id = app.current_org());
create policy tenant_isolation on sync_operations
  using (org_id = app.current_org()) with check (org_id = app.current_org());

-- ------------------------------------------------------------------ worker: cross-tenant discovery only
-- The worker finds due work with these fixed-body functions, then does the work inside a transaction scoped to that
-- organization (row-level security applies). It never gets cross-tenant table access.

-- Claims synchronization operations that need the worker: uploads to verify, and abandoned uploads to expire.
create function app.claim_sync_work(p_limit integer, p_lock_seconds integer)
  returns table (operation_id text, org_id text, state text)
  language sql security definer set search_path = app, pg_temp
as $$
  with due as (
    select o.id from sync_operations o
     where (o.state = 'verifying' or (o.state = 'uploading' and o.expires_at < now()))
       and (o.locked_until is null or o.locked_until < now())
     order by o.updated_at
     limit greatest(1, least(p_limit, 100))
     for update skip locked
  )
  update sync_operations o
     set locked_until = now() + make_interval(secs => greatest(10, least(p_lock_seconds, 3600))),
         attempts = o.attempts + case when o.state = 'verifying' then 1 else 0 end
    from due where o.id = due.id
  returning o.id, o.org_id, o.state
$$;

-- Snapshots whose stored object must be erased: failed, canceled or expired uploads, and deleted snapshots after
-- their grace period. Returns at most p_limit (org, snapshot) pairs.
create function app.snapshot_objects_to_erase(p_limit integer)
  returns table (org_id text, snapshot_id text)
  language sql stable security definer set search_path = app, pg_temp
as $$
  select s.org_id, s.id from snapshot_manifests s
   where s.object_deleted_at is null
     and (s.status in ('failed', 'canceled', 'expired') or (s.status = 'deleted' and s.purge_after < now()))
   order by s.created_at
   limit greatest(1, least(p_limit, 1000))
$$;

-- Applies each organization's retention policy: keeps a profile's newest committed snapshot, everything committed in
-- the last 24 hours, and the newest snapshot of each of the last `backup_retention_days` UTC days. Older snapshots
-- become 'deleted' (erased from storage after one day). Audited per snapshot. Returns the number marked.
create function app.apply_snapshot_retention(p_limit integer)
  returns integer
  language plpgsql security definer set search_path = app, pg_temp
as $$
declare
  n integer;
begin
  with ranked as (
    select s.org_id, s.id, s.profile_id, s.committed_at, p.head_snapshot_id, o.backup_retention_days,
           row_number() over (partition by s.profile_id, date_trunc('day', s.committed_at, 'UTC')
                              order by s.committed_at desc, s.id desc) as newest_of_day
      from snapshot_manifests s
      join profiles p on p.id = s.profile_id
      join organizations o on o.id = s.org_id
     where s.status = 'committed'
  ), doomed as (
    select r.org_id, r.id, r.profile_id from ranked r
     where r.id is distinct from r.head_snapshot_id
       and r.committed_at < now() - interval '24 hours'
       and not (r.newest_of_day = 1
                and r.committed_at >= date_trunc('day', now(), 'UTC') - make_interval(days => r.backup_retention_days - 1))
     limit greatest(1, least(p_limit, 1000))
  ), marked as (
    update snapshot_manifests s
       set status = 'deleted', deleted_at = now(), purge_after = now() + interval '1 day'
      from doomed d where s.id = d.id
    returning s.org_id, s.id, s.profile_id
  ), logged as (
    insert into audit_events (id, org_id, actor_user_id, actor_device_id, action, target_type, target_id, outcome,
                              request_id, details)
    select app.new_id('aud'), m.org_id, null, null, 'snapshot.expired', 'snapshot', m.id, 'success',
           app.new_id('req'), jsonb_build_object('profile_id', m.profile_id, 'reason', 'retention')
      from marked m
    returning 1
  )
  select count(*)::integer into n from logged;
  return n;
end
$$;

-- Deleted profiles whose trash period is over (the worker erases their snapshots, then the profile).
create function app.profiles_to_purge(p_limit integer)
  returns table (org_id text, profile_id text)
  language sql stable security definer set search_path = app, pg_temp
as $$
  select p.org_id, p.id from profiles p join organizations o on o.id = p.org_id
   where p.deleted_at is not null and p.deleted_at < now() - make_interval(days => o.trash_days)
   order by p.deleted_at
   limit greatest(1, least(p_limit, 500))
$$;

-- Organizations with key maintenance due: data keys still wrapped by a retired version, retired versions ready to
-- be scheduled for destruction or past their destruction date, or versions wrapped by an old root key.
create function app.orgs_with_key_work(p_active_root text, p_limit integer)
  returns table (org_id text)
  language sql stable security definer set search_path = app, pg_temp
as $$
  select distinct k.org_id from organization_key_versions k
   where k.status = 'retired'
      or (k.status <> 'destroyed' and k.kms_key_id <> p_active_root)
   limit greatest(1, least(p_limit, 1000))
$$;

-- The backup quota of one organization (the worker checks it when committing; it has no access to organizations).
create function app.org_backup_quota(p_org text)
  returns bigint
  language sql stable security definer set search_path = app, pg_temp
as $$
  select backup_quota_bytes from organizations where id = p_org
$$;

-- Whether a stored object key belongs to any manifest (orphan sweep).
create function app.snapshot_object_known(p_object_key text)
  returns boolean
  language sql stable security definer set search_path = app, pg_temp
as $$
  select exists (select 1 from snapshot_manifests where object_key = p_object_key)
$$;

revoke all on function app.claim_sync_work(integer, integer) from public;
revoke all on function app.snapshot_objects_to_erase(integer) from public;
revoke all on function app.apply_snapshot_retention(integer) from public;
revoke all on function app.profiles_to_purge(integer) from public;
revoke all on function app.orgs_with_key_work(text, integer) from public;
revoke all on function app.snapshot_object_known(text) from public;
revoke all on function app.org_backup_quota(text) from public;
grant execute on function app.org_backup_quota(text) to pb_worker;
grant execute on function app.claim_sync_work(integer, integer) to pb_worker;
grant execute on function app.snapshot_objects_to_erase(integer) to pb_worker;
grant execute on function app.apply_snapshot_retention(integer) to pb_worker;
grant execute on function app.profiles_to_purge(integer) to pb_worker;
grant execute on function app.orgs_with_key_work(text, integer) to pb_worker;
grant execute on function app.snapshot_object_known(text) to pb_worker;
-- 0001 granted execute on every function in the schema to both roles; these are the worker's alone.
revoke execute on function app.claim_sync_work(integer, integer) from pb_app;
revoke execute on function app.snapshot_objects_to_erase(integer) from pb_app;
revoke execute on function app.apply_snapshot_retention(integer) from pb_app;
revoke execute on function app.profiles_to_purge(integer) from pb_app;
revoke execute on function app.orgs_with_key_work(text, integer) from pb_app;
revoke execute on function app.snapshot_object_known(text) from pb_app;

-- ------------------------------------------------------------------ grants (least privilege)
grant select, insert, update on organization_key_versions to pb_app;
grant select, insert, update on sync_operations to pb_app;
grant update on snapshot_manifests to pb_app;

-- Worker: per-organization work under row-level security.
grant select, update on sync_operations to pb_worker;
grant select, update, delete on snapshot_manifests to pb_worker;
grant select, update on organization_key_versions to pb_worker;
grant select, update, delete on profiles to pb_worker;
grant select on profile_leases to pb_worker;
grant insert on outbox_events to pb_worker;
grant insert on audit_events to pb_worker;
