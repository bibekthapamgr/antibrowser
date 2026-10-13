-- Milestone 06: identity, organizations and authorization.
--
-- Adds verified identity on users, the final role set, clients with same-organization composite keys, devices with
-- device-bound sessions (rotating refresh tokens), invitations, client/profile permission grants, an append-only
-- security audit log and database-backed rate limits.
--
-- Tenant rules (ADR-0013):
--  * Every org-scoped row carries org_id; references between org-scoped rows are composite (org_id, id) foreign keys,
--    so a row can never point at another organization's client, profile or membership.
--  * Row-level security keys every tenant table on the transaction-local app.org_id / app.user_id (set_config(...,
--    true)); with no context set nothing is visible. The API role is not the owner and has no BYPASSRLS.
--  * Work that must happen before a tenant or user is known (sign-in, refresh, invitation acceptance, rate limits)
--    goes through owner-defined SECURITY DEFINER functions with fixed bodies and a pinned search_path. They are
--    revoked from PUBLIC and granted to the API role only.
set search_path = app;

-- ------------------------------------------------------------------ ids
-- Server-side id generation for rows created inside SQL (data migration only). Same grammar as packages/contracts.
create function app.new_id(prefix text) returns text language sql volatile
  as $$ select prefix || '_' || string_agg(substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ', 1 + floor(random() * 32)::int, 1), '')
          from generate_series(1, 26) $$;
revoke all on function app.new_id(text) from public;

-- ------------------------------------------------------------------ users: verified identity
alter table users
  add column email          text check (email is null or (length(email) between 3 and 254 and email = lower(email))),
  add column email_verified boolean not null default false,
  add column updated_at     timestamptz not null default now(),
  add column last_sign_in_at timestamptz,
  add column disabled_at    timestamptz;
create index users_email_idx on users (email) where email is not null;

-- ------------------------------------------------------------------ roles
-- Final role set: owner, admin, operator, viewer, billing. The milestone 01 draft role "manager" becomes admin.
update memberships set role = 'admin' where role = 'manager';
alter table memberships drop constraint memberships_role_check;
alter table memberships add constraint memberships_role_check
  check (role in ('owner', 'admin', 'operator', 'viewer', 'billing'));
alter table memberships add column updated_at timestamptz not null default now();

-- Every organization keeps at least one owner. Checked at commit (deferred), so an ownership transfer can add the new
-- owner and demote the old one in one transaction. Runs as the owner so it sees every membership of the org.
create function app.assert_org_has_owner() returns trigger
  language plpgsql security definer set search_path = app, pg_temp
as $$
declare
  org text := coalesce(old.org_id, new.org_id);
begin
  if exists (select 1 from organizations where id = org)
     and not exists (select 1 from memberships where org_id = org and role = 'owner') then
    raise exception 'LAST_OWNER' using errcode = 'P0001';
  end if;
  return null;
end
$$;
revoke all on function app.assert_org_has_owner() from public;
create constraint trigger memberships_keep_owner
  after update or delete on memberships
  deferrable initially deferred
  for each row execute function app.assert_org_has_owner();

-- ------------------------------------------------------------------ clients
create table clients (
  id          text primary key check (app.valid_id('cli', id)),
  org_id      text not null references organizations(id) on delete cascade,
  name        text not null check (length(name) between 1 and 120),
  -- Folded name (trim, NFKD, no combining marks, lower case) computed by the API, unique per organization.
  name_key    text not null check (length(name_key) between 1 and 480),
  colour      text check (colour ~ '^#[0-9a-f]{6}$'),
  archived_at timestamptz,
  version     integer not null default 1 check (version >= 1),
  created_by  text not null references users(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, name_key)
);
create index clients_page_idx on clients (org_id, created_at, id);

-- ------------------------------------------------------------------ profiles: owner organization and client
alter table profiles add constraint profiles_org_id_id_key unique (org_id, id);
alter table profiles add column client_id text;
alter table profiles add constraint profiles_client_same_org
  foreign key (org_id, client_id) references clients (org_id, id);
create index profiles_client_idx on profiles (org_id, client_id) where deleted_at is null;
create index profiles_name_idx on profiles (org_id, lower(name)) where deleted_at is null;

-- The milestone 01 free-text client label becomes a client; the folder label is dropped (tags are local, 04).
-- Labels that differ only in case, spacing or accents become one client. The folded key approximates the API's
-- (NFKD, combining diacritical marks U+0300-U+036F removed, lower case).
create function pg_temp.fold(label text) returns text language sql immutable
  as $$ select lower(regexp_replace(normalize(trim(label), NFKD), '[\u0300-\u036f]', '', 'g')) $$;
insert into clients (id, org_id, name, name_key, created_by)
select app.new_id('cli'), org_id, min(trim(client_label)), pg_temp.fold(client_label), min(created_by)
  from profiles
 where client_label is not null and length(trim(client_label)) > 0
 group by org_id, pg_temp.fold(client_label);
update profiles p set client_id = c.id
  from clients c
 where c.org_id = p.org_id and p.client_label is not null and c.name_key = pg_temp.fold(p.client_label);
alter table profiles drop column client_label, drop column folder_label;

-- ------------------------------------------------------------------ devices and sessions
alter table devices
  add column last_seen_at   timestamptz,
  add column revoked_reason text check (revoked_reason in ('user', 'sign_out_everywhere', 'admin', 'compromised')),
  add constraint devices_user_id_id_key unique (user_id, id);

-- One row per signed-in session of a device. The refresh token is `<session id>.<secret>`; only SHA-256 digests are
-- stored. Each refresh replaces the secret (rotation); presenting the previous secret again revokes the session
-- (reuse detection). Access tokens are short-lived JWTs that name the session, so revoking the session or the device
-- stops server operations at the next request.
create table device_sessions (
  id              text primary key check (app.valid_id('ses', id)),
  user_id         text not null references users(id) on delete cascade,
  device_id       text not null,
  refresh_hash    text not null check (refresh_hash ~ '^[0-9a-f]{64}$'),
  previous_hash   text check (previous_hash ~ '^[0-9a-f]{64}$'),
  generation      integer not null default 1 check (generation >= 1),
  auth_time       timestamptz not null,
  created_at      timestamptz not null default now(),
  last_used_at    timestamptz not null default now(),
  idle_expires_at timestamptz not null,
  expires_at      timestamptz not null,
  revoked_at      timestamptz,
  revoke_reason   text check (revoke_reason in ('sign_out', 'device_revoked', 'refresh_reuse', 'replaced', 'user_disabled')),
  foreign key (user_id, device_id) references devices (user_id, id) on delete cascade,
  check (expires_at > created_at)
);
create index device_sessions_device_idx on device_sessions (device_id) where revoked_at is null;

-- ------------------------------------------------------------------ invitations
create table invitations (
  id          text primary key check (app.valid_id('inv', id)),
  org_id      text not null references organizations(id) on delete cascade,
  -- The verified e-mail address the invitation is bound to.
  email       text not null check (length(email) between 3 and 254 and email = lower(email)),
  role        text not null check (role in ('admin', 'operator', 'viewer', 'billing')),
  token_hash  text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  created_by  text not null references users(id),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  accepted_at timestamptz,
  accepted_by text references users(id),
  revoked_at  timestamptz,
  revoked_by  text references users(id),
  version     integer not null default 1 check (version >= 1),
  unique (org_id, id),
  check (expires_at > created_at and expires_at <= created_at + interval '30 days'),
  check (accepted_at is null or revoked_at is null)
);
-- At most one open invitation per address and organization (expired ones are revoked before a new one is made).
create unique index invitations_one_open on invitations (org_id, email) where accepted_at is null and revoked_at is null;
create index invitations_page_idx on invitations (org_id, created_at, id);

-- ------------------------------------------------------------------ permission grants
-- Operators and viewers see and use only what they are granted: a whole client (all its profiles) or one profile.
-- Owners and admins have the whole organization; billing has no client or profile access. Removing a membership
-- removes its grants (composite FK to memberships).
create table permission_grants (
  id          text primary key check (app.valid_id('grt', id)),
  org_id      text not null references organizations(id) on delete cascade,
  user_id     text not null,
  client_id   text,
  profile_id  text,
  created_by  text not null references users(id),
  created_at  timestamptz not null default now(),
  check ((client_id is null) <> (profile_id is null)),
  foreign key (org_id, user_id) references memberships (org_id, user_id) on delete cascade,
  foreign key (org_id, client_id) references clients (org_id, id) on delete cascade,
  foreign key (org_id, profile_id) references profiles (org_id, id) on delete cascade,
  unique (org_id, id)
);
create unique index permission_grants_client_uq on permission_grants (org_id, user_id, client_id) where client_id is not null;
create unique index permission_grants_profile_uq on permission_grants (org_id, user_id, profile_id) where profile_id is not null;
create index permission_grants_user_idx on permission_grants (org_id, user_id);

-- ------------------------------------------------------------------ security audit
-- Append-only: the API may insert and read (its own tenant), never update or delete. Successful changes are written
-- in the same transaction as the change; denials and sign-in failures in their own transaction.
create table audit_events (
  id              text primary key check (app.valid_id('aud', id)),
  org_id          text references organizations(id) on delete cascade,
  actor_user_id   text check (actor_user_id is null or app.valid_id('usr', actor_user_id)),
  actor_device_id text check (actor_device_id is null or app.valid_id('dev', actor_device_id)),
  action          text not null check (action ~ '^[a-z_]+(\.[a-z_]+)+$' and length(action) <= 64),
  target_type     text check (target_type ~ '^[a-z_]{1,32}$'),
  target_id       text check (length(target_id) <= 64),
  outcome         text not null check (outcome in ('success', 'denied', 'failed')),
  request_id      text not null check (request_id ~ '^req_[0-9A-HJKMNP-TV-Z]{26}$'),
  details         jsonb not null default '{}'::jsonb check (length(details::text) <= 2000),
  created_at      timestamptz not null default now()
);
create index audit_events_org_idx on audit_events (org_id, created_at desc, id desc);
create index audit_events_actor_idx on audit_events (actor_user_id, created_at desc) where org_id is null;

-- ------------------------------------------------------------------ rate limits
-- Fixed-window counters shared by every API instance. Keys are SHA-256 digests (no raw IP addresses are stored).
create table rate_limit_counters (
  bucket       text not null check (bucket ~ '^[a-z_.]{1,40}$'),
  key_hash     text not null check (key_hash ~ '^[0-9a-f]{64}$'),
  window_start timestamptz not null,
  hits         integer not null default 0,
  primary key (bucket, key_hash)
);

-- One-time use of ID tokens: a verified ID token enrolls a device or re-authenticates exactly once, so a token copied
-- in transit cannot be replayed within its lifetime. Digests only; rows are dropped after the token expires.
create table used_id_tokens (
  token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null
);

-- ------------------------------------------------------------------ definer functions (pre-tenant work)
-- Returns true the first time a token digest is claimed, false on any replay.
create function app.claim_id_token(p_token_hash text, p_expires_at timestamptz) returns boolean
  language plpgsql security definer set search_path = app, pg_temp
as $$
declare
  n integer;
begin
  delete from used_id_tokens
   where ctid in (select ctid from used_id_tokens where expires_at < now() limit 100);
  insert into used_id_tokens (token_hash, expires_at) values (p_token_hash, p_expires_at) on conflict do nothing;
  get diagnostics n = row_count;
  return n = 1;
end
$$;

-- Sign-in: find or create the user for a verified OIDC identity. Matching is by (issuer, subject), never by e-mail.
create function app.upsert_oidc_user(p_new_id text, p_issuer text, p_subject text, p_email text,
                                     p_email_verified boolean, p_display_name text)
  returns table (user_id text, disabled boolean)
  language plpgsql security definer set search_path = app, pg_temp
as $$
begin
  if not app.valid_id('usr', p_new_id) then raise exception 'bad id'; end if;
  insert into users (id, oidc_issuer, oidc_subject, display_name, email, email_verified, last_sign_in_at)
  values (p_new_id, p_issuer, p_subject, p_display_name, p_email, coalesce(p_email_verified, false), now())
  on conflict (oidc_issuer, oidc_subject) do update set
    display_name = excluded.display_name,
    email = excluded.email,
    email_verified = excluded.email_verified,
    last_sign_in_at = now(),
    updated_at = now(),
    version = users.version + 1;
  return query select u.id, u.disabled_at is not null from users u
                where u.oidc_issuer = p_issuer and u.oidc_subject = p_subject;
end
$$;

-- Refresh-token rotation. Atomic per session (row lock). Outcomes:
--   rotated  - the presented secret was current; it is replaced by p_new_hash
--   reused   - the presented secret was the previous one: the session is revoked (token theft or a replayed request)
--   invalid  - unknown session or secret
--   revoked / expired / device_revoked / user_disabled
create function app.rotate_refresh_token(p_session_id text, p_presented_hash text, p_new_hash text,
                                         p_idle_seconds integer)
  returns table (outcome text, user_id text, device_id text, auth_time timestamptz, generation integer)
  language plpgsql security definer set search_path = app, pg_temp
as $$
declare
  s device_sessions%rowtype;
  dev_revoked boolean;
  user_off boolean;
begin
  select * into s from device_sessions where id = p_session_id for update;
  if not found then
    return query select 'invalid'::text, null::text, null::text, null::timestamptz, null::integer; return;
  end if;
  select d.revoked_at is not null into dev_revoked from devices d where d.id = s.device_id;
  select u.disabled_at is not null into user_off from users u where u.id = s.user_id;
  -- The device is checked first: revoking a device also ends its sessions, and the client should learn why.
  if dev_revoked then
    return query select 'device_revoked'::text, s.user_id, s.device_id, s.auth_time, s.generation; return;
  end if;
  if s.revoked_at is not null then
    return query select 'revoked'::text, s.user_id, s.device_id, s.auth_time, s.generation; return;
  end if;
  if user_off then
    update device_sessions set revoked_at = now(), revoke_reason = 'user_disabled' where id = s.id;
    return query select 'user_disabled'::text, s.user_id, s.device_id, s.auth_time, s.generation; return;
  end if;
  if s.expires_at <= now() or s.idle_expires_at <= now() then
    return query select 'expired'::text, s.user_id, s.device_id, s.auth_time, s.generation; return;
  end if;
  if p_presented_hash = s.refresh_hash then
    update device_sessions set previous_hash = s.refresh_hash, refresh_hash = p_new_hash,
           generation = s.generation + 1, last_used_at = now(),
           idle_expires_at = least(s.expires_at, now() + make_interval(secs => p_idle_seconds))
     where id = s.id;
    update devices set last_seen_at = now() where id = s.device_id;
    return query select 'rotated'::text, s.user_id, s.device_id, s.auth_time, s.generation + 1; return;
  end if;
  if p_presented_hash = s.previous_hash then
    update device_sessions set revoked_at = now(), revoke_reason = 'refresh_reuse' where id = s.id;
    return query select 'reused'::text, s.user_id, s.device_id, s.auth_time, s.generation; return;
  end if;
  return query select 'invalid'::text, null::text, null::text, null::timestamptz, null::integer;
end
$$;

-- Invitation preview by token digest (the holder of a token may see where it leads).
create function app.invitation_by_token(p_token_hash text)
  returns table (id text, org_id text, org_name text, email text, role text, expires_at timestamptz,
                 status text)
  language sql stable security definer set search_path = app, pg_temp
as $$
  select i.id, i.org_id, o.name, i.email, i.role, i.expires_at,
         case when i.revoked_at is not null then 'revoked'
              when i.accepted_at is not null then 'accepted'
              when i.expires_at <= now() then 'expired'
              else 'open' end
    from invitations i join organizations o on o.id = i.org_id
   where i.token_hash = p_token_hash
$$;

-- Accepting is atomic and single-use, and bound to the invited address: the user's verified e-mail (as stored from
-- the identity provider at sign-in) must equal the invitation's address.
create function app.accept_invitation(p_token_hash text, p_user_id text)
  returns table (outcome text, org_id text, role text, invitation_id text)
  language plpgsql security definer set search_path = app, pg_temp
as $$
declare
  inv invitations%rowtype;
  u users%rowtype;
begin
  select * into inv from invitations where token_hash = p_token_hash for update;
  if not found then return query select 'invalid'::text, null::text, null::text, null::text; return; end if;
  if inv.revoked_at is not null then return query select 'revoked'::text, null::text, null::text, inv.id; return; end if;
  if inv.accepted_at is not null then return query select 'used'::text, null::text, null::text, inv.id; return; end if;
  if inv.expires_at <= now() then return query select 'expired'::text, null::text, null::text, inv.id; return; end if;
  select * into u from users where id = p_user_id;
  if not found or u.disabled_at is not null then
    return query select 'invalid'::text, null::text, null::text, null::text; return;
  end if;
  if not u.email_verified or u.email is distinct from inv.email then
    return query select 'wrong_account'::text, null::text, null::text, inv.id; return;
  end if;
  if exists (select 1 from memberships m where m.org_id = inv.org_id and m.user_id = p_user_id) then
    return query select 'already_member'::text, inv.org_id, null::text, inv.id; return;
  end if;
  insert into memberships (org_id, user_id, role) values (inv.org_id, p_user_id, inv.role);
  update invitations set accepted_at = now(), accepted_by = p_user_id, version = version + 1 where id = inv.id;
  return query select 'accepted'::text, inv.org_id, inv.role, inv.id;
end
$$;

-- Fixed-window rate limit. Returns the hits in the current window after counting this one; the caller compares it with
-- its limit. Old windows are reset in place.
create function app.rate_limit_hit(p_bucket text, p_key_hash text, p_window_seconds integer)
  returns integer
  language plpgsql security definer set search_path = app, pg_temp
as $$
declare
  w timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  n integer;
begin
  insert into rate_limit_counters (bucket, key_hash, window_start, hits) values (p_bucket, p_key_hash, w, 1)
  on conflict (bucket, key_hash) do update set
    hits = case when rate_limit_counters.window_start = w then rate_limit_counters.hits + 1 else 1 end,
    window_start = w
  returning hits into n;
  return n;
end
$$;

-- Worker maintenance: drop counters of past windows.
create function app.purge_rate_limits(p_older_than_seconds integer default 86400)
  returns integer
  language sql security definer set search_path = app, pg_temp
as $$
  with deleted as (
    delete from rate_limit_counters where window_start < now() - make_interval(secs => p_older_than_seconds)
    returning 1)
  select count(*)::integer from deleted
$$;

revoke all on function app.upsert_oidc_user(text, text, text, text, boolean, text) from public;
revoke all on function app.rotate_refresh_token(text, text, text, integer) from public;
revoke all on function app.invitation_by_token(text) from public;
revoke all on function app.accept_invitation(text, text) from public;
revoke all on function app.rate_limit_hit(text, text, integer) from public;
revoke all on function app.purge_rate_limits(integer) from public;
revoke all on function app.claim_id_token(text, timestamptz) from public;
grant execute on function app.claim_id_token(text, timestamptz) to pb_app;
grant execute on function app.upsert_oidc_user(text, text, text, text, boolean, text) to pb_app;
grant execute on function app.rotate_refresh_token(text, text, text, integer) to pb_app;
grant execute on function app.invitation_by_token(text) to pb_app;
grant execute on function app.accept_invitation(text, text) to pb_app;
grant execute on function app.rate_limit_hit(text, text, integer) to pb_app;
grant execute on function app.purge_rate_limits(integer) to pb_worker;

-- ------------------------------------------------------------------ row-level security
alter table users             enable row level security;
alter table devices           enable row level security;
alter table device_sessions   enable row level security;
alter table clients           enable row level security;
alter table invitations       enable row level security;
alter table permission_grants enable row level security;
alter table audit_events      enable row level security;
alter table rate_limit_counters enable row level security;  -- no policy: only the definer functions touch it
alter table used_id_tokens    enable row level security;    -- no policy: only app.claim_id_token touches it

-- A user sees themself and the members of the organization in context.
create policy user_self_or_co_member on users for select
  using (id = app.current_user_id()
         or exists (select 1 from memberships m where m.user_id = users.id and m.org_id = app.current_org()));

create policy own_devices on devices
  using (user_id = app.current_user_id()) with check (user_id = app.current_user_id());
create policy own_sessions on device_sessions
  using (user_id = app.current_user_id()) with check (user_id = app.current_user_id());

-- Organizations: read where a member (milestone 01 policy); create/rename only inside their own context.
create policy org_insert on organizations for insert with check (id = app.current_org());
create policy org_update on organizations for update
  using (id = app.current_org()) with check (id = app.current_org());

-- Memberships: a user may read their own memberships across organizations (to list workspaces), but every write is
-- confined to the organization in context.
drop policy membership_scope on memberships;
create policy membership_read on memberships for select
  using (org_id = app.current_org() or user_id = app.current_user_id());
create policy membership_insert on memberships for insert with check (org_id = app.current_org());
create policy membership_update on memberships for update
  using (org_id = app.current_org()) with check (org_id = app.current_org());
create policy membership_delete on memberships for delete using (org_id = app.current_org());

create policy tenant_isolation on clients           using (org_id = app.current_org()) with check (org_id = app.current_org());
create policy tenant_isolation on invitations       using (org_id = app.current_org()) with check (org_id = app.current_org());
create policy tenant_isolation on permission_grants using (org_id = app.current_org()) with check (org_id = app.current_org());

create policy audit_read on audit_events for select
  using (org_id = app.current_org() or (org_id is null and actor_user_id = app.current_user_id()));
create policy audit_append on audit_events for insert
  with check ((org_id is null and actor_user_id is not distinct from app.current_user_id())
              or org_id = app.current_org());

-- ------------------------------------------------------------------ grants (least privilege)
grant insert, update on organizations to pb_app;
grant insert, update, delete on memberships to pb_app;
grant select, insert, update on devices to pb_app;
grant select, insert, update on device_sessions to pb_app;
grant select, insert, update on clients to pb_app;
grant select, insert, update on invitations to pb_app;
grant select, insert, delete on permission_grants to pb_app;
grant select, insert on audit_events to pb_app;     -- append-only: no update, no delete
