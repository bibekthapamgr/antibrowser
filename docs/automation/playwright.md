# Playwright debugging sessions

A debugging session hands a running profile's browser session to a Playwright script **on the computer running the
job**, for authorized testing of sites you own or may test. It is powerful — the script controls the whole session,
including its sign-ins — so it needs three separate approvals:

1. **Permission**: the `automation:debug` scope on the token (only owners and admins can hand it out) and the
   `automation.debug` permission of the token's member.
2. **The computer's consent**: Settings → Automation on this computer → *Allow Playwright connections* (off by
   default, confirmed with a warning, recorded in the computer's activity log). The server can neither turn it on nor
   see more than whether it is on. Turning it off ends open debugging sessions.
3. **A capability**: the requester generates a secret and sends only its SHA-256 with the job. The computer accepts a
   connection only with that secret; the server never sees it.

## How it works
```ts
import { chromium } from 'playwright-core';
import { connectPlaywright, debugEndpoint, newDebugCapability, ProjectBrowser } from '@pb/sdk';

const cap = await newDebugCapability();                       // { secret: 'pbcap_…', sha256 }
const { job } = await pb.jobs.create({
  profile_id: 'prf_…', agent_id: 'agt_…',                    // the computer you are on
  steps: [], keep_open_minutes: 30, debug: { capability_sha256: cap.sha256 },
});
const ready = await pb.jobs.wait(job.id, { until: (d) => debugEndpoint(d) !== null || d.job.state !== 'RUNNING' && d.job.state !== 'QUEUED' && d.job.state !== 'CLAIMED' });
const browser = await connectPlaywright(chromium, debugEndpoint(ready)!, cap.secret);
// … your steps on sites you are authorized to test …
await browser.close();            // disconnects only
await pb.jobs.cancel(job.id);     // closes the profile; its closing backup uploads
```
Full example: [packages/sdk/examples/playwright-debug.ts](../../packages/sdk/examples/playwright-debug.ts).

On the computer, the job opens the profile under its session lease (nobody else can have it open), runs any steps,
then its `debug_bridge` step starts a **loopback broker** and reports its address,
`ws://127.0.0.1:<random port>/cdp/<job id>`. The broker:
- listens on 127.0.0.1 only and accepts connections from loopback peers only;
- requires `Host: 127.0.0.1:<port>` or `localhost:<port>` (no DNS rebinding) and **refuses any request with an
  `Origin` header** — browsers always send one, so no web page can connect, even one running on this computer;
- requires `Authorization: Bearer <secret>` whose SHA-256 equals the job's capability digest (constant-time compare);
- must receive the first connection within 5 minutes, accepts one client at a time, and stops when the job stops holding
  the profile (canceled, its time is up, or the browser is closed);
- relays the client's DevTools messages over the job's protected pipe (the browser itself never listens on a port),
  never lets a client use the id range of the app's own commands, and counts relayed commands (the count, not their
  content, is written to the computer's activity log with the job id).

The browser was launched with `--enable-automation`, so websites see `navigator.webdriver === true` and Chromium shows
that the browser is being controlled.

## Compatibility
Tested with `playwright-core` 1.63 (`chromium.connectOverCDP` with an `Authorization` header) against the broker and
Chromium's headless shell in CI (`packages/sdk/test/playwright.test.ts`, using the `bridge` example of
`crates/devtools`): a connection without the secret is refused; with it, the browser context and the job's page are
visible, locators, evaluation and screenshots work, `navigator.webdriver` is true, and `browser.close()` only
disconnects (a second connection works). Playwright features that need their own browser launch (persistent contexts,
`launch()` options, tracing of a launch) do not apply: the browser belongs to the job.
