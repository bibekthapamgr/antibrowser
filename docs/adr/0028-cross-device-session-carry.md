# 0028 — Cross-device session carry for workspace profiles
Status: **Accepted**, superseding the "session transfer is not supported" decision of [ADR-0002](0002-profile-portability.md). Date: 2026-10-16. Owner: technical lead.

## Context
ADR-0002 decided that an encrypted snapshot restores a profile's *site data* (localStorage, IndexedDB) on another
device but **not** its signed-in sessions: a teammate opening a shared workspace profile on a different computer was
asked to sign in again. The reason is that Chromium encrypts each cookie's value at rest with a key held by the
source computer's operating system — a login-Keychain item on macOS, a DPAPI-protected key on Windows, a password
store on Linux — and that key never travels with the profile directory. The milestone 03/07 portability matrix
confirmed this on every OS pair (cookies lost everywhere except Linux→Linux, which is only an artefact of the
development password store not being machine-bound).

Workspace (organization) profiles are different from the local-only alpha profiles ADR-0002 was written against:
they are the profile's *own* accounts, shared by a workspace owner with invited teammates, inside the workspace's
own end-to-end-encrypted snapshot. The owner asked for the established multi-profile-browser behaviour: a shared
profile opens already signed in on another enrolled teammate's computer. This is the profile's own data moving
within one authorized, encrypted workspace at the user's request — not a way around any website's security.

## Decision
1. **Carry the profile's own sessions inside the existing encrypted snapshot, re-keyed on arrival.** When a
   **workspace** profile is sealed, read its Chromium cookie store, decrypt each value with the **source** computer's
   own cookie key (the same key the browser itself uses), and store the resulting opaque plaintext blobs as a new
   `cookies.json` member **inside** the snapshot. That member is sealed under the workspace's own snapshot data key
   (the same AES-256-GCM key the snapshot already uses, ADR-0014) alongside everything else — no new key, no weaker
   scheme. On restore into a closed profile, re-encrypt each blob under the **destination** computer's own Chromium
   cookie key and write it back into the restored cookie store, so the browser opens already signed in.
2. **Workspace profiles only.** The carry runs only for organization snapshots (`Kind::OrgSnapshot`). Local-only
   backups (`Kind::LocalBackup`, device-keychain-sealed) never carry sessions and their on-disk data is never read
   for this purpose.
3. **Nothing in the clear, ever.** The decrypted blobs exist only (a) transiently in memory while being re-keyed
   (zeroized after use) and (b) inside the AES-256-GCM sealed snapshot. They are never written to disk unencrypted.
   The plaintext is treated as opaque: it is re-encrypted byte-for-byte, so Chromium's own per-cookie domain binding
   must still match on the destination or the browser drops the cookie — this is not a decryption oracle and grants
   no access the authorized teammate did not already have to the profile.
4. **Promise only measured OS pairs.** A cross-device restore is labelled `supported` (stay signed in) only for the
   OS pairs in `pb_sync::portability::SESSION_CARRY_PLATFORMS`. Every other pair keeps `sign_in_required`. The label
   is honest by construction: the runtime pipeline measures, on real runners of both operating systems, that the
   session actually survives, and fails the build on any `supported` label whose cookie did not in fact survive.

## Supported, and not
| Source → Target | Session carry | Why |
|---|---|---|
| Windows x64 → Windows x64 | **Supported** | Per-profile `Local State` key is DPAPI-wrapped; restore mints a fresh key wrapped for the destination machine, writes it to the restored `Local State`, and re-encrypts cookies (AES-256-GCM `v10`) under it |
| macOS arm64 → macOS arm64 | **Supported** | Safe Storage password is read from (or created in) the login Keychain; AES-128-CBC `v10` re-encryption |
| Windows x64 ↔ macOS arm64 | **Supported** | The carried plaintext is OS-independent, so a session sealed on one re-encrypts under the other's scheme |
| Same device (any OS) | **Supported** | Unchanged from ADR-0002; the carry is redundant but harmless there |
| Anything involving Linux | `sign_in_required` | Linux is a development/CI platform only; its password store is not machine-bound and is not representative of a shipped device, so it is never promised (ADR-0006) |
| macOS Intel (`macos-x64`) | `sign_in_required` | Expected to work (same Keychain mechanism) but no runner gates it yet; not promised until measured (ADR-0006 support gate) |
| Windows app-bound (`v20`) cookies | not carried (fall back to sign-in) | App-bound encryption binds the key to an elevation service we do not run; such values are skipped, never downgraded. The shipped runtime is Chrome for Testing, which uses the `v10` per-profile key, so this does not arise in practice |
| Older browser major, unknown platform, newer snapshot format | `unsupported` | Downgrade guard, unchanged |

## Key handling (security review)
- **No new key material and no weakening.** The carried sessions ride inside the same end-to-end-encrypted snapshot,
  under the workspace snapshot data key the app already manages (ADR-0014). The snapshot's binding, chunked
  AES-256-GCM (STREAM) container, fail-closed opening, and safe extraction are untouched.
- **Source read** uses the OS's own supported API to obtain the browser's cookie key: Keychain lookup (macOS),
  DPAPI unwrap of the profile's `Local State` key (Windows), the documented password-store key (Linux). No
  OS-protected key is ever extracted outside a supported API, exactly as ADR-0002 §4 required.
- **Destination re-key** obtains this computer's own cookie key the same way. On Windows, when the travelled
  `Local State` key cannot be unwrapped here (it was wrapped for another machine), a fresh 32-byte key is generated,
  DPAPI-wrapped **for this machine**, and written to the restored profile's own `Local State`; any travelled
  `app_bound_encrypted_key` (for a foreign machine) is removed so it cannot shadow ours. On macOS the browser's
  Safe Storage Keychain item is used, or created under the browser's own name if absent, so the browser adopts it.
- **Blast radius.** The carried values are the profile's own cookies, which the authorized teammate can already use
  by opening the profile. Nothing leaves the workspace; tenant isolation, the app's authentication, and Chromium's
  sandbox are unchanged. The re-keyed values are written only into the destination profile's own cookie database.
- **Residual risk.** The exact macOS Keychain service name for the destination's *first-ever* profile (when no Safe
  Storage item exists yet and one must be created) is the browser's product name; it is verified by the macOS
  runner, and a wrong name turns that run red (a dishonest label is impossible, only a failed build).

## Evidence
The `portability_spike` test (sealing + real-browser restore through the production snapshot format) now carries and
re-keys sessions and asserts the honesty rule per row; the runtime-pipeline `report` job fails on any dishonest
label. Local verification (Linux, Chrome for Testing 141.0.7390.37): a signed-in profile sealed with the carried
`cookies.json` member restored into a new profile and opened still signed in; unit tests in
`apps/desktop/src-tauri/src/cookies.rs` prove the AES-128-CBC (`v10`/`v11`) and AES-256-GCM (`v10`) re-encryption is
byte-exact and that unsupported schemes (`v20`, empty) are skipped rather than corrupted. Windows and macOS pairs
are measured by the macOS and Windows runners in the runtime pipeline. Full table:
[docs/portability-matrix.md](../portability-matrix.md).

## Consequences
- Milestone 07/08 handoff UX no longer tells the user to sign in again after a restore from a measured OS pair; the
  "websites may ask you to sign in again" notice is shown only when the restore is labelled `sign_in_required`.
- Adding an OS to the promised set requires a runner that measures it and a passing row in the matrix; this ADR must
  be updated, never the label alone.
- ADR-0002 remains the record of the original decision and of what still does not travel; this ADR supersedes only
  its "session transfer is not supported/advertised" line.
