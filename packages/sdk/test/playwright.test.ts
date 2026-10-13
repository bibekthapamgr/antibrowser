/**
 * Playwright compatibility (milestone 10): a real Chromium started with the protected DevTools pipe and the loopback
 * broker exactly as a debugging job does (crates/devtools/examples/bridge.rs), driven by playwright-core's
 * connectOverCDP through the SDK. Runs when PB_BRIDGE_BIN (the built example) and PB_CHROME_PATH are set (CI: the
 * Rust job on Linux); otherwise skipped.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { describe, expect, it } from 'vitest';
import { connectPlaywright, newDebugCapability } from '../src/index.ts';

const bin = process.env.PB_BRIDGE_BIN;
const chrome = process.env.PB_CHROME_PATH;

async function startBridge(sha256: string): Promise<{ child: ChildProcess; endpoint: string }> {
  const child = spawn(bin as string, [], {
    env: { ...process.env, PB_CAPABILITY_SHA256: sha256 },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const lines = createInterface({ input: child.stdout as NodeJS.ReadableStream });
  const endpoint = await new Promise<string>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('the bridge did not start')), 60_000);
    lines.once('line', (l) => {
      clearTimeout(t);
      resolve((JSON.parse(l) as { endpoint: string }).endpoint);
    });
    child.once('exit', (code) => reject(new Error(`the bridge exited (${code})`)));
  });
  return { child, endpoint };
}

describe.skipIf(!bin || !chrome)('Playwright through the authenticated broker', () => {
  it('drives the job’s session with the capability, and is refused without it', async () => {
    const { chromium } = await import('playwright-core');
    const cap = await newDebugCapability();
    const { child, endpoint } = await startBridge(cap.sha256);
    try {
      expect(endpoint).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/cdp\/job_/);
      await expect(chromium.connectOverCDP(endpoint, { timeout: 5000 })).rejects.toThrow();
      await expect(
        chromium.connectOverCDP(endpoint, {
          timeout: 5000,
          headers: { authorization: 'Bearer pbcap_wrong' },
        }),
      ).rejects.toThrow();

      const browser = await connectPlaywright(chromium, endpoint, cap.secret);
      const context = browser.contexts()[0];
      expect(context).toBeDefined();
      const page = context?.pages()[0] ?? (await context?.newPage());
      if (!page) throw new Error('no page');
      await page.setContent('<title>Compat</title><h1 id="greeting">Hello from the job</h1>');
      expect(await page.title()).toBe('Compat');
      expect(await page.locator('#greeting').textContent()).toBe('Hello from the job');
      // The session says it is automated (nothing hides it from websites).
      expect(await page.evaluate('navigator.webdriver === true')).toBe(true);
      const png = await page.screenshot();
      expect([...png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
      // Disconnecting leaves the job's browser running; the script can connect again.
      await browser.close();
      const again = await connectPlaywright(chromium, endpoint, cap.secret);
      expect(again.contexts().length).toBeGreaterThan(0);
      await again.close();
    } finally {
      child.stdin?.end();
      await new Promise((r) => child.once('exit', r));
    }
  });
});
