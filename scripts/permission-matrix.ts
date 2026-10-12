/** Generates docs/permission-matrix.md from the single source of truth in packages/contracts. */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PERMISSIONS, ROLE_PERMISSIONS, ROLES } from '../packages/contracts/src/index.ts';

const rows = PERMISSIONS.map(
  (p) => `| \`${p}\` | ${ROLES.map((r) => (ROLE_PERMISSIONS[r].includes(p) ? 'yes' : '—')).join(' | ')} |`,
);
const md = `# Permission matrix (draft)

Generated from \`packages/contracts/src/resources.ts\` by \`pnpm run docs:permissions\`. Do not edit by hand.
Enforced only on the server (\`services/api/src/tenancy.ts\`); the desktop and web UIs may hide controls but are never the authority.

| Permission | ${ROLES.join(' | ')} |
|---|${ROLES.map(() => '---').join('|')}|
${rows.join('\n')}

## Notes for review (milestone 06)
- **owner** is the only role with billing. Every organization must keep at least one owner.
- **admin** manages members but cannot change billing.
- **manager** runs client workspaces: creates/edits profiles and can force-release a stuck lease (handoff, milestone 08).
- **operator** uses profiles (launch, snapshot) but cannot create, rename or delete them.
- **viewer** is read-only; it cannot open profiles, because opening exposes logged-in sessions.
- Open question: should operators be limited to profiles assigned to them (per-profile grants)? Proposed for 08.
`;
writeFileSync(join(import.meta.dirname, '..', 'docs', 'permission-matrix.md'), md);
console.log(md);
