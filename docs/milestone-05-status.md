# Milestone 05 — status against the handoff file

Proxy connectivity, privacy and environment controls. Version 0.5.0. Decisions:
[ADR-0012](adr/0012-proxy-gateway-and-privacy-controls.md). Deliverables: [protocol support matrix](network/protocol-support.md),
[permission and environment presets](network/environment-presets.md), [leak-test evidence](network/leak-test-evidence.md),
[known limitations](network/README.md#known-limitations).

Scope reminder: a proxy changes the network path a profile uses; presets are configuration and QA controls. Nothing
in the product or docs claims undetectability, ban protection or fingerprint changes, and nothing is randomised.

## Build
| Required | Implemented |
|---|---|
| Proxy list/detail | **Proxies** screen (`apps/desktop/src/network.tsx`): name, type, address, login saved (never shown), profiles using it, last check (result, delay, exit address, time), expiry badge; Test, Edit, History (checks of the last 7 days), Delete (refused while profiles use it, with the reason) |
| Assignment | Drawer **Network** section: proxy picker, fail-closed switch with an explanation of both modes, live status, “restart required”; bulk **Set proxy…** with undo; filter by proxy (`ProfileFilter.proxy`); duplicates keep the proxy |
| Credential prompt | Add/edit dialog with a paste-line helper (`host:port:user:pass`, `user:pass@host:port`, optional scheme; the line itself is not kept). When a launch finds the login missing from the keychain (`PROXY_CREDENTIALS_MISSING`), a dialog asks for it and then opens the profile |
| Connection test and failure state | User-started checks with specific causes and next steps for every error code; table and drawer show **Blocked** (fail-closed), **Direct** (fail-closed off), **Reopen** (gateway lost) and **Restart**; toasts when a proxy starts failing, when traffic goes direct, when a proxy expires |
| Privacy/settings screen | Drawer **Privacy and environment** section: preset, page language, time zone, window size, text size, reduced motion, WebRTC address sharing (locked to “only through the proxy” when fail-closed), third-party cookies, Do Not Track; camera/microphone/location stay under Website permissions (03). Each setting shows what this OS's browser will do, including **“Not available on this computer”** |
| Presets labelled as configuration/QA | Copy on the section and in the docs: “do not make the profile look like a different device, and nothing is randomised”; preset names describe the task (Accessibility review, Small laptop window, German, Berlin time, …) |
| Settings | “Allow proxies on this computer or my local network” (off by default) |

## Steps
| Step | Status |
|---|---|
| 1. Tested HTTP CONNECT and SOCKS variants through a routing adapter; exact auth/DNS matrix; unsupported combinations fail visibly | Done. Loopback gateway (`crates/netproxy`) for HTTP and HTTPS proxies (none/Basic) and SOCKS5 (none/RFC 1929) with remote DNS; Digest/NTLM/Negotiate/GSSAPI → `PROXY_AUTH_UNSUPPORTED`, SOCKS4/PAC not offered. Matrix: [protocol-support.md](network/protocol-support.md). 11 routing tests against in-process proxies |
| 2. Credentials in the OS keychain, metadata only in SQLite; masked; bound to the assigned endpoint | Done. Keychain entry `proxy:<id>#<suffix>`; SQLite holds only that name; IPC returns `has_login` only; `Debug` redacts; the gateway sends the login only to its one upstream and never answers a challenge from anywhere else; a `407` never reaches the browser |
| 3. Validate scheme/host/port; no credentials in URLs, logs or command lines; spike proves credential handling first | Done. Host must be a bare name or IP literal (schemes, paths, `user@` refused), port 1–65535, logins ≤255 bytes, no `:` in HTTP usernames; the browser gets only `--proxy-server=http://127.0.0.1:<port>`. Spike = the routing tests plus `tests/network.rs`, which searches the database file and WAL, every IPC answer, diagnostics and all export formats for the username and password |
| 4. User-initiated checks against a controlled HTTPS service; latency, egress IP, time; no “safe from bans” | Done. One HTTPS request through the proxy to a service that echoes the address it saw (interim: Cloudflare `/cdn-cgi/trace`; our own `/v1/netcheck` later, ADR-0012). Wording: “Working · 182 ms · exit address …” |
| 5. Fail-closed mode validated for browser, DNS and WebRTC — not only UI | Done and validated in a real browser on Windows, macOS and Linux: no DNS query for the site, no UDP datagram, every TCP connection to the gateway, zero STUN packets, nothing reached the site during an outage ([evidence](network/leak-test-evidence.md)). Fail-closed off is an explicit per-profile choice; direct connections are counted and shown |
| 6. Browser-supported permission/privacy controls; geolocation denied unless granted; RTC tested on owned pages; OS limits documented | Done. Location/camera/microphone default to “Ask” (a page gets a prompt, nothing is granted silently; real browser: `prompt`, or `denied` when blocked or on http). WebRTC policy tested with a STUN counter and an unproxied control. Limits: [network/README.md](network/README.md#known-limitations) |
| 7. Coherent QA/accessibility presets; show unavailable settings; no fingerprint randomisation | Done. 10 presets; locale presets set language and time zone together; time zone shown unavailable on Windows (confirmed by the Windows run: the page kept UTC), language partial on macOS. Unknown setting keys are refused |
| 8. Expiry reminders; no automatic rotation mid-session | Done. Expiry date per proxy; badges at 7 days and after; reminders at launch and about hourly (once per proxy and state per session). Edits and reassignments never touch an open browser: “restart required” until reopened |

## Records and interfaces
| Required | Implemented as |
|---|---|
| `proxy_configs(id, owner_scope, type, host, port, credential_ref, version, expires_at)` | Schema v5 (`crates/storage/src/migrations.rs`), plus name (unique per workspace), notes and timestamps |
| `profile_network_settings(profile_id, proxy_id, fail_closed, config_version)` | Schema v5; `proxy_id` is `ON DELETE RESTRICT` (a used proxy cannot vanish) |
| `network_checks(id, proxy_id, result, latency_ms, checked_at)`; 7-day retention | Schema v5, plus `error_code` and `egress_ip`; purged about hourly (`CHECK_RETENTION_DAYS = 7`) |
| `proxies.test(id)` | `test_proxy { proxyId }` → check record (also `list_proxies`, `create_proxy`, `update_proxy`, `delete_proxy`, `list_proxy_checks`) |
| `profiles.assign_proxy(id, proxy_id, expected_version)` | `assign_proxy { profileId, proxyId, failClosed, expectedVersion }`; bulk `set_proxy` |
| `privacy.validate(config)` | `validate_privacy { config, failClosedProxy }` → valid, error, per-field support report; `get_privacy_options`; `update_profile { privacy }` |
| Later cloud tests reject private/link-local/metadata; local private proxies only by explicit local policy | The same address policy is enforced locally on every connection; private addresses only with `proxies.allow_private_addresses`; link-local/metadata never. The cloud check endpoint (06/13) will apply it with no override |

Also added: `gateway_sessions` (restore a running profile's gateway on the same port after a manager restart) and
`profiles.privacy_json`. 9 new commands (53 in total), each granted individually to the main window; contract in
`packages/contracts/src/ipc.ts`, regenerated `docs/ipc-schema.json`.

## Tests and completion
| Criterion | Evidence |
|---|---|
| Controlled endpoints: DNS | Real browser (3 OSes): 0 DNS queries for the site's name; SOCKS5 proxy received the domain name. Routing tests: SOCKS5 remote DNS, proxy name resolution checked against the address policy |
| IPv4/IPv6 | Routing test `ipv6_proxies_and_destinations` (IPv6 proxy, IPv6 destination through it); browser runs over IPv4 loopback |
| Authentication failure | Routing tests (wrong/missing login, Digest-only proxy); IPC and real-browser checks report `PROXY_AUTH_FAILED`; missing keychain entry stops the launch and prompts |
| Proxy outage | Routing test (blocks, recovers); IPC test (warning, status, recovery); real browser on 3 OSes: nothing reached a directly reachable site |
| WebRTC policy | Real browser: 0 STUN packets and no candidates with fail-closed; 5–6 packets from the unproxied control |
| Sleep/wake | Not automatable on CI. The gateway opens a new upstream connection per browser connection, so no state survives a sleep; recovery after an outage is tested. A real sleep/wake check stays open for the pilot (known limitation 11) |
| No silent direct routing when fail-closed | Gateway has no direct route (routing + real-browser tests); fail-open only by explicit choice and only for an unreachable proxy, counted and shown |
| Browser features still work under the restrictions | Real browser with fail-closed + German/Kathmandu/1366×768/reduced motion/DNT: the page loaded, ran scripts, posted its report with `fetch`, opened a WebSocket tunnel and created a WebRTC offer; language, time zone (not Windows), window size and reduced motion took effect |
| Pass: the user understands failures and can choose recovery | Every error code has a cause and a next step (`PROXY_ERROR_HELP`); Blocked/Direct/Reopen/Restart states; credential prompt; e2e tests cover the prompt and the failing state |
| Pass: plaintext credentials never in exported configs or diagnostics | `tests/network.rs` `proxy_logins_live_only_in_the_keychain_and_never_leave_it` (CSV, JSON and bundle exports, diagnostics, database + WAL) |

Test counts at this milestone: netproxy 12 unit + 11 routing; runtime 41; storage 29 (6 for 05); desktop IPC 33 +
9 network + 19 unit; real browser 10 per OS (5 new); TypeScript 30 desktop unit (5 new); UI e2e 75 (16 new: five
screens in light and dark with axe and the 900×600 check, plus 6 flows).

CI: Linux push run green on `2f4cef8`; installers built ([desktop internal build 38348545803](https://github.com/bibekthapamgr/antibrowser/actions/runs/38348545803));
runtime pipeline [38348533869](https://github.com/bibekthapamgr/antibrowser/actions/runs/38348533869) passed the real-browser
set on all three OSes. The first full Windows/macOS run on `6df1fce` found two timing-dependent tests (a 10,000-row
import exceeding a 20 s wait on Windows, and two checks recorded in the same millisecond ordered by random id on
macOS); both were fixed (longer wait with diagnostics; insertion order as tie-breaker) and re-run.

## Release
Local engineering alpha after this milestone: single-user local profiles; no team sync claims. Installers remain
unsigned until the owner's certificates are added (os-setup.md); the browser is Chrome for Testing (ADR-0010 gate).
