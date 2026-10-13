-- Milestone 09: agency workspace (client tasks, shared bookmarks) and browser extension policy. ADR-0016.
--
-- Tasks and bookmarks belong to a client of the same organization (composite keys); a task may link one profile of
-- that client. They are app records: completing a task records that someone ticked it, nothing about what happened on
-- a website. The extension policy is the organization's allowlist/blocklist; devices report what is installed in each
-- profile so admins can decide. Health observations are device-local (SQLite), not stored here.
set search_path = app;

-- ------------------------------------------------------------------ client tasks
create table client_tasks (
  id           text primary key check (app.valid_id('tsk', id)),
  org_id       text not null references organizations(id) on delete cascade,
  client_id    text not null,
  profile_id   text,
  assignee_id  text,
  title        text not null check (length(title) between 1 and 200),
  notes        text not null default '' check (length(notes) <= 2000),
  status       text not null default 'open' check (status in ('open', 'in_progress', 'done')),
  due_at       timestamptz,
  created_by   text not null references users(id),
  completed_by text references users(id),
  completed_at timestamptz,
  version      integer not null default 1 check (version >= 1),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, client_id) references clients (org_id, id) on delete cascade,
  foreign key (org_id, profile_id) references profiles (org_id, id) on delete cascade,
  -- An assignee must stay a member; leaving the organization unassigns their tasks.
  foreign key (org_id, assignee_id) references memberships (org_id, user_id) on delete set null (assignee_id),
  check ((status = 'done') = (completed_at is not null))
);
create index client_tasks_client_idx on client_tasks (org_id, client_id, status, due_at nulls last, id);
create index client_tasks_assignee_idx on client_tasks (org_id, assignee_id) where status <> 'done';

-- ------------------------------------------------------------------ shared bookmarks (start-page templates)
create table client_bookmarks (
  id          text primary key check (app.valid_id('bkm', id)),
  org_id      text not null references organizations(id) on delete cascade,
  client_id   text not null,
  title       text not null check (length(title) between 1 and 120),
  -- http(s) only, no credentials, no whitespace or control characters (checked again by the API).
  url         text not null check (length(url) between 8 and 2048 and url ~ '^https?://[^\s@/]+(/[^\s]*)?$'),
  position    integer not null default 0 check (position between 0 and 999),
  created_by  text not null references users(id),
  version     integer not null default 1 check (version >= 1),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, client_id) references clients (org_id, id) on delete cascade
);
create index client_bookmarks_client_idx on client_bookmarks (org_id, client_id, position, id);

-- ------------------------------------------------------------------ extension policy
-- off: inventory only; warn: the app warns about extensions that are not approved; enforce: profiles with an
-- extension that is not approved open with extensions turned off.
alter table organizations
  add column extension_mode text not null default 'off' check (extension_mode in ('off', 'warn', 'enforce')),
  add column extension_policy_version integer not null default 1 check (extension_policy_version >= 1),
  add column extension_policy_updated_at timestamptz;

create table extension_policies (
  org_id                 text not null references organizations(id) on delete cascade,
  -- Chromium extension ids: 32 letters a-p.
  extension_id           text not null check (extension_id ~ '^[a-p]{32}$'),
  name                   text not null default '' check (length(name) <= 120),
  decision               text not null check (decision in ('allowed', 'blocked')),
  -- web_store: only when installed from the Chrome Web Store; any: from any supported source.
  source                 text not null default 'web_store' check (source in ('web_store', 'any')),
  -- Versions admins approved (null: any version). Forms: 1.2.3, 1.2.*, >=1.2 <2 (see ADR-0016).
  approved_version_range text check (approved_version_range is null or length(approved_version_range) between 1 and 64),
  -- Sensitive permissions admins approved; anything more waits for review.
  permissions            text[] not null default '{}' check (cardinality(permissions) <= 64),
  updated_by             text references users(id),
  updated_at             timestamptz not null default now(),
  primary key (org_id, extension_id)
);

-- What each device last reported for each profile (latest report per profile and device).
create table extension_reports (
  org_id       text not null references organizations(id) on delete cascade,
  profile_id   text not null,
  device_id    text not null references devices(id) on delete cascade,
  user_id      text not null references users(id),
  extensions   jsonb not null check (jsonb_typeof(extensions) = 'array' and jsonb_array_length(extensions) <= 200),
  reported_at  timestamptz not null default now(),
  primary key (org_id, profile_id, device_id),
  foreign key (org_id, profile_id) references profiles (org_id, id) on delete cascade
);

-- ------------------------------------------------------------------ row-level security and grants
alter table client_tasks       enable row level security;
alter table client_bookmarks   enable row level security;
alter table extension_policies enable row level security;
alter table extension_reports  enable row level security;
create policy tenant_isolation on client_tasks
  using (org_id = app.current_org()) with check (org_id = app.current_org());
create policy tenant_isolation on client_bookmarks
  using (org_id = app.current_org()) with check (org_id = app.current_org());
create policy tenant_isolation on extension_policies
  using (org_id = app.current_org()) with check (org_id = app.current_org());
create policy tenant_isolation on extension_reports
  using (org_id = app.current_org()) with check (org_id = app.current_org());

grant select, insert, update, delete on client_tasks to pb_app;
grant select, insert, update, delete on client_bookmarks to pb_app;
grant select, insert, update, delete on extension_policies to pb_app;
grant select, insert, update on extension_reports to pb_app;

-- The client dashboard lists recent app activity for one client and its profiles.
create index audit_events_target_idx on audit_events (org_id, target_id, created_at desc) where target_id is not null;
