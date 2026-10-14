# R3 — screen map

Decisions: [ADR-0022](../adr/0022-unified-profiles-and-team-sharing.md). Before: [R1 inventory and screen map](../r1/inventory-and-screen-map.md).

## Navigation (default, `ui.unified_profiles` on)

| Sidebar | Screen | Code | Who sees what |
|---|---|---|---|
| Workspace switcher | account workspaces (role shown) + **This computer** | `App.tsx` | Signed out: This computer only |
| **Profiles** — account workspace | merged list: name, folder, status, last backup; Open/Close, Details, Move…, Take over…, Delete; search, folder filter, New folder, **New profile** | `workspace.tsx` `WorkspaceProfiles` | Rows = profiles the person reaches (API). Open needs `launch`; Move needs `edit` + `profile.update`; New profile/Delete/Take over by role |
| **Profiles** — This computer | "This computer" note + the local profile manager (milestone 04 screen); *Move profiles into a workspace…* (R1 adoption); *Sign in or create an account* when signed out | `workspace.tsx` `ThisComputerBanner`, `profiles.tsx` | Local-only; nothing uploads unless moved |
| **Proxies** | proxies of this computer | `network.tsx` | — |
| *Agency tools* (only when used) | clients, dashboards, tasks, bookmarks | `workspace.tsx` `AgencyTools` → `org.tsx` `ClientsSection` | `clients.read` and the workspace uses clients (`modules.agency` or client records) |
| **Team** | seats; Members (role, *Access…*, remove/leave, transfer ownership); Pending invitations (*Invite someone…* wizard, withdraw); detailed access (each grant) | `team-access.tsx` `TeamScreen` | Members list: `members.read`; invite: `members.manage`; access: `grants.manage` |
| **Subscription** | plan, usage, invoices, checkout/portal | `workspace.tsx` `SubscriptionScreen` → `billing.tsx` | `billing.read`; others see "managed by owners and billing managers" |
| **Settings → General** | appearance, *Profiles view* (rollback switch), quitting, proxies, automation on this computer, library, privacy… | `screens.tsx` `SettingsScreen` | — |
| **Settings → Account** | server, sign-in/create account, devices, join with a code | `account.tsx` | — |
| **Settings → Updates and downloads** | app and browser updates, imports | `screens.tsx` `DownloadsScreen`, `updates.tsx` | — |
| **Settings → Health and diagnostics** | health cards, memory, extensions, diagnostics report | `health.tsx` | — |
| **Settings → Workspace** | Workspace (rename, copy from this computer), Backups (policy, trash, keys, recovery copies), Extension policy, Developer tools, Activity | `workspace.tsx` `WorkspaceSettings` | Tabs by permission; Developer tools only with `modules.automation` |
| Always visible | reconnect banner, update banner, billing banner, notifications | `notices.tsx`, `updates.tsx`, `billing.tsx` | — |

## Dialogs
| Dialog | Steps / fields |
|---|---|
| New profile | Name · Folder (optional) · Proxy on this computer (optional) → Create profile |
| Invite someone | E-mail (+ validity) → Role preset (Member, Member who can edit, Viewer, Admin, Billing manager; "also restore and download backups") → Profiles (all / folder / selected, "also profiles added later") → Review (server preview: count, names, future rule, what they can do) → Send |
| Access of a member | Profiles (same picker) + "They can also: change settings / restore and download backups" → Preview → Save (replaces) |
| Move | Folder → who gains / loses access (server) → Move (refused without grant management) |
| Move profiles into a workspace | Workspace → plan (each local profile: movable / already in / close first / open-and-close first) → quota → Move |

## Redirects from earlier destinations
| Earlier | Now |
|---|---|
| Organization (any section) | Profiles of that workspace; sections live in Team, Subscription, Agency tools, Settings → Workspace |
| Account | Settings → Account |
| Health (and its tabs) | Settings → Health and diagnostics (same tab) |
| Downloads and updates | Settings → Updates and downloads |
| Command palette "Go to organization X" | "Switch to workspace X" |

## Rollback
Settings → General → *Profiles view: use the earlier screens*, or the R1 migration rollback, sets `ui.unified_profiles`
off: the milestone 02–12 navigation returns unchanged (and is what those end-to-end suites exercise).

## Pictures
`PB_SCREENSHOTS=1` with the desktop end-to-end suite writes `docs/design/r3-*-light.png` / `-dark.png` for every R3
screen listed in the accessibility sweep (profiles, this computer, member profiles, create profile, team, invite
wizard, subscription, settings).
