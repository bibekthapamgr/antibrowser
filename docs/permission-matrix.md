# Permission matrix

Generated from `packages/contracts/src/resources.ts` by `pnpm run docs:permissions`. Do not edit by hand.
Enforced only on the server (`services/api/src/tenancy.ts`, backed by PostgreSQL row-level security); the desktop and
web UIs may hide controls but are never the authority. Decisions: [ADR-0013](adr/0013-identity-and-authorization.md).

## Role permissions

| Permission | owner | admin | operator | viewer | billing |
|---|---|---|---|---|---|
| `org.read` | yes | yes | yes | yes | yes |
| `org.update` | yes | yes | — | — | — |
| `org.transfer_ownership` | yes | — | — | — | — |
| `members.read` | yes | yes | — | — | — |
| `members.manage` | yes | yes | — | — | — |
| `billing.read` | yes | — | — | — | yes |
| `billing.manage` | yes | — | — | — | — |
| `clients.read` | yes | yes | yes | yes | — |
| `clients.manage` | yes | yes | — | — | — |
| `profile.read` | yes | yes | yes | yes | — |
| `profile.create` | yes | yes | — | — | — |
| `profile.update` | yes | yes | with `edit` | — | — |
| `profile.delete` | yes | yes | — | — | — |
| `profile.export` | yes | yes | — | — | — |
| `profile.launch` | yes | yes | with `launch` | — | — |
| `snapshot.read` | yes | yes | yes | — | — |
| `snapshot.commit` | yes | yes | with `launch` | — | — |
| `snapshot.restore` | yes | yes | with `backup_download` | — | — |
| `backups.manage` | yes | yes | — | — | — |
| `keys.manage` | yes | — | — | — | — |
| `lease.force_release` | yes | yes | — | — | — |
| `grants.manage` | yes | yes | — | — | — |
| `audit.read` | yes | yes | — | — | — |
| `tasks.write` | yes | yes | yes | — | — |
| `extensions.manage` | yes | yes | — | — | — |

## Which clients and profiles a role reaches

| | owner | admin | operator | viewer | billing |
|---|---|---|---|---|---|
| Clients and profiles | all | all | granted only | granted only | none |

A permission on a client or profile applies only inside that reach. **Granted only**: the member's permission grants name
a whole client (all its profiles, including ones added later) or single profiles. Deny by default: no grant, no access.

## Grant capabilities (milestone 08)

Members who reach profiles through grants also need the capability for the action, in a grant that covers the profile
("with `launch`" above). New operator grants get `launch` and `backup_download` unless the admin chooses; viewers'
grants carry none. Permanent deletion, export and sharing (grants) are never grantable.

| Capability | Permissions it gates |
|---|---|
| `launch` | `profile.launch`, `snapshot.commit` |
| `edit` | `profile.update` |
| `backup_download` | `snapshot.restore` |

## How a request is decided
1. **Organization**: the caller must be a member. Otherwise the answer is `404 NOT_FOUND`, exactly as for an
   organization that does not exist (the attempt is audited as `org.access` / denied).
2. **Reach**: a client or profile outside the member's reach answers `404 NOT_FOUND`, exactly as for a nonexistent id.
   Bulk operations report such ids as `not_found`; lists, search and export leave them out.
3. **Permission**: inside the reach, a role without the permission answers `403 FORBIDDEN` (audited as
   `access.denied`); so does a granted profile whose grants lack the capability (`safe_details.capability`).
4. Every check runs on every request, so a removed membership, grant or role change applies to the next request. A
   change that takes away someone's right to open a profile they have open also ends that session lease (milestone 08).

## Notes
- **owner**: everything, including ownership transfer and billing. Ownership moves only through
  `POST /v1/orgs/{org}/ownership-transfer` (recent sign-in required; the caller becomes admin). The last owner can never
  be removed or demoted (API and a deferred database constraint).
- **admin**: members, invitations, clients, grants, profiles and the audit log; no billing, no ownership transfer, and
  cannot change or remove an owner.
- **operator**: uses granted profiles as their grants allow: open them (`launch`, including the closing backup), edit
  their configuration (`edit`: name, notes; never moving them to another client) and restore backups
  (`backup_download`). Cannot create, delete, bulk-change or export profiles, or grant access.
  Adds and edits tasks of clients and profiles they reach (`tasks.write`, milestone 09): tasks on their profiles, or on
  the whole client with a whole-client grant; assigns tasks only to themselves and deletes only tasks they created.
- **viewer**: sees granted metadata only; cannot open profiles, read snapshots (logged-in sessions) or export.
- **billing**: subscription data only (milestone 11); no client or profile access at all.
- `lease.force_release`: forced takeover of a session (owners and admins, reason required, audited; milestone 08).
- `profile.export` additionally needs a sign-in within the last 10 minutes (milestone 08).
- `extensions.manage`: the organization's browser extension policy and the inventory of reported extensions
  (milestone 09, [extension policy](agency/extension-policy.md)). Every member reads the policy (`org.read`), because
  their app applies it.
- Client dashboards, tasks and bookmarks inherit the reach: a dashboard counts only profiles the caller can see; who works
  on a client and its recent activity are shown to holders of `grants.manage` and `audit.read` only (milestone 09).
- `billing.*` are reserved for milestone 11; no endpoint uses them yet.
