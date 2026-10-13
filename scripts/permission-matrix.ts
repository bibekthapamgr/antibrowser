/** Generates docs/permission-matrix.md from the single source of truth in packages/contracts. */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PERMISSIONS, ROLE_PERMISSIONS, ROLE_SCOPE, ROLES } from '../packages/contracts/src/index.ts';

const rows = PERMISSIONS.map(
  (p) => `| \`${p}\` | ${ROLES.map((r) => (ROLE_PERMISSIONS[r].includes(p) ? 'yes' : '—')).join(' | ')} |`,
);
const SCOPE_TEXT = { organization: 'all', granted: 'granted only', none: 'none' } as const;
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
a whole client (all its profiles, including ones added later) or single profiles. Deny by default: no grant, no access.

## How a request is decided
1. **Organization**: the caller must be a member. Otherwise the answer is \`404 NOT_FOUND\`, exactly as for an
   organization that does not exist (the attempt is audited as \`org.access\` / denied).
2. **Reach**: a client or profile outside the member's reach answers \`404 NOT_FOUND\`, exactly as for a nonexistent id.
   Bulk operations report such ids as \`not_found\`; lists, search and export leave them out.
3. **Permission**: inside the reach, a role without the permission answers \`403 FORBIDDEN\` (audited as
   \`access.denied\`).
4. Every check runs on every request, so a removed membership, grant or role change applies to the next request.

## Notes
- **owner**: everything, including ownership transfer and billing. Ownership moves only through
  \`POST /v1/orgs/{org}/ownership-transfer\` (recent sign-in required; the caller becomes admin). The last owner can never
  be removed or demoted (API and a deferred database constraint).
- **admin**: members, invitations, clients, grants, profiles and the audit log; no billing, no ownership transfer, and
  cannot change or remove an owner.
- **operator**: uses granted profiles (open, save snapshots) but cannot create, rename, delete or export them.
- **viewer**: sees granted metadata only; cannot open profiles, read snapshots (logged-in sessions) or export.
- **billing**: subscription data only (milestone 11); no client or profile access at all.
- \`lease.force_release\` and \`billing.*\` are reserved for milestones 08 and 11; no endpoint uses them yet.
`;
writeFileSync(join(import.meta.dirname, '..', 'docs', 'permission-matrix.md'), md);
console.log(md);
