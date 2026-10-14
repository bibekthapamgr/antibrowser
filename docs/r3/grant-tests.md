# R3 — role and grant tests

Effective access has one definition, `grantCovers(g, p)` in `services/api/src/tenancy.ts`: a grant covers a profile
when it names the profile, the profile's client, the folder the profile is in, or all profiles. It is used by
`roleProfileVisible` (lists, reads, search, export, bulk), `clientVisible`, `requireCapability`, and in
`services/api/src/sessions.ts` (`capabilitiesSql`, `userMayLaunch`) for leases and automation; API tokens never go
beyond their owner's access.

## API (`services/api/test/team.test.ts`)
| Test | Proves |
|---|---|
| owner shares exactly 10 of 50 profiles; the teammate sees and opens only those 10 | preview count and names; invitation access applied at acceptance; list = those 10; lease on one of them 201, on another 404 |
| a Member can open and use by default, but not edit, export backups, delete, share or manage billing | capabilities `['launch']`; PATCH profile, snapshot download, DELETE, grants, billing → refused |
| a viewer invited with access sees the profiles but cannot open them | viewer grants carry no capabilities; lease refused |
| a folder grant follows future profiles only when that rule was chosen | "now" vs "also later" invitations; a profile filed later reaches only the second |
| moving a profile shows who gains or loses access; without grants.manage such a move is refused | `folder-impact`; operator with `edit` → 403 `grants.manage`; admin move ends the loser's lease |
| all profiles, now and later; or only those there now | whole-workspace rule vs snapshot of ids |
| setting a member's access replaces it and ends sessions they may no longer hold | `PUT …/members/{user}/access`; lease revoked |
| an invitation never grants a profile deleted in the meantime, and grants nothing to another workspace | deleted profiles skipped; foreign ids → 404 |
| creates a profile straight into a folder, shows its folder and filters the list by folder | `ProfileCreate.folder_id`, `Profile.folder_id`, `?folder_id=` and `none` |

`cross-tenant.test.ts` swaps another workspace's ids into the three new routes (preview, member access, folder impact):
404 without disclosure. The desktop allow-list (`crates/cloud/src/allow.rs` test `r3_team_sharing_routes`) admits only
the new routes, validates `folder_id`, never caches the impact, and refuses other methods on the access route.

## Desktop (`apps/desktop/e2e/manager.e2e.test.ts`, "R3 unified profiles and simple team sharing")
| Test | Proves |
|---|---|
| a fresh user signs up and reaches Create Profile without any organization, client or server setup | first run without a workspace step; sign up → workspace opens; New profile has only name, folder, proxy; open/close through the lease |
| an invitation shares exactly the chosen profiles, previewed first; Members open and use only | wizard steps; 10 selected → preview "10 profiles … only these … open and use them" → invitation listed |
| the teammate sees and opens only the 10 shared profiles, with no billing, export or sharing | 10 rows; no New profile, Move or Delete; open works; Subscription read-only text; no Invite |
| switching workspaces never shows the previous workspace's rows | a mutation observer records no row of the previous workspace after the switch |
| a linked profile appears once and opens its earlier session here | one row for the linked profile, Details from its copy, open → Running; This computer still lists it |
| recoverable states | in use by a teammate → *Ask for it*; server unreachable → saved copy marked or *Try again*, nothing opens from it |
| moving a profile shows who gains or loses access before anything changes | folder grant with "added later" via *Access…*; move → "Gain access: Sam Operator" → moved |

Plus the accessibility sweep (axe, light and dark, 900×600 without horizontal scroll) over eight R3 screens, and
keyboard checks inherited by the dialogs (focus trap, Escape, focus return).

Recoverable failures already covered by earlier suites and unchanged by R3: lease collision and forced takeover
(milestone 08), disk almost full warning (milestone 09), interrupted restore keeping the earlier copy (milestone 07,
`sync.rs`), pending closing backup (milestone 08). In the unified list they appear as *In use by teammate*,
*Recovery needed* and *Sync pending*.
