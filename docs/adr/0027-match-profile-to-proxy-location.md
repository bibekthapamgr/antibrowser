# 0027 — Match a profile's time zone, language and location to its proxy (server-side IP geolocation)
Status: **Accepted**. Date: 2026-10-15. Owner: technical lead + browser/security owner.
Builds on ADR-0012 (loopback gateway, fail-closed, checks, browser-supported environment settings) and ADR-0025
(one environment per server, trusted reverse-proxy hops).

## Context
A profile behind a proxy in another country still shows this computer's time zone and language next to the proxy's
address, and a website that asks for the location gets this computer's real position. Comparable products offer a
"masked" mode that follows the proxy. The owner asked for the same behaviour, within the project's rule that
environment settings are browser-supported configuration, not fingerprint spoofing (ADR-0012; roadmap: "do not sell
browser fingerprint spoofing").

The interim check service (Cloudflare `/cdn-cgi/trace`) reports the exit address and a country, but no time zone,
city or language. A geolocation database inside the desktop app would add ~120 MB to every install and its own
update channel.

## Decision
1. **Server-side lookup.** The API serves `GET /v1/netcheck` (public, rate limited per address like the other public
   routes, `no-store`): Cloudflare's trace format with `ip=` (the client address after `TRUST_PROXY_HOPS`) and, when
   `GEOIP_DB` points at a MaxMind-format City database, `loc=`, `city=`, `tz=`, `lat=`/`lon=` (two decimals) and
   `lang=`. Nothing is stored; the address appears only in the existing request log line. The time zone is the
   database's own when present, else computed offline from the coordinates (`@photostructure/tz-lookup`, CC0); the
   language is the country's most likely language (CLDR likely subtags via `Intl.Locale('und-CC').maximize()`). Every
   value is reduced to a small safe alphabet before it is written. The lookup is injectable (tests stub it; no binary
   database in the repository); a missing or unreadable file means "address only", with one warning.
2. **Data source: DB-IP "IP to City Lite"** (free, monthly, MMDB, CC BY 4.0). `scripts/deploy/geo-setup.sh` downloads
   it into `/var/lib/pb-geo/` (current month, else the previous one), checks gzip, size, the MMDB marker and that the
   API's own reader opens it as user `pb`, and only then swaps it in (previous file kept as `.prev`). A monthly
   systemd timer refreshes it; the API notices the new file within 10 minutes. A failed download never fails
   `vps-setup.sh` (warning). Attribution "IP geolocation by DB-IP" with a link to https://db-ip.com is on the website
   footer, the desktop Proxies screen and in the docs.
3. **Desktop check.** With an https account server the check goes to `<server>/v1/netcheck` through the proxy (TLS
   verified as before); otherwise to Cloudflare. The answer's extra keys are parsed strictly (`loc` two capitals,
   `tz` IANA-shaped, `lang` `ll-CC`, coordinates in range and both present, `city` ≤ 64 safe characters; anything
   else is dropped) and stored with the check (SQLite migration v13, six nullable columns with matching `check`
   constraints; deleted with the check after 7 days). `NetworkCheck.geo` carries them to the UI.
4. **`PrivacyConfig.match_proxy`.** For a profile with a proxy: time zone (`TZ`) and language (`--lang`,
   `intl.accept_languages`) from the proxy's last successful check unless the person set them by hand; WebRTC
   `disable_non_proxied_udp` even with fail-closed off; the location permission **Block** when it was "Ask" (an
   explicit Allow is kept). No JavaScript geolocation override: the real location is refused, not replaced. If the
   last check is missing, failed, older than 24 h or older than the proxy's last edit, the launch checks first (≤ 10 s,
   on the launch's worker thread); on failure, or when the service gave no location, the profile opens without the
   match and the person gets a `PROXY_MATCH_UNAVAILABLE` notice (WebRTC and location stay restricted). Values from the
   check are validated again in `pb-runtime` before they become a switch or an environment variable.
5. **Defaults and migration.** On by default for profiles created with a proxy (workspace "New profile"; the
   create dialog shows the switch). Existing profiles are **not** migrated: their `privacy_json` has no
   `match_proxy` (= off), because switching a running business profile's clock and language on an update would be a
   surprise and could trip sign-in risk checks on accounts that have been used with the old values. People turn it
   on per profile in Privacy and environment.
6. **Honesty.** The UI, docs and `environment.rs` say what this is: an estimate for the proxy's address applied
   through browser settings. It is not fingerprint protection and does not make a profile undetectable; canvas,
   WebGL, audio, fonts, `navigator` properties, screen and hardware values are unchanged. On Windows the time zone is
   reported as unavailable (Chromium uses the system zone), so the mode is "partly applied" there.

## Consequences
- Proxy checks now reach the project's own server when one is configured; the server sees proxies' exit addresses
  (as the request log already did). The privacy policy draft says so.
- Accuracy is DB-IP Lite's: country-level is usually right, city-level often is not; mobile and some datacenter
  ranges are coarse. The UI calls it an estimate.
- Without an account server (or before the server has the database) nothing is matched; the profile says so.
- Windows profiles keep the system time zone; a future engine-level change would need its own design review.

## Evidence / verification
- API: `services/api/test/netcheck.test.ts` (format, missing/unreadable database → `ip=` only, trusted hops, spoofed
  hops, value sanitising, rate limit); a real MMDB read through `openGeoLookup` was checked locally with a generated
  database. `packages/config` tests the `GEOIP_DB` rule.
- Rust: strict trace parsing (`pb-netproxy` unit + `routing.rs`), storage migration v12→v13 and constraints,
  `proxy_match`/`apply_proxy_match`/report per platform (`pb-runtime`), desktop IPC test
  `a_matching_profile_takes_time_zone_and_language_from_the_proxy_check` (fresh check reused, stale check repeated,
  manual language wins, failing proxy → notice, WebRTC and location still restricted), real Chromium
  `matching_profile_shows_the_proxy_locations_time_zone_and_language`.
- UI: e2e coverage of the Proxies location line, the switch, the summary, manual override and the create-dialog
  default; axe and 900×600 checks include the new state.

## Revisit when
- A coordinate override for the Geolocation API is wanted (needs its own review: it would replace, not refuse, a
  value and must stay honest about being configuration).
- DB-IP's licence or download terms change, or a paid database is chosen for better city accuracy.
- Chromium gains a supported per-profile time-zone switch on Windows.
