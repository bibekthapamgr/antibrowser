# OS setup notes (milestone 02)

Supported targets for internal builds (ADR-0006): **Windows 11 x64** and **macOS 13+ on Apple Silicon**. Linux builds compile in CI for development only.

## Getting an internal build
1. GitHub → **Actions → desktop internal build** → latest run on `main` (or *Run workflow*).
2. Download the artifact for your OS: `project-browser-windows-x64-<signed|unsigned>` or `project-browser-macos-arm64-<signed|unsigned>`.
3. Check the download before opening it:
   - macOS: `shasum -a 256 -c SHA256SUMS`
   - Windows (PowerShell): `Get-FileHash .\<file> -Algorithm SHA256` and compare with `SHA256SUMS`.
4. `provenance.json` records the commit, workflow run, toolchain versions and whether the build is signed.

Files named `internal-UNSIGNED` are engineering builds. They are not for customers or pilots.

## Install
| | Windows | macOS |
|---|---|---|
| Installer | `…-nsis-setup.exe` (per user, no admin rights) or `…-msi.msi` | `…-dmg.dmg` → drag *Project Browser* to Applications |
| Unsigned build warning | SmartScreen: *More info → Run anyway* | macOS says the app "is damaged" or "cannot be verified". Builds from 0.2.0 onward are signed ad hoc; remove the download mark once: `xattr -cr "/Applications/Project Browser.app"` (see below) |
| Deep-link scheme | `projectbrowser://` registered for the current user | `projectbrowser://` registered via the app's Info.plist |

### macOS: opening an unsigned internal build
Browsers mark downloads with `com.apple.quarantine`, and Gatekeeper refuses quarantined apps that are not signed with a Developer ID. Recent macOS versions no longer offer *Open anyway* from the right-click menu for these, and older internal builds (before the ad-hoc signing fix) are reported as "damaged". In Terminal:

```bash
xattr -cr "/Applications/Project Browser.app"                    # remove the download mark
codesign --force --deep --sign - "/Applications/Project Browser.app"   # only if it still says "damaged"
open "/Applications/Project Browser.app"
```
Only do this for builds whose checksum matches `SHA256SUMS` from the workflow run. Signed and notarized builds (owner certificates) need none of this.

## Where data lives
| | Windows | macOS |
|---|---|---|
| Manager database, browser profiles, crash reports | `%LOCALAPPDATA%\dev.projectbrowser.manager\` | `~/Library/Application Support/dev.projectbrowser.manager/` |
| Secrets (later milestones) | Windows Credential Manager, service `dev.projectbrowser.manager` | Keychain, service `dev.projectbrowser.manager` |

Inside the data directory: `local.db` (SQLite, WAL), `local.db.v<N>.bak` (copy taken before a schema upgrade), `profiles/<prf_…>/` (one Chromium user-data directory per profile), `runtimes/` (verified browser runtimes), `crash-reports/` (scrubbed, local only), `session.json` (clean-exit marker), `manager.lock`.

Browser profiles contain cookies and site data in plaintext while in use (see security-model.md, disclosure 1). Use OS disk encryption (BitLocker / FileVault).

## Uninstall and data removal
Uninstalling never deletes profiles unless you choose to.

- **Any OS, from the app:** *Settings → Remove all local data* (type `DELETE`; all profiles must be closed). This removes the database, every profile and crash reports, then the manager shows the recovery screen. Uninstall afterwards.
- **Windows, NSIS installer:** *Settings → Apps → Project Browser → Uninstall*. The uninstaller has a **"Delete the application data"** checkbox; tick it to remove the data directory as well.
- **Windows, MSI:** the MSI uninstaller removes the program only. Use *Remove all local data* first if you want the data gone.
- **macOS:** quit the manager, drag *Project Browser* from Applications to the Bin. Data stays in `~/Library/Application Support/dev.projectbrowser.manager/` unless you used *Remove all local data* first (or delete that folder yourself).

## Signing (owner action)
Signed builds are a milestone 02 requirement. The workflow signs automatically once these repository secrets exist (*Settings → Secrets and variables → Actions*):

| Secret | Value |
|---|---|
| `APPLE_CERTIFICATE` | base64 of the *Developer ID Application* certificate exported as .p12 |
| `APPLE_CERTIFICATE_PASSWORD` | password of that .p12 |
| `APPLE_SIGNING_IDENTITY` | e.g. `Developer ID Application: Ten Tech Solutions LLC (TEAMID)` |
| `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | Apple ID, an app-specific password, and team id for notarization |
| `WINDOWS_CERTIFICATE` | base64 of the code-signing certificate (.pfx) |
| `WINDOWS_CERTIFICATE_PASSWORD` | password of that .pfx |

`base64 -i cert.p12 | pbcopy` (macOS) or `[Convert]::ToBase64String([IO.File]::ReadAllBytes("cert.pfx")) | Set-Clipboard` (Windows) produces the value. Hardware-token (EV) or cloud signing certificates need a different signing step; record that choice in an ADR when the certificate is bought.

## Troubleshooting
- **"Your local data needs attention"**: a schema upgrade failed. The previous database was kept unchanged. *Try again*, or *Restore the copy made before the update*, or *Save a diagnostics report* and send it to engineering.
- **"Project Browser closed unexpectedly last time"**: a crash was detected. Profiles that kept running are re-attached; a scrubbed report is in `crash-reports/`.
- **Diagnostics** screen → *Save report…* writes a JSON file with versions, schema status, disk space, keychain status and startup timings. It contains no profile names, cookies or tokens.
- **Second launch** focuses the existing window instead of starting another manager.
