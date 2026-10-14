# Security limitations (customer-facing)

This page states plainly what Project Browser does **not** protect against, and how long data remains after
deletion. Product pages, onboarding and the in-app help link here. Keep it current: a change to any of these
statements is a security change and needs review.

## Using the product
- **Profiles in use are readable on that computer.** While a profile is open, Chromium works with its cookies and
  site data unencrypted. Anyone with access to the signed-in OS account can read them. Protect computers with
  full-disk encryption, a screen lock and separate OS accounts.
- **Separate profiles separate stored website data only.** Each profile has its own cookies, storage and cache.
  Profiles do **not** look like different devices or networks to websites, and they do not stop websites from
  linking activity. Project Browser is not an anonymity or "anti-detection" tool, and makes no promise that
  accounts will not be restricted or banned.
- **Automation is visible to websites.** Profiles opened by automation jobs tell websites the browser is automated.
  Nothing in the product hides automation.
- **Signed-in sessions may not survive moving a profile to another computer.** Websites can bind sessions to a
  device; you may need to sign in again after a restore elsewhere.
- **Extensions you install inside a profile run with that profile's access.** Your organization's extension policy
  can turn off all extensions from the next time a profile opens.

## Backups and keys
- **The organization server's operator can decrypt organization backups.** Snapshots are encrypted before they leave
  your computer, with keys that are protected by the server's root key. Whoever operates the server holds that root
  key. Every restore is recorded in your organization's activity log.
- **Not end-to-end encrypted.** Encryption keys for a snapshot reach your authorized computers over TLS.
- **Keys and backups can be lost.**
  - If the operator loses the root key, organization backups cannot be recovered. Your computers still hold the
    profiles they last used.
  - If a computer's keychain is reset, that computer's local backup copies cannot be opened.
- **Recovery targets, not guarantees.** The service is designed so that, after a server loss, at most about
  15 minutes of recent changes are lost, and service returns within about 4 hours. These are targets that we test
  regularly. Committed cloud backups are recoverable up to the last one copied off-site, which runs every
  2 minutes. A backup committed in the last 2–3 minutes before a total server loss may need to be uploaded again
  from the computer that made it. Changes on a computer that were never backed up cannot be recovered from the
  service.

## Installing and updating
- **Installers are not yet signed by an OS-recognized publisher.**
  - **Windows:** the installer is unsigned, so Windows SmartScreen warns on first install.
  - **macOS:** the app is not notarized by Apple. Open it with right-click → Open the first time.

  Download installers only from the project's GitHub Releases page. You can check them with GitHub's attestation
  (`gh attestation verify <file> --repo bibekthapamgr/antibrowser`).
- **Updates are verified by the app, not by the OS.** After the first install, the app installs only updates signed
  with the project's release key, never older versions. You are asked before an update is installed.
- **Updates reach computers at their next check** (about every 6 hours, or when you click *Check now*). A computer
  that cannot reach GitHub keeps its current version.
- **A withdrawn version keeps working until you update.** When a version is withdrawn for a security reason, the app
  says it must be updated. The server may also refuse versions below a minimum. Your profiles and data are never
  changed by a withdrawal.

## Support access
- **Support staff cannot see browsing data.** No support or admin screen shows cookies, site data or browsing
  history, and staff cannot decrypt backups.
- **What staff can see, and when.**
  - Seeing members or activity needs time-limited access that a second staff member approves. Both the approval and
    each view appear in your organization's activity log.
  - In an emergency (for example a leaked API token), a staff member can get **break-glass** access, for at most
    60 minutes and only to named organizations. They can then see members and activity, and revoke your
    organization's API tokens. Every use is recorded in your activity log and reviewed by a second staff member.

## Data retention
When you delete something, this is how long copies remain:

| Data | After you delete it |
|---|---|
| A profile and its cloud backups | Restorable from the trash for your organization's trash period (1–90 days, default 30). It is then erased from the service. Encrypted copies remain in our off-site backups for up to about **5 weeks** after that (database backups), and the encrypted snapshot files for up to **30 days**. They are then deleted automatically. |
| Older backup versions past your retention setting | Erased by the service. The same off-site residual periods apply. |
| Automation screenshots | Deleted after 7 days. Finished jobs and webhook delivery records after 30 days. Off-site residual: up to about 5 weeks. |
| Your organization after you cancel | Kept until an owner deletes it, or as stated in the retention policy shown to owners. Nothing is deleted automatically today. |
| Activity and audit logs | Kept. They record actions and ids, never browsing data, passwords or keys. |
| Caches | The service keeps no separate cache of your data, so a deletion takes effect everywhere at once. Browser caches belong to each profile on your computers. |
| Data on your computers | Yours. The service cannot reach or delete it. |

Off-site backups are encrypted and access to them is restricted. They are not used to restore one customer's
deleted data unless that customer asks, and only within the periods above.

## Reporting a problem
Report security issues to **official.bibekthapa@gmail.com** (see [SECURITY.md](../../SECURITY.md)).
