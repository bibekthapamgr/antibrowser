# Webhooks

Owners and admins add HTTPS endpoints (Organization → Automation → Webhooks, or the API) for job events:
`automation.job.queued`, `automation.job.started`, `automation.job.succeeded`, `automation.job.failed`,
`automation.job.canceled`, plus `webhook.test` from "Send test". At most 10 endpoints per organization.

## What arrives
```
POST /your/path HTTP/1.1
content-type: application/json
user-agent: ProjectBrowser-Webhooks/1
webhook-id: evt_01J…                  ← the event id: the same on every retry and redelivery
webhook-timestamp: 1791937535         ← seconds, when this attempt was sent
webhook-signature: v1,K5oZfz…=        ← two, separated by a space, right after a secret rotation

{"type":"automation.job.succeeded","timestamp":"2026-10-14T09:12:03.120Z",
 "data":{"job_id":"job_…","profile_id":"prf_…","state":"SUCCEEDED","agent_id":"agt_…","error_code":null,
         "reconciliation_required":false,"attempt":1}}
```
`data` holds identifiers and states only — never page content, screenshots, profile names or anything a job saw. Fetch
details with the API (`GET …/automation/jobs/{job_id}`) using a token.

## Verifying (Standard Webhooks)
The secret (`whsec_` + base64 of 32 random bytes) is shown once when the endpoint is created or its secret rotated.
Compute `base64(HMAC-SHA256(key, "<webhook-id>.<webhook-timestamp>.<raw body>"))`, where `key` is the 32 decoded
bytes, and compare it in constant time with each `v1,` signature in the header (either may match). Refuse timestamps
more than 5 minutes from your clock. Use the raw body exactly as received (before JSON parsing).
The SDK does this: `await verifyWebhook(secret, headers, rawBody)` ([example](../../packages/sdk/examples/webhook-receiver.ts)).

Rotating the secret (`POST …/rotate-secret`, `grace_minutes` 0–1440, default 60) signs with both the new and the old
secret during the grace period, so you can switch receivers without losing deliveries.

## Delivery, duplicates and order
- **At least once.** An attempt counts as delivered on any 2xx answer within 10 seconds. Anything else — timeouts,
  connection or TLS errors, 3xx (redirects are never followed), 4xx, 5xx — is retried after 30 s, 2 min, 10 min,
  30 min, 2 h, 6 h and 12 h (about 21 hours in all). After the last attempt the delivery is a **dead letter**: listed
  under the endpoint's deliveries for 30 days and can be sent again (`POST …/deliveries/{dlv}/redeliver`).
- **Duplicates happen**: a retry after your server processed the event but its answer was lost, a manual redelivery,
  or a test. Every copy of an event carries the same `webhook-id`. Deduplicate on it (store the ids you processed for
  at least a day) and make handlers idempotent.
- **Order is not guaranteed** across retries; use the job's `state` and the API for the current truth (a `started`
  event can arrive after `succeeded` if the first attempt failed).
- Answer quickly (within 10 s) and process asynchronously. At most 4 KiB of your answer is read.
- 20 dead deliveries in a row turn the endpoint off (`state: disabled`, `disabled_reason: failing`); turn it back on
  when your receiver works again (new events only; dead letters can be redelivered).
- Deliveries are spread fairly across organizations, so one organization's backlog cannot hold up another's.

## Destinations that are refused (SSRF protection)
Checked when an endpoint is created or changed (`WEBHOOK_DESTINATION_BLOCKED`, with a reason) and again before every
attempt:

| Refused | Reason code |
|---|---|
| Not `https://` | `scheme` |
| User name or password in the address; a `#fragment` | `credentials`, `fragment` |
| Ports below 1024 except 443 | `port` |
| IP addresses in private (10/8, 172.16/12, 192.168/16), loopback, link-local (169.254/16 — cloud metadata), CGNAT (100.64/10), "this network", multicast, reserved, documentation and benchmarking ranges; IPv6 unspecified, loopback, unique-local, link-local, site-local, multicast, discard-only, documentation, IETF protocol assignments (Teredo, ORCHID) and 6to4; IPv4-mapped and NAT64 forms judged as the IPv4 address | `blocked_address` |
| `localhost` and names ending in `.localhost`, `.local`, `.internal`, `.intranet`, `.lan`, `.home`, `.corp`, `.localdomain`; single-label names and numeric or hex host forms | `blocked_name`, `host` |

At delivery the worker resolves the name, refuses if **any** answer is blocked (`blocked_destination`), connects to the
address it checked (the TLS server name stays the host name, so certificates are verified normally), and never follows
redirects. On the server the worker's systemd unit also denies outbound connections to private and loopback ranges
except the DNS resolvers (`IPAddressDeny`/`IPAddressAllow`), so a name that resolves differently after the check still
cannot reach an internal address. Development and test servers can allow private destinations
(`WEBHOOK_ALLOW_PRIVATE_DESTINATIONS=true`); with any other `APP_ENV` the API and worker refuse to start with it.

## Inspecting deliveries
Organization → Automation → Webhooks → Deliveries (waiting, delivered, dead letters, attempts, last status and error:
`timeout`, `connection`, `tls`, `status_4xx`, `status_5xx`, `redirect`, `blocked_destination`, `dns`), or
`GET …/webhook-endpoints/{whk}/deliveries?state=dead`.
