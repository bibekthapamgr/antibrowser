-- Milestone 11 review fixes (ADR-0018). An independent review of the billing state logic found:
--   1. Accepting an invitation skipped the seat check (its seat was "reserved"), so after a downgrade an organization
--      over its seats could still gain members, and a restricted or canceled organization could gain members at all.
--   2. A stored past_due never ended: with the provider set to leave subscriptions past due, or a long outage after a
--      failed renewal, full access lasted forever. It now ends: 30 days after the period end it is treated as grace,
--      7 days later as restricted (still nothing is deleted).
--   3. Two fetches of one subscription (two workers, or an event and a resync) could commit in the wrong order, so a
--      late "active" read could undo an applied cancellation. Each applied object now carries the database time at
--      which its fetch started (provider_fetched_at); an older fetch is ignored (services/api/src/billing/reconcile.ts).
--   4. A resync that kept failing for one organization stayed at the head of every batch. Failures now back off
--      (resync_after) and a lasting failure raises a 'resync_failed' alert. A staff "resync now" no longer clears
--      synced_at (which briefly counted as an unconfirmed renewal); it asks for a resync instead.
--   5. The organization's own backup quota (the milestone 07 cost limit, 20 GiB by default) capped every plan, so the
--      Team and Agency storage and storage overrides above 20 GiB never applied. The operator's limit is now a
--      ceiling of 1 TiB by default; the plan's storage decides below it.

-- ------------------------------------------------------------------ 5. storage: the plan decides under the ceiling
alter table organizations alter column backup_quota_bytes set default 1099511627776;
update organizations set backup_quota_bytes = 1099511627776 where backup_quota_bytes = 21474836480;
comment on column organizations.backup_quota_bytes is
  'Service operator''s storage ceiling (bytes); the plan''s storage (and overrides) decides below it (milestone 11).';

-- ------------------------------------------------------------------ 3 and 4: freshness and resync bookkeeping
alter table subscriptions
  add column provider_fetched_at  timestamptz,
  add column resync_after         timestamptz,
  add column resync_requested_at  timestamptz;
comment on column subscriptions.provider_fetched_at is
  'Database time at which the fetch of the last applied provider object started; an older fetch is never applied.';

alter table billing_alerts drop constraint billing_alerts_kind_check;
alter table billing_alerts add constraint billing_alerts_kind_check check (kind in ('webhook_backlog', 'event_failed',
  'unknown_customer', 'unknown_price', 'duplicate_subscriptions', 'paid_not_active', 'missed_webhook', 'dispute',
  'refund', 'signature_failures', 'resync_failed'));

create or replace function app.billing_resync_due(p_limit integer)
  returns table (org_id text, provider_customer_id text, provider_subscription_id text)
  language sql stable security definer set search_path = app, pg_temp
as $$
  select s.org_id, s.provider_customer_id, s.provider_subscription_id from subscriptions s
   where s.provider = 'stripe' and s.provider_customer_id is not null
     and (s.resync_after is null or s.resync_after <= now())
     and (s.resync_requested_at is not null
          or s.synced_at is null
          or s.synced_at < now() - interval '24 hours'
          or (s.synced_at < now() - interval '1 hour'
              and (s.state in ('past_due', 'grace')
                   or (s.current_period_end is not null
                       and s.current_period_end between now() - interval '10 days' and now() + interval '1 day'))))
   order by s.resync_requested_at nulls last, s.synced_at nulls first
   limit greatest(1, least(p_limit, 500))
$$;

create or replace function app.billing_request_resync(p_org text)
  returns boolean
  language sql security definer set search_path = app, pg_temp
as $$
  update subscriptions set resync_requested_at = now(), resync_after = null
   where org_id = p_org and provider = 'stripe' and provider_customer_id is not null
  returning true
$$;

-- ------------------------------------------------------------------ 2. past_due ends
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
    -- The provider is retrying the payment: full access, but not forever (BILLING_TIMING.pastDueMaxDays, then the
    -- grace days): whatever the provider's retry setting, or if the provider cannot be reached.
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

-- ------------------------------------------------------------------ 1. joining needs a seat and an unblocked org
-- Seats: members plus pending invitations. An invitation reserves its seat when it is created; accepting it converts
-- the reservation, but only while the organization is within its seats (after a downgrade it may be over: then the
-- owner upgrades or withdraws invitations first) and not restricted or canceled (raised as P0001
-- 'BILLING_RESTRICTED', mapped to SUBSCRIPTION_RESTRICTED).
create or replace function app.billing_limit_seats() returns trigger
  language plpgsql security definer set search_path = app, pg_temp
as $$
declare
  allowed bigint;
  used bigint;
  reserved boolean := false;
  e record;
begin
  perform 1 from subscriptions where org_id = new.org_id for update;
  if tg_table_name = 'memberships' then
    select * into e from app.billing_effective(new.org_id);
    if e.blocked then
      raise exception 'BILLING_RESTRICTED'
        using detail = jsonb_build_object('state', e.state, 'reason', e.reason, 'action', 'invitation.accept')::text;
    end if;
  end if;
  allowed := app.billing_limit(new.org_id, 'seats');
  if allowed is null then return new; end if;
  used := app.billing_seats_used(new.org_id);
  if tg_table_name = 'memberships' then
    select exists (select 1 from invitations i join users u on u.id = new.user_id
                    where i.org_id = new.org_id and i.email = lower(u.email) and i.accepted_at is null
                      and i.revoked_at is null and i.expires_at > now())
      into reserved;
  end if;
  -- A reserved seat is already counted in `used`; a new one adds to it.
  if used + (case when reserved then 0 else 1 end) > allowed then
    raise exception 'PLAN_LIMIT'
      using detail = jsonb_build_object('limit', 'seats', 'used', used, 'allowed', allowed)::text;
  end if;
  return new;
end
$$;
