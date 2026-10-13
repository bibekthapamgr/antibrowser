# Diagnostics report and redaction

Where: Health → Diagnostics → "Preview and save report…" (also on the database recovery screen). The person sees the
exact text that will be saved, then chooses where to save it. The app sends nothing anywhere.

## What it contains
- App version, operating system and architecture, platform; local database status, schema version, journal mode and
  integrity; secure storage availability; the browser runtime's manifest status and version.
- Measurements: manager start and database open times, manager memory, browser start and ready times, free disk
  space, total memory, resource use per open profile **by profile id**.
- **Operations** (the last 100): operation id (`op_…`), kind, status, error code and message.
- **Recent app activity** (the last 200 local audit entries): time, profile id, action, outcome and the short detail
  the app recorded.
- **Error summary**: outcome codes of the last 1,000 audit entries that were not successes, counted.
- **Health**: each card's status, check time and validity.
- **Extensions**: per profile id, each extension's id, version, source, whether it is on, and whether an update waits
  for review.
- **Settings** (keys and values), crash report count, whether the previous session crashed, the start-up reconcile
  summary.

## What it never contains
Proxy addresses, logins and passwords; page addresses, titles, history, cookies or any site data; profile notes;
profile, client, tag or workspace names (profiles appear by id); access tokens, fencing tokens or keys. These are
left out by construction — the report is built from the sections above only.

## Redaction (every string, including object keys)
Applied after the report is built (`apps/desktop/src-tauri/src/diagnostics.rs`), in this order:

1. The home folder (`HOME`, `USERPROFILE`) becomes `~`.
2. Each word is examined:
   - `secret-word=value` or `secret-word: value` / `secret-word value` — for password, passwd, passphrase, secret,
     token, apikey, api_key, api-key, authorization, bearer, cookie, session, credential, private_key — keeps the
     word and replaces the value with `[secret]`;
   - anything with a scheme (`https://…`, `socks5://…`, `file://…`) becomes `<address>`;
   - e-mail addresses become `<email>`; IPv4 addresses (with or without a port) and IPv6 addresses become `<ip>`;
   - opaque tokens (24 or more letters, digits and `-_.+/=`, with at least one digit and one letter) become
     `[redacted]` — except the app's own ids (`prf_…`, `org_…`, `op_12`, `run_…`), which support needs.
3. The user name (`USER`, `USERNAME`, `LOGNAME`), in any letter case, becomes `<user>`.
4. Values under keys that sound secret or personal (password, secret, token, credential, authorization, cookie,
   api_key, private_key, username, login, email, notes, url, host, ip, address, and keys ending or starting with
   them, such as `fencing_token` or `start_urls`) are replaced with `[secret]`.

The preview lists how many of each were removed ("Removed: 2 web addresses, 1 e-mail address, …").

Version numbers with four parts that look like an IPv4 address (for example an extension version `1.2.3.4`) are
shown as `<ip>`; this errs on the side of removing.

## Size and retention
- At most 1 MiB. If the report is larger, the longest list is halved repeatedly until it fits; the preview says the
  report was shortened. If it still cannot fit, a short note replaces it.
- A preview is kept in memory for 10 minutes (at most three at a time) and forgotten after it is saved once. Nothing
  is written to disk until the person saves it, and the app keeps no copy.

## Tests
- `apps/desktop/src-tauri/src/diagnostics.rs`: addresses, e-mail and IP addresses, home paths, user names in any case,
  `password:` / `token=` / `Bearer` values and opaque tokens are removed while ids, operation ids and error codes stay;
  nested values and secret keys; the size limit; preview expiry.
- `apps/desktop/src-tauri/tests/agency.rs` — "the diagnostics preview contains no fixture secrets": a proxy with a
  login, profile notes with a page address and an e-mail address, an audit detail carrying an address, an e-mail
  address and a token, and a server address are set up (all built at run time, none real); the preview contains none
  of them but does contain versions, operation ids and the error code; what is saved is byte for byte the preview; a
  preview cannot be saved twice and an unknown preview is refused (`PREVIEW_EXPIRED`).
- UI end-to-end: the preview is shown before saving and contains no web address.
