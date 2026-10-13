# Health definitions

Health (desktop: Health) describes this computer, the organization server, proxies, the browser, backups, sessions,
extensions and memory. Every card shows its status in words (OK, Needs attention, Problem, Unknown, Not used — never
colour alone), when it was checked and, where it applies, until when the result counts. A result past that time is
**Unknown**, never the old result: a proxy check from last week does not mean the proxy works now.

Health never says anything about website accounts. Whether a site restricts or closes an account is not something the
app can know, so there is no "ban risk" or similar score anywhere (a test checks the words are absent).

| Card | What is checked | Counts for | OK | Needs attention | Problem | Unknown | Not used | Button |
|---|---|---|---|---|---|---|---|---|
| Server connection | A signed-in request to the organization server (`GET /v1/me`); run when the app starts, when the Health page opens without a current result, every 5 minutes while signed in (reconnect banner) and on demand | 15 minutes | The server answered and the sign-in works | Signed out: sign in again | The server could not be reached, or answered unexpectedly | Never checked, or the result expired | No organization server set up | Check again |
| Proxies | The last user-started check of each proxy in the workspace (address reachable through the proxy, as in milestone 05) | 24 hours per proxy | All checked within 24 hours and reachable | — | At least one failed its last check (with its error code) | Never checked, or the check is older than 24 hours | No proxies | Check all proxies (at most 20, one after another) |
| Browser | The browser this app opens profiles with: installed, verified against the signed manifest, the version the app is built for | Now | Installed and verified (or a development browser) | — | Not installed yet, or the manifest could not be verified | — | — | Open downloads and updates |
| Backups | Organization profiles on this computer: backed up at least once from here; not changed here for more than 7 days without a backup | Now | All current | Never backed up from here, or changed here without a backup for 7+ days | — | — | No organization profiles here | Show profiles |
| Sync conflicts | Backups that met a newer one from another computer; shared sessions waiting for a decision or with a lost connection | Now | None | A session is lost (reconnects by itself) or a handoff waits | A conflict needs a choice | — | — | Show profiles |
| Disk space | Free space where profiles are stored | Now | 5 GB or more | Less than 5 GB (backups may be skipped soon) | Less than 1 GB: profiles cannot open | Could not be read | — | — |
| Open profiles and sessions | Profiles open on this computer; shared sessions this computer holds | Now | Informational | — | — | — | — | Show resources |
| Extensions | Each profile's last scan: unreadable settings file, extensions not approved by the organization, updates asking for more access (local profiles) | Since each profile's last scan (shown) | Nothing waiting for review | Not approved (warn), an update to review, or an unreadable scan | Extensions will be turned off at the next open (enforce) | — | — | Show extensions |
| Memory | Free memory against this computer's measured use per profile (median; 450 MB before any measurement) plus 1 GB kept free | Now | Room for at least one more profile | Less than that | — | — | — | Show resources |

## Resources (Health → Resources)
- **Per profile**: the browser tree this app started or re-attached — its main process and every process that descends
  from it — with the number of processes, resident memory (RSS; working set on Windows) and how long it has been open.
  Memory shared between a browser's processes is counted in each, so the sum is an upper estimate.
- **Manager**: this app's own process and its helper processes that are not browser trees (for example the window's
  web view on Windows and Linux), shown separately and never added to the browsers.
- **Not counted**: any other browser on the computer, even another Chromium with the same executable, unless this app
  started it for a profile or re-attached it after a restart.
- **Estimate**: each time resources are shown, every open profile whose browser is fully started (more than two
  processes) adds one measurement (kept: the newest 200). The median is used for the memory card and before opening profiles; it says nothing about what a particular
  website will need.

## Before opening profiles
The app asks first only when free memory minus 1 GB is less than the estimate times the number of profiles to open
(setting "Warn before opening profiles when free memory looks too low", on by default), or when the organization's
policy will turn extensions off. Nothing is ever closed for the person.

## Reconnect and notifications
- While signed in and the server check fails, a banner says organization profiles cannot open and backups wait; local
  profiles work as usual. "Try again" runs one check (no retry loop). An ended session shows "Sign in again".
- The notification centre keeps what needs attention until it is resolved (for example the next successful backup of
  that profile, or the session reconnecting) or dismissed. Repeated short messages are counted instead of stacked.
