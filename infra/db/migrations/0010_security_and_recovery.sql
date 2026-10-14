-- Milestone 12: production security, updates and recovery (ADR-0019).
--   1. Recovery markers: the restore drill writes one into the live database just before it restores, so the drill
--      measures how recent the restored data is (recovery point) from the data itself. No application role can read or
--      write them.
--   2. The platform audit becomes append-only and hash-chained: every entry carries a sequence number and
--      sha256(previous hash || its canonical text). Updates, deletes and truncation are refused, and the chain head
--      lives where no application role can write. An export (services/api/scripts/audit-export.ts, or the staff
--      route) carries the hashes, so an exported copy kept elsewhere proves later that nothing was changed or removed.
--      The audit now outlives organizations (the organization id is kept as text, no longer cleared on deletion).
--   3. Break-glass access: a short (at most 60 minutes), reasoned emergency grant to one staff member, created only
--      with services/api/scripts/staff.ts on the server, never through the API. Its use is audited like everything
--      else and raises a console alert.

-- ------------------------------------------------------------------ 1. recovery markers
create table recovery_markers (
  id         bigserial primary key,
  created_at timestamptz not null default clock_timestamp(),
  note       text not null check (length(note) <= 200)
);
revoke all on recovery_markers from public;

-- ------------------------------------------------------------------ 2. append-only, hash-chained platform audit
alter table platform_audit drop constraint if exists platform_audit_org_id_fkey;
alter table platform_audit
  add column seq       bigint,
  add column prev_hash bytea,
  add column hash      bytea;

-- The exact text each entry's hash covers. Times are whole microseconds since the epoch (no time zone or format
-- dependence); details are PostgreSQL's canonical jsonb text. The export carries the same fields, so anyone can
-- recompute the chain.
create function platform_audit_text(
  p_seq bigint, p_id text, p_at timestamptz, p_actor text, p_action text, p_org text, p_target text,
  p_details jsonb, p_request text) returns text
  language sql immutable parallel safe
  as $$ select concat_ws(chr(31), p_seq::text, p_id, (extract(epoch from p_at) * 1000000)::bigint::text,
                         coalesce(p_actor, ''), p_action, coalesce(p_org, ''), coalesce(p_target, ''),
                         p_details::text, coalesce(p_request, '')) $$;

create table platform_audit_head (
  singleton boolean primary key default true check (singleton),
  seq       bigint not null,
  hash      bytea not null
);
revoke all on platform_audit_head from public;

-- Existing entries are chained in the order they were written.
do $$
declare
  r record;
  h bytea := '\x'::bytea;
  n bigint := 0;
begin
  for r in select * from platform_audit order by at, id loop
    n := n + 1;
    update platform_audit set seq = n, prev_hash = h,
      hash = sha256(h || convert_to(platform_audit_text(n, r.id, r.at, r.actor_user_id, r.action, r.org_id,
                                                        r.target, r.details, r.request_id), 'UTF8'))
     where id = r.id
     returning hash into h;
  end loop;
  insert into platform_audit_head (singleton, seq, hash) values (true, n, h);
end $$;

alter table platform_audit
  alter column seq set not null,
  alter column prev_hash set not null,
  alter column hash set not null,
  add constraint platform_audit_seq_key unique (seq);

create function platform_audit_chain() returns trigger
  language plpgsql security definer set search_path = app, pg_catalog
  as $$
declare
  h platform_audit_head%rowtype;
begin
  -- One writer at a time extends the chain; a rolled-back insert rolls the head back with it.
  select * into h from platform_audit_head where singleton for update;
  new.seq := h.seq + 1;
  new.at := now();
  new.prev_hash := h.hash;
  new.hash := sha256(h.hash || convert_to(platform_audit_text(new.seq, new.id, new.at, new.actor_user_id,
                                          new.action, new.org_id, new.target, new.details, new.request_id), 'UTF8'));
  update platform_audit_head set seq = new.seq, hash = new.hash where singleton;
  return new;
end $$;
revoke all on function platform_audit_chain() from public;

create function platform_audit_immutable() returns trigger
  language plpgsql
  as $$
begin
  raise exception 'the platform audit is append-only' using errcode = 'insufficient_privilege';
end $$;

create trigger platform_audit_chain before insert on platform_audit
  for each row execute function platform_audit_chain();
create trigger platform_audit_no_update before update or delete on platform_audit
  for each row execute function platform_audit_immutable();
create trigger platform_audit_no_truncate before truncate on platform_audit
  for each statement execute function platform_audit_immutable();

revoke update, delete, truncate on platform_audit from pb_app, pb_worker;

-- Staff exports read the chain head through this function only (no application role can write the head).
create function platform_audit_head_read(out seq bigint, out hash bytea)
  language sql stable security definer set search_path = app, pg_catalog
  as $$ select seq, hash from platform_audit_head where singleton $$;
revoke all on function platform_audit_head_read() from public;
grant execute on function platform_audit_head_read() to pb_app;

-- ------------------------------------------------------------------ 3. break-glass grants
create table break_glass_grants (
  id         text primary key check (app.valid_id('bgg', id)),
  user_id    text not null references platform_staff(user_id) on delete cascade,
  reason     text not null check (length(reason) between 20 and 500),
  -- Who ran the server command (operating-system account), recorded by staff.ts.
  granted_by text not null check (length(granted_by) between 1 and 80),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  check (expires_at > created_at and expires_at <= created_at + interval '60 minutes')
);
create index break_glass_grants_user_idx on break_glass_grants (user_id, expires_at desc);
grant select on break_glass_grants to pb_app;

-- A grant and every use of it raise a console alert.
alter table billing_alerts drop constraint billing_alerts_kind_check;
alter table billing_alerts add constraint billing_alerts_kind_check check (kind in ('webhook_backlog', 'event_failed',
  'unknown_customer', 'unknown_price', 'duplicate_subscriptions', 'paid_not_active', 'missed_webhook', 'dispute',
  'refund', 'signature_failures', 'resync_failed', 'break_glass_used'));

comment on table break_glass_grants is
  'Emergency staff access (milestone 12): at most 60 minutes, with a reason; created only by staff.ts on the server.';
