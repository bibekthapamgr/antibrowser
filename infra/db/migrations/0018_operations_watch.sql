-- R7: operational health for the owner and alerts the worker raises by itself (nothing is removed or renamed).
--   1. Alert kinds for operations: queue_backlog (oldest outbox event or queued automation job waiting too long),
--      backup_failing (off-site log archiving failing now), restore_failed (the newest restore drill failed; written
--      by restore-drill.sh), sync_failures (many snapshot uploads failing in the last hour).
--   2. app.ops_alert / app.ops_resolve: one open alert per kind, raised and cleared again automatically.
--   3. app.ops_watch(): called by the worker every minute; returns the number of open operations alerts.
--   4. app.admin_health(): figures for the console's Operations page (staff-checked, counts and times only).
set search_path = app;

alter table billing_alerts drop constraint billing_alerts_kind_check;
alter table billing_alerts add constraint billing_alerts_kind_check
  check (kind in ('webhook_backlog', 'event_failed', 'unknown_customer', 'unknown_price', 'duplicate_subscriptions',
                  'paid_not_active', 'missed_webhook', 'dispute', 'refund', 'signature_failures', 'resync_failed',
                  'break_glass_used', 'publish_failed', 'queue_backlog', 'backup_failing', 'restore_failed',
                  'sync_failures'));

create function app.ops_alert(p_kind text, p_detail text) returns void
  language sql volatile security definer set search_path = app, pg_temp
as $$
  insert into billing_alerts (id, kind, org_id, ref, detail) values (app.new_id('alr'), p_kind, null, null, left(p_detail, 300))
  on conflict (kind, coalesce(org_id, ''), coalesce(ref, '')) where resolved_at is null
  do update set last_seen_at = now(), detail = excluded.detail
$$;
create function app.ops_resolve(p_kind text) returns void
  language sql volatile security definer set search_path = app, pg_temp
as $$
  update billing_alerts set resolved_at = now()
   where kind = p_kind and org_id is null and ref is null and resolved_at is null
$$;
revoke all on function app.ops_alert(text, text) from public;
revoke all on function app.ops_resolve(text) from public;

create function app.ops_watch() returns integer
  language plpgsql volatile security definer set search_path = app, pg_temp
as $$
declare
  v_outbox timestamptz;
  v_job timestamptz;
  v_failed bigint;
  v_archiving boolean;
  v_open integer;
begin
  select min(created_at) into v_outbox from outbox_events where published_at is null;
  select min(created_at) into v_job from automation_jobs where state = 'QUEUED';
  if v_outbox < now() - interval '15 minutes' or v_job < now() - interval '30 minutes' then
    perform app.ops_alert('queue_backlog', format('Oldest waiting: outbox event %s min, queued automation job %s min',
      coalesce(floor(extract(epoch from now() - v_outbox) / 60)::text, '-'),
      coalesce(floor(extract(epoch from now() - v_job) / 60)::text, '-')));
  else
    perform app.ops_resolve('queue_backlog');
  end if;

  -- Only where off-site archiving is in use: the newest attempt failed.
  select coalesce(last_failed_time > coalesce(last_archived_time, 'epoch'), false) into v_archiving from pg_stat_archiver;
  if v_archiving then
    perform app.ops_alert('backup_failing', 'Off-site log archiving is failing: the newest attempt failed (check R2)');
  else
    perform app.ops_resolve('backup_failing');
  end if;

  select count(*) into v_failed from snapshot_manifests where status = 'failed' and created_at > now() - interval '1 hour';
  if v_failed >= 10 then
    perform app.ops_alert('sync_failures', format('%s snapshot uploads failed verification in the last hour', v_failed));
  elsif v_failed = 0 then
    perform app.ops_resolve('sync_failures');
  end if;

  select count(*) into v_open from billing_alerts
   where kind in ('queue_backlog', 'backup_failing', 'restore_failed', 'sync_failures') and resolved_at is null;
  return v_open;
end
$$;
revoke all on function app.ops_watch() from public;
grant execute on function app.ops_watch() to pb_worker;

create function app.admin_health()
  returns table (signups_24h bigint, signups_7d bigint, checkouts_open bigint, checkout_oldest_open timestamptz,
                 leases_active bigint, leases_expired_unreleased bigint, snapshots_committed_24h bigint,
                 snapshots_failed_24h bigint, jobs_queued bigint, job_oldest_queued timestamptz,
                 archiving_failing boolean)
  language plpgsql stable security definer set search_path = app, pg_temp
as $$
begin
  perform app.staff_require('admin.operations.read');
  return query
  select (select count(*) from onboarding_state where state = 'ready' and completed_at > now() - interval '1 day'),
         (select count(*) from onboarding_state where state = 'ready' and completed_at > now() - interval '7 days'),
         (select count(*) from checkout_attempts where state = 'open'),
         (select min(created_at) from checkout_attempts where state = 'open'),
         (select count(*) from profile_leases where released_at is null and expires_at > now()),
         (select count(*) from profile_leases where released_at is null and expires_at <= now()
             and expires_at > now() - interval '1 day'),
         (select count(*) from snapshot_manifests where status = 'committed' and committed_at > now() - interval '1 day'),
         (select count(*) from snapshot_manifests where status = 'failed' and created_at > now() - interval '1 day'),
         (select count(*) from automation_jobs where state = 'QUEUED'),
         (select min(created_at) from automation_jobs where state = 'QUEUED'),
         (select coalesce(last_failed_time > coalesce(last_archived_time, 'epoch'), false) from pg_stat_archiver);
end
$$;
revoke all on function app.admin_health() from public;
grant execute on function app.admin_health() to pb_app;
