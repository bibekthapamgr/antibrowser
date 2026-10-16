# Network, privacy and environment (milestone 05)

| Document | What it covers |
|---|---|
| [protocol-support.md](protocol-support.md) | Supported proxy types, logins and DNS behaviour; what goes through the proxy; address policy; failure behaviour; error codes |
| [environment-presets.md](environment-presets.md) | Privacy, permission and environment settings, how each is applied per OS, and the presets |
| [leak-test-evidence.md](leak-test-evidence.md) | Real-browser leak tests (DNS, UDP/QUIC, TCP, WebRTC, environment) on Windows, macOS and Linux |
| [ADR-0012](../adr/0012-proxy-gateway-and-privacy-controls.md) | Design decisions: loopback gateway, fail-closed, logins in the keychain, checks, no rotation |
| [ADR-0027](../adr/0027-match-profile-to-proxy-location.md) | Matching a profile's time zone and language to its proxy's location (server-side geo from DB-IP Lite) |
| [ADR-0029](../adr/0029-proxy-location-lock-and-ip-check-page.md) | Warning before a profile opens from another country than last time (location lock), and the `/check/` page |

What a proxy does and does not do (also in the UI): a proxy changes the network path a profile uses and the address
websites see. It does not make a profile undetectable, does not change the device a website sees, and does not
protect an account from being restricted. Use proxies only where the website's terms and the account owner allow it.

## Known limitations

1. **Proxied profiles need the manager.** All of a proxied profile's traffic passes through a gateway inside the
   manager. If the manager is quit while the profile stays open, the profile has no connection (nothing is sent
   without the proxy) until the manager starts again and restores the gateway on the same port. The quit prompt says
   so. If another program has taken that port meanwhile, the profile shows “lost — reopen it”.
2. **Time zone on Windows.** Chromium on Windows always uses the system time zone; the setting is saved but shown as
   unavailable there. Pages may also see the older ICU name of a zone (for example `Asia/Katmandu` for
   `Asia/Kathmandu`); the offset is the same.
3. **Language on macOS** changes what websites get (`Accept-Language`, `navigator.languages`) but not the browser's
   own menus, which follow macOS.
4. **Window size** is the size the window opens at; the OS may shrink it to fit the screen, and the user can resize
   it. It is not a screen or device size.
5. **Supported logins**: Basic for HTTP/HTTPS proxies and username/password for SOCKS5. Digest, NTLM, Kerberos and
   GSSAPI fail with a clear error. No PAC files, system proxy, chained or rotating proxies.
6. **HTTP/3 is off** for proxied profiles (QUIC is UDP and cannot go through these proxies).
7. **WebRTC with fail-closed off** follows the profile's own WebRTC setting and may use direct UDP (calls work
   better, but a site can then see addresses of this computer). Fail-closed on (the default) restricts WebRTC to the
   proxy, which can make calls fail when the proxy cannot carry them.
8. **Local programs.** While a profile is open, other programs running as the same OS user could connect to its
   gateway port and use its proxy. Such programs can already read the profile's data (security model, disclosure 1).
9. **Linux keychain.** Linux builds use the kernel keyring, which forgets proxy logins at logout or reboot; the app
   asks for them again. Linux is a development platform only.
10. **Connectivity checks** contact a check service through the proxy: the account server's `/v1/netcheck` when one
    is configured (https; ADR-0027), otherwise Cloudflare's `/cdn-cgi/trace`. It sees the proxy's exit address.
    Checks run when you press Test; for a profile that matches its proxy, before it opens when the last check is
    older than a day; and, with the location lock (ADR-0029, on by default for profiles with a proxy), before it
    opens when the last check is older than 10 minutes (at most 10 s each).
13. **Matching the proxy's location is an estimate and only configuration** (ADR-0027). A profile with “Match
    timezone, language and location to the proxy” takes its time zone and language from the check service's estimate
    for the exit address (DB-IP City Lite: country-level is usually right, the city often is not), keeps WebRTC on the
    proxy and blocks websites from this computer's location. It does not change canvas, WebGL, audio, fonts,
    `navigator` properties, screen or hardware values, and it does not make a profile undetectable. On Windows the
    browser keeps the computer's time zone (shown as “partly applied”). Without an account server the check gives the
    country only, so nothing is matched and the profile says so when it opens. IP geolocation by
    [DB-IP](https://db-ip.com) (CC BY 4.0).
11. **Sleep and network changes.** Each browser connection opens a new connection to the proxy, so nothing stale
    survives sleep/wake or a network change; connections that were open at that moment fail and the page retries.
    The outage/recovery tests cover this behaviour; an actual OS sleep/wake cycle has **not** been tested yet (CI
    machines cannot sleep); it stays an open item for the pilot (milestone 14).
14. **The location lock compares estimates** (ADR-0029). Another country than at the last open, or no country when one
    was known (the check failed), stops the open until you choose “Open anyway”; the same country with another city
    or address opens with a notice. Cities from DB-IP Lite are approximate, so they never block. The lock only tells
    you; it does not change what websites see. Automation jobs are not stopped by it yet. The IP check page
    (`<server>/check/`, opened first when “Open the IP check page first” is on) shows the same estimate next to the
    browser's own time zone and language; it compares a few values only.
12. **The browser is Chrome for Testing** in this alpha (ADR-0010): not for customer distribution.
