-- Milestone 01 foundation schema.
-- Contracts: opaque server-generated ids, UTC timestamptz, version columns, org_id on every org-scoped row,
-- row-level security keyed by server-derived tenant context (app.org_id / app.user_id), transactional outbox,
-- idempotency keys and authoritative profile leases with fencing tokens.
-- Compatible with PostgreSQL 16+ (production baseline: 18). No version-specific features are used.

create schema if not exists app authorization pb_owner;
set search_path = app;

-- Id grammar shared with packages/contracts/src/ids.ts and crates/runtime.
create function app.valid_id(prefix text, value text) returns boolean
  language sql immutable strict parallel safe
  as $$ select value ~ ('^' || prefix || '_[0-9A-HJKMNP-TV-Z]{26}$') $$;

-- Tenant context helpers. current_setting(..., true) returns NULL when unset, so policies fail closed.
create function app.current_org() returns text language sql stable
  as $$ select nullif(current_setting('app.org_id', true), '') $$;
create function app.current_user_id() returns text language sql stable
  as $$ select nullif(current_setting('app.user_id', true), '') $$;

create table organizations (
  id          text primary key check (app.valid_id('org', id)),
  name        text not null check (length(name) between 1 and 120),
  version     integer not null default 1 check (version >= 1),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table users (
  id            text primary key check (app.valid_id('usr', id)),
  oidc_issuer   text not null,
  oidc_subject  text not null,
  display_name  text not null check (length(display_name) between 1 and 120),
  version       integer not null default 1,
  created_at    timestamptz not null default now(),
  unique (oidc_issuer, oidc_subject)
);

create table memberships (
  org_id      text not null references organizations(id) on delete cascade,
  user_id     text not null references users(id) on delete cascade,
  role        text not null check (role in ('owner', 'admin', 'manager', 'operator', 'viewer')),
  version     integer not null default 1,
  created_at  timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index memberships_user_idx on memberships (user_id);

create table devices (
  id          text primary key check (app.valid_id('dev', id)),
  user_id     text not null references users(id) on delete cascade,
  name        text not null check (length(name) between 1 and 80),
  platform    text not null check (platform in ('windows-x64', 'macos-arm64', 'macos-x64', 'linux-x64')),
  created_at  timestamptz not null default now(),
  revoked_at  timestamptz
);
create index devices_user_idx on devices (user_id);

create table profiles (
  id            text primary key check (app.valid_id('prf', id)),
  org_id        text not null references organizations(id) on delete cascade,
  name          text not null check (length(name) between 1 and 120),
  client_label  text check (length(client_label) between 1 and 120),
  folder_label  text check (length(folder_label) between 1 and 120),
  notes         text not null default '' check (length(notes) <= 2000),
  version       integer not null default 1 check (version >= 1),
  created_by    text not null references users(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);
create index profiles_page_idx on profiles (org_id, created_at, id) where deleted_at is null;

-- Authoritative leases. Expiry is judged only by the database clock (now()).
create sequence lease_fencing_seq as bigint minvalue 1 no cycle;
create table profile_leases (
  profile_id        text primary key references profiles(id) on delete cascade,
  org_id            text not null references organizations(id) on delete cascade,
  holder_device_id  text not null references devices(id),
  holder_user_id    text not null references users(id),
  fencing_token     bigint not null check (fencing_token > 0),
  version           integer not null default 1 check (version >= 1),
  acquired_at       timestamptz not null default now(),
  expires_at        timestamptz not null,
  released_at       timestamptz,
  check (expires_at > acquired_at)
);
-- A lease is held iff released_at is null and expires_at > now(). Rows are kept (not deleted) so the
-- per-profile lease version keeps increasing and the fencing token history stays auditable.
create index profile_leases_org_idx on profile_leases (org_id);

create table snapshot_manifests (
  id                 text primary key check (app.valid_id('snp', id)),
  org_id             text not null references organizations(id) on delete cascade,
  profile_id         text not null references profiles(id) on delete cascade,
  fencing_token      bigint not null,
  object_key         text not null unique,
  sha256             text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes         bigint not null check (size_bytes > 0),
  platform           text not null,
  browser_revision   text not null,
  encryption_scheme  text not null,
  key_id             text not null,
  created_by         text not null references users(id),
  created_at         timestamptz not null default now()
);
create index snapshot_manifests_profile_idx on snapshot_manifests (org_id, profile_id, created_at desc);

-- Idempotency: unique per (tenant, operation, key); the stored request digest must match on replay.
create table idempotency_keys (
  org_id           text not null references organizations(id) on delete cascade,
  operation        text not null,
  key              text not null check (key ~ '^[A-Za-z0-9_-]{8,128}$'),
  request_digest   text not null check (request_digest ~ '^[0-9a-f]{64}$'),
  response_status  integer not null,
  response_body    jsonb not null,
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null default now() + interval '24 hours',
  primary key (org_id, operation, key)
);
create index idempotency_keys_expiry_idx on idempotency_keys (expires_at);

-- Transactional outbox. Written by the API in the same transaction as the state change.
create table outbox_events (
  event_id           text primary key check (app.valid_id('evt', event_id)),
  org_id             text not null,
  actor_id           text not null,
  aggregate_id       text not null,
  aggregate_version  integer not null check (aggregate_version >= 1),
  event_type         text not null,
  created_at         timestamptz not null default now(),
  redacted_payload   jsonb not null default '{}'::jsonb,
  published_at       timestamptz,
  attempts           integer not null default 0,
  next_attempt_at    timestamptz not null default now(),
  last_error         text
);
create index outbox_pending_idx on outbox_events (next_attempt_at) where published_at is null;

create table processed_events (
  consumer      text not null,
  event_id      text not null,
  processed_at  timestamptz not null default now(),
  primary key (consumer, event_id)
);

-- Audit index, populated idempotently by the worker from outbox events.
create table audit_entries (
  id          text primary key check (app.valid_id('aud', id)),
  org_id      text not null references organizations(id) on delete cascade,
  actor_id    text not null,
  action      text not null,
  target_id   text not null,
  event_id    text not null unique,
  created_at  timestamptz not null
);
create index audit_entries_org_idx on audit_entries (org_id, created_at desc);

create table entitlements (
  org_id      text not null references organizations(id) on delete cascade,
  key         text not null,
  value       jsonb not null,
  version     integer not null default 1,
  updated_at  timestamptz not null default now(),
  primary key (org_id, key)
);

-- ------------------------------------------------------------------ Row-level security
alter table organizations      enable row level security;
alter table memberships        enable row level security;
alter table profiles           enable row level security;
alter table profile_leases     enable row level security;
alter table snapshot_manifests enable row level security;
alter table idempotency_keys   enable row level security;
alter table audit_entries      enable row level security;
alter table entitlements       enable row level security;

create policy org_member_read on organizations
  using (id = app.current_org()
         or exists (select 1 from memberships m where m.org_id = organizations.id and m.user_id = app.current_user_id()));

create policy membership_scope on memberships
  using (org_id = app.current_org() or user_id = app.current_user_id())
  with check (org_id = app.current_org());

create policy tenant_isolation on profiles           using (org_id = app.current_org()) with check (org_id = app.current_org());
create policy tenant_isolation on profile_leases     using (org_id = app.current_org()) with check (org_id = app.current_org());
create policy tenant_isolation on snapshot_manifests using (org_id = app.current_org()) with check (org_id = app.current_org());
create policy tenant_isolation on idempotency_keys   using (org_id = app.current_org()) with check (org_id = app.current_org());
create policy tenant_isolation on audit_entries      using (org_id = app.current_org()) with check (org_id = app.current_org());
create policy tenant_isolation on entitlements       using (org_id = app.current_org()) with check (org_id = app.current_org());

-- ------------------------------------------------------------------ Grants (least privilege)
grant usage on schema app to pb_app, pb_worker;
grant execute on all functions in schema app to pb_app, pb_worker;

grant select on organizations, users, devices to pb_app;
grant insert on devices to pb_app;
grant select on memberships to pb_app;
grant select, insert, update on profiles to pb_app;
grant select, insert, update on profile_leases to pb_app;
grant usage on sequence lease_fencing_seq to pb_app;
grant select, insert on snapshot_manifests to pb_app;
grant select, insert, update on idempotency_keys to pb_app;
grant insert on outbox_events to pb_app;          -- the API can enqueue but never read or alter the outbox
grant select on audit_entries, entitlements to pb_app;

grant select, update on outbox_events to pb_worker;
grant select, insert on processed_events to pb_worker;
grant select, insert on audit_entries to pb_worker;
grant select, delete on idempotency_keys to pb_worker;  -- expiry cleanup (per tenant, under RLS)
grant select on organizations to pb_worker;
