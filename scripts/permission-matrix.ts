/** Generates docs/permission-matrix.md from the single source of truth in packages/contracts. */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  API_SCOPES,
  GRANT_CAPABILITIES,
  PERMISSION_CAPABILITY,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  ROLE_SCOPE,
  ROLES,
  SCOPE_LABELS,
  SCOPE_PERMISSIONS,
  STAFF_PERMISSION_MAPPING_VERSION,
  STAFF_PERMISSIONS,
  STAFF_ROLE_PERMISSIONS,
  STAFF_ROLES,
} from '../packages/contracts/src/index.ts';

const cell = (r: (typeof ROLES)[number], p: (typeof PERMISSIONS)[number]) => {
  if (!ROLE_PERMISSIONS[r].includes(p)) return '—';
  const cap = PERMISSION_CAPABILITY[p];
  return ROLE_SCOPE[r] === 'granted' && cap ? `with \`${cap}\`` : 'yes';
};
const rows = PERMISSIONS.map((p) => `| \`${p}\` | ${ROLES.map((r) => cell(r, p)).join(' | ')} |`);
const capabilityRows = GRANT_CAPABILITIES.map(
  (c) =>
    `| \`${c}\` | ${Object.entries(PERMISSION_CAPABILITY)
      .filter(([, v]) => v === c)
      .map(([k]) => `\`${k}\``)
      .join(', ')} |`,
);
const staffRows = STAFF_PERMISSIONS.map(
  (p) =>
    `| \`${p}\` | ${STAFF_ROLES.map((r) => (STAFF_ROLE_PERMISSIONS[r].includes(p) ? 'yes' : '—')).join(' | ')} |`,
);
const SCOPE_TEXT = { organization: 'all', granted: 'granted only', none: 'none' } as const;
const scopeRows = API_SCOPES.map(
  (scope) =>
    `  - \`${scope}\` — ${SCOPE_LABELS[scope]}: ${SCOPE_PERMISSIONS[scope].map((p) => `\`${p}\``).join(', ')}`,
).join('\n');

const md = `# Permission matrix

Generated from \`packages/contracts/src/resources.ts\` by \`pnpm run docs:permissions\`. Do not edit by hand.
Enforced only on the server (\`services/api/src/tenancy.ts\`, backed by PostgreSQL row-level security); the desktop and
web UIs may hide controls but are never the authority. Decisions: [ADR-0013](adr/0013-identity-and-authorization.md).

## Role permissions

| Permission | ${ROLES.join(' | ')} |
|---|${ROLES.map(() => '---').join('|')}|
${rows.join('\n')}

## Which clients and profiles a role reaches

| | ${ROLES.join(' | ')} |
|---|${ROLES.map(() => '---').join('|')}|
| Clients and profiles | ${ROLES.map((r) => SCOPE_TEXT[ROLE_SCOPE[r]]).join(' | ')} |

A permission on a client or profile applies only inside that reach. **Granted only**: the member's permission grants name
single profiles, a whole client (all its profiles, including ones added later), a folder or the whole workspace (R3,
[ADR-0022](adr/0022-unified-profiles-and-team-sharing.md)). A folder or whole-workspace grant follows profiles added
later — that is why it exists only when the person sharing chose "also profiles added later" in a preview; otherwise the
profiles there at that moment are granted one by one. Deny by default: no grant, no access. One definition of what a grant
covers (\`services/api/src/tenancy.ts\` \`grantCovers\`) is used for listing, opening (leases), automation and tokens.
Moving a profile between folders that changes who reaches it needs \`grants.manage\`, and ends the sessions of people
who lose it.

## Grant capabilities (milestone 08)

Members who reach profiles through grants also need the capability for the action, in a grant that covers the profile
("with \`launch\`" above). Access chosen with an invitation or on the Team page (R3) defaults to \`launch\` only (the
"Member" preset: open and use); grants made one by one through \`POST /orgs/{org}/grants\` keep their earlier default
(\`launch\` and \`backup_download\`) unless the admin chooses. Viewers' grants carry none. Permanent deletion, export,
billing and sharing (grants) are never grantable.

| Capability | Permissions it gates |
|---|---|
${capabilityRows.join('\n')}

## How a request is decided
1. **Organization**: the caller must be a member. Otherwise the answer is \`404 NOT_FOUND\`, exactly as for an
   organization that does not exist (the attempt is audited as \`org.access\` / denied).
2. **Reach**: a client or profile outside the member's reach answers \`404 NOT_FOUND\`, exactly as for a nonexistent id.
   Bulk operations report such ids as \`not_found\`; lists, search and export leave them out.
3. **Permission**: inside the reach, a role without the permission answers \`403 FORBIDDEN\` (audited as
   \`access.denied\`); so does a granted profile whose grants lack the capability (\`safe_details.capability\`).
4. Every check runs on every request, so a removed membership, grant or role change applies to the next request. A
   change that takes away someone's right to open a profile they have open also ends that session lease (milestone 08).

## Notes
- **owner**: everything, including ownership transfer and billing. Ownership moves only through
  \`POST /v1/orgs/{org}/ownership-transfer\` (recent sign-in required; the caller becomes admin). The last owner can never
  be removed or demoted (API and a deferred database constraint).
- **admin**: members, invitations, clients, grants, profiles and the audit log; no billing, no ownership transfer, and
  cannot change or remove an owner.
- **operator**: uses granted profiles as their grants allow: open them (\`launch\`, including the closing backup), edit
  their configuration (\`edit\`: name, notes; never moving them to another client) and restore backups
  (\`backup_download\`). Cannot create, delete, bulk-change or export profiles, or grant access.
  Adds and edits tasks of clients and profiles they reach (\`tasks.write\`, milestone 09): tasks on their profiles, or on
  the whole client with a whole-client grant; assigns tasks only to themselves and deletes only tasks they created.
- **viewer**: sees granted metadata only; cannot open profiles, read snapshots (logged-in sessions) or export.
- **billing**: subscription data only (milestone 11); no client or profile access at all.
- \`lease.force_release\`: forced takeover of a session (owners and admins, reason required, audited; milestone 08).
- \`profile.export\` additionally needs a sign-in within the last 10 minutes (milestone 08).
- \`extensions.manage\`: the organization's browser extension policy and the inventory of reported extensions
  (milestone 09, [extension policy](agency/extension-policy.md)). Every member reads the policy (\`org.read\`), because
  their app applies it.
- Client dashboards, tasks and bookmarks inherit the reach: a dashboard counts only profiles the caller can see; who works
  on a client and its recent activity are shown to holders of \`grants.manage\` and \`audit.read\` only (milestone 09).
- **Automation** (milestone 10, [ADR-0017](adr/0017-developer-api-and-automation.md)): \`automation.run\` asks for
  jobs on profiles one may open (operators: the grant's \`launch\` capability) and cancels one's own;
  \`automation.manage\` sets the approved sites and limits and cancels anyone's jobs; \`automation.debug\` asks for
  debugging (Playwright) sessions; \`automation.agent\` lets one's own computer run jobs as oneself (only profiles one
  may open). Jobs are visible to those who can see their profile.
- **API tokens** act as their owner and never beyond the owner's access *now*: each request needs the role permission,
  the grant capability and a token scope, inside the token's client/profile restrictions. Scopes:
${scopeRows}
  Tokens reach only the routes marked "API tokens: yes" in the OpenAPI document; tokens, webhooks, members, grants,
  computers and sessions need an interactive sign-in. \`tokens.create\`: one's own tokens; \`tokens.manage\`: see and
  revoke everyone's. A member who leaves loses their tokens and computers.
- \`webhooks.manage\`: webhook endpoints, their secrets and deliveries (owners and admins).
- \`billing.read\`: the subscription, plans, usage, invoices and receipts (owners and the billing role).
  \`billing.manage\`: checkout and the payment provider's customer portal — plan changes, payment methods,
  cancellation (owners only). A billing state never widens a role: restricted and canceled organizations refuse the
  creating and opening actions listed in ADR-0018 to every role, and keep reading, closing, backing up, exporting,
  deleting and billing. Support staff are not an organization role (ADR-0018).

## Platform staff (R5, [ADR-0024](adr/0024-business-owner-administration.md))

Staff are not workspace members and workspace owners are not staff. Staff are added only on the server
(\`staff.ts\`); the first platform owner is bootstrapped once (\`staff.ts bootstrap-owner\`) and the last one cannot
be removed. Every /v1/admin route names one permission below, checks it in the API and again in the database, and
needs a console session opened with a one-time code. Mapping version ${STAFF_PERMISSION_MAPPING_VERSION}.

| Permission | ${STAFF_ROLES.map((r) => `\`${r}\``).join(' | ')} |
|---|${STAFF_ROLES.map(() => '---').join('|')}|
${staffRows.join('\n')}

Support roles keep the milestone 11 tools (exact search, time-bound approved access to members and activity, overrides
for billing admins, alerts and audit for leads); they do not browse all customers.
`;
writeFileSync(join(import.meta.dirname, '..', 'docs', 'permission-matrix.md'), md);
console.log(md);
