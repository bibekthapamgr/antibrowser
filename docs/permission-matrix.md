# Permission matrix (draft)

Generated from `packages/contracts/src/resources.ts` by `pnpm run docs:permissions`. Do not edit by hand.
Enforced only on the server (`services/api/src/tenancy.ts`); the desktop and web UIs may hide controls but are never the authority.

| Permission | owner | admin | manager | operator | viewer |
|---|---|---|---|---|---|
| `org.read` | yes | yes | yes | yes | yes |
| `org.manage_members` | yes | yes | — | — | — |
| `org.manage_billing` | yes | — | — | — | — |
| `profile.read` | yes | yes | yes | yes | yes |
| `profile.create` | yes | yes | yes | — | — |
| `profile.update` | yes | yes | yes | — | — |
| `profile.delete` | yes | yes | yes | — | — |
| `profile.launch` | yes | yes | yes | yes | — |
| `lease.force_release` | yes | yes | yes | — | — |
| `snapshot.commit` | yes | yes | yes | yes | — |
| `snapshot.restore` | yes | yes | yes | yes | — |
| `audit.read` | yes | yes | yes | — | — |

## Notes for review (milestone 06)
- **owner** is the only role with billing. Every organization must keep at least one owner.
- **admin** manages members but cannot change billing.
- **manager** runs client workspaces: creates/edits profiles and can force-release a stuck lease (handoff, milestone 08).
- **operator** uses profiles (launch, snapshot) but cannot create, rename or delete them.
- **viewer** is read-only; it cannot open profiles, because opening exposes logged-in sessions.
- Open question: should operators be limited to profiles assigned to them (per-profile grants)? Proposed for 08.
