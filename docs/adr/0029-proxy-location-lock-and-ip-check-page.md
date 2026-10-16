# 0029 — Proxy location lock and the IP check page
Status: **Accepted**. Date: 2026-10-16. Owner: technical lead + browser/security owner.
Builds on ADR-0012 (gateway, checks), ADR-0014 (encrypted snapshot settings), ADR-0023 (public website) and
ADR-0027 (`/v1/netcheck` with server-side geolocation, pre-launch check).

## Context
Agencies keep one profile per client account, each with a proxy. Websites' account-security checks commonly react
when a known account suddenly signs in from another network location (extra verification, locked sessions). A proxy
provider can move an exit to another country without notice, and a teammate may open the same workspace profile
through a different proxy. The owner wants the app to keep each profile consistent and to say so *before* a change
happens unnoticed, and wants a page inside the profile that shows what the server sees next to what the browser
reports. This is transparency for the person using the profile; it does not hide anything from websites, which
still see the proxy's address wherever it is.

## Decision
1. **Remembered location.** Each profile remembers where its proxy exited at its last successful open: exit address,
   country, city and time zone (SQLite migration v14, `profile_locations`, one row per profile, deleted with it, the
   same `check` shapes as a check record, at least an address or a country). It is written only after the browser
   has started (`remember_location` after the spawn is recorded), never for a refused open. For a workspace
   (organization) profile it also travels as `network_location` in the encrypted backup's `meta/settings.json`; a
   restore applies it when it was seen later than the one on this computer, after validating every value like a
   check answer (`sync.rs::carried_location`). The proxy itself and its login never travel (unchanged). A restore that
   happens while opening (the shared open path) applies from the following open.
2. **`PrivacyConfig.location_lock`** (app behaviour, never sent to the browser): `null`/absent = on for a profile with
   a proxy (existing profiles included: it only warns, it changes nothing in the browser), `false` = off. UI: Network
   section, “Warn me before opening if this profile's proxy location has changed”, with the last-open place.
3. **At launch** (`launch_profile_with`, before the runtime install, the session lease or anything else starts), with
   the lock on and a proxy: a missing login or a disallowed address still fails at once; then a check of the proxy is
   used when it worked within 10 minutes (decided synchronously), otherwise the existing pre-launch check runs on a
   worker thread for at most 10 s and the click returns the launch operation (a second click joins it). The result is
   compared (`location::compare`):
   - **another country**, or a country was known and the check failed or gave none (`unverified`): nothing starts.
     The launch fails with `PROXY_LOCATION_CHANGED` (synchronously, or as the operation's error code) and a
     `PROXY_LOCATION_CHANGED` warning carries `previous` / `current` (address, country, city, time zone), the time
     the previous one was seen and, without a current place, the check's error code. The UI shows a confirmation:
     “This profile usually opens from … Its proxy now exits from … Opening from a new country can trigger the site's
     security checks. [Cancel] [Open anyway]”. **Open anyway** calls `launch_profile` with `allowLocationChange`
     for that one open; the new location is then remembered.
   - **same country, another city or address**: it opens, and a `PROXY_LOCATION_NOTICE` warning becomes a toast and a
     notification-centre entry (“IP changed from … to …, same country”).
   - **nothing remembered** (first open, or only failed checks so far): it opens and records what it saw.
   With the lock off nothing is checked or blocked by it. Automation jobs open organization profiles through
   `open_for_job`, which does not go through this gate (a job has nobody to confirm; see Revisit).
4. **Logging.** Audit records (`network` / `location_changed`, `location_override`, `location_notice`) carry only the
   verdict code (`COUNTRY_CHANGED`, `UNVERIFIED`, `IP_CHANGED`, `CITY_CHANGED`), never an address or a place,
   following the existing check audit convention. The warnings go to the app's own window only; diagnostics already
   mask addresses.
5. **IP check page.** The public website gains `/check/` (prerendered like the other pages, own script `check.js`, no
   inline code, `noindex`, `Disallow: /check/`, not in the navigation). From inside the profile it fetches
   same-origin `/v1/netcheck` (so through the profile's proxy; the site CSP's `connect-src 'self'` covers it) and
   shows the address, the country (`Intl.DisplayNames`), the city, the estimated time zone and language, and compares
   them with `Intl.DateTimeFormat().resolvedOptions().timeZone` (canonical zone names, so aliases match) and
   `navigator.languages[0]` (same language = match, the region may differ), each row ✅ Match / ⚠️ Mismatch / “Not
   compared”, plus the local time at the address and in the browser. It needs no account, stores nothing, explains a
   failed check with a retry and an address-only answer (no database on the server), and credits DB-IP. It says it
   compares a few values only. The API's existing public-site route serves it; the Caddy `SITE_HOST` block already
   proxies every non-staff path, so no proxy change is needed.
6. **`PrivacyConfig.open_check_page`** (app behaviour): when on and an https account server is configured, the
   profile opens `<server>/check/` as its first tab, followed by its own start page(s) or the explicit start URL,
   under the same start-URL rules (after `--`, at most `MAX_START_URLS`: when the profile's own pages fill every slot
   the check page is left out, never one of them). Never for an automation session. Default: Settings → “Open the IP
   check page first in new profiles with a proxy” (`profiles.open_check_page`, on); it is copied onto a profile that
   gets its first proxy before it was ever opened (classic assignment and workspace “New profile” with a proxy).
   Existing profiles are not changed (an extra tab after an update would be a surprise).
7. Both switches are excluded from the “restart required” comparison: they do not change the running browser.

## Consequences
- An open of a proxied profile may wait up to 10 s for the check when the last one is older than 10 minutes (it was
  24 h for matching only). Failed checks are recorded like any other (7-day retention).
- A proxy that is down while a country is remembered now asks before opening instead of opening fail-closed; with
  the lock off the earlier behaviour is unchanged.
- City-level estimates are approximate (DB-IP Lite), so city changes only notify. Without an account server the
  check gives a country only (Cloudflare), which still drives the country comparison.
- Older desktop builds reading a newer profile's privacy settings (sync) drop them if they contain the new switches
  (unknown fields are refused); the switches are omitted from the stored document unless set.

## Evidence / verification
- Rust: `location::tests` (comparison table, check-page URL and slot rule), `pb-runtime` default/serialisation of the
  switches, storage v13→v14 migration and constraints (`tests_m05`), `sync::tests` (carried location validation), IPC
  tests `the_location_lock_asks_before_a_new_country_and_notes_a_new_address` (first open recorded, 10-minute reuse,
  same-country notice, country change refused with details and no spawn, synchronous refusal, override, unverified on
  a failing proxy, codes-only audit, lock off) and `the_ip_check_page_opens_first_from_the_account_server`.
- UI e2e: confirmation dialog on a country change (Cancel, Open anyway, remembered afterwards), the same-country
  notice, the per-profile and Settings switches; axe and 900×600 checks for the switches and the dialog.
- Website: unit tests (page, script, noindex, attribution, strict parsing, comparisons) and e2e (match, mismatch,
  failure and retry, address-only, nothing stored, axe and no sideways scroll at 375/1280 in both themes); API test
  that `/check/` is served with the site CSP while `/v1/netcheck` stays the API's.

## Revisit when
- Automation jobs should honour the lock (fail the job with `PROXY_LOCATION_CHANGED` instead of opening).
- A shared open should compare with the location restored during that same open.
- A paid geolocation database makes city-level changes reliable enough to ask about.
