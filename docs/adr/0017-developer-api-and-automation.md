# 0017 — Developer API and authorized automation
Status: **Accepted (beta track)**. Date: 2026-10-14. Owner: backend lead + desktop lead. Builds on ADR-0013 (roles,
grants, tenant isolation), ADR-0014 (backups) and ADR-0015 (session leases) for milestone 10.

## Context
Customers want to integrate profile workflows: manage profiles from their own systems, ask an enrolled computer to
open a profile and do a few well-defined things (open an approved address, wait for a page condition, take a
screenshot, keep it open for someone, hand it to a Playwright script for authorized testing), follow the result and
receive events. The hard parts are not the HTTP routes but the boundaries: a token must never be able to do more than
the person who made it; a job must never write a profile someone else has open; a lost answer must never cause a
website-changing action to run twice; nothing may open a browser debugging port; webhooks must not become a way to
reach internal networks (SSRF); and nothing on a web page may change what a job is allowed to do.

## Decision
### API tokens: scoped, restricted, hashed, never more than their creator
- Format `pbt_<token id>_<43 base64url characters>` (256-bit secret; the prefix makes leaked tokens easy to find; a
  gitleaks rule matches it). Only the SHA-256 of the secret is stored (`api_tokens.token_hash`); the secret is in the
  `POST` (and rotation) answer only, never in a `GET`, a log or the desktop's offline cache.
- **Scopes** (`profiles:read`, `profiles:write`, `automation:read`, `automation:run`, `automation:debug`) map to
  permissions (`SCOPE_PERMISSIONS`). A request is allowed only if the creator's **current** role allows the permission
  **and** a token scope includes it (`requirePermission` checks both; a missing scope is `TOKEN_SCOPE_MISSING`, 403). A
  scope can be handed out only if the creator's role has every permission in it (`scopeAllowedForRole`).
- **Restrictions**: optional client ids and profile ids, AND-ed into the same reach clauses as grants
  (`profileVisible`/`clientVisible`), as SQL literal arrays only after a strict id check. A token whose creator loses
  access, leaves the organization or has the role changed loses it at the next request (nothing is copied into the
  token). Expiry 1–365 days, revocation immediate, rotation with an optional grace period (0–24 h) for the previous
  secret, at most 25 active tokens per person and organization.
- **Deny by default**: a route accepts tokens only when declared (`config: { tokens: true }`); 16 routes do (profiles
  and clients reads, profile create/edit/trash, organization read, automation settings read, jobs create/list/get/
  cancel/screenshot, agents list, `api-tokens/current`), pinned by a test. Tokens never manage tokens, webhooks,
  members or computers (`requireInteractive`). Token requests are rate-limited per token (600/min) and per
  organization (3,000/min) on top of the existing per-route limits.

### Jobs: a state machine with steps, leases and fencing like a person's session
- States `QUEUED → CLAIMED → RUNNING → SUCCEEDED | FAILED | CANCELED` (`JOB_TRANSITIONS`, enforced by a trigger;
  a claim that never started may go back to `QUEUED`). Finished jobs change only their references.
- A job is `open_profile`, the requested steps (at most 20, the first an `open_url`, at most 5 screenshots),
  optionally `debug_bridge` and `hold_open`, then `close_profile` (`job_steps`, with state, attempt, effect and a
  typed `safe_output`). `POST /jobs` needs an `Idempotency-Key`; a repeated request answers the same job.
- **Effect classes** (`STEP_REGISTRY`): `read`, `navigation` and `session` are safe to repeat; `external_mutation`
  (none exists in v1) is never repeated: a step started without a recorded result becomes `outcome_unknown` and the job
  `reconciliation_required`. The server decides where an interrupted job continues (`planResume`, `resume_from`),
  using the effect recorded on the step.
- **Leases**: a job runs only under the profile's session lease, taken by the computer exactly as for a person
  (ADR-0015) with the job's key (`<job>-<agent>`; a reopen after that lease ended adds `-r<n>` so it never replays the
  old lease). The computer reports `started` with the lease id and fencing token; every `step_started` re-checks that
  the lease is current, held by that computer and person (`FENCING_TOKEN_STALE` / `LEASE_NOT_HELD` otherwise). Closing
  is recorded without a current lease (it may have ended already); the closing backup is fenced by its own lease.
- **One writer per profile**: claims skip profiles with an active or uncertain lease or with a claimed/running job;
  a unique partial index on `(org_id, profile_id)` for `CLAIMED`/`RUNNING` makes a second running job impossible.
- **Claims recheck the requester**: the person (or token) who asked must still reach the profile and the sites must
  still be approved, or the job fails with `ACCESS_REMOVED` / `URL_NOT_APPROVED`. Removing a member ends their jobs.
- **Fair queue**: claims order by the requester's active jobs (fewest first), then age; an organization-wide limit
  of running jobs (1–50) and per-computer capacity (1–10); at most 500 queued jobs per organization and 100 per
  requester (`QUEUE_FULL`); job creation 1,000/h per organization.
- **Cancel**: `QUEUED`/`CLAIMED` end at once; `RUNNING` sets `cancel_requested_at` — the computer stops before the
  next step, closes the profile and its closing backup uploads; stopping a profile held open ends that job as
  succeeded. A sweeper (worker, every 5 s) expires queued jobs, returns unstarted claims after 60 s, marks silent
  jobs lost after 90 s and fails them after 10 more minutes (`AGENT_LOST`), stops holds past their time, and deletes
  screenshots after 7 days and finished jobs after 30.

### Computers: outbound only, as the person who enrolled them
- A computer is enrolled per organization from the desktop (`POST /automation/agents`, never with a token); it runs
  jobs as its person (`accepts`: their own jobs, or anyone's in the organization) and only on profiles that person may
  open. It **polls** (`POST …/agents/{agt}/poll`, every 5 s: heartbeat for its running jobs, new claims up to its
  capacity, cancellations, jobs to drop). No port is opened for jobs.
- Automation launches add `--enable-automation` (websites can tell; Chromium shows that the browser is controlled)
  and `--disable-backgrounding-occluded-windows` (a covered job window keeps rendering for its steps and screenshots)
  and connect the DevTools protocol over a **protected pipe**: `--remote-debugging-pipe` with descriptors 3/4 placed
  only in the child (Unix: close-on-exec pipes, `dup2` in `pre_exec`), or `--remote-debugging-io-pipes=<r>,<w>`
  with handles that are inheritable only while the launch holds a process-wide spawn lock (Windows). No
  `--remote-debugging-port` or address switch is ever added. If this app stops, the pipe closes and Chromium closes
  the browser cleanly (checked with the headless shell: exit code 0 within a few seconds).
- **Allowlisted steps only** (`pb_devtools::workflow`): navigate to an approved address (and fail if the page ends
  elsewhere: `PAGE_LEFT_APPROVED_SITES`), wait for a selector/text/title/address prefix (fixed expressions with the
  job's text as a JSON string literal, evaluated in an isolated world), capture a JPEG of the visible approved page
  (at most 1.5 MiB, quality lowered before refusing). Only booleans, the HTTP status, the page's origin and requested
  screenshots leave the page. Approved sites use one grammar in TypeScript and Rust with shared vectors.
- **Debugging sessions** (Playwright) need the `automation:debug` scope or permission (owners and admins), a job that
  keeps the profile open, the computer's own consent ("Allow Playwright connections", off by default, audited, not
  settable by the server or the generic settings command) and a capability: the requester generates a secret and
  sends only its SHA-256; the computer's **loopback broker** (127.0.0.1, random port, path `/cdp/<job>`) accepts a
  WebSocket only with that secret as a bearer token, a loopback `Host`, **no `Origin` header** (so no web page can
  connect), within a connect window, one client at a time, never ids in this app's own range. Commands are counted
  (number only) and audited locally.

### Webhooks: signed, retried, deduplicable, and not a way into private networks
- Standard Webhooks headers (`webhook-id` = the event id, `webhook-timestamp`, `webhook-signature: v1,<base64
  HMAC-SHA256>` over `id.timestamp.body`); after a secret rotation both signatures are sent for a grace period
  (default 1 h, at most 24 h). Secrets
  (`whsec_` + 32 random bytes) are wrapped with the KMS root key (context: organization and endpoint) and shown once.
- Delivery at least once: retries after 30 s, 2 min, 10 min, 30 min, 2 h, 6 h and 12 h, then a dead letter (kept 30
  days, can be sent again); 20 consecutive dead deliveries turn an endpoint off (`failing`). Fair claim per
  organization. Receivers deduplicate on `webhook-id`.
- **SSRF**: https only (http only in dev/test), no credentials or fragments in the address, port 443 or 1024+, no
  IP literals in private, loopback, link-local, CGNAT, multicast, documentation, metadata, NAT64/6to4/mapped ranges,
  no `localhost`/`.local`/`.internal` names — checked at create/update; the worker resolves **every** address and
  refuses if any is blocked, connects to the checked address (TLS server name kept), never follows redirects, reads at
  most 4 KiB, 10 s timeout; on the server, the app user's processes (API, worker) are refused private, link-local,
  CGNAT and local IPv6 destinations by host rules (nftables; amended below), so a DNS answer that changes after the
  check still cannot reach them.

### Desktop UI
Organization → Automation (jobs with steps and screenshots — downloaded by the shell —, cancel naming the profile and
client, computers, API tokens, webhooks with deliveries, approved sites) and Settings → Automation on this computer
(enroll per organization, Playwright consent, jobs here, stop a job). The window's allowlist gains the read and manage
routes; enrolling, polling, reports, uploads and job creation stay with the shell or the API.

## Consequences
- Jobs reuse the session machinery: no separate "automation lease", no second writer, the closing backup protects
  work done by a job like a person's. A computer can hold a profile only while it polls; a stopped app closes its
  automation browsers.
- v1 has no website-changing step. Adding one needs a preview/approval boundary and an idempotency strategy first;
  the effect class, `outcome_unknown` and reconciliation are in place for it.
- An automation launch is visible to websites (`navigator.webdriver`); nothing hides automation.
- Webhook delivery is at least once and unordered across retries; integrations must deduplicate and tolerate order.

## Evidence / verification
- API: `services/api/test/automation.test.ts` (30 scenarios: scopes, restrictions, revocation, rotation grace, one job
  per profile, duplicate requests, fairness, cancellation, lost agents, outcome unknown, SSRF fixtures, deliveries),
  `sdk.test.ts`, `authorization.test.ts` (M10 operations for every role), `cross-tenant.test.ts` (every new route).
- Worker: `services/worker/test/webhooks.test.ts` (signing, retries, dead letters, DNS answers with blocked addresses,
  redirects not followed).
- Desktop: `apps/desktop/src-tauri/tests/automation.rs` (7 scenarios with the in-memory server and a DevTools fake),
  `tests/browser.rs` (a job against real Chromium over the pipe), `crates/devtools` (real Chromium: pipe, steps,
  `navigator.webdriver`, broker), the SDK's Playwright `connectOverCDP` compatibility test.
- [Threat review](../automation/threat-review.md), [API](../automation/api.md), [webhooks](../automation/webhooks.md),
  [Playwright](../automation/playwright.md).

## Amendment (2026-10-14, after the first test-server deployment)
The egress policy was first a systemd `IPAddressDeny` list on the worker's unit. On the AlmaLinux 8 test server it was
accepted but not enforced (RHEL 8's default cgroup v1 has no BPF cgroup firewalling); CI's Ubuntu VM had hidden this,
and the setup only read the configuration back. Decision: an nftables table of its own (`inet pb_egress`, loaded by
`pb-egress.service`) matching the app user's uid — outbound only, other users and existing firewall rules untouched,
DNS resolvers allowed. The setup proves enforcement with a connection that must be refused and counted, and only then
makes the worker require the rules (fail closed after reboots); where they cannot be applied it says so and the
worker's own checks remain the control. Trade-off: the rules cover every process of the `pb` user (the API and tools
too), not only the worker, since the worker needs the same files (root key) as the API.

## Revisit when
A website-changing step is proposed; customers need push (WebSocket) instead of polling for agents; a managed egress
proxy replaces the host egress rules for webhooks; remote browser hosting (a separate tier) is planned.
