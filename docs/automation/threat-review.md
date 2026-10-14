# Automation threat review (milestone 10)

Scope: API tokens, the job queue and state machine, enrolled computers (the desktop agent), the DevTools pipe, the
Playwright broker, screenshots and webhooks. Method: assets → entry points → threats (STRIDE) → controls in place →
tests → residual risk. Decisions: [ADR-0017](../adr/0017-developer-api-and-automation.md). The full product threat
model and an external review are milestone 12 gates; this review is the milestone 10 input to them.

## Assets
1. Organization profiles' sessions (sign-ins, site data) — opening a profile is the most sensitive action.
2. The single-writer guarantee of a profile and its backups (ADR-0015).
3. API token secrets, webhook signing secrets, debugging capabilities.
4. The organization server's network position (internal services, cloud metadata).
5. Screenshots (they can show account pages).
6. The person's computer (no new listening services; no code from jobs).

## Trust boundaries
| From → to | Channel | Authenticated by |
|---|---|---|
| Integration → API | HTTPS, `Authorization: Bearer pbt_…` | Token digest + the creator's current membership, role, grants; scopes; restrictions |
| Desktop → API (agent) | HTTPS, interactive session | Device-bound session of the computer's person (ADR-0013); agent bound to that device |
| Desktop → Chromium | Anonymous pipe (fds 3/4, or inherited handles) | Possession: only this app holds the other ends |
| Playwright script → broker | WebSocket on 127.0.0.1 | Capability secret (bearer), loopback Host, no Origin |
| Web page → browser | The page itself | Untrusted; never authority |
| Worker → webhook receiver | HTTPS | Receiver verifies our HMAC signature |

## Threats and controls
| # | Threat (STRIDE) | Controls | Tests |
|---|---|---|---|
| T1 | A token does more than its creator could (E) | Every check is `role allows` **and** `scope includes`; scopes limited to the creator's role at creation; restrictions AND-ed into reach queries; membership, role and grants read at each request (nothing copied into the token) | API: scopes beyond the role refused; narrowed/orphaned tokens; authorization matrix for every role |
| T2 | A stolen token (I, E) | 256-bit secret, only its SHA-256 stored; shown once; prefix for secret scanning (gitleaks rules for `pbt_`, `whsec_`, `pbcap_`); expiry ≤ 365 days; immediate revocation; rotation with grace; `last_used_at`; rate limits per token and organization; deny-by-default route list; tokens cannot manage tokens, webhooks, members or computers | API: secret not in `GET`s or logs; revocation; rotation grace; rate limit; pinned token route list |
| T3 | Cross-tenant access with a token (I) | A token's organization must equal the path's (404 otherwise); RLS on every M10 table; composite keys | Cross-tenant swaps on every new route, including token routes |
| T4 | Two writers on one profile (T) | Jobs run under the profile's session lease (same rules as a person); claims skip leased and busy profiles; unique index on active jobs per profile; every `step_started` re-checks lease id, holder device and person, fencing token; the closing backup is fenced by its own lease | API: second job waits; database refuses a second active job; takeover → next step refused. Desktop: lease taken before `started`, released after the closing backup |
| T5 | A replayed or duplicated request runs a job twice (T) | `Idempotency-Key` required (same key → same job, also concurrently); the desktop opens with the job's lease key (a retried open gets the same lease back; a reopen after a released lease uses a new suffix); reports carry the claim attempt (`JOB_CLAIM_STALE` for an old claim) | API: concurrent and sequential replays; retried lease key; stale claim cannot report. Desktop: lost answer → resume under a new lease |
| T6 | A lost answer causes a website-changing action to run twice (T) | Effect classes; only `read`/`navigation`/`session` steps repeat; `external_mutation` becomes `outcome_unknown` + `reconciliation_required` and is never repeated (server refuses `step_started` for it); v1 has no such step | API: outcome unknown is never repeated; `planResume` vectors |
| T7 | A job reaches an unapproved site (E, I) | Approved sites checked at creation, at claim and by the computer before navigating; the page's final origin checked after every navigation (`PAGE_LEFT_APPROVED_SITES` stops the job); strict address grammar shared by TypeScript and Rust; screenshots and conditions only on approved pages | Shared vectors; API: `URL_NOT_APPROVED`; desktop: redirect off-site stops the job, unapproved address never navigated |
| T8 | Page content steers the job (prompt-injection style) (E) | No step reads page text into decisions except a yes/no condition; conditions are fixed expressions with the job's text as a JSON string literal in an isolated world; outputs are typed fields (origin, status, booleans, sizes) validated per action on the server; no free text from pages is stored or forwarded | Desktop: expression shape; API: output fields restricted per step |
| T9 | A local process or web page drives the browser through a debugging port (E) | No `--remote-debugging-port`/address ever; DevTools over a pipe whose ends only this app holds (Unix: close-on-exec, placed in the child only; Windows: inheritable only inside a spawn lock); the broker (opt-in) refuses requests with an `Origin`, non-loopback `Host`, missing/wrong capability, late first connection, a second client; client ids cannot collide with the app's own | Launch test (no port switch); real Chromium: pipe works, `DevToolsActivePort` never written; broker tests for each refusal; Playwright compatibility |
| T10 | The server turns on debugging on a computer (E) | "Allow Playwright connections" is local only (not settable by the generic settings command or the server), audited; the server only learns whether it is on; debugging jobs need `automation.debug` and a capability whose secret the server never sees | Desktop: setting not settable via `update_setting`; job not assigned without consent; consent off ends the session |
| T11 | Automation is hidden from websites (R) | Launch adds `--enable-automation`; `navigator.webdriver` is true; nothing alters fingerprints | Real Chromium test asserts `navigator.webdriver === true` |
| T12 | SSRF through webhooks (I, E) | https only, no credentials/fragments, port policy, IP literal and name checks at create/update; at delivery every resolved address checked, connect to the checked address, no redirects, 4 KiB read, 10 s; host egress rules on the test server (nftables: the app user is refused private, link-local, CGNAT and local IPv6 networks; proven by a refused connection at every setup run; the worker requires them); private destinations only in dev/test (config refuses otherwise) | SSRF vectors (v4, v6, mapped, NAT64, 6to4, names); worker: DNS answer with a blocked address refused, redirects not followed; deploy-scripts CI: user `pb` refused 10/8, 192.168/16 and 169.254.169.254 |
| T13 | Forged or replayed webhooks at the receiver (S, T) | HMAC-SHA256 over id, timestamp and body; constant-time verification; 5-minute tolerance; same `webhook-id` for duplicates; secrets wrapped with the KMS root key and shown once | SDK and API verification tests; rotation dual signature |
| T14 | One tenant starves others (D) | Fair claims (fewest active jobs per requester first), organization running limit, computer capacity, queue limits (500 per organization, 100 per requester), job creation 1,000/h, token rate limits, fair webhook claims per organization | API: fairness across requesters; queue limits; rate limit |
| T15 | Screenshot leakage (I) | Taken only when a step asks, only of an approved page, ≤ 1.5 MiB; readable only by those who can see the job; kept 7 days; the window gets them through the shell (allow-listed, never cached offline); webhooks never carry them | API: typed upload, access only with the job; allowlist test (screenshots are not in the window's list); retention by the sweeper |
| T16 | Abuse of a computer: jobs as code execution (E) | No step runs code from the job; Playwright only with local consent + capability; jobs run as the enrolled person, only on profiles they may open; `accepts: mine` by default | API: computer accepting only its person's jobs; launch capability required |
| T17 | A removed member's jobs keep running (E) | Removal ends their jobs and revokes their tokens' reach; claims re-check the requester (`ACCESS_REMOVED`); agents of removed devices stop polling (404 → forgotten locally) | API: requester lost access → fails at claim; computer removal; desktop: removed computer forgets its enrollment |
| T18 | Audit gaps (R) | Server audit for token create/rotate/revoke, settings, job create/claim/start/cancel/finish, agent enroll/update/remove, webhook changes and redeliveries; desktop audit for enrollment, consent changes, debugging sessions (port, connections, command count), job outcomes | API audit assertions; desktop audit assertions |

## Residual risks and follow-ups
- **The session is powerful by nature.** A job (and above all a Playwright session) acts inside a signed-in browser
  profile. Approved sites, typed steps and consent reduce what a job can do, but a person with `automation:debug`
  and a computer that allows Playwright can do anything in that session. Keep both rare; review in milestone 12.
- **Same-user local processes.** Anything running as the computer's user could already read the profile's files;
  the broker does not defend against that user (it defends against web pages and other users' processes via the
  capability). Disk encryption and OS account hygiene remain the customer's responsibility.
- **Windows handle inheritance** is contained by serialising this app's browser launches; another program started by
  the app at the same instant (no such path today) would inherit the handles. Revisit with
  `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` when the standard library supports it.
- **Webhook egress** relies on host rules of the single-server deployment (they do not cover loopback, which the API
  and worker need; the worker's own checks refuse loopback destinations); a managed egress proxy replaces them at
  scale (milestone 13).
- **No website-changing steps yet.** Adding one requires the preview/approval boundary and idempotency strategy in
  ADR-0017 first; the reconciliation path is built but unexercised by real steps.
- **Polling latency**: a cancel reaches the computer within ~5 s and takes effect after the current step (at most
  2 minutes for a long wait).
