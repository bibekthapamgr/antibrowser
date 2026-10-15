# R7 — Pilot and staged rollout

## Who
5–10 people who agree in writing to take part (consent form below), including at least:
- a **solo operator** (one person, a few profiles);
- an **agency owner** (several clients' profiles, invites a teammate);
- an **invited member** (joins through the invitation, gets only some profiles).
Mix of Windows x64 and macOS arm64. Nobody gets staff help with the first journey unless they are stuck for more than
15 minutes (then it counts as "assisted").

## What is observed (no screen recording without separate consent)
| Measure | How | Target (suggested) |
|---|---|---|
| Unassisted activation | registered → app installed → profile created and opened, without staff help | ≥ 80 % |
| Sharing without help | owner invites, member opens a shared profile | ≥ 80 % of owners who try |
| Tenant/profile leaks | reports + the console's audit + member-visible counts | **0 confirmed** |
| Lost committed snapshots | console Operations (failed vs saved backups), support reports | **0** |
| Severe security findings | register in `docs/security/findings.md` | none unresolved |
| Crashes / sync failures | desktop Diagnostics (shared by the person), console health | no rising trend |
Report the sample size with every number. A small pilot does not prove reliability for everyone.

## Consent (short form)
"I agree to take part in the Project Browser pilot from ___ to ___. I will use it for my own authorized accounts. I
agree to answer a short interview and to share the app's Diagnostics page when I report a problem. No browsing content,
passwords or page data is collected. I can stop at any time; my data can be exported or deleted on request."

## Staged rollout
1. **Canary** (pilot users only): the canary update channel, `PB_UNSIGNED_PILOT=true` only if OS signing is not ready
   (labelled "Unsigned pilot build").
2. **Staged stable**: promote the exact canary files to stable after at least 7 days without a pause criterion, open
   the website's download to new sign-ups in steps (invite list → public).
3. **Pause criteria** — any one of these pauses the channel (`desktop release` → `pause`) and new sign-ups (website
   notice + status page) until understood:
   - data loss (a committed snapshot missing, a profile's data lost);
   - an authorization violation (anyone sees or opens what they were not given);
   - a broken paid entitlement (a paying customer restricted, or limits wrong);
   - crashes or sync failures clearly above the previous week (console Health, Diagnostics reports).
   Resume only with the cause fixed and a test that would have caught it.

## Report
| Item | Value |
|---|---|
| Dates | |
| Participants (solo / agency / member; Windows / macOS) | |
| Unassisted activation | __ of __ |
| Sharing without help | __ of __ |
| Leaks / lost snapshots / severe findings | |
| Issues found (link each) | |
| Decision (continue / pause / fix first) | |
