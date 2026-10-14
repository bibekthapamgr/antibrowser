# @pb/sdk — Project Browser developer API for TypeScript

A small client for the [developer API](../../docs/automation/api.md): profiles, automation jobs, screenshots, webhook
verification and Playwright debugging sessions. No dependencies (`fetch` and WebCrypto); Node 24 or a bundler.

```ts
import { writeFile } from 'node:fs/promises';
import { ProjectBrowser, newIdempotencyKey } from '@pb/sdk';

const pb = new ProjectBrowser({ baseUrl: 'https://api.example.com', orgId: 'org_…', token: process.env.PB_TOKEN! });
const key = newIdempotencyKey();               // keep it with your own record; retries reuse it
const { job } = await pb.jobs.create(
  { profile_id: 'prf_…', steps: [{ action: 'open_url', url: 'https://portal.example.com/' }, { action: 'screenshot' }] },
  { idempotencyKey: key },
);
const done = await pb.jobs.wait(job.id);
if (done.job.state === 'SUCCEEDED') {
  const shot = done.artifacts[0];
  if (shot) await writeFile('shot.jpg', await pb.jobs.screenshot(job.id, shot.id));
}
```

| API | |
|---|---|
| `new ProjectBrowser({ baseUrl, orgId, token, retries?, fetch? })` | Checks the token's shape; retries GETs and job creation on network errors, 429 (honouring `Retry-After`) and 5xx |
| `token.current()` | The calling token (scopes, restrictions, expiry) |
| `profiles.list/get/create/update/trash`, `clients.list` | Profile management within the token's scopes and restrictions |
| `automation.settings()`, `automation.agents()` | Approved sites; enrolled computers |
| `jobs.create(body, { idempotencyKey? })` | Always sends an `Idempotency-Key` (generated if not given); a retry answers the same job |
| `jobs.get/list/cancel/wait/screenshot` | `wait` polls until finished (or `until`); `screenshot` returns the bytes |
| `ApiError` | `status`, `code`, `message`, `requestId`, `retryable`, `details` (the API's error envelope) |
| `verifyWebhook(secret, headers, rawBody)`, `parseWebhook(rawBody)` | Standard Webhooks signature check (constant time, 5-minute tolerance); deduplicate on `webhook-id` |
| `newDebugCapability()`, `debugEndpoint(detail)`, `connectPlaywright(chromium, endpoint, secret)` | Debugging sessions ([Playwright](../../docs/automation/playwright.md)) |

Examples: [examples/](examples/README.md). Tests: `pnpm --filter @pb/sdk test` (unit) and the API's `test/sdk.test.ts`
(the SDK against the real API); the Playwright compatibility test runs when `PB_BRIDGE_BIN` and `PB_CHROME_PATH` are set.
