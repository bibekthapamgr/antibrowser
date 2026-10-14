-- Milestone 11: billing, plan limits and support access. ADR-0018.
--
-- The database decides what an organization may do: app.billing_effective computes the effective state and limits
-- from the organization's subscription, its plan version, active overrides and the clock, so time-based transitions
-- (trial end, grace end, an unconfirmed renewal) need no job to take effect. Limits on profiles and seats are checked
-- by triggers that lock the organization's subscription row, so concurrent creates cannot overshoot. Nothing here
-- ever deletes customer data. The plan catalog itself is synced from packages/contracts/src/billing.ts by the
-- migration script (a released plan version is immutable).
set search_path = app;

-- ------------------------------------------------------------------ plan catalog
create table plans (
  id          text not null check (id ~ '^[a-z][a-z0-9_]{1,31}$'),
  version     integer not null check (version between 1 and 999999),
  name        text not null check (length(name) between 1 and 60),
  description text not null check (length(description) <= 200),
  purchasable boolean not null,
  trial_days  integer check (trial_days between 1 and 90),
  limits      jsonb not null check (jsonb_typeof(limits) = 'object'),
  features    jsonb not null check (jsonb_typeof(features) = 'object'),
  created_at  timestamptz not null default now(),
  primary key (id, version)
);

-- ------------------------------------------------------------------ subscriptions (one per organization)
create table subscriptions (
  org_id                        text primary key references organizations(id) on delete cascade,
  plan_id                       text not null,
  plan_version                  integer not null,
  -- The stored state; app.billing_effective derives the effective one (time-based transitions, overrides).
  state                         text not null
                                  check (state in ('trial', 'active', 'past_due', 'grace', 'restricted', 'canceled')),
  reason                        text not null check (reason in ('trial', 'trial_ended', 'paid', 'payment_failed',
                                  'payment_retries_exhausted', 'renewal_unconfirmed', 'grace_ended',
                                  'canceled_by_customer', 'paused', 'no_subscription', 'complimentary')),
  provider                      text not null default 'none' check (provider in ('none', 'stripe')),
  provider_customer_id          text unique check (provider_customer_id ~ '^cus_[A-Za-z0-9]{1,64}$'),
  provider_subscription_id      text unique check (provider_subscription_id ~ '^sub_[A-Za-z0-9]{1,64}$'),
  -- When the provider created the current subscription: an older subscription's events never replace a newer one.
  provider_subscription_created timestamptz,
  provider_status               text check (provider_status ~ '^[a-z_]{1,32}$'),
  trial_ends_at                 timestamptz,
  current_period_end            timestamptz,
  cancel_at_period_end          boolean not null default false,
  grace_until                   timestamptz,
  canceled_at                   timestamptz,
  -- Last time the provider's own data confirmed this row (fetch after a webhook, or the periodic resync).
  synced_at                     timestamptz,
  -- Last effective state recorded in subscription_history (the worker records time-based transitions).
  observed_state                text,
  version                       integer not null default 1 check (version >= 1),
  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now(),
  foreign key (plan_id, plan_version) references plans (id, version),
  check (state <> 'trial' or trial_ends_at is not null),
  check (state <> 'grace' or grace_until is not null)
);

create table subscription_history (
  id            bigint generated always as identity primary key,
  org_id        text not null references organizations(id) on delete cascade,
  at            timestamptz not null default now(),
  from_state    text,
  to_state      text not null,
  reason        text not null,
  plan_id       text not null,
  plan_version  integer not null,
  -- What caused it: 'created', 'migration', 'time', 'staff', 'webhook:<event type>', 'resync', 'checkout'.
  cause         text not null check (cause ~ '^[a-z_]+(:[a-z_.]+)?$' and length(cause) <= 80)
);
create index subscription_history_org_idx on subscription_history (org_id, at desc);

-- ------------------------------------------------------------------ entitlement overrides (staff, billing_admin)
create table entitlement_overrides (
  id          text primary key check (app.valid_id('ovr', id)),
  org_id      text not null references organizations(id) on delete cascade,
  scope       text not null check (scope in ('limit.profiles', 'limit.seats', 'limit.storage_bytes',
                'limit.automation_concurrency', 'feature.team_sessions', 'feature.automation',
                'feature.api_tokens', 'feature.webhooks', 'access.unrestricted')),
  value       jsonb not null,
  reason      text not null check (length(reason) between 20 and 500),
  created_by  text not null references users(id),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  revoked_at  timestamptz,
  revoked_by  text references users(id),
  check (expires_at > created_at and expires_at <= created_at + interval '90 days'),
  check (case when scope like 'limit.%' then jsonb_typeof(value) in ('null', 'number')
              when scope = 'access.unrestricted' then value = 'true'::jsonb
              else jsonb_typeof(value) = 'boolean' end)
);
create index entitlement_overrides_org_idx on entitlement_overrides (org_id, scope, created_at desc)
  where revoked_at is null;

-- ------------------------------------------------------------------ usage ledger
-- Idempotent: every writer inserts with "on conflict do nothing" on (org_id, dedupe_key), so reprocessing an event
-- or re-running a daily sample never counts twice.
create table usage_events (
  id          bigint generated always as identity primary key,
  org_id      text not null references organizations(id) on delete cascade,
  type        text not null check (type in ('snapshot_committed', 'automation_job', 'api_requests',
                'storage_bytes', 'active_profiles', 'seats')),
  quantity    numeric not null check (quantity >= 0),
  dedupe_key  text not null check (dedupe_key ~ '^[a-z_]+:[A-Za-z0-9_:-]{1,100}$'),
  occurred_at timestamptz not null,
  created_at  timestamptz not null default now(),
  unique (org_id, dedupe_key)
);
create index usage_events_org_idx on usage_events (org_id, occurred_at desc);

-- API-token requests per organization and UTC day (rolled up into usage_events after the day ends).
create table api_usage_daily (
  org_id   text not null references organizations(id) on delete cascade,
  day      date not null,
  requests bigint not null default 0 check (requests >= 0),
  primary key (org_id, day)
);

-- ------------------------------------------------------------------ provider events, invoices, alerts
-- Platform tables (no organization context): the webhook route records an event before knowing its organization.
-- Only the event's identity is stored, never its payload; the worker fetches the current object from the provider.
create table billing_webhook_events (
  provider_event_id   text primary key check (provider_event_id ~ '^evt_[A-Za-z0-9]{1,64}$'),
  type                text not null check (type ~ '^[a-z_]+(\.[a-z_]+)+$' and length(type) <= 80),
  object_type         text check (object_type ~ '^[a-z_.]{1,40}$'),
  object_id           text check (object_id ~ '^[a-z]{2,8}_[A-Za-z0-9_]{1,80}$'),
  livemode            boolean not null,
  provider_created_at timestamptz not null,
  status              text not null default 'pending' check (status in ('pending', 'processed', 'ignored', 'failed')),
  org_id              text references organizations(id) on delete set null,
  attempts            integer not null default 0 check (attempts >= 0),
  next_attempt_at     timestamptz not null default now(),
  error               text check (length(error) <= 200),
  received_at         timestamptz not null default now(),
  processed_at        timestamptz
);
create index billing_webhook_events_due_idx on billing_webhook_events (next_attempt_at) where status = 'pending';
create index billing_webhook_events_org_idx on billing_webhook_events (org_id, received_at desc);

create table billing_invoices (
  id              text primary key check (id ~ '^in_[A-Za-z0-9]{1,64}$'),
  org_id          text not null references organizations(id) on delete cascade,
  subscription_id text check (subscription_id ~ '^sub_[A-Za-z0-9]{1,64}$'),
  number          text check (length(number) <= 64),
  status          text not null check (status in ('draft', 'open', 'paid', 'void', 'uncollectible')),
  currency        text not null check (currency ~ '^[a-z]{3}$'),
  amount_due      bigint not null,
  amount_paid     bigint not null,
  provider_created_at timestamptz not null,
  period_start    timestamptz,
  period_end      timestamptz,
  -- Provider-hosted pages (capability URLs): shown to owners only and opened by the desktop shell.
  hosted_url      text check (hosted_url ~ '^https://[a-z0-9.-]+\.stripe\.com/'),
  pdf_url         text check (pdf_url ~ '^https://[a-z0-9.-]+\.stripe\.com/'),
  updated_at      timestamptz not null default now()
);
create index billing_invoices_org_idx on billing_invoices (org_id, provider_created_at desc);

create table billing_alerts (
  id            text primary key check (app.valid_id('alr', id)),
  kind          text not null check (kind in ('webhook_backlog', 'event_failed', 'unknown_customer',
                  'unknown_price', 'duplicate_subscriptions', 'paid_not_active', 'missed_webhook', 'dispute',
                  'refund', 'signature_failures')),
  org_id        text references organizations(id) on delete cascade,
  ref           text check (length(ref) <= 80),
  detail        text not null check (length(detail) <= 300),
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  count         integer not null default 1 check (count >= 1),
  resolved_at   timestamptz,
  resolved_by   text references users(id)
);
-- One open alert per kind, organization and reference: a repeat bumps its count.
create unique index billing_alerts_open_idx on billing_alerts (kind, coalesce(org_id, ''), coalesce(ref, ''))
  where resolved_at is null;

-- ------------------------------------------------------------------ staff and support access
-- Staff are not a tenant role: added and removed only with services/api/scripts/staff.ts on the server.
create table platform_staff (
  user_id     text primary key references users(id) on delete cascade,
  roles       text[] not null check (cardinality(roles) between 1 and 3
                and roles <@ array['support', 'support_lead', 'billing_admin']::text[]),
  note        text check (length(note) <= 200),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  disabled_at timestamptz
);

create table staff_sessions (
  id         text primary key check (app.valid_id('stf', id)),
  user_id    text not null references platform_staff(user_id) on delete cascade,
  auth_time  timestamptz not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  check (expires_at > created_at and expires_at <= created_at + interval '1 hour')
);

create table support_access_requests (
  id               text primary key check (app.valid_id('sar', id)),
  org_id           text not null references organizations(id) on delete cascade,
  scope            text not null check (scope in ('members', 'activity')),
  reason           text not null check (length(reason) between 20 and 500),
  duration_minutes integer not null check (duration_minutes between 5 and 240),
  state            text not null default 'pending' check (state in ('pending', 'approved', 'denied', 'revoked')),
  requested_by     text not null references users(id),
  decided_by       text references users(id),
  created_at       timestamptz not null default now(),
  decided_at       timestamptz,
  expires_at       timestamptz,
  -- Two people: nobody approves their own request.
  check (decided_by is null or decided_by <> requested_by),
  check (state <> 'approved' or (expires_at is not null and decided_at is not null))
);
create index support_access_requests_org_idx on support_access_requests (org_id, created_at desc);
create index support_access_requests_pending_idx on support_access_requests (created_at) where state = 'pending';

create table platform_audit (
  id            text primary key check (app.valid_id('aud', id)),
  at            timestamptz not null default now(),
  actor_user_id text check (actor_user_id is null or app.valid_id('usr', actor_user_id)),
  action        text not null check (action ~ '^[a-z_]+(\.[a-z_]+)+$' and length(action) <= 64),
  org_id        text references organizations(id) on delete set null,
  target        text check (length(target) <= 80),
  details       jsonb not null default '{}'::jsonb check (length(details::text) <= 2000),
  request_id    text check (request_id ~ '^req_[0-9A-HJKMNP-TV-Z]{26}$')
);
create index platform_audit_at_idx on platform_audit (at desc);
create index platform_audit_org_idx on platform_audit (org_id, at desc);

-- The milestone 01 placeholder is replaced by plans and overrides.
drop table entitlements;

-- ------------------------------------------------------------------ the effective state and limits
create function app.billing_effective(p_org text,
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
        -- The customer asked to cancel at the period end, which has passed.
        state := 'canceled'; reason := 'canceled_by_customer'; until := null;
      elsif t > s.current_period_end + interval '72 hours'
            and (s.synced_at is null or s.synced_at < s.current_period_end) then
        -- No confirmed renewal (missed webhooks, a provider outage): bounded grace, never restricted at once.
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
    state := 'past_due'; reason := 'payment_failed'; until := null;
  elsif s.state = 'grace' then
    if s.grace_until <= t then
      state := 'restricted'; reason := 'grace_ended'; until := null;
    else
      state := 'grace'; reason := s.reason; until := s.grace_until;
    end if;
  else
    state := s.state; reason := s.reason; until := null;
  end if;

  -- Overrides in force: the newest per scope.
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
  blocked := state in ('restricted', 'canceled') and not unrestricted;
end
$$;

-- The effective limit for one key: null when there is none (no limit).
create function app.billing_limit(p_org text, p_key text)
  returns bigint
  language plpgsql stable security definer set search_path = app, pg_temp
as $$
declare
  v jsonb;
begin
  select e.limits -> p_key into v from app.billing_effective(p_org) e;
  if v is null or jsonb_typeof(v) <> 'number' then return null; end if;
  return (v #>> '{}')::numeric::bigint;
end
$$;

create function app.billing_seats_used(p_org text)
  returns bigint
  language sql stable security definer set search_path = app, pg_temp
as $$
  select (select count(*) from memberships where org_id = p_org)
       + (select count(*) from invitations
           where org_id = p_org and accepted_at is null and revoked_at is null and expires_at > now())
$$;

create function app.billing_storage_used(p_org text)
  returns bigint
  language sql stable security definer set search_path = app, pg_temp
as $$
  select coalesce(sum(size_bytes), 0)::bigint from snapshot_manifests
   where org_id = p_org and status in ('committed', 'deleted', 'recovery') and object_deleted_at is null
$$;

-- ------------------------------------------------------------------ limits enforced in the transaction
-- Raised as P0001 'PLAN_LIMIT' with a JSON detail ({"limit", "used", "allowed"}); the API maps it to
-- PLAN_LIMIT_REACHED. The subscription row lock serializes concurrent creates of one organization.
create function app.billing_limit_profiles() returns trigger
  language plpgsql security definer set search_path = app, pg_temp
as $$
declare
  allowed bigint;
  used bigint;
begin
  if tg_op = 'UPDATE' and not (old.deleted_at is not null and new.deleted_at is null) then return new; end if;
  if tg_op = 'INSERT' and new.deleted_at is not null then return new; end if;
  perform 1 from subscriptions where org_id = new.org_id for update;
  allowed := app.billing_limit(new.org_id, 'profiles');
  if allowed is null then return new; end if;
  select count(*) into used from profiles where org_id = new.org_id and deleted_at is null and id <> new.id;
  if used + 1 > allowed then
    raise exception 'PLAN_LIMIT'
      using detail = jsonb_build_object('limit', 'profiles', 'used', used, 'allowed', allowed)::text;
  end if;
  return new;
end
$$;
create trigger billing_limit_profiles before insert or update of deleted_at on profiles
  for each row execute function app.billing_limit_profiles();

-- Seats: members plus pending invitations. An invitation reserves its seat; accepting it converts the reservation.
create function app.billing_limit_seats() returns trigger
  language plpgsql security definer set search_path = app, pg_temp
as $$
declare
  allowed bigint;
  used bigint;
  reserved boolean := false;
begin
  perform 1 from subscriptions where org_id = new.org_id for update;
  allowed := app.billing_limit(new.org_id, 'seats');
  if allowed is null then return new; end if;
  used := app.billing_seats_used(new.org_id);
  if tg_table_name = 'memberships' then
    select exists (select 1 from invitations i join users u on u.id = new.user_id
                    where i.org_id = new.org_id and i.email = lower(u.email) and i.accepted_at is null
                      and i.revoked_at is null and i.expires_at > now())
      into reserved;
  end if;
  if not reserved and used + 1 > allowed then
    raise exception 'PLAN_LIMIT'
      using detail = jsonb_build_object('limit', 'seats', 'used', used, 'allowed', allowed)::text;
  end if;
  return new;
end
$$;
create trigger billing_limit_seats before insert on memberships
  for each row execute function app.billing_limit_seats();
create trigger billing_limit_seats before insert on invitations
  for each row execute function app.billing_limit_seats();

-- Storage (ADR-0014 quota): the smaller of the organization's own quota and the plan's storage.
create or replace function app.org_backup_quota(p_org text)
  returns bigint
  language plpgsql stable security definer set search_path = app, pg_temp
as $$
declare
  own bigint;
  plan bigint;
begin
  select backup_quota_bytes into own from organizations where id = p_org;
  if own is null then return null; end if;
  plan := app.billing_limit(p_org, 'storage_bytes');
  return least(own, coalesce(plan, own));
end
$$;

-- ------------------------------------------------------------------ new organizations start a trial
create function app.billing_new_org() returns trigger
  language plpgsql security definer set search_path = app, pg_temp
as $$
declare
  p plans%rowtype;
begin
  select * into p from plans where id = 'trial' order by version desc limit 1;
  if not found then raise exception 'BILLING_CATALOG_MISSING'; end if;
  insert into subscriptions (org_id, plan_id, plan_version, state, reason, trial_ends_at, observed_state)
  values (new.id, p.id, p.version, 'trial', 'trial', now() + make_interval(days => coalesce(p.trial_days, 14)),
          'trial');
  insert into subscription_history (org_id, from_state, to_state, reason, plan_id, plan_version, cause)
  values (new.id, null, 'trial', 'trial', p.id, p.version, 'created');
  return new;
end
$$;
create trigger billing_new_org after insert on organizations
  for each row execute function app.billing_new_org();

-- ------------------------------------------------------------------ usage events written where things happen
create function app.billing_usage_job() returns trigger
  language plpgsql security definer set search_path = app, pg_temp
as $$
begin
  if new.state in ('SUCCEEDED', 'FAILED', 'CANCELED') and old.state is distinct from new.state
     and new.started_at is not null then
    insert into usage_events (org_id, type, quantity, dedupe_key, occurred_at)
    values (new.org_id, 'automation_job', 1, 'job:' || new.id, coalesce(new.finished_at, now()))
    on conflict do nothing;
  end if;
  return new;
end
$$;
create trigger billing_usage_job after update of state on automation_jobs
  for each row execute function app.billing_usage_job();

create function app.billing_usage_snapshot() returns trigger
  language plpgsql security definer set search_path = app, pg_temp
as $$
begin
  if new.status = 'committed' and old.status is distinct from 'committed' then
    insert into usage_events (org_id, type, quantity, dedupe_key, occurred_at)
    values (new.org_id, 'snapshot_committed', coalesce(new.size_bytes, 0), 'snapshot:' || new.id,
            coalesce(new.committed_at, now()))
    on conflict do nothing;
  end if;
  return new;
end
$$;
create trigger billing_usage_snapshot after update of status on snapshot_manifests
  for each row execute function app.billing_usage_snapshot();

-- One API-token request (the API calls this for token principals only).
create function app.billing_count_api(p_org text)
  returns void
  language sql security definer set search_path = app, pg_temp
as $$
  insert into api_usage_daily (org_id, day, requests) values (p_org, (now() at time zone 'UTC')::date, 1)
  on conflict (org_id, day) do update set requests = api_usage_daily.requests + 1
$$;

-- Daily samples and the API roll-up (worker). Idempotent per organization and day.
create function app.billing_sample_usage(p_day date)
  returns integer
  language plpgsql security definer set search_path = app, pg_temp
as $$
declare
  n integer := 0;
  v_at timestamptz := (p_day::timestamp at time zone 'UTC') + interval '1 day' - interval '1 second';
  k integer;
begin
  insert into usage_events (org_id, type, quantity, dedupe_key, occurred_at)
  select o.id, 'storage_bytes', app.billing_storage_used(o.id), 'storage:' || p_day, v_at from organizations o
  on conflict do nothing;
  get diagnostics k = row_count; n := n + k;
  insert into usage_events (org_id, type, quantity, dedupe_key, occurred_at)
  select o.id, 'active_profiles',
         (select count(*) from profiles p where p.org_id = o.id and p.deleted_at is null), 'profiles:' || p_day, v_at
    from organizations o
  on conflict do nothing;
  get diagnostics k = row_count; n := n + k;
  insert into usage_events (org_id, type, quantity, dedupe_key, occurred_at)
  select o.id, 'seats', app.billing_seats_used(o.id), 'seats:' || p_day, v_at from organizations o
  on conflict do nothing;
  get diagnostics k = row_count; n := n + k;
  -- Finished days of API-token requests.
  insert into usage_events (org_id, type, quantity, dedupe_key, occurred_at)
  select a.org_id, 'api_requests', a.requests, 'api:' || a.day,
         (a.day::timestamp at time zone 'UTC') + interval '1 day' - interval '1 second'
    from api_usage_daily a where a.day < (now() at time zone 'UTC')::date
  on conflict do nothing;
  get diagnostics k = row_count; n := n + k;
  return n;
end
$$;

-- ------------------------------------------------------------------ worker helpers (cross-organization lookups)
create function app.billing_org_for_customer(p_customer text)
  returns text
  language sql stable security definer set search_path = app, pg_temp
as $$
  select org_id from subscriptions where provider_customer_id = p_customer
$$;

-- Provider subscriptions due for a resync: daily, hourly around the period end and while past due or in grace.
create function app.billing_resync_due(p_limit integer)
  returns table (org_id text, provider_customer_id text, provider_subscription_id text)
  language sql stable security definer set search_path = app, pg_temp
as $$
  select s.org_id, s.provider_customer_id, s.provider_subscription_id from subscriptions s
   where s.provider = 'stripe' and s.provider_customer_id is not null
     and (s.synced_at is null
          or s.synced_at < now() - interval '24 hours'
          or (s.synced_at < now() - interval '1 hour'
              and (s.state in ('past_due', 'grace')
                   or (s.current_period_end is not null
                       and s.current_period_end between now() - interval '10 days' and now() + interval '1 day'))))
   order by s.synced_at nulls first
   limit greatest(1, least(p_limit, 500))
$$;

-- Time-based transitions are effective at once (app.billing_effective); this records them in the history and the
-- organization's activity log so owners and staff can see when they happened.
create function app.billing_observe(p_limit integer)
  returns integer
  language plpgsql security definer set search_path = app, pg_temp
as $$
declare
  r record;
  e record;
  n integer := 0;
begin
  for r in select s.org_id, s.observed_state from subscriptions s
            order by s.org_id limit greatest(1, least(p_limit, 100000)) for update skip locked loop
    select * into e from app.billing_effective(r.org_id);
    if e.state is distinct from r.observed_state then
      insert into subscription_history (org_id, from_state, to_state, reason, plan_id, plan_version, cause)
      values (r.org_id, r.observed_state, e.state, e.reason, e.plan_id, e.plan_version, 'time');
      insert into audit_events (id, org_id, actor_user_id, actor_device_id, action, target_type, target_id, outcome,
                                request_id, details)
      values (app.new_id('aud'), r.org_id, null, null, 'billing.state_changed', 'organization', r.org_id, 'success',
              app.new_id('req'), jsonb_build_object('from', r.observed_state, 'to', e.state, 'reason', e.reason));
      update subscriptions set observed_state = e.state where org_id = r.org_id;
      n := n + 1;
    end if;
  end loop;
  return n;
end
$$;

-- ------------------------------------------------------------------ support console helpers (staff checked by the API)
create function app.support_orgs_for_email(p_email text)
  returns table (org_id text)
  language sql stable security definer set search_path = app, pg_temp
as $$
  select distinct m.org_id from users u join memberships m on m.user_id = u.id
   where lower(u.email) = lower(p_email) limit 20
$$;

create function app.entitlement_override_org(p_id text)
  returns text
  language sql stable security definer set search_path = app, pg_temp
as $$
  select org_id from entitlement_overrides where id = p_id
$$;

-- Makes the subscription due for a resync at the worker's next pass.
create function app.billing_request_resync(p_org text)
  returns boolean
  language sql security definer set search_path = app, pg_temp
as $$
  update subscriptions set synced_at = null where org_id = p_org and provider = 'stripe' returning true
$$;

-- ------------------------------------------------------------------ row-level security and grants
alter table subscriptions          enable row level security;
alter table subscription_history   enable row level security;
alter table entitlement_overrides  enable row level security;
alter table usage_events           enable row level security;
alter table api_usage_daily        enable row level security;
alter table billing_invoices       enable row level security;
create policy tenant_isolation on subscriptions
  using (org_id = app.current_org()) with check (org_id = app.current_org());
create policy tenant_isolation on subscription_history
  using (org_id = app.current_org()) with check (org_id = app.current_org());
create policy tenant_isolation on entitlement_overrides
  using (org_id = app.current_org()) with check (org_id = app.current_org());
create policy tenant_isolation on usage_events
  using (org_id = app.current_org()) with check (org_id = app.current_org());
create policy tenant_isolation on api_usage_daily
  using (org_id = app.current_org()) with check (org_id = app.current_org());
create policy tenant_isolation on billing_invoices
  using (org_id = app.current_org()) with check (org_id = app.current_org());

grant select on plans to pb_app, pb_worker;
-- The API reads its organization's billing rows; it writes only the provider customer it created (checkout) and
-- overrides (staff, in the organization's context). Provider state is written by the worker alone.
grant select on subscriptions, subscription_history, usage_events, billing_invoices, api_usage_daily to pb_app;
grant update (provider, provider_customer_id, updated_at, version) on subscriptions to pb_app;
grant insert on subscription_history to pb_app;
grant select, insert, update on entitlement_overrides to pb_app;
grant select, update on subscriptions to pb_worker;
grant select, insert on subscription_history to pb_worker;
grant select, insert, update on billing_invoices to pb_worker;
grant select on entitlement_overrides, usage_events to pb_worker;
grant select, insert on audit_events to pb_worker;
-- Platform tables.
grant select, insert on billing_webhook_events to pb_app;
grant select, update on billing_webhook_events to pb_worker;
grant select, insert, update on billing_alerts to pb_app;
grant select, insert, update on billing_alerts to pb_worker;
grant select on platform_staff to pb_app;
grant select, insert, update on staff_sessions to pb_app;
grant select, insert, update on support_access_requests to pb_app;
grant select, insert on platform_audit to pb_app;
grant insert on platform_audit to pb_worker;

revoke all on function app.billing_effective(text) from public;
revoke all on function app.billing_limit(text, text) from public;
revoke all on function app.billing_seats_used(text) from public;
revoke all on function app.billing_storage_used(text) from public;
revoke all on function app.billing_count_api(text) from public;
revoke all on function app.billing_sample_usage(date) from public;
revoke all on function app.billing_org_for_customer(text) from public;
revoke all on function app.billing_resync_due(integer) from public;
revoke all on function app.billing_observe(integer) from public;
grant execute on function app.billing_effective(text) to pb_app, pb_worker;
grant execute on function app.billing_limit(text, text) to pb_app, pb_worker;
grant execute on function app.billing_seats_used(text) to pb_app, pb_worker;
grant execute on function app.billing_storage_used(text) to pb_app, pb_worker;
grant execute on function app.billing_count_api(text) to pb_app;
grant execute on function app.org_backup_quota(text) to pb_app;
grant execute on function app.billing_sample_usage(date) to pb_worker;
grant execute on function app.billing_org_for_customer(text) to pb_worker;
grant execute on function app.billing_resync_due(integer) to pb_worker;
grant execute on function app.billing_observe(integer) to pb_worker;
revoke all on function app.support_orgs_for_email(text) from public;
revoke all on function app.entitlement_override_org(text) from public;
revoke all on function app.billing_request_resync(text) from public;
grant execute on function app.support_orgs_for_email(text) to pb_app;
grant execute on function app.entitlement_override_org(text) to pb_app;
grant execute on function app.billing_request_resync(text) to pb_app;
grant execute on function app.billing_org_for_customer(text) to pb_app;
