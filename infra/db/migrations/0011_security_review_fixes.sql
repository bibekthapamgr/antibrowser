-- Milestone 12 independent review fixes (docs/security/findings.md). Migration 0010 is left as released.
--   T1    Break-glass grants name the organizations they cover (1-10); support routes honour a grant only there.
--   T5    The trash purge re-checks, with the profile row locked, that the profile is still due (an undelete racing
--         the purge wins, or is refused once the purge has begun).
--   C-L3  The platform audit's hashed text joins its fields with U+001F; no field may contain that character, so
--         the text can be split back into exactly one set of fields. (Details are jsonb, whose text form escapes
--         control characters.)

-- ------------------------------------------------------------------ T1: break-glass names its organizations
create function app.valid_org_ids(p_ids text[]) returns boolean
  language sql immutable parallel safe
  as $$ select p_ids is not null and cardinality(p_ids) between 1 and 10
               and coalesce((select bool_and(app.valid_id('org', x)) from unnest(p_ids) as x), false) $$;

alter table break_glass_grants add column org_ids text[];
-- Grants written before this column existed have all expired (60 minutes at most); they are left unchecked and
-- cover no organization.
alter table break_glass_grants
  add constraint break_glass_grants_org_ids check (app.valid_org_ids(org_ids)) not valid;

comment on column break_glass_grants.org_ids is
  'The organizations this grant covers (1-10). Support routes honour break-glass for these organizations only.';

-- ------------------------------------------------------------------ T5: purge re-check
create function app.profile_purge_due(p_org text, p_profile text) returns boolean
  language sql stable security definer set search_path = app, pg_temp
as $$
  select exists (
    select 1 from profiles p join organizations o on o.id = p.org_id
     where p.org_id = p_org and p.id = p_profile and p.deleted_at is not null
       and p.deleted_at < now() - make_interval(days => o.trash_days))
$$;
revoke all on function app.profile_purge_due(text, text) from public;
grant execute on function app.profile_purge_due(text, text) to pb_worker;

-- ------------------------------------------------------------------ C-L3: unambiguous audit text
alter table platform_audit add constraint platform_audit_no_separator check (
  strpos(concat(id, action, actor_user_id, org_id, target, request_id), chr(31)) = 0);
