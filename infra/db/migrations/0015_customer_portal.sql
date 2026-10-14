-- R4: public website, customer portal and checkout (ADR-0023). ADDITIVE: no table, column or route is dropped or
-- renamed. One check constraint of email_tasks is replaced to admit the new e-mail kinds.
--
--   1. More e-mail kinds (payment results, trial ending, contact requests and account deletion requests for the
--      owner's support address); the worker may queue e-mails too (billing results it applies).
--   2. checkout_attempts: at most one checkout being created or open per workspace, reused for the same plan and
--      interval, so a refresh or a second click (web or desktop) never makes a second checkout.
--   3. contact_requests: the website's contact form (platform table, the API only inserts).
--   4. notification_settings: per person, reminders about trials and renewals (essential mail is always sent).
--   5. account_deletion_requests: a person asks for their account to be deleted (processed by staff, R5).
--   6. app.billing_contacts: who receives a workspace's billing e-mails (owners and billing managers, verified).
set search_path = app;

-- ------------------------------------------------------------------ 1. e-mail kinds
alter table email_tasks drop constraint email_tasks_kind_check;
alter table email_tasks add constraint email_tasks_kind_check
  check (kind in ('invitation', 'welcome', 'payment_succeeded', 'payment_failed', 'trial_ending',
                  'contact_request', 'deletion_request'));
grant insert on email_tasks to pb_worker;

-- ------------------------------------------------------------------ 2. checkout attempts
create table checkout_attempts (
  id                  text primary key check (app.valid_id('chk', id)),
  org_id              text not null references organizations(id) on delete cascade,
  plan_id             text not null check (plan_id ~ '^[a-z][a-z0-9_]{1,31}$'),
  plan_version        integer not null check (plan_version >= 1),
  interval            text not null check (interval in ('month', 'year')),
  state               text not null default 'creating'
                      check (state in ('creating', 'open', 'completed', 'expired', 'replaced', 'failed')),
  provider_session_id text unique check (provider_session_id ~ '^cs_[A-Za-z0-9_]{1,250}$'),
  url                 text check (url ~ '^https?://' and length(url) <= 2000),
  expires_at          timestamptz,
  created_by          text references users(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  check (state <> 'open' or (provider_session_id is not null and url is not null and expires_at is not null))
);
-- One checkout in progress per workspace: a second request waits for it, reuses it or replaces it, never adds one.
create unique index checkout_attempts_active_uq on checkout_attempts (org_id) where state in ('creating', 'open');
create index checkout_attempts_org_idx on checkout_attempts (org_id, created_at desc);
alter table checkout_attempts enable row level security;
create policy tenant_isolation on checkout_attempts
  using (org_id = app.current_org()) with check (org_id = app.current_org());
grant select, insert, update on checkout_attempts to pb_app;
grant select, update on checkout_attempts to pb_worker;

-- ------------------------------------------------------------------ 3. contact requests (platform table)
create table contact_requests (
  id          bigint generated always as identity primary key,
  topic       text not null check (topic in ('sales', 'support', 'billing', 'security', 'privacy', 'other')),
  name        text not null check (length(name) between 1 and 120),
  email       text not null check (length(email) between 3 and 254 and email = lower(email)),
  message     text not null check (length(message) between 10 and 4000),
  created_at  timestamptz not null default now(),
  handled_at  timestamptz
);
grant insert on contact_requests to pb_app;              -- the API stores; staff tools read (R5)

-- ------------------------------------------------------------------ 4. notification settings
create table notification_settings (
  user_id            text primary key references users(id) on delete cascade,
  -- Trial-ending and renewal reminders. Security, invitations and payment results are always sent.
  billing_reminders  boolean not null default true,
  updated_at         timestamptz not null default now()
);
alter table notification_settings enable row level security;
create policy own_settings on notification_settings
  using (user_id = app.current_user_id()) with check (user_id = app.current_user_id());
grant select, insert, update on notification_settings to pb_app;

-- ------------------------------------------------------------------ 5. account deletion requests
create table account_deletion_requests (
  id          bigint generated always as identity primary key,
  user_id     text not null references users(id) on delete cascade,
  state       text not null default 'pending' check (state in ('pending', 'withdrawn', 'completed', 'rejected')),
  note        text check (length(note) <= 1000),
  created_at  timestamptz not null default now(),
  decided_at  timestamptz
);
create unique index account_deletion_requests_pending_uq on account_deletion_requests (user_id)
  where state = 'pending';
alter table account_deletion_requests enable row level security;
create policy own_requests on account_deletion_requests
  using (user_id = app.current_user_id()) with check (user_id = app.current_user_id());
grant select, insert on account_deletion_requests to pb_app;
grant update (state, decided_at) on account_deletion_requests to pb_app;

-- ------------------------------------------------------------------ 6. billing e-mail recipients
-- Owners and billing managers with a verified address and an active account. `p_reminder`: only those who did not
-- turn reminders off. Used by the worker (payment results, trial reminders); returns the addresses and the
-- workspace's name, nothing else.
create function app.billing_contacts(p_org text, p_reminder boolean)
  returns table (email text, org_name text)
  language sql stable security definer set search_path = app, pg_temp
as $$
  select distinct u.email, o.name
    from memberships m
    join organizations o on o.id = m.org_id
    join users u on u.id = m.user_id
    left join notification_settings ns on ns.user_id = u.id
   where m.org_id = p_org and m.role in ('owner', 'billing')
     and u.email is not null and u.email_verified and u.disabled_at is null
     and (not p_reminder or coalesce(ns.billing_reminders, true))
$$;
revoke all on function app.billing_contacts(text, boolean) from public;
grant execute on function app.billing_contacts(text, boolean) to pb_worker;

-- Workspaces whose free trial ends within `p_days` and that have not subscribed (trial-ending reminders).
create function app.trials_ending(p_days integer)
  returns table (org_id text, trial_ends_at timestamptz)
  language sql stable security definer set search_path = app, pg_temp
as $$
  select s.org_id, s.trial_ends_at from subscriptions s
   where s.state = 'trial' and s.provider_subscription_id is null
     and s.trial_ends_at > now() and s.trial_ends_at <= now() + make_interval(days => p_days)
   order by s.trial_ends_at limit 500
$$;
revoke all on function app.trials_ending(integer) from public;
grant execute on function app.trials_ending(integer) to pb_worker;
