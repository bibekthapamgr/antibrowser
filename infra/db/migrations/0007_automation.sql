-- Milestone 10: developer API and authorized automation. ADR-0017.
--
-- API tokens act for their creator and never beyond the creator's current access (checked on every request); only a
-- SHA-256 digest of the secret is stored. Automation jobs open organization profiles on enrolled computers through a
-- session lease exactly like a person would, run a few allowlisted steps on approved sites and close the profile.
-- Steps are checkpoints: after a lost connection only steps that are safe to repeat run again, anything else is
-- reported as "outcome unknown". Webhooks are signed (Standard Webhooks), retried with backoff and kept as dead
-- letters when they keep failing; the destination is checked again at every delivery.
set search_path = app;

-- ------------------------------------------------------------------ API tokens
create table api_tokens (
  id                   text primary key check (app.valid_id('tok', id)),
  org_id               text not null references organizations(id) on delete cascade,
  user_id              text not null references users(id),
  name                 text not null check (length(name) between 1 and 80),
  -- SHA-256 (hex) of the 256-bit secret. The secret itself is shown once and never stored.
  token_hash           text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  -- After a rotation the previous secret keeps working until previous_valid_until (a grace period of 0-24 h).
  previous_hash        text check (previous_hash ~ '^[0-9a-f]{64}$'),
  previous_valid_until timestamptz,
  scopes               text[] not null check (cardinality(scopes) between 1 and 5 and scopes <@ array[
                         'profiles:read', 'profiles:write', 'automation:read', 'automation:run',
                         'automation:debug']::text[]),
  -- Restrictions (null: everything the creator can reach). Ids are checked against the creator's reach on creation
  -- and again on every request.
  client_ids           text[] check (client_ids is null or cardinality(client_ids) between 1 and 50),
  profile_ids          text[] check (profile_ids is null or cardinality(profile_ids) between 1 and 100),
  created_at           timestamptz not null default now(),
  expires_at           timestamptz not null,
  last_used_at         timestamptz,
  rotated_at           timestamptz,
  revoked_at           timestamptz,
  revoked_by           text references users(id),
  revoke_reason        text check (length(revoke_reason) between 1 and 200),
  unique (org_id, id),
  check (expires_at > created_at),
  check ((previous_hash is null) = (previous_valid_until is null))
);
create index api_tokens_user_idx on api_tokens (org_id, user_id, created_at desc);

-- Authentication runs before the organization is known (the token names it). This definer function returns only
-- what verification needs for one token id; the caller compares digests in constant time.
create function app.api_token_for_auth(p_id text)
  returns table (org_id text, user_id text, token_hash text, previous_hash text, previous_valid boolean,
                 scopes text[], client_ids text[], profile_ids text[], expired boolean, revoked boolean,
                 user_disabled boolean, member boolean, name text)
  language sql stable security definer set search_path = app, pg_temp
as $$
  select t.org_id, t.user_id, t.token_hash, t.previous_hash,
         coalesce(t.previous_valid_until > now(), false), t.scopes, t.client_ids, t.profile_ids,
         t.expires_at <= now(), t.revoked_at is not null, u.disabled_at is not null,
         exists (select 1 from memberships m where m.org_id = t.org_id and m.user_id = t.user_id), t.name
    from api_tokens t join users u on u.id = t.user_id
   where t.id = p_id
$$;

-- Last use, at most once a minute per token (no write on every request).
create function app.api_token_touch(p_id text)
  returns void
  language sql security definer set search_path = app, pg_temp
as $$
  update api_tokens set last_used_at = now()
   where id = p_id and (last_used_at is null or last_used_at < now() - interval '1 minute')
$$;

-- ------------------------------------------------------------------ automation settings
create table automation_settings (
  org_id            text primary key references organizations(id) on delete cascade,
  -- Approved sites: scheme://host[:port] or scheme://*.domain (grammar in packages/contracts/src/automation.ts).
  allowed_origins   text[] not null default '{}' check (cardinality(allowed_origins) <= 50),
  max_running_jobs  integer not null default 5 check (max_running_jobs between 1 and 50),
  version           integer not null default 1 check (version >= 1),
  updated_by        text references users(id),
  updated_at        timestamptz
);

-- ------------------------------------------------------------------ enrolled computers (agents)
-- An agent is a person's signed-in desktop app that agreed to run jobs. It runs them as that person: a lease is
-- taken by that person and device, so only profiles they may open. 'mine': only jobs that person (or their tokens)
-- asked for; 'org': any member's jobs it may run. debug_allowed is set on the computer itself (off by default).
create table automation_agents (
  id               text primary key check (app.valid_id('agt', id)),
  org_id           text not null references organizations(id) on delete cascade,
  device_id        text not null references devices(id) on delete cascade,
  user_id          text not null references users(id),
  name             text not null check (length(name) between 1 and 80),
  platform         text check (platform ~ '^[a-z0-9-]{1,32}$'),
  browser_version  text check (browser_version ~ '^[0-9.]{1,64}$'),
  enabled          boolean not null default true,
  accepts          text not null default 'mine' check (accepts in ('mine', 'org')),
  debug_allowed    boolean not null default false,
  max_jobs         integer not null default 1 check (max_jobs between 1 and 10),
  last_seen_at     timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  version          integer not null default 1 check (version >= 1),
  unique (org_id, id),
  -- One enrollment per computer and organization. Leaving the organization removes the person's computers from it
  -- (the API ends their jobs first).
  unique (org_id, device_id)
);

-- ------------------------------------------------------------------ jobs
create table automation_jobs (
  id                      text primary key check (app.valid_id('job', id)),
  org_id                  text not null references organizations(id) on delete cascade,
  profile_id              text not null,
  requested_by            text not null references users(id),
  token_id                text,
  requested_agent_id      text,
  agent_id                text,
  -- The Idempotency-Key the job was created with (replays answer the same job; see idempotency_keys).
  idempotency_key         text not null check (idempotency_key ~ '^[A-Za-z0-9_-]{8,128}$'),
  label                   text check (length(label) between 1 and 120),
  state                   text not null default 'QUEUED'
                            check (state in ('QUEUED', 'CLAIMED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELED')),
  -- Claims so far; every report names the claim it holds, so a computer that lost the job cannot write to it.
  attempt                 integer not null default 0 check (attempt between 0 and 100),
  keep_open_minutes       integer check (keep_open_minutes between 1 and 480),
  debug_capability_sha256 text check (debug_capability_sha256 ~ '^[0-9a-f]{64}$'),
  -- The session lease the job runs under (the same lease a person's session would take) and its fencing token.
  lease_id                text check (lease_id is null or app.valid_id('lse', lease_id)),
  lease_token             bigint,
  -- The main result: the id of the last screenshot taken, if any.
  result_ref              text check (result_ref is null or app.valid_id('art', result_ref)),
  error_code              text check (error_code ~ '^[A-Z_]{2,40}$'),
  reconciliation_required boolean not null default false,
  holding                 boolean not null default false,
  holding_since           timestamptz,
  queue_expires_at        timestamptz not null,
  claimed_at              timestamptz,
  claim_expires_at        timestamptz,
  started_at              timestamptz,
  heartbeat_at            timestamptz,
  lost_at                 timestamptz,
  finished_at             timestamptz,
  cancel_requested_at     timestamptz,
  cancel_requested_by     text references users(id),
  cancel_reason           text check (length(cancel_reason) <= 200),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  version                 integer not null default 1 check (version >= 1),
  unique (org_id, id),
  foreign key (org_id, profile_id) references profiles (org_id, id) on delete cascade,
  foreign key (org_id, token_id) references api_tokens (org_id, id),
  foreign key (org_id, agent_id) references automation_agents (org_id, id) on delete set null (agent_id),
  foreign key (org_id, requested_agent_id) references automation_agents (org_id, id)
    on delete set null (requested_agent_id),
  check ((state in ('SUCCEEDED', 'FAILED', 'CANCELED')) = (finished_at is not null)),
  check (debug_capability_sha256 is null or keep_open_minutes is not null)
);
-- Two jobs never work on the same profile at the same time (on top of the profile's lease).
create unique index automation_jobs_one_active_per_profile
  on automation_jobs (org_id, profile_id) where state in ('CLAIMED', 'RUNNING');
create index automation_jobs_queue_idx on automation_jobs (org_id, created_at, id) where state = 'QUEUED';
create index automation_jobs_page_idx on automation_jobs (org_id, created_at desc, id desc);
create index automation_jobs_agent_idx on automation_jobs (agent_id) where state in ('CLAIMED', 'RUNNING');
create index automation_jobs_profile_idx on automation_jobs (org_id, profile_id, created_at desc);
create index automation_jobs_sweep_idx on automation_jobs (state, updated_at) where state in ('QUEUED', 'CLAIMED', 'RUNNING');

-- Jobs only move forward (packages/contracts JOB_TRANSITIONS); a finished job never changes.
create function app.automation_job_guard() returns trigger
  language plpgsql set search_path = app, pg_temp
as $$
begin
  if old.state in ('SUCCEEDED', 'FAILED', 'CANCELED') then
    -- Only references may change afterwards (a removed computer is set to null); never the result.
    if new.state <> old.state or new.error_code is distinct from old.error_code
       or new.reconciliation_required <> old.reconciliation_required
       or new.finished_at is distinct from old.finished_at or new.attempt <> old.attempt
       or new.result_ref is distinct from old.result_ref then
      raise exception 'JOB_FINISHED' using errcode = 'P0001';
    end if;
    return new;
  end if;
  if new.state <> old.state and not (
       (old.state = 'QUEUED' and new.state in ('CLAIMED', 'FAILED', 'CANCELED'))
    or (old.state = 'CLAIMED' and new.state in ('RUNNING', 'QUEUED', 'FAILED', 'CANCELED'))
    or (old.state = 'RUNNING' and new.state in ('SUCCEEDED', 'FAILED', 'CANCELED'))) then
    raise exception 'JOB_TRANSITION' using errcode = 'P0001', detail = old.state || ' -> ' || new.state;
  end if;
  new.updated_at := now();
  return new;
end
$$;
create trigger automation_job_guard before update on automation_jobs
  for each row execute function app.automation_job_guard();

-- Steps (checkpoints). effect decides what happens to a step whose result was lost: read/navigation/session steps
-- are safe to repeat; an external_mutation step is never repeated (its outcome becomes 'outcome_unknown').
create table job_steps (
  org_id       text not null references organizations(id) on delete cascade,
  job_id       text not null,
  sequence     integer not null check (sequence between 0 and 64),
  action       text not null check (action in ('open_profile', 'open_url', 'wait_for', 'screenshot', 'debug_bridge',
                                                'hold_open', 'close_profile')),
  effect       text not null check (effect in ('read', 'navigation', 'session', 'external_mutation')),
  input        jsonb not null default '{}'::jsonb check (length(input::text) <= 4000),
  state        text not null default 'pending'
                 check (state in ('pending', 'running', 'succeeded', 'failed', 'skipped', 'canceled', 'outcome_unknown')),
  attempt      integer not null default 0 check (attempt between 0 and 100),
  started_at   timestamptz,
  finished_at  timestamptz,
  error_code   text check (error_code ~ '^[A-Z_]{2,40}$'),
  -- Small typed values only (StepOutput): never page text, titles, full addresses or secrets.
  safe_output  jsonb check (safe_output is null or length(safe_output::text) <= 2000),
  primary key (job_id, sequence),
  foreign key (org_id, job_id) references automation_jobs (org_id, id) on delete cascade
);

-- Diagnostic screenshots (explicit steps only), deleted after 7 days.
create table job_artifacts (
  id            text primary key check (app.valid_id('art', id)),
  org_id        text not null references organizations(id) on delete cascade,
  job_id        text not null,
  sequence      integer not null,
  content_type  text not null check (content_type in ('image/jpeg', 'image/png')),
  bytes         bytea not null check (octet_length(bytes) between 1 and 1572864),
  sha256        text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  width         integer not null check (width between 0 and 100000),
  height        integer not null check (height between 0 and 100000),
  label         text check (length(label) between 1 and 80),
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null default now() + interval '7 days',
  unique (job_id, sequence),
  foreign key (org_id, job_id) references automation_jobs (org_id, id) on delete cascade
);

-- ------------------------------------------------------------------ webhooks
create table webhook_endpoints (
  id                  text primary key check (app.valid_id('whk', id)),
  org_id              text not null references organizations(id) on delete cascade,
  -- https only, no credentials or fragments, public destinations (checked by the API; the resolved addresses are
  -- checked again by the worker at every delivery).
  destination         text not null check (length(destination) between 10 and 2048 and destination ~ '^https?://[^\s@#]+$'),
  description         text not null default '' check (length(description) <= 200),
  events              text[] not null check (cardinality(events) between 1 and 20),
  state               text not null default 'active' check (state in ('active', 'disabled')),
  disabled_reason     text check (disabled_reason in ('manual', 'failing')),
  -- The signing secret, encrypted with the server's root key (AES-256-GCM, bound to org and endpoint).
  encrypted_secret    bytea not null,
  -- Which root key encrypted it.
  secret_key_ref      text not null check (length(secret_key_ref) between 1 and 64),
  -- During a rotation both secrets sign (two signatures in the header) until previous_secret_until.
  previous_encrypted_secret bytea,
  previous_secret_key_ref   text,
  previous_secret_until     timestamptz,
  secret_rotated_at   timestamptz,
  consecutive_dead    integer not null default 0 check (consecutive_dead >= 0),
  last_success_at     timestamptz,
  last_failure_at     timestamptz,
  created_by          text not null references users(id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  version             integer not null default 1 check (version >= 1),
  unique (org_id, id),
  check ((state = 'disabled') = (disabled_reason is not null))
);

create table webhook_deliveries (
  id               text primary key check (app.valid_id('dlv', id)),
  org_id           text not null references organizations(id) on delete cascade,
  endpoint_id      text not null,
  -- The event's id is the webhook-id header: retries carry the same id, so receivers deduplicate on it.
  event_id         text not null check (app.valid_id('evt', event_id)),
  event_type       text not null check (event_type ~ '^[a-z_]+(\.[a-z_]+)+$'),
  event_created_at timestamptz not null,
  payload          jsonb not null check (length(payload::text) <= 4000),
  state            text not null default 'pending' check (state in ('pending', 'delivered', 'dead')),
  attempt          integer not null default 0 check (attempt between 0 and 100),
  next_attempt_at  timestamptz,
  locked_until     timestamptz,
  last_status      integer,
  last_error       text check (last_error ~ '^[a-z0-9_]{1,40}$'),
  created_at       timestamptz not null default now(),
  delivered_at     timestamptz,
  unique (endpoint_id, event_id),
  foreign key (org_id, endpoint_id) references webhook_endpoints (org_id, id) on delete cascade,
  check ((state = 'pending') = (next_attempt_at is not null))
);
create index webhook_deliveries_due_idx on webhook_deliveries (next_attempt_at) where state = 'pending';
create index webhook_deliveries_endpoint_idx on webhook_deliveries (org_id, endpoint_id, created_at desc, id desc);

-- ------------------------------------------------------------------ worker functions (fixed bodies, definer)
-- Due deliveries, fairly across organizations: at most p_per_org per organization per batch, oldest first. Each
-- returned delivery is locked for 60 s (another worker skips it).
create function app.webhook_claim_due(p_limit integer, p_per_org integer)
  returns table (id text, org_id text, endpoint_id text, destination text, encrypted_secret bytea,
                 secret_key_ref text, previous_encrypted_secret bytea, previous_secret_key_ref text,
                 event_id text, event_type text, event_created_at timestamptz, payload jsonb, attempt integer)
  language plpgsql security definer set search_path = app, pg_temp
as $$
begin
  return query
  with ranked as (
    select d.id, row_number() over (partition by d.org_id order by d.next_attempt_at, d.id) as rn,
           d.next_attempt_at
      from webhook_deliveries d join webhook_endpoints e on e.id = d.endpoint_id
     where d.state = 'pending' and d.next_attempt_at <= now()
       and (d.locked_until is null or d.locked_until < now())
       and e.state = 'active'
  ), picked as (
    select r.id from ranked r where r.rn <= greatest(1, p_per_org)
     order by r.next_attempt_at, r.id limit greatest(1, least(p_limit, 500))
  ), locked as (
    update webhook_deliveries d set locked_until = now() + interval '60 seconds'
      from picked p where d.id = p.id
    returning d.*
  )
  select l.id, l.org_id, l.endpoint_id, e.destination, e.encrypted_secret, e.secret_key_ref,
         case when e.previous_secret_until > now() then e.previous_encrypted_secret end,
         case when e.previous_secret_until > now() then e.previous_secret_key_ref end,
         l.event_id, l.event_type, l.event_created_at, l.payload, l.attempt
    from locked l join webhook_endpoints e on e.id = l.endpoint_id;
end
$$;

-- Records one attempt. p_next_seconds null: no more attempts (dead). Twenty dead deliveries in a row turn the endpoint
-- off ('failing'); a success resets the count.
create function app.webhook_record_attempt(p_id text, p_ok boolean, p_status integer, p_error text,
                                           p_next_seconds integer)
  returns text
  language plpgsql security definer set search_path = app, pg_temp
as $$
declare
  d webhook_deliveries%rowtype;
  new_state text;
begin
  select * into d from webhook_deliveries where id = p_id for update;
  if not found or d.state <> 'pending' then
    return 'gone';
  end if;
  if p_ok then
    new_state := 'delivered';
  elsif p_next_seconds is null then
    new_state := 'dead';
  else
    new_state := 'pending';
  end if;
  update webhook_deliveries
     set state = new_state, attempt = d.attempt + 1, last_status = p_status,
         last_error = case when p_ok then null else p_error end, locked_until = null,
         delivered_at = case when p_ok then now() end,
         next_attempt_at = case when new_state = 'pending' then now() + make_interval(secs => p_next_seconds) end
   where id = p_id;
  if p_ok then
    update webhook_endpoints set consecutive_dead = 0, last_success_at = now() where id = d.endpoint_id;
  else
    update webhook_endpoints
       set last_failure_at = now(),
           consecutive_dead = consecutive_dead + (case when new_state = 'dead' then 1 else 0 end)
     where id = d.endpoint_id;
    if new_state = 'dead' then
      update webhook_endpoints set state = 'disabled', disabled_reason = 'failing', version = version + 1,
                                   updated_at = now()
       where id = d.endpoint_id and state = 'active' and consecutive_dead >= 20;
      if found then
        insert into audit_events (id, org_id, actor_user_id, actor_device_id, action, target_type, target_id,
                                  outcome, request_id, details)
        values (app.new_id('aud'), d.org_id, null, null, 'webhook.disabled', 'webhook', d.endpoint_id, 'success',
                app.new_id('req'), jsonb_build_object('reason', 'failing'));
      end if;
    end if;
  end if;
  return new_state;
end
$$;

-- Ends one job from the sweeper (no request context): steps that were running are failed (or marked
-- outcome_unknown when their effect is not safe to repeat), pending steps are skipped; audited; an outbox event lets
-- webhooks know.
create function app.automation_end_job(p_job text, p_state text, p_code text)
  returns void
  language plpgsql security definer set search_path = app, pg_temp
as $$
declare
  j automation_jobs%rowtype;
  unknown integer;
begin
  select * into j from automation_jobs where id = p_job for update;
  if not found or j.state in ('SUCCEEDED', 'FAILED', 'CANCELED') then
    return;
  end if;
  update job_steps set state = 'outcome_unknown', finished_at = now(), error_code = 'OUTCOME_UNKNOWN'
   where job_id = p_job and state = 'running' and effect = 'external_mutation';
  get diagnostics unknown = row_count;
  update job_steps set state = 'failed', finished_at = now(), error_code = p_code
   where job_id = p_job and state = 'running';
  update job_steps set state = 'skipped' where job_id = p_job and state = 'pending';
  update automation_jobs
     set state = p_state, error_code = p_code, finished_at = now(), holding = false,
         reconciliation_required = reconciliation_required or unknown > 0, version = version + 1
   where id = p_job;
  insert into audit_events (id, org_id, actor_user_id, actor_device_id, action, target_type, target_id, outcome,
                            request_id, details)
  values (app.new_id('aud'), j.org_id, null, null, 'automation.job_' || lower(p_state), 'job', p_job, 'success',
          app.new_id('req'), jsonb_build_object('reason', p_code, 'profile_id', j.profile_id));
  insert into outbox_events (event_id, org_id, actor_id, aggregate_id, aggregate_version, event_type,
                             redacted_payload)
  values (app.new_id('evt'), j.org_id, j.requested_by, p_job, j.version + 1,
          'automation.job.' || lower(p_state),
          jsonb_build_object('job_id', p_job, 'profile_id', j.profile_id, 'state', p_state, 'agent_id', j.agent_id,
                             'error_code', p_code, 'reconciliation_required', j.reconciliation_required or unknown > 0,
                             'attempt', j.attempt));
end
$$;

-- The sweeper (worker, every few seconds):
--  1. queued jobs nobody started in time fail (QUEUE_EXPIRED);
--  2. claims not started in time return to the queue (nothing ran), or fail after too many claims;
--  3. running jobs not heard from for 90 s are marked lost (their computer may come back and resume safe steps);
--     lost for longer than the resume window, they fail (AGENT_LOST; unknown outcomes need reconciliation);
--  4. profiles kept open past their time are asked to close (a stop request, like a cancel);
--  5. screenshots past their retention and finished jobs older than 30 days are deleted.
create function app.automation_sweep(p_limit integer, p_lost_seconds integer, p_resume_seconds integer,
                                     p_max_attempts integer)
  returns jsonb
  language plpgsql security definer set search_path = app, pg_temp
as $$
declare
  r record;
  expired integer := 0;
  requeued integer := 0;
  lost integer := 0;
  failed integer := 0;
  stopped integer := 0;
  artifacts integer := 0;
  purged integer := 0;
begin
  for r in select id from automation_jobs where state = 'QUEUED' and queue_expires_at <= now()
            order by queue_expires_at limit p_limit loop
    perform app.automation_end_job(r.id, 'FAILED', 'QUEUE_EXPIRED');
    expired := expired + 1;
  end loop;

  for r in select id, attempt, org_id, cancel_requested_at is not null as cancel from automation_jobs
            where state = 'CLAIMED' and claim_expires_at <= now() order by claim_expires_at limit p_limit loop
    if r.cancel then
      perform app.automation_end_job(r.id, 'CANCELED', 'CANCELED');
      failed := failed + 1;
    elsif r.attempt >= p_max_attempts then
      perform app.automation_end_job(r.id, 'FAILED', 'TOO_MANY_ATTEMPTS');
      failed := failed + 1;
    else
      update automation_jobs set state = 'QUEUED', agent_id = null, claimed_at = null, claim_expires_at = null,
                                 version = version + 1
       where id = r.id;
      insert into audit_events (id, org_id, actor_user_id, actor_device_id, action, target_type, target_id,
                                outcome, request_id, details)
      values (app.new_id('aud'), r.org_id, null, null, 'automation.job_requeued', 'job', r.id, 'success',
              app.new_id('req'), jsonb_build_object('reason', 'claim_expired'));
      requeued := requeued + 1;
    end if;
  end loop;

  update automation_jobs set lost_at = now()
   where state = 'RUNNING' and lost_at is null and heartbeat_at < now() - make_interval(secs => p_lost_seconds);
  get diagnostics lost = row_count;

  for r in select id from automation_jobs
            where state = 'RUNNING' and lost_at < now() - make_interval(secs => p_resume_seconds)
            order by lost_at limit p_limit loop
    perform app.automation_end_job(r.id, 'FAILED', 'AGENT_LOST');
    failed := failed + 1;
  end loop;

  update automation_jobs set cancel_requested_at = now(), cancel_reason = 'keep_open_elapsed', version = version + 1
   where state = 'RUNNING' and holding and cancel_requested_at is null
     and holding_since + make_interval(mins => keep_open_minutes) <= now();
  get diagnostics stopped = row_count;

  delete from job_artifacts where expires_at <= now();
  get diagnostics artifacts = row_count;
  delete from automation_jobs where id in (
    select id from automation_jobs where state in ('SUCCEEDED', 'FAILED', 'CANCELED')
       and finished_at < now() - interval '30 days' limit p_limit);
  get diagnostics purged = row_count;
  delete from webhook_deliveries where state <> 'pending' and created_at < now() - interval '30 days';

  return jsonb_build_object('expired', expired, 'requeued', requeued, 'lost', lost, 'failed', failed,
                            'stopped', stopped, 'artifacts_deleted', artifacts, 'jobs_purged', purged);
end
$$;

-- ------------------------------------------------------------------ row-level security and grants
alter table api_tokens          enable row level security;
alter table automation_settings enable row level security;
alter table automation_agents   enable row level security;
alter table automation_jobs     enable row level security;
alter table job_steps           enable row level security;
alter table job_artifacts       enable row level security;
alter table webhook_endpoints   enable row level security;
alter table webhook_deliveries  enable row level security;
create policy tenant_isolation on api_tokens
  using (org_id = app.current_org()) with check (org_id = app.current_org());
create policy tenant_isolation on automation_settings
  using (org_id = app.current_org()) with check (org_id = app.current_org());
create policy tenant_isolation on automation_agents
  using (org_id = app.current_org()) with check (org_id = app.current_org());
create policy tenant_isolation on automation_jobs
  using (org_id = app.current_org()) with check (org_id = app.current_org());
create policy tenant_isolation on job_steps
  using (org_id = app.current_org()) with check (org_id = app.current_org());
create policy tenant_isolation on job_artifacts
  using (org_id = app.current_org()) with check (org_id = app.current_org());
create policy tenant_isolation on webhook_endpoints
  using (org_id = app.current_org()) with check (org_id = app.current_org());
create policy tenant_isolation on webhook_deliveries
  using (org_id = app.current_org()) with check (org_id = app.current_org());

grant select, insert, update on api_tokens to pb_app;
grant select, insert, update on automation_settings to pb_app;
grant select, insert, update, delete on automation_agents to pb_app;
grant select, insert, update on automation_jobs to pb_app;
grant select, insert, update on job_steps to pb_app;
grant select, insert, update on job_artifacts to pb_app;  -- a retried screenshot replaces the upload
grant select, insert, update, delete on webhook_endpoints to pb_app;
grant select, insert, update on webhook_deliveries to pb_app;

-- The worker's fan-out runs inside each outbox event's transaction (app.org_id set): it reads the organization's
-- endpoints and creates deliveries. Everything else goes through the definer functions above.
grant select on webhook_endpoints to pb_worker;
grant select, insert on webhook_deliveries to pb_worker;  -- select: needed for "on conflict do nothing"

revoke all on function app.api_token_for_auth(text) from public;
revoke all on function app.api_token_touch(text) from public;
revoke all on function app.webhook_claim_due(integer, integer) from public;
revoke all on function app.webhook_record_attempt(text, boolean, integer, text, integer) from public;
revoke all on function app.automation_end_job(text, text, text) from public;
revoke all on function app.automation_sweep(integer, integer, integer, integer) from public;
grant execute on function app.api_token_for_auth(text) to pb_app;
grant execute on function app.api_token_touch(text) to pb_app;
revoke execute on function app.api_token_for_auth(text) from pb_worker;
revoke execute on function app.api_token_touch(text) from pb_worker;
grant execute on function app.webhook_claim_due(integer, integer) to pb_worker;
grant execute on function app.webhook_record_attempt(text, boolean, integer, text, integer) to pb_worker;
grant execute on function app.automation_sweep(integer, integer, integer, integer) to pb_worker;
revoke execute on function app.webhook_claim_due(integer, integer) from pb_app;
revoke execute on function app.webhook_record_attempt(text, boolean, integer, text, integer) from pb_app;
revoke execute on function app.automation_sweep(integer, integer, integer, integer) from pb_app;
revoke execute on function app.automation_end_job(text, text, text) from pb_app, pb_worker;
