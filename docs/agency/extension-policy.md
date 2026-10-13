# Browser extension policy (for owners and admins)

Decide which browser extensions may be used in your organization's profiles. The app judges what the browser has
installed in each profile; it never installs, removes or loads extensions itself, and never bypasses the browser's
signature or security checks. Decisions: [ADR-0016](../adr/0016-agency-workspace-and-technical-health.md).

Where: Organization → Extensions (owners and admins edit; every member's app reads the policy because it applies it).

## Modes
| Mode | What happens when a profile has an extension that is not approved |
|---|---|
| Off | Nothing. Extensions are still listed (inventory) so you can prepare rules. |
| Warn | The profile opens normally; the person is told which extensions are not approved (a notice that stays until dismissed). |
| Enforce | The profile opens with **all** extensions turned off for that session (Chromium's own `--disable-extensions`), and the person is told why. Everything else about the profile works. |

"Not approved" means any installed extension — turned on or off in the browser, since it could be turned on during
the session — whose verdict below is not "Approved".

## Rules
One rule per extension (by its 32-letter id):

| Field | Meaning |
|---|---|
| Decision | Allowed or Blocked. A blocked extension is never approved, whatever its version. |
| From | Chrome Web Store only (default), or any supported source (also a computer policy, another program, or a folder in developer mode). |
| Approved versions | Empty: any version. `1.2.3` exactly (missing parts count as 0), `1.2.*` that prefix, or comparisons that must all hold: `>=4 <5`. Up to four parts per version. A range that does not parse is refused when you save. |
| Approved access | The sensitive permissions you accept for this extension. An update asking for anything sensitive beyond them needs your approval. |

### Verdicts
| Verdict | When |
|---|---|
| Approved | A rule allows it, from an allowed source, in the approved versions, asking for no sensitive access beyond what you approved |
| Not on your organization's list | No rule for it |
| Blocked by your organization | The rule blocks it |
| Only allowed from the Chrome Web Store | Installed another way while the rule says Web Store only |
| Version X is not approved yet | Its version is outside the approved range (typically after an automatic update) |
| Asks for more access than approved | Its permissions include something sensitive you did not approve |

The same rules run on the server, in the window and on the desktop (shared test vectors:
`packages/contracts/fixtures/extension-policy-cases.json`).

### Sensitive access
Any host pattern that matches every site (`<all_urls>`, `*://*/*`, `https://*/*`, `http://*/*`, `file://*/*`) and these
permissions: activeTab, bookmarks, browsingData, clipboardRead, contentSettings, cookies, debugger,
declarativeNetRequest, declarativeNetRequestWithHostAccess, desktopCapture, downloads, history, identity, management,
nativeMessaging, pageCapture, privacy, proxy, scripting, tabCapture, tabs, topSites, webNavigation, webRequest,
webRequestBlocking. Access to specific sites (e.g. `https://*.shop.example/*`) is listed but not counted as sensitive.

## Updates
Chromium updates Web Store extensions by itself while a profile runs. The app reads the profile's extensions when it
opens and after it closes, records version changes and newly requested sensitive access, and reports them to the
organization. An update outside the approved versions, or asking for more access, is judged at the next open: held
back in enforce mode (extensions off until you approve), announced in warn mode. Approving is a change to the rule
(widen the versions, or "Approve its access" in the inventory).

## What members' computers report
After an organization profile opens and after it closes, the person's app sends, for that profile and that computer
only: each extension's id, name, version, source, whether it is turned on, and the permissions it declares or was
granted. Never browsing data, page content, cookies or extension data. The inventory shows each extension's versions,
sources, how many profiles and computers have it, its access (sensitive items marked) and when it was last reported.

## What members see
Health → Extensions on their computer: every profile's extensions with version (and the previous one after an
update), source, sensitive access, and your verdict; whether extensions will be turned off at the next open. Before
opening a profile whose extensions will be turned off, the app says so and names them.

## Limits
- Enforce cannot stop someone installing an extension during a session (Chromium offers no per-profile policy without
  administering the whole computer). It is found when the session ends; the next open runs with extensions off.
- Turning extensions off is for all extensions of that session: Chromium has no supported switch to keep only some
  while keeping Web Store signature checks (`--disable-extensions-except` loads folders without them and is never
  used).
- A computer applies the policy it last downloaded (refreshed before an organization profile opens when older than 5
  minutes). Offline, organization profiles cannot open anyway (milestone 08).
- Local profiles (not shared with an organization) are not under the policy; the person reviews updates that ask for
  more access themselves.
