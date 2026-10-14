-- R2: self-service accounts and automatic onboarding (ADR-0021). ADDITIVE like R1: no table, column or route from
-- earlier milestones is dropped or renamed. One constraint added in R1 is replaced (see 1).
--
--   1. onboarding_state       gains the bootstrap mapping (one personal workspace per user, unique), the validated
--                             plan intent, attempt bookkeeping and the state `choose` (several owned workspaces: the
--                             person picks one, once). R1's coupling check (ready <=> default workspace) is dropped:
--                             with `on delete set null` it made deleting a default workspace fail.
--   2. user_consents          terms acceptance (versioned) kept apart from optional marketing consent; append-only.
--   3. trial_claims           one trial clock per verified e-mail address (and per user): further workspaces share
--                             it instead of starting a fresh trial. No application access except app.claim_trial.
--   4. organizations          `suspended_at`: a suspended workspace cannot be joined through an invitation and is
--                             never chosen as anyone's default.
--   5. web_sessions           the customer web portal's server-side sessions (backend-for-frontend): the cookie holds
--      web_auth_requests      a random secret, the database only its digest; pending sign-ins hold the PKCE verifier
--                             for at most 10 minutes and are taken once.
--   6. email_tasks            e-mails the worker sends (invitation links, welcome). Secret links are encrypted with
--                             a key the database never sees and erased once sent. Like the outbox: the API inserts,
--                             only the worker reads.
--   7. app.accept_invitation  refuses a suspended workspace and a full workspace (seats), everything else unchanged.
set search_path = app;

-- ------------------------------------------------------------------ 1. onboarding state
alter table onboarding_state drop constraint onboarding_state_check;
alter table onboarding_state drop constraint onboarding_state_state_check;
alter table onboarding_state add constraint onboarding_state_state_check
  check (state in ('new', 'invited', 'ready', 'choose'));
alter table onboarding_state
  -- The personal workspace the bootstrap created (at most one per user, and one user per workspace).
  add column bootstrap_org_id text unique references organizations(id) on delete set null,
  -- A plan chosen on the website before signing up; validated against the catalog, never a price.
  add column plan_intent      text check (plan_intent ~ '^[a-z][a-z0-9_]{1,31}$'),
  add column choice_made_at   timestamptz,
  add column attempts         integer not null default 0 check (attempts >= 0),
  add column last_error       text check (last_error ~ '^[A-Z0-9_]{1,64}$'),
  add column created_at       timestamptz not null default now();

-- (4. below) A suspended workspace; added first because the functions in 3 read it.
alter table organizations add column suspended_at timestamptz;

-- ------------------------------------------------------------------ 2. consents
create table user_consents (
  id       bigint generated always as identity primary key,
  user_id  text not null references users(id) on delete cascade,
  kind     text not null check (kind in ('terms', 'marketing')),
  version  text not null check (version ~ '^[A-Za-z0-9._-]{1,32}$'),
  granted  boolean not null,
  at       timestamptz not null default now(),
  -- Terms are accepted or not recorded at all; marketing consent can be given and withdrawn.
  check (kind = 'marketing' or granted)
);
create index user_consents_user_idx on user_consents (user_id, kind, at desc);
alter table user_consents enable row level security;
create policy own_consents on user_consents
  using (user_id = app.current_user_id()) with check (user_id = app.current_user_id());
grant select, insert on user_consents to pb_app;

-- ------------------------------------------------------------------ 3. trial clock per e-mail address
create table trial_claims (
  email_key     text primary key check (email_key ~ '^[0-9a-f]{64}$'),
  user_id       text references users(id) on delete set null,
  org_id        text references organizations(id) on delete set null,
  trial_ends_at timestamptz not null,
  claimed_at    timestamptz not null default now()
);
create unique index trial_claims_user_idx on trial_claims (user_id) where user_id is not null;

-- Called right after a workspace is created (its subscription row exists, made by app.billing_new_org). The first
-- workspace of an e-mail address keeps the trial it was given and records the clock; any later workspace of the same
-- person or address shares that clock (an already ended trial leaves the new workspace restricted until it
-- subscribes). Returns true when this workspace started the trial.
create function app.claim_trial(p_org text, p_user text)
  returns boolean
  language plpgsql security definer set search_path = app, pg_temp
as $$
declare
  u users%rowtype;
  s subscriptions%rowtype;
  key text;
  ends timestamptz;
begin
  select * into u from users where id = p_user;
  if not found or u.email is null or not u.email_verified then raise exception 'EMAIL_NOT_VERIFIED'; end if;
  select * into s from subscriptions where org_id = p_org for update;
  if not found or s.state <> 'trial' then return false; end if;
  key := encode(sha256(convert_to(lower(u.email), 'UTF8')), 'hex');
  insert into trial_claims (email_key, user_id, org_id, trial_ends_at)
  values (key, p_user, p_org, s.trial_ends_at)
  on conflict do nothing;
  if found then return true; end if;
  select min(c.trial_ends_at) into ends from trial_claims c where c.email_key = key or c.user_id = p_user;
  if ends is null or ends >= s.trial_ends_at then return false; end if;
  update subscriptions set trial_ends_at = ends, observed_state = case when ends <= now() then 'restricted'
                                                                       else observed_state end,
                           version = version + 1, updated_at = now()
   where org_id = p_org;
  insert into subscription_history (org_id, from_state, to_state, reason, plan_id, plan_version, cause)
  values (p_org, 'trial', case when ends <= now() then 'restricted' else 'trial' end,
          case when ends <= now() then 'trial_ended' else 'trial' end, s.plan_id, s.plan_version, 'trial_shared');
  return false;
end
$$;
revoke all on function app.claim_trial(text, text) from public;
grant execute on function app.claim_trial(text, text) to pb_app;

-- Existing trials keep counting: every owner's earliest trial workspace becomes their claim (verified addresses
-- only; nothing changes for workspaces that already exist).
insert into trial_claims (email_key, user_id, org_id, trial_ends_at, claimed_at)
select distinct on (k) k, user_id, org_id, trial_ends_at, created_at from (
  select encode(sha256(convert_to(lower(u.email), 'UTF8')), 'hex') as k, u.id as user_id, o.id as org_id,
         s.trial_ends_at, o.created_at
    from memberships m join users u on u.id = m.user_id join organizations o on o.id = m.org_id
    join subscriptions s on s.org_id = o.id
   where m.role = 'owner' and u.email is not null and u.email_verified and s.trial_ends_at is not null
) t
order by k, created_at, org_id
on conflict do nothing;

-- Whether a new workspace of this person would start a fresh trial.
create function app.trial_available(p_user text)
  returns boolean
  language sql stable security definer set search_path = app, pg_temp
as $$
  select not exists (
    select 1 from trial_claims c, users u
     where u.id = p_user
       and (c.user_id = p_user
            or (u.email is not null and c.email_key = encode(sha256(convert_to(lower(u.email), 'UTF8')), 'hex'))))
$$;
revoke all on function app.trial_available(text) from public;
grant execute on function app.trial_available(text) to pb_app;

-- Open invitations addressed to this person's VERIFIED e-mail (names and roles only, for the onboarding choice).
create function app.invitations_for_user(p_user text)
  returns table (org_name text, role text, expires_at timestamptz)
  language sql stable security definer set search_path = app, pg_temp
as $$
  select o.name, i.role, i.expires_at
    from users u join invitations i on i.email = u.email join organizations o on o.id = i.org_id
   where u.id = p_user and u.email_verified and i.accepted_at is null and i.revoked_at is null
     and i.expires_at > now() and o.suspended_at is null
     and not exists (select 1 from memberships m where m.org_id = i.org_id and m.user_id = p_user)
   order by i.created_at desc limit 20
$$;
revoke all on function app.invitations_for_user(text) from public;
grant execute on function app.invitations_for_user(text) to pb_app;

-- ------------------------------------------------------------------ 4. suspended workspaces

-- Whether another account with this verified address was disabled (a person whose account was suspended cannot
-- start over with a fresh identity and a fresh workspace).
create function app.email_suspended(p_user text)
  returns boolean
  language sql stable security definer set search_path = app, pg_temp
as $$
  select exists (select 1 from users me join users other on other.email = me.email and other.id <> me.id
                  where me.id = p_user and me.email is not null and other.disabled_at is not null)
$$;
revoke all on function app.email_suspended(text) from public;
grant execute on function app.email_suspended(text) to pb_app;

-- ------------------------------------------------------------------ 5. web portal sessions
create table web_sessions (
  id_hash         text primary key check (id_hash ~ '^[0-9a-f]{64}$'),
  user_id         text not null references users(id) on delete cascade,
  csrf_hash       text not null check (csrf_hash ~ '^[0-9a-f]{64}$'),
  auth_time       timestamptz not null,
  created_at      timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  idle_expires_at timestamptz not null,
  expires_at      timestamptz not null,
  revoked_at      timestamptz,
  revoke_reason   text check (revoke_reason in ('sign_out', 'rotated', 'revoke_all', 'user_disabled'))
);
create index web_sessions_user_idx on web_sessions (user_id) where revoked_at is null;
alter table web_sessions enable row level security;
create policy own_web_sessions on web_sessions
  using (user_id = app.current_user_id()) with check (user_id = app.current_user_id());
grant select, insert, update on web_sessions to pb_app;

-- The cookie's digest -> the session's user, when the session, the user and both lifetimes are still good; extends
-- the idle lifetime (bounded by the absolute one). Before the user is known, so it bypasses the per-user policy.
create function app.web_session_for_auth(p_hash text, p_idle_seconds integer)
  returns table (user_id text, csrf_hash text, auth_time timestamptz)
  language plpgsql security definer set search_path = app, pg_temp
as $$
begin
  return query
  update web_sessions w set last_seen_at = now(),
         idle_expires_at = least(w.expires_at, now() + make_interval(secs => p_idle_seconds))
    from users u
   where w.id_hash = p_hash and u.id = w.user_id and w.revoked_at is null
     and w.idle_expires_at > now() and w.expires_at > now() and u.disabled_at is null
  returning w.user_id, w.csrf_hash, w.auth_time;
end
$$;
revoke all on function app.web_session_for_auth(text, integer) from public;
grant execute on function app.web_session_for_auth(text, integer) to pb_app;

create table web_auth_requests (
  state_hash  text primary key check (state_hash ~ '^[0-9a-f]{64}$'),
  verifier    text not null check (length(verifier) between 43 and 128),
  nonce       text not null check (length(nonce) between 16 and 128),
  return_to   text not null check (length(return_to) <= 512 and return_to ~ '^/[A-Za-z0-9/_.#?=&%-]*$'
                                   and return_to !~ '^//'),
  created_at  timestamptz not null default now()
);
create function app.web_auth_begin(p_state_hash text, p_verifier text, p_nonce text, p_return_to text)
  returns void
  language sql security definer set search_path = app, pg_temp
as $$
  delete from web_auth_requests where created_at < now() - interval '10 minutes';
  insert into web_auth_requests (state_hash, verifier, nonce, return_to)
  values (p_state_hash, p_verifier, p_nonce, p_return_to);
$$;
create function app.web_auth_take(p_state_hash text)
  returns table (verifier text, nonce text, return_to text)
  language sql security definer set search_path = app, pg_temp
as $$
  delete from web_auth_requests r where r.state_hash = p_state_hash and r.created_at > now() - interval '10 minutes'
  returning r.verifier, r.nonce, r.return_to;
$$;
revoke all on function app.web_auth_begin(text, text, text, text) from public;
revoke all on function app.web_auth_take(text) from public;
grant execute on function app.web_auth_begin(text, text, text, text) to pb_app;
grant execute on function app.web_auth_take(text) to pb_app;

-- ------------------------------------------------------------------ 6. e-mail tasks
create table email_tasks (
  id              text primary key check (app.valid_id('eml', id)),
  org_id          text references organizations(id) on delete cascade,
  kind            text not null check (kind in ('invitation', 'welcome')),
  to_email        text not null check (length(to_email) between 3 and 254 and to_email = lower(to_email)),
  -- AES-256-GCM of the template variables (EMAIL_TASK_KEY, never stored here); erased once sent or given up.
  payload_enc     bytea,
  dedupe_key      text not null unique check (length(dedupe_key) between 1 and 200),
  state           text not null default 'pending' check (state in ('pending', 'sent', 'failed', 'skipped')),
  attempts        integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  last_error      text check (last_error ~ '^[a-z0-9_]{1,64}$'),
  created_at      timestamptz not null default now(),
  sent_at         timestamptz
);
create index email_tasks_due_idx on email_tasks (next_attempt_at) where state = 'pending';
grant insert on email_tasks to pb_app;              -- the API can enqueue but never read the queue
grant select, update on email_tasks to pb_worker;

-- Delivery status for the people it concerns, without the queue: did the invitation e-mail for this address go out?
create function app.email_task_state(p_dedupe_key text)
  returns table (state text, attempts integer, last_error text)
  language sql stable security definer set search_path = app, pg_temp
as $$
  select t.state, t.attempts, t.last_error from email_tasks t where t.dedupe_key = p_dedupe_key
$$;
revoke all on function app.email_task_state(text) from public;
grant execute on function app.email_task_state(text) to pb_app;

-- ------------------------------------------------------------------ 7. invitations: suspended or full workspaces
create or replace function app.accept_invitation(p_token_hash text, p_user_id text)
  returns table (outcome text, org_id text, role text, invitation_id text)
  language plpgsql security definer set search_path = app, pg_temp
as $$
declare
  inv invitations%rowtype;
  u users%rowtype;
  allowed bigint;
  members bigint;
begin
  select * into inv from invitations where token_hash = p_token_hash for update;
  if not found then return query select 'invalid'::text, null::text, null::text, null::text; return; end if;
  if inv.revoked_at is not null then return query select 'revoked'::text, null::text, null::text, inv.id; return; end if;
  -- R2: still 'used', but the person who accepted it learns which workspace (onboarding retries answer the same).
  if inv.accepted_at is not null then
    return query select 'used'::text,
                        case when inv.accepted_by = p_user_id then inv.org_id end, null::text, inv.id;
    return;
  end if;
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
  -- R2: an invitation never revives a suspended workspace.
  if exists (select 1 from organizations o where o.id = inv.org_id and o.suspended_at is not null) then
    return query select 'workspace_suspended'::text, null::text, null::text, inv.id; return;
  end if;
  -- R2: the seat this invitation reserved may be gone (a smaller plan since): members alone must leave room.
  perform 1 from subscriptions s where s.org_id = inv.org_id for update;
  allowed := app.billing_limit(inv.org_id, 'seats');
  select count(*) into members from memberships m where m.org_id = inv.org_id;
  if allowed is not null and members + 1 > allowed then
    return query select 'seats_full'::text, null::text, null::text, inv.id; return;
  end if;
  insert into memberships (org_id, user_id, role) values (inv.org_id, p_user_id, inv.role);
  update invitations set accepted_at = now(), accepted_by = p_user_id, version = version + 1 where id = inv.id;
  return query select 'accepted'::text, inv.org_id, inv.role, inv.id;
end
$$;
