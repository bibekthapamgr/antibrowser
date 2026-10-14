-- R3: simple team sharing (ADR-0022). ADDITIVE: no table, column or route is dropped or renamed. One check
-- constraint of permission_grants is replaced to admit the two new grant scopes.
--
--   1. permission_grants gains two scopes beside a client and a profile:
--        folder_id     every profile in that folder, now and later (an explicit, previewed rule: ADR-0022 replaces
--                      ADR-0020's "a folder is never a grant scope" with "only by an explicit folder grant");
--        all_profiles  every profile of the workspace, now and later.
--      Exactly one scope per grant. Effective access is one SQL definition used by the API, automation and the
--      desktop (services/api/src/tenancy.ts grantCovers).
--   2. invitation_grants: what an invited member may reach, chosen with the invitation (all profiles, a folder,
--      selected profiles; capabilities), applied in the same transaction that accepts the invitation.
set search_path = app;

-- ------------------------------------------------------------------ 1. folder and whole-workspace grants
alter table permission_grants
  add column folder_id    text,
  add column all_profiles boolean not null default false,
  add foreign key (org_id, folder_id) references folders (org_id, id) on delete cascade;
alter table permission_grants drop constraint permission_grants_check;
alter table permission_grants add constraint permission_grants_one_scope
  check (num_nonnulls(client_id, profile_id, folder_id) + (case when all_profiles then 1 else 0 end) = 1);
create unique index permission_grants_folder_uq on permission_grants (org_id, user_id, folder_id)
  where folder_id is not null;
create unique index permission_grants_all_uq on permission_grants (org_id, user_id) where all_profiles;

-- ------------------------------------------------------------------ 2. access chosen with an invitation
create table invitation_grants (
  id            text primary key check (app.valid_id('grt', id)),
  org_id        text not null references organizations(id) on delete cascade,
  invitation_id text not null,
  client_id     text,
  profile_id    text,
  folder_id     text,
  all_profiles  boolean not null default false,
  capabilities  text[] not null default '{}'
                check (capabilities <@ array['launch', 'edit', 'backup_download']::text[]),
  created_at    timestamptz not null default now(),
  check (num_nonnulls(client_id, profile_id, folder_id) + (case when all_profiles then 1 else 0 end) = 1),
  foreign key (org_id, invitation_id) references invitations (org_id, id) on delete cascade,
  foreign key (org_id, client_id) references clients (org_id, id) on delete cascade,
  foreign key (org_id, profile_id) references profiles (org_id, id) on delete cascade,
  foreign key (org_id, folder_id) references folders (org_id, id) on delete cascade
);
create index invitation_grants_invitation_idx on invitation_grants (org_id, invitation_id);
alter table invitation_grants enable row level security;
create policy tenant_isolation on invitation_grants
  using (org_id = app.current_org()) with check (org_id = app.current_org());
grant select, insert, delete on invitation_grants to pb_app;

-- Accepting an invitation also gives the access chosen with it (same transaction; nothing is applied to admins, who
-- reach every profile anyway). Everything else as in 0013.
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
  if exists (select 1 from organizations o where o.id = inv.org_id and o.suspended_at is not null) then
    return query select 'workspace_suspended'::text, null::text, null::text, inv.id; return;
  end if;
  perform 1 from subscriptions s where s.org_id = inv.org_id for update;
  allowed := app.billing_limit(inv.org_id, 'seats');
  select count(*) into members from memberships m where m.org_id = inv.org_id;
  if allowed is not null and members + 1 > allowed then
    return query select 'seats_full'::text, null::text, null::text, inv.id; return;
  end if;
  insert into memberships (org_id, user_id, role) values (inv.org_id, p_user_id, inv.role);
  if inv.role in ('operator', 'viewer') then
    insert into permission_grants (id, org_id, user_id, client_id, profile_id, folder_id, all_profiles, created_by,
                                   capabilities)
    select ig.id, ig.org_id, p_user_id, ig.client_id, ig.profile_id, ig.folder_id, ig.all_profiles, inv.created_by,
           case when inv.role = 'operator' then ig.capabilities else '{}'::text[] end
      from invitation_grants ig
     where ig.org_id = inv.org_id and ig.invitation_id = inv.id
       -- A profile deleted since the invitation was sent is skipped (its grant would point at nothing).
       and (ig.profile_id is null
            or exists (select 1 from profiles p where p.org_id = ig.org_id and p.id = ig.profile_id
                                                  and p.deleted_at is null))
    on conflict do nothing;
  end if;
  update invitations set accepted_at = now(), accepted_by = p_user_id, version = version + 1 where id = inv.id;
  return query select 'accepted'::text, inv.org_id, inv.role, inv.id;
end
$$;
