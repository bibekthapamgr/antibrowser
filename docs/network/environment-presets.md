# Permission, privacy and environment presets (milestone 05)

Every setting here is something Chromium itself supports, applied through a typed switch, the profile's
`Preferences` file or the process environment. They are **configuration and QA controls**: they change what the
browser sends and shows so pages can be checked in a given language, time zone, window size or accessibility mode,
and they tighten privacy defaults. They do **not** make a profile look like a different device, and nothing is
randomised. Saved per profile as `privacy_json` (schema v5); validated in Rust (`crates/runtime/src/environment.rs`)
and again in the UI through `privacy.validate`.

## Settings and how each is applied

| Setting | Values | Applied as | Windows | macOS | Linux |
|---|---|---|---|---|---|
| Page language | 20 tags (`en-US` … `zh-CN`, incl. `ne-NP`) | `--lang=<tag>` and `intl.accept_languages = "<tag>,<base>"` | Applied | **Partial**: websites get it; the browser's own menus follow macOS | Applied |
| Time zone | 46 IANA zones (e.g. `Asia/Kathmandu`) | `TZ` in the browser's environment | **Unavailable**: Chromium on Windows always uses the system zone (shown as unavailable; the value is kept) | Applied | Applied |
| Window size when opening | 800×600 … 3840×2160 | `--window-size=W,H` | Applied (the OS may shrink it to fit the screen) | Applied (same) | Applied |
| Text size | default / large (20 px) / larger (24 px) | `webkit.webprefs.default_font_size` and `default_fixed_font_size` | Applied | Applied | Applied |
| Reduced motion | on / off | `--force-prefers-reduced-motion` | Applied | Applied | Applied |
| WebRTC address sharing | browser default / only the public address / only through the proxy | `webrtc.ip_handling_policy` | Applied | Applied | Applied |
| Block third-party cookies | on / off | `profile.cookie_controls_mode = 1` and `profile.block_third_party_cookies` | Applied | Applied | Applied |
| Do Not Track | on / off | `enable_do_not_track` (websites may ignore it) | Applied | Applied | Applied |

Settings left at their default are **removed** from `Preferences` (not written as defaults), so turning one off
really returns the browser to its own behaviour. A setting the OS cannot apply is shown in the drawer as
“Not available on this computer” with the reason, never silently claimed.

### Match timezone, language and location to the proxy (`match_proxy`, ADR-0027)

For a profile with a proxy. The values come from the proxy's last successful check (the check service's estimate for
the exit address); the check is repeated before the profile opens when it is missing, failed, older than 24 hours or
older than the proxy's last edit (at most 10 s; on failure the profile opens without the match and the person is
told). A language or time zone chosen by hand always wins. On by default for profiles created with a proxy; existing
profiles keep their behaviour until it is turned on.

| What | Applied as | Windows | macOS | Linux |
|---|---|---|---|---|
| Time zone | the check's IANA zone as `TZ` (any IANA-shaped name, not only the list above) | **Unavailable** (system zone; the drawer says “partly applied”) | Applied | Applied |
| Page language | the check's `ll-CC` tag as `--lang` and `intl.accept_languages = "ll-CC,ll"` | Applied | Partial (menus follow macOS) | Applied |
| WebRTC | `webrtc.ip_handling_policy = disable_non_proxied_udp`, even with fail-closed off | Applied | Applied | Applied |
| Location permission | `geolocation` content setting **Block** when it was “Ask” (an explicit Allow is kept) | Applied | Applied | Applied |

Not changed (deliberately): canvas, WebGL, audio, fonts, user agent, `navigator` properties, screen and hardware
values, and the coordinates a page could get from the Geolocation API (it is refused, not faked). Real-browser
evidence: `matching_profile_shows_the_proxy_locations_time_zone_and_language` (Linux: `Asia/Tokyo`, UTC+9,
`navigator.languages = ["ja-JP"]`, `Accept-Language: ja-JP,ja;q=0.9`, 0 STUN packets with fail-closed off).

### When the profile opens (ADR-0029; app behaviour, never sent to the browser)

| Switch | Default | What it does |
|---|---|---|
| `location_lock` — “Warn me before opening if this profile's proxy location has changed” | On for a profile with a proxy (also existing ones) | Compares a check of the proxy (≤ 10 minutes old, else repeated for ≤ 10 s) with the place seen at the last open. Another country, or none when one was known: asks first (“Open anyway” opens that once). Same country, new city or address: opens with a notice. |
| `open_check_page` — “Open the IP check page first” | From Settings (on) for a profile that gets its first proxy before it was ever opened; off for existing profiles | Opens `<account server>/check/` as the first tab, then the profile's own start pages (within the 10-page limit; never for automation). |

Neither switch changes what the browser sends, and changing one never asks for a restart.

Forced by routing: a profile with a proxy and fail-closed on always gets WebRTC “only through the proxy” and has
speculative pre-connects/DNS prefetch turned off (`net.network_prediction_options = 2`); the drawer shows the WebRTC
choice as locked and says why.

Website permissions (from milestone 03, same drawer): camera, microphone and location are **Ask each time** by
default (websites get a prompt; nothing is granted without the user) and can be set to Block or Allow per profile.
Real-browser evidence: on a secure page a default profile reports `prompt` for camera and microphone and a profile
with location blocked reports `denied`; on a plain-http page all three are `denied`.

## Presets

A preset fills in the fields above and records its id; the user can change any field afterwards (the preset label
then reads “Custom”). Locale presets always set a language **and** a matching time zone, so a page never sees a
German language with a Tokyo clock by accident.

| Id | Name | Sets |
|---|---|---|
| `standard` | Standard | Everything at the browser's defaults |
| `privacy` | Stricter privacy | WebRTC: only the public address; block third-party cookies; Do Not Track |
| `accessibility` | Accessibility review | Text size larger; reduced motion; window 1280×800 |
| `laptop` | Small laptop window | Window 1366×768 |
| `desktop` | Full HD window | Window 1920×1080 |
| `locale-en-us` | English (US), New York time | `en-US`, `America/New_York` |
| `locale-en-gb` | English (UK), London time | `en-GB`, `Europe/London` |
| `locale-de-de` | German, Berlin time | `de-DE`, `Europe/Berlin` |
| `locale-ja-jp` | Japanese, Tokyo time | `ja-JP`, `Asia/Tokyo` |
| `locale-ne-np` | Nepali, Kathmandu time | `ne-NP`, `Asia/Kathmandu` |

`presets_are_valid_and_coherent` (runtime unit test) checks that every preset validates, records its own id and
sets language and time zone together.

## What is deliberately not offered

User-agent strings, canvas/WebGL/audio noise, fonts lists, hardware concurrency, device memory, screen size
emulation, client hints, and any randomisation. These would need engine changes and a separately scoped design
(roadmap: “Do not sell browser fingerprint spoofing”); unknown keys in a stored or submitted configuration are
refused (`deny_unknown_fields`), so they cannot be smuggled in.
