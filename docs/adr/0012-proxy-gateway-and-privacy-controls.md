# 0012 — Proxy routing through a loopback gateway, fail-closed by default; privacy and environment controls
Status: **Accepted** for the local engineering alpha. Date: 2026-10-13. Owner: technical lead + browser/security owner.
Builds on ADR-0001 (maintained Chromium distribution), ADR-0010 (runtime lifecycle) and the milestone 02 keychain rule
(secrets only in the OS keychain, never a file fallback).

## Context
Milestone 05 asks for per-profile proxies (HTTP CONNECT and SOCKS variants with an exact auth/DNS matrix), logins
kept in the OS keychain and bound to their endpoint, nothing secret in URLs, logs or command lines, user-started
connectivity checks, a fail-closed mode validated for browser, DNS and WebRTC traffic, browser-supported privacy and
environment controls with coherent presets, and expiry reminders without automatic rotation.

Chromium accepts a proxy address on its command line but **no password**, cannot log in to SOCKS5 proxies at all,
and would show a website-style login prompt for a `407`. Putting `user:pass@` in `--proxy-server` is not supported
and would expose the secret in the process list.

## Decision
1. **Loopback gateway per open profile** (`crates/netproxy`). The manager starts a small proxy on `127.0.0.1:<port>`
   (port chosen by the OS) for each profile that has a proxy, and launches the browser with
   `--proxy-server=http://127.0.0.1:<port>`, `--proxy-bypass-list=<-loopback>` and `--disable-quic`. The gateway
   accepts only loopback peers and only proxy requests (`CONNECT host:port` or absolute-form `http://`), relays each
   connection through the upstream proxy and adds the login there. A `407` from upstream becomes a `502` page with
   a code; the browser never prompts. The gateway runs on a dedicated two-thread Tokio runtime in the manager.
2. **Supported upstreams**: HTTP and HTTPS (TLS to the proxy, certificate verified with the OS trust store) with no
   login or Basic; SOCKS5 with no login or RFC 1929 username/password, always sending **domain names** (remote DNS).
   Digest, NTLM, Negotiate, GSSAPI and SOCKS4 fail visibly (`PROXY_AUTH_UNSUPPORTED`). Matrix:
   [network/protocol-support.md](../network/protocol-support.md).
3. **Logins**: entered once, written to the OS keychain under `proxy:<proxy id>#<random suffix>` as JSON, never
   returned over IPC (`has_login` only), never in SQLite (only the account name), exports, diagnostics, the audit log,
   `Debug` output, Preferences or the command line. A changed login gets a new suffix and the old entry is deleted only
   after the database update succeeds, so a rejected edit never leaves a changed login. Credentials are sent only to
   the endpoint they belong to (the gateway's single upstream). A missing keychain entry (the user removed it, or a
   Linux session keyring was cleared) stops the launch with `PROXY_CREDENTIALS_MISSING` and the UI asks for it.
4. **Fail-closed by default.** The gateway has no route except its upstream. With fail-closed **off** (an explicit
   per-profile choice) a connection whose proxy cannot be reached at all (name, address, time-out) is made directly
   instead, every such connection is counted, the profile shows “Direct” and the user is warned once per outage;
   login, TLS, address-policy and website errors never fall back. Fail-closed also forces
   `webrtc.ip_handling_policy = disable_non_proxied_udp`; any proxied profile gets speculative pre-connects and DNS
   prefetch off.
5. **Address policy** on every resolved proxy address: public always; loopback/private/CGNAT/ULA only with the local
   setting `proxies.allow_private_addresses` (off by default); link-local (incl. 169.254.169.254), unspecified,
   multicast, broadcast and documentation ranges never.
6. **No rotation mid-session.** Editing a proxy, changing a profile's assignment or its privacy settings never
   touches an open browser: the profile shows “restart required” and keeps its route until it is reopened. Expiry
   dates are reminders only (in the list, at launch and about hourly, once per proxy and state per session).
7. **Gateway sessions** (`gateway_sessions`: port, proxy, version, mode) are stored while a profile runs, so when the
   manager restarts and re-attaches a browser that stayed open, its gateway is recreated **on the same port**. If the
   manager is not running, a proxied browser's connections fail (nothing goes direct). If the port cannot be taken
   back the profile shows “lost — reopen it”.
8. **Connectivity checks** are started only by the user: one HTTPS request through the proxy to a check service that
   echoes the address it saw. Interim service for the alpha: `https://www.cloudflare.com/cdn-cgi/trace` (no account,
   plain text, `ip=` line), contacted only when the user presses Test. Records keep result, error code, latency,
   exit address and time, and are deleted after 7 days. Milestone 06/13 replaces it with our own `/v1/netcheck`
   endpoint answering in the same format, which will also refuse private, link-local and metadata destinations.
9. **Privacy and environment controls** use only what Chromium supports: WebRTC IP handling, third-party cookie
   blocking, Do Not Track, page language (`--lang` + `intl.accept_languages`), time zone (`TZ`), initial window
   size, text size and reduced motion, plus the milestone 03 permission defaults. Coherent presets (locale presets
   set language and time zone together). Per-OS support is reported, not assumed: time zone is **unavailable on
   Windows** (Chromium reads the system zone there), language is partial on macOS (browser menus follow the OS).
   No fingerprint randomisation, user-agent or hardware spoofing (roadmap boundary). Detail:
   [network/environment-presets.md](../network/environment-presets.md).
10. **Leak evidence from the browser itself.** Test builds may pass `--log-net-log=<absolute path>` (the only valued
    switch in the test allowlist); `tests/browser_network.rs` reads Chromium's network log and asserts no DNS query
    for the site's name, no UDP datagrams (the IPv6 reachability probe socket sends nothing) and every TCP connection to
    the gateway, and counts STUN packets for WebRTC,
    with an unproxied control profile proving the counter works. The runtime pipeline runs it on Windows, macOS and
    Linux and publishes the findings as annotations ([network/leak-test-evidence.md](../network/leak-test-evidence.md)).

## Consequences
- Every byte of a proxied profile passes through the manager process: proxied profiles need the manager running
  (documented; the tray already keeps it alive), and the gateway is part of the security boundary (fuzz/pen test in
  milestone 12).
- Other programs of the same OS user can connect to a gateway port while the profile is open and would use its proxy
  and login. Accepted for now: such programs can already read the profile's data (security model disclosure 1).
- HTTP/3 is off for proxied profiles (QUIC cannot go through these proxies); pages still load over HTTP/2 or 1.1.
- Linux uses the kernel keyring (`linux-native`), which forgets logins at logout/reboot; the credential prompt covers
  it. Linux remains a development platform.
- One more runtime dependency set (tokio, rustls with the ring provider, rustls-platform-verifier).

## Evidence / verification
- `crates/netproxy/tests/routing.rs` (11 tests against in-process HTTP, HTTPS and SOCKS5 proxies): logins only to the
  proxy, 407 never reaching the browser, outage blocks and recovers, fail-open counted and limited to unreachable
  proxies, remote DNS for SOCKS5, HTTPS proxy certificates verified, IPv6, address policy, website errors not counted
  as proxy failures, check latency/exit address.
- `apps/desktop/src-tauri/tests/network.rs` (9 IPC tests): logins only in the keychain (database incl. WAL, list,
  diagnostics and all export formats searched for the username and password), validation, routing through the
  launched gateway, outage warning, restart-required, gateway restore after a manager restart, checks and retention,
  assignment/bulk/undo/deletion protection, privacy settings applied at launch.
- `apps/desktop/src-tauri/tests/browser_network.rs` (5 real-browser tests) — see the evidence document.

## Revisit when
- Our own check endpoint exists (06/13): switch the default check target and drop the interim service.
- Remote browser hosting (future tier): the gateway moves next to the browser; the address policy becomes mandatory.
- A customer needs Digest/NTLM, PAC or chained proxies: separate ADR with tests per method.
- Chromium gains per-profile proxy credentials in a supported form, or the gateway shows up in performance work (13).
