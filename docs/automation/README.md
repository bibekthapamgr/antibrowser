# Developer API and authorized automation (milestone 10)

Customers integrate profile workflows through scoped, auditable interfaces: an HTTP API with API tokens, jobs that
enrolled computers run on organization profiles, webhooks for job events, and Playwright debugging sessions for
authorized testing. Decisions: [ADR-0017](../adr/0017-developer-api-and-automation.md). Reference:
[api.md](api.md) and [OpenAPI](../openapi.json). Also: [webhooks](webhooks.md), [Playwright](playwright.md),
[threat review](threat-review.md), [API changelog](api-changelog.md), [SDK](../../packages/sdk/README.md) and its
[examples](../../packages/sdk/examples/README.md).

Automation here is for authorized testing and business workflows on sites you own or are permitted to use. Jobs open
only the organization's approved sites, websites can tell the browser is automated (`--enable-automation`,
`navigator.webdriver`), and nothing in this product hides automation or changes what a browser looks like.

## How it fits together
```
your system ──(API token)──► API ──► automation_jobs (QUEUED)
                                         ▲     │ claim (fair queue, one job per profile)
                                         │     ▼
             desktop app on an enrolled computer ──(polls every 5 s, outbound only)──┘
               │ session lease (same as a person) → restore newest backup → launch with --enable-automation
               │ DevTools over a protected pipe (no port) → allowlisted steps → screenshots uploaded
               │ close → closing backup → lease released → result reported
               ▼
             webhooks (signed, retried, dead letters) ──► your HTTPS endpoint
```

## Setting it up (owner or admin)
1. **Approved sites**: Organization → Automation → Approved sites (`https://app.example.com`, `https://*.example.com`,
   `http://localhost:3000` for a test site on the computer itself). Jobs never open anything else.
2. **A computer**: on the computer that will run jobs, Settings → Automation on this computer → *Run jobs here* for the
   organization (only my jobs, or anyone's; 1–5 at a time). It runs jobs as the person signed in there, only on profiles
   that person may open. An admin can turn a computer off or remove it under Organization → Automation → Computers.
3. **An API token**: Organization → Automation → API tokens → *New token*: permissions (scopes), optionally only some
   clients or profiles, an expiry. Copy the secret: it is shown once.
4. Optionally **webhooks**: Organization → Automation → Webhooks → *New endpoint* (https). Copy the signing secret.

## Running a job (SDK)
```ts
import { ProjectBrowser } from '@pb/sdk';
const pb = new ProjectBrowser({ baseUrl: 'https://api.example.com', orgId: 'org_…', token: process.env.PB_TOKEN! });
const { job } = await pb.jobs.create({
  profile_id: 'prf_…',
  label: 'Morning login check',
  steps: [
    { action: 'open_url', url: 'https://portal.example.com/login' },
    { action: 'wait_for', condition: { type: 'text', text: 'Welcome' } },
    { action: 'screenshot', label: 'login' },
  ],
});
const done = await pb.jobs.wait(job.id);   // SUCCEEDED, FAILED (error_code) or CANCELED
```
The job dashboard (Organization → Automation → Jobs) shows each job's steps, results and screenshots; a person can stop
a job there (the confirmation names the profile and client).

## What a job can do (v1)
| Step | Effect | What it does |
|---|---|---|
| `open_profile` (automatic) | session | Takes the profile's session lease on the computer (refused if anyone has it open), restores the newest backup if needed, launches the browser |
| `open_url` | navigation | Opens an approved address; fails if the page ends on another site (`PAGE_LEFT_APPROVED_SITES`); reports the final origin and HTTP status |
| `wait_for` | read | Waits for a CSS selector, a text, a title or an address prefix (on approved pages); reports only yes/no and the time |
| `screenshot` | read | A JPEG of the visible approved page (≤ 1.5 MiB), kept 7 days; a minimized or hidden job window is brought to the front first (a covered one keeps rendering) |
| `debug_bridge` (with `debug`) | session | Hands the session to a Playwright script on that computer ([Playwright](playwright.md)) |
| `hold_open` (with `keep_open_minutes`) | session | Keeps the profile open until stopped or the time is up |
| `close_profile` (automatic) | session | Closes the browser; the closing backup uploads; the lease is released |

There is no step that clicks, types, submits or runs code from the job. A step that would change something on a website
needs a preview/approval boundary and an idempotency strategy first (ADR-0017); the effect class and reconciliation
are in place for it.

## Failure behaviour
- **Lost connection or restart**: the server keeps the job; when the computer comes back (within 10 minutes) it
  continues from the step that has no recorded result if that step is safe to repeat (navigation, read, session), in a
  new session lease. If the computer does not come back, the job fails with `AGENT_LOST`. A step with an external effect
  would never be repeated: it becomes `outcome_unknown` and the job `reconciliation_required` (check by hand).
- **Someone has the profile open**: the job waits in the queue (claims skip profiles in use); two jobs never run on the
  same profile.
- **Cancel**: queued jobs end at once; a running job stops before its next step and the profile closes with its
  closing backup. Stopping a profile held open ends that job as succeeded.
- **Removed access**: if the requester (or their token) loses access before a computer takes the job, it fails with
  `ACCESS_REMOVED`; removing a member ends their running jobs.

## Tests and evidence
| Exit criterion | Evidence |
|---|---|
| Revoked/scoped tokens fail outside grants | `services/api/test/automation.test.ts` (scopes, client/profile restrictions, revoked, expired, narrowed by a removed grant, orphaned by a removed member, rotated with and without grace, deny-by-default routes, tokens never manage tokens or webhooks), `authorization.test.ts`, `cross-tenant.test.ts`; SDK `test/sdk.test.ts` |
| Two jobs cannot write the same shared profile | API tests: the second job waits; a profile open interactively is not claimed; a direct database update to a second active job is refused by the unique index; after a takeover the next step is refused (`FENCING_TOKEN_STALE`). Desktop tests: every job opens under the session lease, which is released only after the closing backup |
| Duplicate request yields one job | Same `Idempotency-Key` → same job (API test; SDK retries with the same key; replays answered while the original is still running) |
| Webhook duplicate documented and deduplicable | [webhooks.md](webhooks.md): at-least-once, `webhook-id` = event id on every retry and redelivery; worker test; SDK example deduplicates |
| SSRF fixture destinations blocked | `webhookUrlProblem` vectors (private, loopback, link-local, metadata, CGNAT, IPv6 mapped/NAT64/6to4, `localhost`, `.internal`, credentials, ports); worker test resolving a name to a blocked address; no redirects followed; host egress policy |
| Agent disconnect resumes only safe steps and reports ambiguous outcomes | Desktop `tests/automation.rs` (a lost answer → resumed step under a new lease, open not repeated); API tests for `planResume`, `outcome_unknown` and `reconciliation_required`, sweeper `AGENT_LOST` |

Real browser: `crates/devtools/tests/chromium.rs` (pipe, steps, `navigator.webdriver` true, broker) runs in CI with
the headless shell on Linux, Windows and macOS; `apps/desktop/src-tauri/tests/browser.rs` (a job end to end against the
browser over the pipe, through the app's real launcher) runs in the runtime pipeline's compatibility jobs (Windows,
macOS, Linux) with the current upstream stable Chrome for Testing; the SDK's Playwright `connectOverCDP` compatibility
test runs in CI on Linux.
