# Milestone 10 — status against the handoff file

Developer API and authorized automation. Version 0.10.0. Decisions:
[ADR-0017](adr/0017-developer-api-and-automation.md). Deliverables: [API docs](automation/api.md) and
[OpenAPI](openapi.json), [SDK](../packages/sdk/README.md) with [examples](../packages/sdk/examples/README.md),
[automation threat review](automation/threat-review.md), the job dashboard (Organization → Automation), integration
tests. Overview: [automation/README.md](automation/README.md); also [webhooks](automation/webhooks.md),
[Playwright](automation/playwright.md), [API changelog](automation/api-changelog.md).

Outcome: customers integrate profile workflows through scoped, auditable interfaces — API tokens that never exceed
their creator, jobs that enrolled computers run under the same session lease as a person, signed webhooks, and
Playwright debugging sessions that need the computer's own consent.

## V1 scope
| Required | Implemented |
|---|---|
| API profile/configuration management | Profiles (list, get, create, edit, trash), clients and organization reads with API tokens (`profiles:read`, `profiles:write`), within the token's client/profile restrictions |
| Launch/stop requests to enrolled online agents | Jobs (`POST …/automation/jobs`) to a chosen or any enrolled computer that may run them; `keep_open_minutes` keeps a profile open (a launch request), cancel stops it; computers enrolled per organization in the desktop app, online by their polls |
| Job progress, webhooks, small allowlisted workflow steps | Job and step states, typed outputs, screenshots; webhooks for queued/started/succeeded/failed/canceled; steps: open an approved address, wait for a condition, screenshot, keep open, Playwright hand-off |
| Authorized testing/business workflows; no autonomous agents or unrestricted code | No step runs code from a job or clicks/types; approved sites only; automation visible to websites (`--enable-automation`) |

## Ordered implementation
| Step | Implemented |
|---|---|
| 1. OpenAPI schemas, examples, SDK, API changelog; existing `/v1` contracts; no unguarded automation endpoints | Routes under `/v1/orgs/{org}/…` with TypeBox schemas in `packages/contracts/src/automation.ts`; `docs/openapi.json` marks the 16 token routes; `@pb/sdk` (fetch + WebCrypto, no dependencies) with three examples; [API changelog](automation/api-changelog.md); every route requires a session or a token and the tenant checks of milestone 06 |
| 2. Scoped tokens with org/client/profile restrictions, expiry, rotation; hashes only; secret shown once; never beyond the creator | `api_tokens` (SHA-256 of a 256-bit secret, scopes, client/profile ids, expiry, rotation with a 0–24 h grace for the previous secret, revocation); `role allows ∧ scope includes` on every check, membership and grants read per request; scopes limited to the creator's role; deny-by-default routes; per-token and per-organization rate limits; UI: create (secret once), rotate, revoke |
| 3. Job state machine QUEUED→CLAIMED→RUNNING→SUCCEEDED/FAILED/CANCELED; steps and checkpoints; retry only idempotent steps; execution requires a lease | `automation_jobs` with a transition trigger, `job_steps` with effect classes; `planResume` repeats only `read`/`navigation`/`session` steps; `external_mutation` becomes `outcome_unknown` + `reconciliation_required`; the computer reports `started` with its session lease and every `step_started` re-checks it (fencing) |
| 4. Outbound authenticated connection/polling; no public localhost control port; any local bridge loopback, authenticated, Origin-validated, short-lived capability, off by default | Computers poll every 5 s with their interactive device session; nothing listens for jobs; the only local listener is the Playwright broker: off by default per computer, 127.0.0.1, capability bearer (SHA-256 known to the server, secret only to the requester), refuses any `Origin` and non-loopback `Host`, 5-minute connect window, one client, ends with the job |
| 5. Playwright adapter after compatibility tests; protected pipe or authenticated broker rather than debugging endpoints; debugging admin-controlled and audited | DevTools over a protected pipe (`--remote-debugging-pipe` / `--remote-debugging-io-pipes`), never a port; broker relays to the pipe; `playwright-core` 1.63 `connectOverCDP` compatibility test in CI; `automation.debug` (owners/admins) + the `automation:debug` scope + the computer's audited consent; sessions audited with port, connections and command count |
| 6. Narrow actions: open approved URL, explicit diagnostic screenshot, wait for owned/test page condition, return result; preview/approval and idempotency before website-changing actions | `open_url`, `wait_for` (selector/text/title/address prefix as JSON literals in an isolated world), `screenshot` (≤ 1.5 MiB, 7 days); results as typed outputs only; no website-changing step exists (the effect class and reconciliation path are ready; ADR-0017 requires preview/approval first) |
| 7. Webhooks: signed payloads, timestamp, event id, retries/backoff, dead-letter inspection; SSRF via destination validation, DNS/redirect checks, egress policy | Standard Webhooks signatures (secret KMS-wrapped, shown once, dual signatures during rotation); 7 retries over ~21 h, dead letters kept 30 days and redeliverable; endpoint off after 20 dead in a row; destination checks at create/update and every delivery (all DNS answers, connect to the checked address, no redirects); systemd `IPAddressDeny` on the worker |
| 8. Rate-limit by org and token; fair queue; cancellation propagates, closes or releases safely, preserves pending snapshot | Token and organization limits, job creation limit, queue limits; claims fair by requester; organization running limit and computer capacity; cancel: queued → canceled at once, running → stops before the next step, closes the profile and its closing backup uploads (a backup that cannot upload stays pending on the computer and the profile stays held) |

## Data / API
| Required | Implemented ([OpenAPI](openapi.json), migration `0007_automation.sql`) |
|---|---|
| `api_tokens(id, org_id, token_hash, scopes, expires_at, revoked_at)` | Plus name, owner, client/profile restrictions, last used, rotation and previous secret validity |
| `automation_jobs(id, org_id, profile_id, requested_by, idempotency_key, state, lease_token, result_ref)` | Plus token, label, chosen/claiming agent, attempt, lease id, queue expiry, keep-open, debugging digest, cancel request, reconciliation flag, timestamps, version |
| `job_steps(job_id, sequence, state, attempt, safe_output)` | Plus action, effect, input, error code, timestamps; `job_artifacts` for screenshots |
| `webhook_endpoints(id, org_id, encrypted_secret_ref, destination, state)` | `encrypted_secret` + `secret_key_ref` (KMS-wrapped), events, previous secret during rotation, disabled reason |
| `webhook_deliveries(event_id, endpoint_id, attempt, next_attempt_at)` | Plus state, last status and error code, lock |
| Routes: `POST/GET /v1/automation/jobs`, `GET …/{id}`, `POST …/{id}/cancel`, CRUD `/v1/api-tokens` and `/v1/webhook-endpoints` | Under the organization like every route since 06: `/v1/orgs/{org}/automation/jobs…`, `/v1/orgs/{org}/api-tokens…`, `/v1/orgs/{org}/webhook-endpoints…`, plus settings, agents, screenshots, deliveries |
| Also: `automation_settings`, `automation_agents` | Approved sites and running limit; enrolled computers |

## Failure rules
| Required | Implemented |
|---|---|
| A timeout after an external mutation is "outcome unknown"; expose reconciliation; a restarted agent never reruns a payment/publish because the last response was lost | The server refuses `step_started` again for a running `external_mutation` step; the sweeper and `finished` mark it `outcome_unknown` and the job `reconciliation_required` (API test); the dashboard says "check by hand" |
| Retried internal launches use the same idempotency key | The desktop opens with the job's lease key (`<job>-<agent>`, saved before the request); a retried open gets the same lease back (API test); a reopen after the lease ended uses `-r<n>` (desktop test) |
| Untrusted page text is data, never authority; a future AI assistant cannot read credentials or turn page instructions into privileged calls | Only booleans, status, origin and screenshots leave a page; outputs validated per action; no step takes decisions from page text; jobs' permissions come only from the requester and token |

## Exit criteria
| Criterion | Evidence |
|---|---|
| Revoked/scoped tokens fail outside grants | API: scopes, restrictions, revoked, expired, narrowed, orphaned, rotation grace, pinned token routes, token cannot manage tokens/webhooks; authorization matrix for every role; cross-tenant swaps for every new route |
| Two jobs cannot write the same shared profile | API: second job waits; database refuses a second active job; a profile open interactively is not claimed; after a takeover the next step is refused. Desktop: jobs open under the session lease and release it after the closing backup |
| Duplicate request yields one job | API: concurrent and sequential replays with one `Idempotency-Key` answer the same job; SDK retries with the same key |
| Webhook duplicate documented and deduplicable | [webhooks.md](automation/webhooks.md) (at least once, same `webhook-id` on every copy); SDK example deduplicates; worker tests |
| SSRF fixture destinations blocked | Contract vectors (IPv4/IPv6 ranges, mapped, NAT64, 6to4, local names, credentials, ports); API refuses them at create/update; worker refuses a name resolving to a blocked address and never follows redirects; worker egress firewall on the test server |
| Agent disconnect resumes only safe steps and reports ambiguous outcomes | Desktop: a lost answer → the computer stops reporting, closes the profile, and resumes the unfinished navigation step under a new lease (open not repeated); API: resume plans, `outcome_unknown` never repeated, `AGENT_LOST` after the resume window |
| Deliver API docs, SDK examples, threat review, job dashboard, integration tests | Links above; dashboard screenshots in `docs/design/org-automation-*.png`; UI e2e with axe for the new screens in light and dark |

Test counts: Rust 317 across the workspace locally (new: desktop automation 7, real-browser job 1, DevTools crate 9 unit
+ 3 real-Chromium, launch 1, storage 1, window allowlist 1, agent helpers 2); API 443 (+ 9 gated on Keycloak/S3; new:
30 automation scenarios, 2 SDK-against-API, 8 operations × 5 roles, every new route in the cross-tenant swaps); worker
18 (11 webhooks); contracts 24 (shared approved-site vectors, SSRF vectors); config 8; SDK 8 + the Playwright
compatibility test; UI unit 30; UI end-to-end 169 (4 new flows and 4 new screens in light and dark with axe).

CI: _pending — filled in with the run ids once the dispatched runs finish._

## Test server
`vps-setup.sh` changed (the worker's egress firewall), so the update runs **twice**: the first run copies the new
script, the second applies it — migration `0007_automation.sql`, the worker unit with `IPAddressDeny`/`IPAddressAllow`
(checked with `systemctl show`), and the API tests including the automation suite. Automation works through the same
SSH tunnel; a computer enrolled from the desktop polls the API through it.

## Found and fixed during verification
- Chromium reads DevTools message ids as 32-bit integers: the app's own ids start at 2^30 (ids at 2^31 got no answer).
- A job resumed after its lease was released would have replayed the old (released) lease through the idempotency
  record; reopens now use a new key suffix, counted in the local run record.
- Closing could not be reported once the lease had ended (after a takeover or a restart); closing is now recorded
  without a current lease, since the closing backup is fenced by its own lease.
- The broker records a refusal after answering; the Windows CI job was faster than the record, so the tests wait for it.
- On Windows every inheritable handle is inherited by any process started at the same time; browser launches are now
  serialised so a job's pipe ends reach only its own browser.
- Secret scanning flagged a placeholder capability and RFC 6455's sample WebSocket key in tests; both are now built at
  run time, and gitleaks gained rules for this project's token, capability and webhook-secret formats.

## Known limitations
- No website-changing step (by design for v1); the reconciliation path is built but not exercised by a real step.
- Cancels reach a computer within ~5 s and take effect after the current step (a long `wait_for` can take up to 2 min).
- A profile whose closing backup cannot upload stays held by that computer until its person retries or gives the
  handoff up (as for a person's session); the job reports `BACKUP_PENDING`.
- A job for a profile that was never backed up can run only on the computer that has it (other computers give the
  claim back).
- Playwright sessions control the whole browser session (sign-ins included) on the computer that allows them.

## Release
No release boundary at this milestone (team beta was reached at 08; paid launch after 14). Internal builds remain
unsigned (owner action, milestone 12 updater).
