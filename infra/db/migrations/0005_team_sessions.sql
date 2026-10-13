-- Milestone 08: team access, session leases and handoff. ADR-0015.
--
-- profile_leases stays the profile's current lease (one row per profile, the authoritative fencing token), now with
-- an id per acquisition, a purpose, an explicit state and what the holder reports. A session lease that expires
-- without a release is *uncertain*: the old browser may still be open, so nobody else may start a session until the
-- holder confirms closure (it can revive or release its own lease) or an administrator forces a takeover. Upload
-- leases (backups of a closed profile, milestone 07) simply expire.
set search_path = app;

-- ------------------------------------------------------------------ current lease of each profile
alter table profile_leases
  add column id            text,
  add column purpose       text not null default 'upload' check (purpose in ('session', 'upload')),
  add column state         text not null default 'active'
    check (state in ('active', 'released', 'taken_over', 'revoked', 'superseded')),
  add column ttl_seconds   integer not null default 120 check (ttl_seconds between 30 and 600),
  add column heartbeat_at  timestamptz,
  -- What the holder last reported (audited on change): the run of the browser on its device.
  add column run_state     text check (run_state in ('starting', 'restoring', 'running', 'stopping', 'uploading', 'closed')),
  -- The holder device's name when it took the lease (co-members cannot read other people's devices).
  add column device_name   text check (length(device_name) between 1 and 120),
  add column platform      text check (platform ~ '^[a-z0-9-]{1,32}$'),
  add column browser_version text check (length(browser_version) between 1 and 64),
  add column ended_by      text references users(id),
  add column end_reason    text check (length(end_reason) between 1 and 500),
  -- Left by the holder when releasing, shown to whoever opens the profile next.
  add column handoff_note  text check (length(handoff_note) <= 500),
  add column handoff_note_by text references users(id),
  add column handoff_note_at timestamptz;
update profile_leases l set id = app.new_id('lse'),
  state = case when l.released_at is null then 'active' else 'released' end,
  device_name = (select d.name from devices d where d.id = l.holder_device_id);
alter table profile_leases alter column id set not null;
alter table profile_leases add constraint profile_leases_id_valid check (app.valid_id('lse', id));
alter table profile_leases add constraint profile_leases_id_key unique (id);
alter table profile_leases add constraint profile_leases_state_released
  check ((state = 'active') = (released_at is null));
create index profile_leases_holder_idx on profile_leases (org_id, holder_user_id) where state = 'active';
create index profile_leases_device_idx on profile_leases (holder_device_id) where state = 'active';

-- ------------------------------------------------------------------ lease history (one row per acquisition)
-- The audit trail of who held which fencing token, used to accept recovery copies from a previous holder and for
-- the contention report. Rows are never deleted while the profile exists.
create table lease_history (
  id               text primary key check (app.valid_id('lse', id)),
  org_id           text not null references organizations(id) on delete cascade,
  profile_id       text not null,
  purpose          text not null check (purpose in ('session', 'upload')),
  holder_user_id   text not null references users(id),
  holder_device_id text not null references devices(id),
  fencing_token    bigint not null unique,
  acquired_at      timestamptz not null default now(),
  ended_at         timestamptz,
  end_state        text check (end_state in ('released', 'taken_over', 'revoked', 'superseded')),
  end_reason       text check (length(end_reason) between 1 and 500),
  ended_by         text references users(id),
  foreign key (org_id, profile_id) references profiles (org_id, id) on delete cascade
);
create index lease_history_profile_idx on lease_history (org_id, profile_id, acquired_at desc);

-- ------------------------------------------------------------------ handoff requests
create table handoff_requests (
  id               text primary key check (app.valid_id('hrq', id)),
  org_id           text not null references organizations(id) on delete cascade,
  profile_id       text not null,
  requested_by     text not null references users(id),
  requested_device text references devices(id),
  -- The holder when the request was made (the request is addressed to them).
  holder_user_id   text references users(id),
  lease_id         text check (lease_id is null or app.valid_id('lse', lease_id)),
  note             text not null default '' check (length(note) <= 500),
  status           text not null check (status in ('open', 'declined', 'canceled', 'fulfilled', 'expired')),
  created_at       timestamptz not null default now(),
  responded_at     timestamptz,
  expires_at       timestamptz not null,
  unique (org_id, id),
  foreign key (org_id, profile_id) references profiles (org_id, id) on delete cascade,
  check ((status = 'open') = (responded_at is null))
);
create unique index handoff_requests_one_open on handoff_requests (profile_id, requested_by) where status = 'open';
create index handoff_requests_profile_idx on handoff_requests (org_id, profile_id, created_at desc);

-- ------------------------------------------------------------------ grant capabilities
-- What a grant lets an operator do with the granted profiles: open them (launch, including uploading their session),
-- edit their configuration, and download their backups (restore). Viewers' grants carry none. Permanent deletion,
-- export and sharing are never grantable: they stay with owners and admins.
alter table permission_grants
  add column capabilities text[] not null default '{launch,backup_download}'
    check (capabilities <@ array['launch', 'edit', 'backup_download']::text[]),
  add column updated_at timestamptz;
update permission_grants g set capabilities = '{}'
  from memberships m where m.org_id = g.org_id and m.user_id = g.user_id and m.role = 'viewer';
-- Existing operator grants keep what they allowed before (open and restore); new grants say what they allow.
alter table permission_grants alter column capabilities set default '{}';

-- ------------------------------------------------------------------ recovery copies
-- An upload from a device that lost its session lease (taken over, revoked) is kept as a recovery copy: verified like
-- any snapshot, never the head, restorable only as a separate copy by owners and admins, erased after the trash
-- period.
alter table snapshot_manifests drop constraint snapshot_manifests_status_check;
alter table snapshot_manifests add constraint snapshot_manifests_status_check
  check (status in ('pending', 'verifying', 'committed', 'failed', 'canceled', 'expired', 'deleted', 'legacy', 'recovery'));
alter table snapshot_manifests
  add column purpose text not null default 'snapshot' check (purpose in ('snapshot', 'recovery')),
  add column lease_id text check (lease_id is null or app.valid_id('lse', lease_id));
alter table snapshot_manifests add constraint snapshot_manifests_recovery_complete check (
  status <> 'recovery'
  or (purpose = 'recovery' and version is null and sha256 is not null and size_bytes is not null
      and wrapped_dek is not null and committed_at is not null));
alter table sync_operations drop constraint sync_operations_state_check;
alter table sync_operations add constraint sync_operations_state_check
  check (state in ('uploading', 'verifying', 'committed', 'kept', 'failed', 'canceled', 'expired'));

-- Recovery copies past the organization's trash period are marked deleted (erased by the worker's erase step).
create function app.expire_recovery_copies(p_limit integer)
  returns integer
  language plpgsql security definer set search_path = app, pg_temp
as $$
declare
  n integer;
begin
  with doomed as (
    select s.id, s.org_id, s.profile_id from snapshot_manifests s join organizations o on o.id = s.org_id
     where s.status = 'recovery' and s.committed_at < now() - make_interval(days => o.trash_days)
     limit greatest(1, least(p_limit, 1000))
  ), marked as (
    update snapshot_manifests s set status = 'deleted', deleted_at = now(), purge_after = now()
      from doomed d where s.id = d.id
    returning s.org_id, s.id, s.profile_id
  ), logged as (
    insert into audit_events (id, org_id, actor_user_id, actor_device_id, action, target_type, target_id, outcome,
                              request_id, details)
    select app.new_id('aud'), m.org_id, null, null, 'snapshot.expired', 'snapshot', m.id, 'success',
           app.new_id('req'), jsonb_build_object('profile_id', m.profile_id, 'reason', 'recovery_copy_expired')
      from marked m
    returning 1
  )
  select count(*)::integer into n from logged;
  return n;
end
$$;

-- A deleted recovery copy is erased like any deleted snapshot; the constraint above needs version for 'deleted'
-- committed snapshots only.
alter table snapshot_manifests drop constraint snapshot_manifests_committed_complete;
alter table snapshot_manifests add constraint snapshot_manifests_committed_complete check (
  status not in ('committed', 'deleted') or purpose = 'recovery'
  or (version is not null and sha256 is not null and size_bytes is not null and wrapped_dek is not null
      and key_version_id is not null and committed_at is not null));

-- ------------------------------------------------------------------ device revocation ends that device's leases
-- Called by the API when a person signs a device out everywhere (no organization context): every open lease that
-- device holds ends as 'revoked' with a new fencing token, so nothing it still sends can be written. Returns the
-- number of leases ended.
create function app.end_device_leases(p_device text, p_user text, p_reason text)
  returns integer
  language plpgsql security definer set search_path = app, pg_temp
as $$
declare
  n integer;
begin
  with ended as (
    update profile_leases l
       set state = 'revoked', released_at = now(), ended_by = p_user, end_reason = p_reason,
           fencing_token = nextval('lease_fencing_seq'), version = l.version + 1
     where l.holder_device_id = p_device and l.holder_user_id = p_user and l.state = 'active'
    returning l.id, l.org_id, l.profile_id
  ), history as (
    update lease_history h set ended_at = now(), end_state = 'revoked', end_reason = p_reason, ended_by = p_user
      from ended e where h.id = e.id
    returning 1
  ), logged as (
    insert into audit_events (id, org_id, actor_user_id, actor_device_id, action, target_type, target_id, outcome,
                              request_id, details)
    select app.new_id('aud'), e.org_id, p_user, null, 'lease.revoked', 'profile', e.profile_id, 'success',
           app.new_id('req'), jsonb_build_object('lease_id', e.id, 'reason', p_reason)
      from ended e
    returning 1
  )
  select count(*)::integer into n from ended;
  return n;
end
$$;

-- ------------------------------------------------------------------ row-level security and grants
alter table lease_history    enable row level security;
alter table handoff_requests enable row level security;
create policy tenant_isolation on lease_history
  using (org_id = app.current_org()) with check (org_id = app.current_org());
create policy tenant_isolation on handoff_requests
  using (org_id = app.current_org()) with check (org_id = app.current_org());

grant select, insert, update on lease_history to pb_app;
grant select, insert, update on handoff_requests to pb_app;
grant update on permission_grants to pb_app;
grant select on lease_history to pb_worker;

revoke all on function app.expire_recovery_copies(integer) from public;
revoke all on function app.end_device_leases(text, text, text) from public;
grant execute on function app.expire_recovery_copies(integer) to pb_worker;
revoke execute on function app.expire_recovery_copies(integer) from pb_app;
grant execute on function app.end_device_leases(text, text, text) to pb_app;
revoke execute on function app.end_device_leases(text, text, text) from pb_worker;
