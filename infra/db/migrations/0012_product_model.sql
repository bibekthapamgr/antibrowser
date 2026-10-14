-- R1: product contracts and safe migration foundation (ADR-0020). Everything here is ADDITIVE: no table, column or
-- route from earlier milestones is dropped or renamed. An organization is presented as a Workspace/Team; org_id stays
-- the tenant boundary everywhere.
--
--   1. onboarding_state       one row per user: where they are in self-service onboarding (R2 fills it; R1 reads it).
--   2. folders                optional organization of a workspace's profiles. A folder is NOT a grant scope and NOT a
--      profile_folders        client: clients keep their meaning (business metadata + grant scope), and moving a
--                             profile between folders changes nobody's access (ADR-0020).
--   3. feature_settings       per-workspace feature flags (the new UI, optional modules), versioned.
--   4. profile_identity_map   the authoritative mapping local profile (on a device) -> workspace profile. Adopting a
--                             local profile twice maps to the same workspace profile instead of creating a second one.
--   5. migration_runs         a device's migration run: manifest digest, state, checkpoint; re-runs are idempotent.
set search_path = app;

-- ------------------------------------------------------------------ 1. onboarding state
create table onboarding_state (
  user_id        text primary key references users(id) on delete cascade,
  -- new: signed in, no workspace yet; invited: joined through an invitation (no personal workspace needed);
  -- ready: has a default workspace.
  state          text not null check (state in ('new', 'invited', 'ready')),
  default_org_id text references organizations(id) on delete set null,
  completed_at   timestamptz,
  version        integer not null default 1 check (version >= 1),
  updated_at     timestamptz not null default now(),
  check ((state = 'ready') = (default_org_id is not null))
);
alter table onboarding_state enable row level security;
create policy own_onboarding on onboarding_state
  using (user_id = app.current_user_id()) with check (user_id = app.current_user_id());
grant select, insert, update on onboarding_state to pb_app;

-- ------------------------------------------------------------------ 2. folders
create table folders (
  id          text primary key check (app.valid_id('fld', id)),
  org_id      text not null references organizations(id) on delete cascade,
  name        text not null check (length(name) between 1 and 120),
  name_key    text not null,
  colour      text check (colour is null or colour ~ '^#[0-9a-f]{6}$'),
  position    integer not null default 0 check (position between 0 and 9999),
  archived_at timestamptz,
  created_by  text not null references users(id),
  version     integer not null default 1 check (version >= 1),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, name_key)
);

-- A profile is in at most one folder of its own workspace.
create table profile_folders (
  org_id     text not null references organizations(id) on delete cascade,
  profile_id text not null,
  folder_id  text not null,
  updated_at timestamptz not null default now(),
  primary key (org_id, profile_id),
  foreign key (org_id, profile_id) references profiles (org_id, id) on delete cascade,
  foreign key (org_id, folder_id) references folders (org_id, id) on delete cascade
);
create index profile_folders_folder_idx on profile_folders (org_id, folder_id);

alter table folders         enable row level security;
alter table profile_folders enable row level security;
create policy tenant_isolation on folders
  using (org_id = app.current_org()) with check (org_id = app.current_org());
create policy tenant_isolation on profile_folders
  using (org_id = app.current_org()) with check (org_id = app.current_org());
grant select, insert, update on folders to pb_app;
grant select, insert, update, delete on profile_folders to pb_app;

-- ------------------------------------------------------------------ 3. feature settings
-- Keys are dotted names (packages/contracts FEATURE_SETTINGS lists the known ones with their defaults). A value is
-- a JSON scalar or object; the API validates it against the key's schema.
create table feature_settings (
  org_id     text not null references organizations(id) on delete cascade,
  key        text not null check (key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,3}$'),
  value      jsonb not null,
  version    integer not null default 1 check (version >= 1),
  updated_by text references users(id),
  updated_at timestamptz not null default now(),
  primary key (org_id, key)
);
alter table feature_settings enable row level security;
create policy tenant_isolation on feature_settings
  using (org_id = app.current_org()) with check (org_id = app.current_org());
grant select, insert, update on feature_settings to pb_app;

-- ------------------------------------------------------------------ 4. profile identity map
-- One local profile (on one device) maps to at most one workspace profile, and a workspace profile is mapped at most
-- once per device. The map outlives the device's own link table: a reinstalled device learns its mapping back.
create table profile_identity_map (
  org_id           text not null references organizations(id) on delete cascade,
  device_id        text not null references devices(id) on delete cascade,
  local_profile_id text not null check (app.valid_id('prf', local_profile_id)),
  cloud_profile_id text not null,
  created_by       text not null references users(id),
  created_at       timestamptz not null default now(),
  primary key (device_id, local_profile_id),
  unique (org_id, device_id, cloud_profile_id),
  foreign key (org_id, cloud_profile_id) references profiles (org_id, id) on delete cascade
);
create index profile_identity_map_org_idx on profile_identity_map (org_id, cloud_profile_id);
alter table profile_identity_map enable row level security;
create policy tenant_isolation on profile_identity_map
  using (org_id = app.current_org()) with check (org_id = app.current_org());
grant select, insert on profile_identity_map to pb_app;

-- ------------------------------------------------------------------ 5. migration runs
create table migration_runs (
  id              text primary key check (app.valid_id('mgr', id)),
  org_id          text not null references organizations(id) on delete cascade,
  device_id       text not null references devices(id) on delete cascade,
  owner_id        text not null references users(id),
  -- SHA-256 (hex) of the device's migration manifest: the same manifest is the same run.
  manifest_digest text not null check (manifest_digest ~ '^[0-9a-f]{64}$'),
  state           text not null check (state in ('planned', 'running', 'completed', 'failed', 'rolled_back')),
  -- Where to resume: step name and the last finished batch (device-defined, bounded size).
  checkpoint      jsonb not null default '{}'::jsonb check (pg_column_size(checkpoint) <= 16384),
  -- Counts only (profiles seen, mapped, adopted, skipped); never names, cookies or secrets.
  counts          jsonb not null default '{}'::jsonb check (pg_column_size(counts) <= 4096),
  error_code      text check (error_code is null or error_code ~ '^[A-Z0-9_]{1,64}$'),
  version         integer not null default 1 check (version >= 1),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (device_id, manifest_digest)
);
create index migration_runs_org_idx on migration_runs (org_id, updated_at desc);
alter table migration_runs enable row level security;
create policy tenant_isolation on migration_runs
  using (org_id = app.current_org()) with check (org_id = app.current_org());
grant select, insert, update on migration_runs to pb_app;

comment on table folders is 'R1 (ADR-0020): optional organization of profiles; not a grant scope, not a client.';
comment on table profile_identity_map is 'R1: local profile (per device) -> workspace profile; adoption is idempotent through it.';
