# Proxy protocol support matrix (milestone 05)

How a profile's traffic reaches the network. The browser is started with
`--proxy-server=http://127.0.0.1:<port>` pointing at a **loopback gateway** in the manager, plus
`--proxy-bypass-list=<-loopback>` (even `localhost` goes through the gateway) and `--disable-quic` (no UDP). The
gateway relays each connection through the profile's upstream proxy and adds the login itself, so the login is never
on a command line, in the browser, or in the browser's settings files. Design: [ADR-0012](../adr/0012-proxy-gateway-and-privacy-controls.md).

## Upstream proxies

| Type | Login | Supported | How the destination name is resolved | Notes |
|---|---|---|---|---|
| HTTP | none | **Yes** | By the proxy (`CONNECT host:port`, absolute-form `GET http://host/…`) | |
| HTTP | Basic | **Yes** | By the proxy | `Proxy-Authorization` sent only to the configured proxy, on every request |
| HTTP | Digest, NTLM, Negotiate/Kerberos | **No** → `PROXY_AUTH_UNSUPPORTED` | — | The error names the methods the proxy offered |
| HTTPS (TLS to the proxy) | none / Basic | **Yes** | By the proxy | The proxy's certificate is verified like a website's (OS trust store); a bad certificate → `PROXY_TLS_FAILED`, never ignored |
| SOCKS5 | none | **Yes** | By the proxy (SOCKS5 domain address type) | Same as `socks5h://` elsewhere: the device never looks up the site |
| SOCKS5 | username/password (RFC 1929) | **Yes** | By the proxy | |
| SOCKS5 | GSSAPI | **No** → `PROXY_AUTH_UNSUPPORTED` | — | |
| SOCKS4 / SOCKS4a | — | **No** (not offered) | — | Cannot carry a login or IPv6 |
| PAC files, WPAD, system proxy | — | **No** | — | A profile uses exactly the proxy assigned to it |
| Chained proxies, rotating endpoints | — | **No** | — | One fixed endpoint per proxy; nothing rotates during a session |

Only the proxy's **own** host name is resolved on the device (to connect to it). Every address it resolves to is
checked against the address policy before connecting.

## What goes through the proxy

| Traffic | Path | Evidence |
|---|---|---|
| `https://` and `wss://` pages | `CONNECT` tunnel through the gateway | `crates/netproxy/tests/routing.rs`; real browser in `tests/browser_network.rs` |
| `http://` pages | Absolute-form request forwarded through the proxy (`Connection: close`) | routing tests; real browser (page and report requests) |
| `ws://` WebSockets | `CONNECT` tunnel (Chromium tunnels WebSockets through HTTP proxies) | real browser: `CONNECT site.pb.test:80` in the proxy log |
| `localhost` / `127.0.0.1` pages | Through the proxy too (`<-loopback>`) | real browser outage test: the site on 127.0.0.1 was never contacted directly |
| HTTP/3 (QUIC, UDP) | Disabled (`--disable-quic`) | real browser: no UDP datagram in the network log (the only UDP socket is Chromium's IPv6 reachability probe, which is connected but sends nothing) |
| Browser DNS for sites | None: names go to the proxy | real browser: the network log shows only cache/hosts-file look-ups of the site's name, never a DNS query |
| WebRTC (calls, data channels) | Fail-closed profiles: `webrtc.ip_handling_policy = disable_non_proxied_udp` (UDP that cannot use the proxy is not sent) | real browser: 0 STUN packets from a fail-closed profile; the unproxied control profile sends them |
| Speculative pre-connects and DNS prefetch | Off for proxied profiles (`net.network_prediction_options = 2`) | prefs test |
| Browser background services (updates, safe browsing) | Through the gateway like everything else | real browser: every TCP connection in the log went to the gateway |

## Addresses (local policy)

| Proxy address | Default | With “Allow proxies on this computer or my local network” |
|---|---|---|
| Public addresses and host names that resolve to them | Allowed | Allowed |
| Loopback (127.0.0.0/8, ::1), private (10/8, 172.16/12, 192.168/16), carrier-grade NAT (100.64/10), IPv6 unique-local (fc00::/7), `localhost` | Refused → `PROXY_PRIVATE_ADDRESS` | Allowed |
| Link-local (169.254/16 incl. cloud metadata 169.254.169.254, fe80::/10), unspecified, multicast, broadcast, documentation ranges | Refused → `PROXY_FORBIDDEN_ADDRESS` | Still refused |

The rule is applied when a proxy is saved, when a profile opens and on **every** connection (a name that later
resolves to a refused address is refused then). A future cloud-side check service will apply the default column with
no override (roadmap: cloud tests reject private, link-local and metadata destinations).

## Failure behaviour

| Situation | Fail-closed on (default) | Fail-closed off |
|---|---|---|
| Proxy unreachable, its name not found, or no answer in time | Request fails (`502`, page says nothing was sent without the proxy); profile shows **Blocked** | Connection made **directly**; counted; profile shows **Direct** and the user is warned once per outage |
| Login rejected or missing, unsupported login method | Request fails; the browser never sees a `407` (no login prompt from a website or proxy) | Same (never direct) |
| Proxy certificate invalid (HTTPS proxy) | Request fails | Same (never direct) |
| Proxy reached, website unreachable | The browser shows the site as unreachable; the proxy is **not** marked failing | Same |
| Manager quits while a proxied profile stays open | The browser's connections fail (nothing is sent directly); the gateway is restored on the same port when the manager starts again | Same |
| Login missing from the keychain at launch | The profile does not open (`PROXY_CREDENTIALS_MISSING`); the app asks for the login | Same |

## Error codes

`PROXY_DNS_FAILED`, `PROXY_UNREACHABLE`, `PROXY_TIMEOUT`, `PROXY_TLS_FAILED`, `PROXY_AUTH_REQUIRED`,
`PROXY_AUTH_FAILED`, `PROXY_AUTH_UNSUPPORTED`, `PROXY_PROTOCOL_ERROR`, `PROXY_TARGET_FAILED`, `PROXY_TARGET_BLOCKED`,
`PROXY_PRIVATE_ADDRESS`, `PROXY_FORBIDDEN_ADDRESS`, `PROXY_CREDENTIALS_MISSING`, `CHECK_FAILED`. Each has a plain
sentence and a next step in the UI (`apps/desktop/src/network.tsx`, `PROXY_ERROR_HELP`).

## Limits

Timeouts: 10 s to connect to each proxy address, 15 s for the proxy handshake, 120 s for a plain-http response head,
30 s for a whole connectivity check. At most 256 simultaneous browser connections per profile gateway. Usernames and
passwords at most 255 bytes each (SOCKS5 carries each in one length byte); HTTP usernames cannot contain `:`.
