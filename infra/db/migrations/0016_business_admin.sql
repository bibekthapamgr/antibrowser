-- R5: business-owner administration and catalog publishing (ADR-0024). ADDITIVE: no table, column or route is dropped
-- or renamed. Check constraints of platform_staff, email_tasks and billing_alerts are replaced to admit new values;
-- app.billing_effective is replaced to apply staff payment restrictions.
--
--   1. Staff: three business roles (never granted here — the first platform owner is bootstrapped once with
--      `staff.ts bootstrap-owner`), a versioned role → permission table the database checks itself, the last active
--      platform owner cannot be removed, and console sessions record whether a second factor was used.
--   2. Catalog: the database is the runtime authority. Plan versions record where they came from (the code's seed or
--      an admin publication); plan_prices maps each version and interval to an immutable provider price; drafts and
--      publications track the publishing workflow (one running publication per plan; a failed one leaves nothing).
--   3. Restrictions: audited payment restrictions and security suspensions of workspaces and accounts, with reason,
--      scope and expiry. Payment restrictions narrow billing like an unpaid workspace; security suspensions stop all
--      access. Nothing is ever deleted.
--   4. Support-case notes (redacted by the API before storage), release action requests, worker heartbeats.
--   5. Billing facts for metrics: each subscription's price (amount, currency, interval, quantity, tax behavior) and
--      provider refunds.
--   6. Cross-workspace readers for the console (security definer, each checks the staff permission itself).
set search_path = app;

-- ------------------------------------------------------------------ 1. staff roles and permissions
alter table platform_staff drop constraint platform_staff_roles_check;
alter table platform_staff add constraint platform_staff_roles_check
  check (cardinality(roles) between 1 and 6
         and roles <@ array['support', 'support_lead', 'billing_admin',
                            'platform_owner', 'business_admin', 'business_analyst']::text[]);

alter table staff_sessions add column mfa boolean not null default false;

create table staff_role_permissions (
  role            text not null check (role in ('support', 'support_lead', 'billing_admin',
                                                'platform_owner', 'business_admin', 'business_analyst')),
  permission      text not null check (permission ~ '^admin\.[a-z_]+\.[a-z_]+$'),
  mapping_version integer not null check (mapping_version >= 1),
  primary key (role, permission)
);
-- Mapping version 1 (packages/contracts/src/admin.ts STAFF_ROLE_PERMISSIONS; a test keeps them identical).
insert into staff_role_permissions (role, permission, mapping_version) values
  ('support', 'admin.notes.read', 1), ('support', 'admin.notes.write', 1),
  ('support_lead', 'admin.notes.read', 1), ('support_lead', 'admin.notes.write', 1),
  ('support_lead', 'admin.operations.read', 1), ('support_lead', 'admin.operations.act', 1),
  ('billing_admin', 'admin.notes.read', 1), ('billing_admin', 'admin.notes.write', 1),
  ('billing_admin', 'admin.entitlements.exception', 1), ('billing_admin', 'admin.operations.read', 1),
  ('billing_admin', 'admin.operations.act', 1),
  ('business_analyst', 'admin.metrics.read', 1), ('business_analyst', 'admin.customers.read', 1),
  ('business_analyst', 'admin.catalog.read', 1), ('business_analyst', 'admin.operations.read', 1),
  ('business_analyst', 'admin.notes.read', 1);
insert into staff_role_permissions (role, permission, mapping_version)
select r.role, p.permission, 1
  from (values ('platform_owner'), ('business_admin')) r(role)
 cross join (values ('admin.metrics.read'), ('admin.customers.read'), ('admin.customers.contact'),
                    ('admin.restrictions.payment'), ('admin.restrictions.security'),
                    ('admin.entitlements.exception'), ('admin.catalog.read'), ('admin.catalog.edit'),
                    ('admin.catalog.publish'), ('admin.operations.read'), ('admin.operations.act'),
                    ('admin.notes.read'), ('admin.notes.write'), ('admin.staff.read'),
                    ('admin.releases.request')) p(permission)
 where r.role = 'platform_owner'
    or p.permission not in ('admin.restrictions.security', 'admin.staff.read', 'admin.releases.request');
grant select on staff_role_permissions to pb_app;

-- Whether the current user (app.user_id) is active staff with a permission. Every cross-workspace reader below
-- checks it again, so a mistake in an API route cannot open them to customers.
create function app.staff_has(p_permission text)
  returns boolean
  language sql stable security definer set search_path = app, pg_temp
as $$
  select exists (
    select 1 from platform_staff s
      join users u on u.id = s.user_id
      join staff_role_permissions r on r.role = any(s.roles)
     where s.user_id = app.current_user_id() and s.disabled_at is null and u.disabled_at is null
       and r.permission = p_permission)
$$;
revoke all on function app.staff_has(text) from public;
grant execute on function app.staff_has(text) to pb_app;

create function app.staff_require(p_permission text)
  returns void
  language plpgsql stable security definer set search_path = app, pg_temp
as $$
begin
  if not app.staff_has(p_permission) then
    raise exception 'STAFF_FORBIDDEN' using detail = p_permission;
  end if;
end
$$;
revoke all on function app.staff_require(text) from public;
grant execute on function app.staff_require(text) to pb_app;

-- The last active platform owner cannot lose the role, be disabled or be removed (a second owner first).
create function app.protect_last_platform_owner() returns trigger
  language plpgsql security definer set search_path = app, pg_temp
as $$
declare
  was_owner boolean := 'platform_owner' = any(old.roles) and old.disabled_at is null;
  still_owner boolean := false;
begin
  if tg_op = 'UPDATE' then
    still_owner := 'platform_owner' = any(new.roles) and new.disabled_at is null;
  end if;
  if was_owner and not still_owner then
    perform 1 from platform_staff where user_id <> old.user_id and 'platform_owner' = any(roles)
                                    and disabled_at is null
      for update;
    if not found then
      raise exception 'LAST_PLATFORM_OWNER';
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end
$$;
create trigger protect_last_platform_owner before update or delete on platform_staff
  for each row execute function app.protect_last_platform_owner();

-- ------------------------------------------------------------------ 2. catalog: the database is the authority
alter table plans add column source text not null default 'seed' check (source in ('seed', 'admin'));
alter table plans add column published_at timestamptz;
alter table plans add column published_by text references users(id) on delete set null;
update plans set published_at = created_at where published_at is null;
alter table plans alter column published_at set default now();
alter table plans alter column published_at set not null;

-- A stored plan version never changes (customers bought it): a new version is published instead.
create function app.plans_immutable() returns trigger
  language plpgsql set search_path = app, pg_temp
as $$
begin
  raise exception 'PLAN_VERSION_IMMUTABLE' using detail = old.id || '@' || old.version;
end
$$;
create trigger plans_immutable before update or delete on plans
  for each row execute function app.plans_immutable();

-- One row: increases with every publication (pricing caches revalidate); the provider portal configuration that
-- offers the current prices (null: the server's configured or the account's default).
create table catalog_state (
  singleton            boolean primary key default true check (singleton),
  generation           bigint not null default 0 check (generation >= 0),
  portal_configuration text check (portal_configuration ~ '^bpc_[A-Za-z0-9]{1,64}$'),
  updated_at           timestamptz not null default now()
);
insert into catalog_state (singleton) values (true);

create table plan_prices (
  plan_id             text not null,
  plan_version        integer not null,
  interval            text not null check (interval in ('month', 'year')),
  currency            text not null check (currency ~ '^[a-z]{3}$'),
  amount_minor        bigint not null check (amount_minor > 0),
  provider_price_id   text not null unique check (provider_price_id ~ '^price_[A-Za-z0-9_]{1,80}$'),
  provider_product_id text not null check (length(provider_product_id) between 3 and 80),
  created_at          timestamptz not null default now(),
  primary key (plan_id, plan_version, interval),
  foreign key (plan_id, plan_version) references plans (id, version)
);

create table plan_drafts (
  id                text primary key check (app.valid_id('pld', id)),
  plan_id           text not null check (plan_id ~ '^[a-z][a-z0-9_]{1,31}$'),
  base_version      integer check (base_version >= 1),
  name              text not null check (length(name) between 1 and 60),
  description       text not null check (length(description) <= 200),
  purchasable       boolean not null,
  limits            jsonb not null check (jsonb_typeof(limits) = 'object'),
  features          jsonb not null check (jsonb_typeof(features) = 'object'),
  prices            jsonb not null default '[]'::jsonb check (jsonb_typeof(prices) = 'array'),
  state             text not null default 'draft' check (state in ('draft', 'publishing', 'published', 'discarded')),
  revision          integer not null default 1 check (revision >= 1),
  published_version integer,
  last_error        text check (length(last_error) <= 200),
  created_by        text not null references users(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index plan_drafts_plan_idx on plan_drafts (plan_id, created_at desc);

create table catalog_publications (
  id                  text primary key check (app.valid_id('cpo', id)),
  draft_id            text not null references plan_drafts(id),
  draft_revision      integer not null,
  plan_id             text not null,
  version             integer not null check (version >= 1),
  state               text not null default 'running' check (state in ('running', 'succeeded', 'failed')),
  provider_product_id text,
  prices              jsonb not null default '[]'::jsonb,
  error               text check (length(error) <= 200),
  started_by          text not null references users(id),
  started_at          timestamptz not null default now(),
  finished_at         timestamptz
);
-- One publication at a time per plan (two clicks, two tabs or two staff members); one non-failed per draft revision.
create unique index catalog_publications_running_uq on catalog_publications (plan_id) where state = 'running';
create unique index catalog_publications_revision_uq on catalog_publications (draft_id, draft_revision)
  where state <> 'failed';
create index catalog_publications_at_idx on catalog_publications (started_at desc);

grant select, update on catalog_state to pb_app;
grant select on catalog_state, plan_prices to pb_worker;
grant select, insert on plan_prices to pb_app;
grant insert on plans to pb_app;
grant select, insert, update on plan_drafts, catalog_publications to pb_app;

-- ------------------------------------------------------------------ 3. restrictions
create table account_restrictions (
  id          text primary key check (app.valid_id('rst', id)),
  kind        text not null check (kind in ('payment', 'security')),
  scope       text not null check (scope in ('workspace', 'account')),
  org_id      text references organizations(id) on delete cascade,
  user_id     text references users(id) on delete cascade,
  reason      text not null check (length(reason) between 20 and 500),
  created_by  text not null references users(id),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz,
  lifted_at   timestamptz,
  lifted_by   text references users(id),
  lift_reason text check (length(lift_reason) between 20 and 500),
  notified    boolean not null default false,
  -- Expiry processed (a security suspension's effects undone by the worker).
  expired_at  timestamptz,
  check (scope <> 'workspace' or org_id is not null),
  check (scope <> 'account' or (user_id is not null and kind = 'security')),
  check (expires_at is null or (expires_at > created_at and expires_at <= created_at + interval '366 days')),
  check ((lifted_at is null) = (lifted_by is null))
);
create index account_restrictions_org_idx on account_restrictions (org_id, created_at desc);
create index account_restrictions_user_idx on account_restrictions (user_id, created_at desc);
grant select, insert, update on account_restrictions to pb_app;
grant select, update on account_restrictions to pb_worker;

-- A workspace is suspended for security: an active security restriction, or the R2 manual flag.
create function app.org_suspended(p_org text)
  returns boolean
  language sql stable security definer set search_path = app, pg_temp
as $$
  select exists (select 1 from organizations o where o.id = p_org and o.suspended_at is not null)
      or exists (select 1 from account_restrictions r
                  where r.org_id = p_org and r.kind = 'security' and r.scope = 'workspace'
                    and r.lifted_at is null and (r.expires_at is null or r.expires_at > now()))
$$;
revoke all on function app.org_suspended(text) from public;
grant execute on function app.org_suspended(text) to pb_app, pb_worker;

-- Account suspension (security, staff-checked): disable the account, end its sessions everywhere, revoke its API
-- tokens and fence its open profiles (their app closes them; data on the computer is not touched). `p_on = false`
-- re-enables the account when no other active account suspension remains.
create function app.admin_set_account_suspended(p_user text, p_on boolean, p_actor text)
  returns integer
  language plpgsql security definer set search_path = app, pg_temp
as $$
declare
  n integer := 0;
begin
  perform app.staff_require('admin.restrictions.security');
  if p_on then
    update users set disabled_at = coalesce(disabled_at, now()) where id = p_user;
    update device_sessions set revoked_at = now(), revoke_reason = 'user_disabled'
     where user_id = p_user and revoked_at is null;
    update web_sessions set revoked_at = now(), revoke_reason = 'user_disabled'
     where user_id = p_user and revoked_at is null;
    update api_tokens set revoked_at = now() where user_id = p_user and revoked_at is null;
    update profile_leases
       set state = 'revoked', released_at = now(), ended_by = p_actor, end_reason = 'account_suspended',
           fencing_token = nextval('lease_fencing_seq'), version = version + 1
     where holder_user_id = p_user and state = 'active';
    get diagnostics n = row_count;
  else
    if not exists (select 1 from account_restrictions r
                    where r.user_id = p_user and r.scope = 'account' and r.lifted_at is null
                      and (r.expires_at is null or r.expires_at > now())) then
      update users set disabled_at = null where id = p_user;
    end if;
  end if;
  return n;
end
$$;
revoke all on function app.admin_set_account_suspended(text, boolean, text) from public;
grant execute on function app.admin_set_account_suspended(text, boolean, text) to pb_app;

-- Worker: security suspensions whose expiry passed — the workspace flag is cleared and accounts are re-enabled when
-- nothing else holds them. Returns how many were processed.
create function app.restrictions_expire()
  returns integer
  language plpgsql security definer set search_path = app, pg_temp
as $$
declare
  r record;
  n integer := 0;
begin
  for r in select * from account_restrictions
            where kind = 'security' and lifted_at is null and expired_at is null
              and expires_at is not null and expires_at <= now()
            for update skip locked loop
    update account_restrictions set expired_at = now() where id = r.id;
    if r.scope = 'workspace' and not exists (
         select 1 from account_restrictions x where x.org_id = r.org_id and x.id <> r.id and x.kind = 'security'
            and x.scope = 'workspace' and x.lifted_at is null and (x.expires_at is null or x.expires_at > now())) then
      update organizations set suspended_at = null where id = r.org_id;
    elsif r.scope = 'account' and not exists (
         select 1 from account_restrictions x where x.user_id = r.user_id and x.id <> r.id and x.scope = 'account'
            and x.lifted_at is null and (x.expires_at is null or x.expires_at > now())) then
      update users set disabled_at = null where id = r.user_id;
    end if;
    insert into platform_audit (id, actor_user_id, action, org_id, target, details)
    values (app.new_id('aud'), null, 'admin.restriction_expired', r.org_id, r.id,
            jsonb_build_object('kind', r.kind, 'scope', r.scope));
    n := n + 1;
  end loop;
  return n;
end
$$;
revoke all on function app.restrictions_expire() from public;
grant execute on function app.restrictions_expire() to pb_worker;

-- The effective billing state (milestone 11, revised in 0009) — R5: an active staff payment restriction makes the
-- workspace restricted (reason `staff_restriction`, until its expiry), whatever the subscription or an exception.
create or replace function app.billing_effective(p_org text,
  out state text, out reason text, out until timestamptz, out blocked boolean,
  out plan_id text, out plan_version integer, out plan_name text, out limits jsonb, out features jsonb,
  out unrestricted boolean)
  language plpgsql stable security definer set search_path = app, pg_temp
as $$
declare
  s subscriptions%rowtype;
  p plans%rowtype;
  o record;
  t timestamptz := now();
  pr record;
begin
  unrestricted := false;
  select * into s from subscriptions where org_id = p_org;
  if not found then
    -- Every organization has a row (created with it); a missing one fails closed.
    state := 'restricted'; reason := 'no_subscription'; until := null; blocked := true;
    plan_id := 'none'; plan_version := 0; plan_name := 'None';
    limits := '{"profiles": 0, "seats": 0, "storage_bytes": 0, "automation_concurrency": 0}';
    features := '{"team_sessions": false, "automation": false, "api_tokens": false, "webhooks": false}';
    return;
  end if;
  select * into p from plans where plans.id = s.plan_id and plans.version = s.plan_version;
  plan_id := p.id; plan_version := p.version; plan_name := p.name; limits := p.limits; features := p.features;

  if s.state = 'trial' then
    if s.trial_ends_at <= t then
      state := 'restricted'; reason := 'trial_ended'; until := null;
    else
      state := 'trial'; reason := 'trial'; until := s.trial_ends_at;
    end if;
  elsif s.state = 'active' then
    if s.provider = 'stripe' and s.current_period_end is not null and t > s.current_period_end then
      if s.cancel_at_period_end then
        state := 'canceled'; reason := 'canceled_by_customer'; until := null;
      elsif t > s.current_period_end + interval '72 hours'
            and (s.synced_at is null or s.synced_at < s.current_period_end) then
        if t > s.current_period_end + interval '10 days' then
          state := 'restricted'; reason := 'renewal_unconfirmed'; until := null;
        else
          state := 'grace'; reason := 'renewal_unconfirmed'; until := s.current_period_end + interval '10 days';
        end if;
      else
        state := 'active'; reason := s.reason; until := null;
      end if;
    else
      state := 'active'; reason := s.reason;
      until := case when s.cancel_at_period_end then s.current_period_end end;
    end if;
  elsif s.state = 'past_due' then
    if s.current_period_end is not null and t > s.current_period_end + interval '37 days' then
      state := 'restricted'; reason := 'grace_ended'; until := null;
    elsif s.current_period_end is not null and t > s.current_period_end + interval '30 days' then
      state := 'grace'; reason := 'payment_failed'; until := s.current_period_end + interval '37 days';
    else
      state := 'past_due'; reason := 'payment_failed'; until := null;
    end if;
  elsif s.state = 'grace' then
    if s.grace_until <= t then
      state := 'restricted'; reason := 'grace_ended'; until := null;
    else
      state := 'grace'; reason := s.reason; until := s.grace_until;
    end if;
  else
    state := s.state; reason := s.reason; until := null;
  end if;

  for o in select distinct on (e.scope) e.scope, e.value from entitlement_overrides e
            where e.org_id = p_org and e.revoked_at is null and e.expires_at > t
            order by e.scope, e.created_at desc loop
    if o.scope like 'limit.%' then
      limits := jsonb_set(limits, array[substr(o.scope, 7)], o.value);
    elsif o.scope like 'feature.%' then
      features := jsonb_set(features, array[substr(o.scope, 9)], o.value);
    elsif o.scope = 'access.unrestricted' then
      unrestricted := true;
    end if;
  end loop;

  -- R5: a staff payment restriction wins over the subscription and over an entitlement exception.
  select r.expires_at into pr from account_restrictions r
   where r.org_id = p_org and r.kind = 'payment' and r.scope = 'workspace'
     and r.lifted_at is null and (r.expires_at is null or r.expires_at > t)
   order by r.expires_at desc nulls first limit 1;
  if found then
    state := 'restricted'; reason := 'staff_restriction'; until := pr.expires_at; unrestricted := false;
  end if;
  blocked := state in ('restricted', 'canceled') and not unrestricted;
end
$$;

-- ------------------------------------------------------------------ 4. notes, release requests, heartbeats
create table support_notes (
  id             text primary key check (app.valid_id('snt', id)),
  org_id         text not null references organizations(id) on delete cascade,
  author_user_id text not null references users(id),
  body           text not null check (length(body) between 1 and 2000),
  redacted       boolean not null default false,
  created_at     timestamptz not null default now()
);
create index support_notes_org_idx on support_notes (org_id, created_at desc);
grant select, insert on support_notes to pb_app;

create table release_action_requests (
  id           text primary key check (app.valid_id('rlr', id)),
  action       text not null check (action in ('pause_channel', 'resume_channel', 'publish_version')),
  version      text check (version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  reason       text not null check (length(reason) between 20 and 500),
  state        text not null default 'requested' check (state in ('requested', 'done', 'declined')),
  requested_by text not null references users(id),
  created_at   timestamptz not null default now(),
  check (action <> 'publish_version' or version is not null)
);
grant select, insert on release_action_requests to pb_app;

create table worker_heartbeats (
  name text primary key check (name ~ '^[a-z_]{1,40}$'),
  at   timestamptz not null default now()
);
grant select on worker_heartbeats to pb_app;
grant select, insert, update on worker_heartbeats to pb_worker;

-- ------------------------------------------------------------------ 5. billing facts for metrics
alter table subscriptions add column price_id text check (price_id ~ '^price_[A-Za-z0-9_]{1,80}$');
alter table subscriptions add column price_currency text check (price_currency ~ '^[a-z]{3}$');
alter table subscriptions add column price_amount_minor bigint check (price_amount_minor >= 0);
alter table subscriptions add column price_interval text check (price_interval in ('day', 'week', 'month', 'year'));
alter table subscriptions add column price_interval_count integer check (price_interval_count between 1 and 365);
alter table subscriptions add column price_quantity integer check (price_quantity >= 0);
alter table subscriptions add column price_tax_behavior text
  check (price_tax_behavior in ('inclusive', 'exclusive', 'unspecified'));

create table billing_refunds (
  charge_id           text primary key check (charge_id ~ '^ch_[A-Za-z0-9]{1,64}$'),
  org_id              text not null references organizations(id) on delete cascade,
  currency            text not null check (currency ~ '^[a-z]{3}$'),
  amount_refunded     bigint not null check (amount_refunded >= 0),
  provider_created_at timestamptz not null,
  updated_at          timestamptz not null default now()
);
create index billing_refunds_at_idx on billing_refunds (provider_created_at desc);
alter table billing_refunds enable row level security;
create policy tenant_isolation on billing_refunds
  using (org_id = app.current_org()) with check (org_id = app.current_org());
grant select on billing_refunds to pb_app;
grant select, insert, update on billing_refunds to pb_worker;

-- E-mail: notices about restrictions; failed e-mail keeps its sealed contents for 7 days so staff can retry it.
alter table email_tasks drop constraint email_tasks_kind_check;
alter table email_tasks add constraint email_tasks_kind_check
  check (kind in ('invitation', 'welcome', 'payment_succeeded', 'payment_failed', 'trial_ending',
                  'contact_request', 'deletion_request', 'restriction_notice'));
alter table email_tasks add column retried_at timestamptz;

-- ------------------------------------------------------------------ 6. cross-workspace readers (staff only)
-- Customer workspaces exclude the internal plan (staff and fixture workspaces).
create function app.admin_state_counts()
  returns table (state text, total bigint, paying bigint, complimentary bigint, new_30d bigint)
  language plpgsql stable security definer set search_path = app, pg_temp
as $$
begin
  perform app.staff_require('admin.metrics.read');
  return query
  select coalesce(s.observed_state, s.state) as state, count(*),
         count(*) filter (where s.provider = 'stripe' and s.provider_subscription_id is not null
                          and coalesce(s.observed_state, s.state) = 'active'),
         count(*) filter (where s.reason = 'complimentary'),
         count(*) filter (where o.created_at > now() - interval '30 days')
    from subscriptions s join organizations o on o.id = s.org_id
   where s.plan_id <> 'internal'
   group by 1;
end
$$;

-- Recurring revenue per currency, normalized to a month: amount × quantity ÷ months per billing period.
create function app.admin_mrr()
  returns table (currency text, bucket text, canceling boolean, amount numeric, subscriptions bigint)
  language plpgsql stable security definer set search_path = app, pg_temp
as $$
begin
  perform app.staff_require('admin.metrics.read');
  return query
  select s.price_currency,
         case when coalesce(s.observed_state, s.state) = 'active' then 'active' else 'at_risk' end,
         s.cancel_at_period_end,
         sum(s.price_amount_minor::numeric * coalesce(s.price_quantity, 1)
             / case s.price_interval when 'year' then 12.0 * s.price_interval_count
                                     when 'month' then 1.0 * s.price_interval_count
                                     when 'week' then s.price_interval_count * 12.0 / 52.0
                                     else s.price_interval_count * 12.0 / 365.0 end),
         count(*)
    from subscriptions s
   where s.provider = 'stripe' and s.provider_subscription_id is not null and s.price_amount_minor is not null
     and s.price_currency is not null and s.price_interval is not null and s.plan_id <> 'internal'
     and coalesce(s.observed_state, s.state) in ('active', 'past_due', 'grace')
   group by 1, 2, 3;
end
$$;

create function app.admin_billing_gaps()
  returns table (live_without_price bigint, tax_inclusive bigint, oldest_sync timestamptz)
  language plpgsql stable security definer set search_path = app, pg_temp
as $$
begin
  perform app.staff_require('admin.metrics.read');
  return query
  select count(*) filter (where s.price_amount_minor is null or s.price_currency is null),
         count(*) filter (where s.price_tax_behavior = 'inclusive'),
         min(s.synced_at)
    from subscriptions s
   where s.provider = 'stripe' and s.provider_subscription_id is not null
     and coalesce(s.observed_state, s.state) in ('active', 'past_due', 'grace');
end
$$;

create function app.admin_cash(p_days integer)
  returns table (kind text, currency text, amount numeric)
  language plpgsql stable security definer set search_path = app, pg_temp
as $$
begin
  perform app.staff_require('admin.metrics.read');
  return query
  select 'paid'::text, i.currency, sum(i.amount_paid)::numeric from billing_invoices i
   where i.status = 'paid' and i.provider_created_at > now() - make_interval(days => p_days)
   group by 2
  union all
  select 'refunded'::text, r.currency, sum(r.amount_refunded)::numeric from billing_refunds r
   where r.provider_created_at > now() - make_interval(days => p_days)
   group by 2;
end
$$;

-- One page of customers (newest first), filtered; `p_contact` false masks the owner's address.
create function app.admin_customers(p_q text, p_state text, p_plan text, p_after_created timestamptz,
                                    p_after_id text, p_limit integer, p_contact boolean)
  returns table (id text, name text, created_at timestamptz, plan_id text, plan_version integer, plan_name text,
                 state text, member_count bigint, profile_count bigint, owner_email text,
                 last_active_at timestamptz, suspended boolean, restricted boolean)
  language plpgsql stable security definer set search_path = app, pg_temp
as $$
declare
  q text := nullif(btrim(coalesce(p_q, '')), '');
begin
  perform app.staff_require('admin.customers.read');
  return query
  with page as (
    select o.id, o.name, o.created_at, o.suspended_at, s.plan_id, s.plan_version,
           coalesce(s.observed_state, s.state) as state
      from organizations o join subscriptions s on s.org_id = o.id
     where (q is null
            or (q ~ '^org_[0-9A-HJKMNP-TV-Z]{26}$' and o.id = q)
            or (q ~ '^cus_[A-Za-z0-9]{1,64}$' and s.provider_customer_id = q)
            or (position('@' in q) > 0 and exists (
                  select 1 from memberships m join users u on u.id = m.user_id
                   where m.org_id = o.id and m.role = 'owner' and lower(u.email) = lower(q)))
            or (q !~ '^(org|cus)_' and position('@' in q) = 0
                and lower(o.name) like replace(replace(replace(lower(q), '\', '\\'), '%', '\%'), '_', '\_') || '%'))
       and (p_state is null or coalesce(s.observed_state, s.state) = p_state)
       and (p_plan is null or s.plan_id = p_plan)
       and (p_after_created is null or (o.created_at, o.id) < (p_after_created, p_after_id))
     order by o.created_at desc, o.id desc
     limit greatest(1, least(p_limit, 100)))
  select p.id, p.name, p.created_at, p.plan_id, p.plan_version, pl.name, p.state,
         (select count(*) from memberships m where m.org_id = p.id),
         (select count(*) from profiles pr where pr.org_id = p.id and pr.deleted_at is null),
         (select case when p_contact then u.email
                      else left(u.email, 1) || '***@' || split_part(u.email, '@', 2) end
            from memberships m join users u on u.id = m.user_id
           where m.org_id = p.id and m.role = 'owner' and u.email is not null
           order by m.created_at limit 1),
         (select max(ds.last_used_at) from memberships m join device_sessions ds on ds.user_id = m.user_id
           where m.org_id = p.id),
         p.suspended_at is not null or exists (
           select 1 from account_restrictions r where r.org_id = p.id and r.kind = 'security'
              and r.scope = 'workspace' and r.lifted_at is null and (r.expires_at is null or r.expires_at > now())),
         exists (
           select 1 from account_restrictions r where r.org_id = p.id and r.kind = 'payment'
              and r.lifted_at is null and (r.expires_at is null or r.expires_at > now()))
    from page p join plans pl on pl.id = p.plan_id and pl.version = p.plan_version
   order by p.created_at desc, p.id desc;
end
$$;

-- A customer's devices by platform (no names) and members by role.
create function app.admin_customer_people(p_org text)
  returns table (kind text, key text, n bigint)
  language plpgsql stable security definer set search_path = app, pg_temp
as $$
begin
  perform app.staff_require('admin.customers.read');
  return query
  select 'role'::text, m.role, count(*) from memberships m where m.org_id = p_org group by m.role
  union all
  select 'platform'::text, d.platform, count(distinct d.id)
    from memberships m join devices d on d.user_id = m.user_id
   where m.org_id = p_org and d.revoked_at is null
     and exists (select 1 from device_sessions ds where ds.device_id = d.id and ds.revoked_at is null
                   and ds.expires_at > now())
   group by d.platform;
end
$$;

-- Operations: the e-mail queue without addresses or contents; retrying a failed e-mail that still has its contents.
create function app.admin_email_status()
  returns table (id text, kind text, org_id text, state text, attempts integer, last_error text,
                 created_at timestamptz, retryable boolean, sent_recently boolean)
  language plpgsql stable security definer set search_path = app, pg_temp
as $$
begin
  perform app.staff_require('admin.operations.read');
  return query
  select t.id, t.kind, t.org_id, t.state, t.attempts, t.last_error, t.created_at,
         t.state = 'failed' and t.payload_enc is not null,
         t.state = 'sent' and t.sent_at > now() - interval '24 hours'
    from email_tasks t
   where t.state in ('pending', 'failed') or (t.state = 'sent' and t.sent_at > now() - interval '24 hours');
end
$$;

create function app.admin_email_retry(p_id text)
  returns boolean
  language plpgsql security definer set search_path = app, pg_temp
as $$
begin
  perform app.staff_require('admin.operations.act');
  update email_tasks set state = 'pending', attempts = 0, next_attempt_at = now(), retried_at = now()
   where id = p_id and state = 'failed' and payload_enc is not null;
  return found;
end
$$;

create function app.admin_ops_summary()
  returns table (last_profile_backup timestamptz, outbox_pending bigint, outbox_retrying bigint,
                 outbox_oldest timestamptz, deletion_requests bigint, contact_requests bigint)
  language plpgsql stable security definer set search_path = app, pg_temp
as $$
begin
  perform app.staff_require('admin.operations.read');
  return query
  select (select max(committed_at) from snapshot_manifests where status = 'committed'),
         (select count(*) from outbox_events where published_at is null),
         (select count(*) from outbox_events where published_at is null and attempts > 0),
         (select min(created_at) from outbox_events where published_at is null),
         (select count(*) from account_deletion_requests where state = 'pending'),
         (select count(*) from contact_requests where handled_at is null);
end
$$;

-- Whether a user is a member of a workspace (account suspensions name the workspace they were found in).
create function app.admin_member_of(p_org text, p_user text)
  returns boolean
  language plpgsql stable security definer set search_path = app, pg_temp
as $$
begin
  perform app.staff_require('admin.customers.read');
  return exists (select 1 from memberships where org_id = p_org and user_id = p_user);
end
$$;

-- Owners' e-mail addresses for a restriction notice (the API queues the e-mail; staff-checked).
create function app.admin_notice_recipients(p_org text, p_user text)
  returns table (email text, org_name text)
  language plpgsql stable security definer set search_path = app, pg_temp
as $$
begin
  if not (app.staff_has('admin.restrictions.payment') or app.staff_has('admin.restrictions.security')) then
    raise exception 'STAFF_FORBIDDEN' using detail = 'admin.restrictions.payment';
  end if;
  if p_user is not null then
    return query select u.email, coalesce((select o.name from organizations o where o.id = p_org), '')
                   from users u where u.id = p_user and u.email is not null and u.email_verified;
  else
    return query select distinct u.email, o.name
                   from memberships m join organizations o on o.id = m.org_id join users u on u.id = m.user_id
                  where m.org_id = p_org and m.role = 'owner' and u.email is not null and u.email_verified;
  end if;
end
$$;

-- The subscriber count of each plan version (catalog page).
create function app.admin_plan_subscribers()
  returns table (plan_id text, plan_version integer, n bigint)
  language plpgsql stable security definer set search_path = app, pg_temp
as $$
begin
  perform app.staff_require('admin.catalog.read');
  return query select s.plan_id, s.plan_version, count(*) from subscriptions s group by 1, 2;
end
$$;

-- Staff names for case notes and the staff list (staff are not workspace members, so row security hides them).
create function app.staff_display_name(p_user text)
  returns text
  language sql stable security definer set search_path = app, pg_temp
as $$
  select u.display_name from users u join platform_staff s on s.user_id = u.id where u.id = p_user
$$;

create function app.admin_staff_list()
  returns table (user_id text, display_name text, email text, roles text[], disabled boolean,
                 last_sign_in timestamptz)
  language plpgsql stable security definer set search_path = app, pg_temp
as $$
begin
  perform app.staff_require('admin.staff.read');
  return query
  select s.user_id, u.display_name, u.email, s.roles, s.disabled_at is not null,
         (select max(ss.created_at) from staff_sessions ss where ss.user_id = s.user_id)
    from platform_staff s join users u on u.id = s.user_id
   order by s.disabled_at nulls first, u.email;
end
$$;

do $$
declare f text;
begin
  foreach f in array array['app.admin_state_counts()', 'app.admin_mrr()', 'app.admin_billing_gaps()',
    'app.admin_cash(integer)',
    'app.admin_customers(text, text, text, timestamptz, text, integer, boolean)',
    'app.admin_customer_people(text)', 'app.admin_email_status()', 'app.admin_email_retry(text)',
    'app.admin_ops_summary()', 'app.admin_member_of(text, text)', 'app.admin_notice_recipients(text, text)',
    'app.admin_plan_subscribers()', 'app.staff_display_name(text)', 'app.admin_staff_list()'] loop
    execute format('revoke all on function %s from public', f);
    execute format('grant execute on function %s to pb_app', f);
  end loop;
end
$$;

-- Alerts: publication problems are visible like other billing alerts.
alter table billing_alerts drop constraint billing_alerts_kind_check;
alter table billing_alerts add constraint billing_alerts_kind_check
  check (kind in ('webhook_backlog', 'event_failed', 'unknown_customer', 'unknown_price', 'duplicate_subscriptions',
                  'paid_not_active', 'missed_webhook', 'dispute', 'refund', 'signature_failures', 'resync_failed',
                  'break_glass_used', 'publish_failed'));
