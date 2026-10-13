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
