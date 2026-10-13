# Leak-test evidence (milestone 05)

Real Chromium, real manager code, controlled local services; no external network is involved. Test file:
`apps/desktop/src-tauri/tests/browser_network.rs`. Run by the runtime pipeline on each OS against the pinned runtime
(Chrome for Testing **155.0.8059.39**): run [38348533869](https://github.com/bibekthapamgr/antibrowser/actions/runs/38348533869)
at commit `6df1fce`, 2026-10-13 — **10 of 10 real-browser tests passed on Windows x64, macOS arm64 and Linux x64**
(5 isolation tests from milestone 03 and the 5 tests below). Each test prints its findings as a CI annotation; the
values below are copied from those annotations.

## Set-up
- An in-process upstream proxy (HTTP with Basic login, or SOCKS5 with username/password). Only the proxy knows where
  the test site `site.pb.test` is; the name does not exist in any DNS, so a page can load only through the proxy.
- The test site (plain HTTP on 127.0.0.1) serves a page that reports `navigator.languages`, the time zone and its
  UTC offset, reduced motion, the window size, permission states, opens a WebSocket (`ws://site.pb.test/ws`) and
  gathers WebRTC candidates with a STUN server set to this computer's own network address.
- A UDP “STUN server” that only counts datagrams.
- Chromium's own network log (`--log-net-log`, a switch allowed only in test configurations), parsed after the
  browser closes: host-resolver events and their task types, TCP connection attempts, UDP sockets and UDP datagrams.
- The profile is launched by the manager exactly as in the app (gateway, switches, Preferences); the proxy login is
  in an in-memory secret store standing in for the keychain.

## Results

| Check | Windows x64 | macOS arm64 | Linux x64 |
|---|---|---|---|
| **HTTP proxy, fail-closed** (`http_proxy_fail_closed_no_dns_udp_or_webrtc_leaks`) | pass | pass | pass |
| Page, WebSocket and report reached the site only through the proxy, with the login | 12 proxy requests, WebSocket via `CONNECT` | 11, via `CONNECT` | 14, via `CONNECT` |
| DNS queries for the site's name made by the browser | **0** | **0** | **0** |
| Look-ups of the site's name limited to the browser cache / hosts file (no packet) | 1 | 1 | 1 |
| TCP connection attempts / not to the gateway | 12 / **0** | 11 / **0** | 14 / **0** |
| UDP datagrams sent (DNS, QUIC, anything) | **0** | **0** | **0** |
| UDP sockets other than Chromium's IPv6 reachability probe | 0 | 0 | 0 |
| WebRTC: STUN packets received / candidates gathered | **0** / 0 | **0** / 0 | **0** / 0 |
| Page language (`navigator.languages`, `Accept-Language`) | `de-DE`, `de-DE,de;q=0.9` | same | same |
| Time zone seen by the page (setting: Asia/Kathmandu) | `UTC`, offset 0 — **unavailable on Windows**, as documented | `Asia/Katmandu`, −345 min | `Asia/Katmandu`, −345 min |
| Window size (setting: 1366×768) | 1044×768 (shrunk to the runner's 1024-wide screen) | 1366×768 | 1366×768 |
| Reduced motion, Do Not Track header | yes, `DNT: 1` | yes | yes |
| Permissions on a plain-http page (camera, microphone, location) | all `denied` | all `denied` | all `denied` |
| **SOCKS5 with login** (`socks5_proxy_resolves_names_remotely`) | pass | pass | pass |
| Proxy received `SOCKS5 domain site.pb.test:80` (remote DNS) | yes | yes | yes |
| DNS queries for the site / UDP datagrams / TCP not to the gateway | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |
| **Proxy down, fail-closed** (`proxy_outage_blocks_traffic_instead_of_going_direct`) | pass | pass | pass |
| Requests that reached the site (it was on 127.0.0.1, reachable directly) | **0** | **0** | **0** |
| TCP attempts / not to the gateway; UDP datagrams | 11 / 0; 0 | 11 / 0; 0 | 11 / 0; 0 |
| Profile status shown | Blocked (`PROXY_UNREACHABLE`) | same | same |
| **Proxy down, fail-closed off** (`fail_open_is_visible_when_traffic_goes_direct`) | pass | pass | pass |
| Page loaded directly; profile shows “Direct” with a count | 12 direct connections | 13 | 14 |
| **Control without a proxy** (`unproxied_control_profile_does_reach_the_stun_server`) | pass | pass | pass |
| STUN packets from the same page (proves the counter works) | 5 | 6 | 6 |
| Permissions on a secure (localhost) page with location set to Block | location `denied`, camera and microphone `prompt` | same | same |

## Reading the network log
- Chromium logs a host-resolver request for a page's host even when a proxy is used; its **task sequence** shows
  whether it can reach the network. For the site the sequence held only cache and hosts-file tasks, and
  no DNS task, DNS transaction or system-resolver task ever named the site. Any other sequence fails the test.
- The only UDP socket in proxied runs is Chromium's **IPv6 reachability probe**: a UDP socket *connected* to
  `[2001:4860:4860::8888]:443` so the OS reports whether an IPv6 route exists. A connect on UDP sends nothing, and the
  log shows no UDP datagram at all; the tests fail on any datagram or any other UDP destination.
- WebRTC traffic does not appear in the network log, hence the separate STUN counter and the control profile.

## Not covered by these runs
- An actual OS sleep/wake cycle and switching Wi-Fi networks (see [README.md](README.md), limitation 11).
- IPv6-only networks and real third-party proxies; the routing tests cover IPv6 proxies and destinations in-process.
- Linux sandbox runs locally (Chromium 141, non-root user) gave the same results before the CI run.
