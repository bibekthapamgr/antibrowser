# Update runbook (manager releases)

How to publish, check, pause, withdraw and recover desktop releases. The design is in
[ADR-0019](../adr/0019-production-security-updates-and-recovery.md), section 1–2. Everything runs from the
**desktop release** workflow (`.github/workflows/desktop-release.yml`) on `main`. Every action waits for the
`release` environment's approval.

> Versions before 0.12 have no updater. Install 0.12 by hand once; from then on the app updates itself.

## First-time setup (owner, once)

### 1. Make the release key on your own computer
The private key never goes into chat, the repository or any file on the server.

```bash
# Node 24 needed; no checkout required.
npx --yes @tauri-apps/cli@2.12.2 signer generate -w ~/.tauri/project-browser-release.key
# Choose a long password when asked.
```

This writes two files:
- `project-browser-release.key`: the **private** key, encrypted with your password;
- `project-browser-release.key.pub`: the **public** key.

Keep two offline copies of the private key and its password: for example, a password manager plus an encrypted
USB drive kept elsewhere. If both are lost, a new key can only reach customers through a release that the old key
signed. Without it, every customer would have to reinstall by hand.

### 2. Let the app trust the public key
```bash
node scripts/release/add-release-key.mjs ~/.tauri/project-browser-release.key.pub --note "release key 2026"
```
This adds the key to `apps/desktop/src-tauri/release-keys.json`, valid for 3 years by default. The script refuses
a private key. Commit the file. The public key is not secret, so it can also be pasted to whoever maintains the
repository. **Only builds that contain this file can update.**

### 3. Create the protected environment
GitHub → repository **Settings → Environments → New environment** `release`:
- **Deployment branches:** *Selected branches* → `main` only.
- **Required reviewers:** yourself now. Add a second person as soon as there is one, and then tick **Prevent
  self-review**.
- Untick **Allow administrators to bypass configured protection rules**.
- **Environment secrets:**
  - `TAURI_SIGNING_PRIVATE_KEY`: the *contents* of `project-browser-release.key`;
  - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: its password.

  To add them from a terminal, without pasting the values anywhere else:
  ```bash
  gh secret set TAURI_SIGNING_PRIVATE_KEY --env release --repo bibekthapamgr/antibrowser < ~/.tauri/project-browser-release.key
  gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --env release --repo bibekthapamgr/antibrowser   # prompts
  ```

### Protecting the signing key
These steps address finding **D1**. They must be done before the paid launch.
1. **Two-factor authentication with a hardware key** (or passkey) on every account with admin rights on the
   repository.
2. **A second required reviewer** for the `release` environment, with **Prevent self-review**. Then one stolen
   account cannot both start and approve a release.
3. **No admin bypass**, both on the environment and on `main`'s branch protection or ruleset.
4. **Reviews for workflow changes:** a ruleset on `main` that requires a pull request review for
   `.github/workflows/**`, through `CODEOWNERS`. Changes to workflows then go through pull requests instead of
   direct pushes.
5. **Repository settings:** keep "Require approval for all external contributors" on, and use no self-hosted
   runners while the repository is public.
6. **Preferred end state:** sign offline or with a hardware key (for example a YubiKey with an Ed25519 signing
   tool). CI then only builds and checks, and someone with the key signs the files and manifests on a separate
   computer. This trades away the automatic weekly re-signing.

## Releasing

| Step | How |
|---|---|
| 1. Set the version | `node scripts/release/set-version.mjs 0.12.1` (or `0.12.1-beta.1` for canary or dev). Commit, push, and wait for CI to pass. |
| 2. Release to canary | Actions → **desktop release** → *Run workflow*: action `release`, channel `canary`, version `0.12.1`. Approve the `release` environment when asked. |
| 3. Check it | Install on a test computer through the app (Downloads → App updates → channel *canary* → *Check now*). Open profiles, sync, and restore a backup. |
| 4. Promote to stable | Action `promote`, channel `stable`, from `canary`. This offers exactly the same signed files. A pre-release version (`-beta`) cannot go to stable; release a plain version to canary first. |

From a terminal: `gh workflow run desktop-release.yml -f action=release -f channel=canary -f version=0.12.1`.

What the run publishes, under the GitHub release `desktop-v<version>`:
- the installer (`*_x64-setup.exe`) and the macOS app archive (`*.app.tar.gz`), each with its `.sig`;
- `SHA256SUMS`, `provenance.json`, a CycloneDX SBOM and `RELEASE_NOTES.md`;
- GitHub attestations for build provenance and the SBOM.

The channel manifests are on the releases `channel-dev`, `channel-canary` and `channel-stable`. Published versions
never change: the run stops if the tag already exists.

**Anyone can verify a release:**
```bash
gh release download desktop-v0.12.1 --repo bibekthapamgr/antibrowser -D rel
gh attestation verify rel/Project.Browser_0.12.1_x64-setup.exe --repo bibekthapamgr/antibrowser
node scripts/release/verify.mjs file rel/Project.Browser_0.12.1_x64-setup.exe --version 0.12.1
gh release download channel-stable --repo bibekthapamgr/antibrowser -D ch
node scripts/release/verify.mjs manifest ch/stable.json --channel stable
```

## Emergency actions
These change only what the app is offered or allowed to open. **None of them deletes or changes customer data.**

| Situation | Action | Effect on computers |
|---|---|---|
| A release looks wrong and you are investigating | `pause` + channel + reason | At the next check, no update is offered on that channel. Computers that already installed it keep it. |
| Investigation done, release fine | `resume` + channel | The release is offered again. |
| A version is known-bad (crash, data risk, security) | `revoke` + `versions=0.12.1` + reason | **Applies to every channel.** That version is never offered or installed. Computers running it show "This version must be updated" and are offered the newest good version. Release a fixed version next. |
| A browser runtime is known-bad | `revoke` + `runtime_sha256=<archive SHA-256>` + reason | **Applies to every channel.** That runtime is neither installed nor opened. Profiles upgraded by it offer "Restore the copy made before the upgrade". |
| Everyone must leave old versions (security fix) | `minimum` + channel + `version=0.12.2` + reason | Managers below 0.12.2 show "update required" and are offered the update. Also set `MIN_DESKTOP_VERSION=0.12.2` in `/etc/project-browser/api.env` and restart the API, so the server tells older managers the same (`426 CLIENT_UPDATE_REQUIRED`). Do this only once the fixed version is offered. |
| A manifest is close to expiry, or a run was missed | `refresh` + channel | Re-signs the manifest with a new sequence (valid 30 days). This also runs automatically every Monday and waits for approval; the approval is the reminder. |

A computer learns of any of these at its next check: 45 seconds after start, then every 6 hours, or when someone
clicks *Check now*.

## When something goes wrong

| Symptom | Cause | What to do |
|---|---|---|
| Run stops: "release-keys.json is empty" | First-time setup step 2 not done | Add the public key, commit, then release. |
| Run stops: "Version already released" | The tag exists; published files never change | Set a new version (`0.12.2`). |
| Run stops in "Fetch and verify the current channel manifests" | The published manifest does not verify against the keys in this commit (a key was removed too early, or someone tampered with the release) | **Treat as an incident** ([incident response](incident-response.md)). Do not delete the release. Compare it with your last run's summary. |
| The app shows `UPDATE_MANIFEST_EXPIRED` | No `refresh` for more than 30 days | Run `refresh` on that channel. |
| The app shows `UPDATE_SIGNATURE_INVALID` or `UPDATE_CORRUPT` | A wrong or altered file, or a network that rewrites downloads | The app has already deleted the file. Check the release with `verify.mjs`. If the release verifies, the problem is the computer's network. |
| The app shows `UPDATE_MANIFEST_REPLAYED` | The computer is being served an older manifest than one it already accepted | Possibly hostile (a mirror or proxy). Ask for the network details and treat it as an incident if it repeats. |
| The app shows `UPDATE_KEY_EXPIRED` | The release key's validity window ended | Ship a new key early (see *Rotating the key*). Computers that missed it need a manual install. |
| An update installed, but the app misbehaves | A bad release | `revoke` that version, then release a fixed version. On Windows the installer keeps profiles; nothing to restore. |

## Rotating the key
Rotate every 2–3 years, or at once if the key may be exposed.
1. Generate a new key (setup step 1).
2. Add its public key with `add-release-key.mjs`, keeping the old one.
3. Release a version **signed with the old key**. It carries both keys.
4. Wait until most computers have it: at least one full `refresh` cycle and the release's adoption.
5. Replace the environment secrets with the new key.
6. In a later release, set the old key's `not_after` to the rotation date, or remove it.

**If the old key is exposed:**
1. Do steps 1–3 at once. Release with the new key *added* but still signed by the old one; it is the only key
   computers trust.
2. Replace the secrets.
3. Release again signed with the new key, with the old key's `not_after` set to today.
4. Publish a security advisory telling customers which version to have.

Computers that never installed the transition release must reinstall by hand from a verified download.

## OS code signing (planned)
- **Windows:** installers are currently **unsigned** (owner decision, October 2026), so SmartScreen warns on first
  install. When a certificate is bought, use a cloud signing service (Azure Trusted Signing or a hardware-token
  certificate in a signing service) called from the `publish` job after `tauri build`. Never keep a PFX file in
  secrets.
- **macOS:** builds are **ad-hoc signed** and not notarized (no Apple Developer account). The first launch needs
  right-click → Open, or System Settings → Privacy & Security → Open Anyway. Updates then install through the
  app's own signature checks. With an Apple Developer ID later, add `APPLE_SIGNING_IDENTITY` and notarization to the
  macOS build job.
