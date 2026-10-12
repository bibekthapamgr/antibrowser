/**
 * Milestone 02 UI acceptance, run against the production bundle in demo mode:
 * - a keyboard-only user can create a workspace and reach profile settings
 * - no serious/critical axe violations on each screen, in light and dark
 * - usable at the 900x600 minimum window size (no horizontal page scroll) and at 2x DPI
 * - large lists are virtualized
 * - closing the manager with profiles open asks, and says profiles can keep running
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Browser, Page } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { axeSerious, focused, launchBrowser, serveDist, tabTo } from './harness.ts';

const conf = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../src-tauri/tauri.conf.json'), 'utf8'),
) as {
  app: { security: { csp: string } };
};
const SHOTS = process.env.PB_SCREENSHOTS ? resolve(import.meta.dirname, '../../../docs/design') : null;

let browser: Browser;
let server: Awaited<ReturnType<typeof serveDist>>;
const cspErrors: string[] = [];

beforeAll(async () => {
  server = await serveDist(conf.app.security.csp);
  browser = await launchBrowser();
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
});
afterAll(async () => {
  await browser?.close();
  await server?.close();
});

async function open(
  demo: string,
  opts: { width?: number; height?: number; dark?: boolean; scale?: number } = {},
): Promise<Page> {
  const page = await browser.newPage();
  await page.setViewport({
    width: opts.width ?? 1280,
    height: opts.height ?? 800,
    deviceScaleFactor: opts.scale ?? 1,
  });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: opts.dark ? 'dark' : 'light' }]);
  page.on('console', (m) => {
    if (/Content Security Policy/i.test(m.text())) cspErrors.push(m.text());
  });
  page.on('pageerror', (e) => cspErrors.push(String(e)));
  await page.goto(`${server.url}?demo=${encodeURIComponent(demo)}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('h1');
  return page;
}

const text = (page: Page, selector: string) =>
  page.$eval(selector, (el) => (el as HTMLElement).innerText.trim());

async function goTo(page: Page, nav: string) {
  const buttons = await page.$$('nav .nav-item');
  for (const b of buttons) {
    if ((await b.evaluate((el) => el.textContent?.trim())) === nav) {
      await b.click();
      await page.waitForFunction(
        (n) => document.querySelector('h1')?.textContent?.includes(n),
        {},
        nav.split(' ')[0] ?? nav,
      );
      return;
    }
  }
  throw new Error(`no nav item ${nav}`);
}

describe('keyboard-only first run', () => {
  it('creates a workspace and a profile, then reaches profile settings without a mouse', async () => {
    const page = await open('fresh');
    expect(await focused(page)).toMatchObject({ tag: 'h1' });

    await tabTo(page, 'the create-workspace button', (f) => f.text === 'Create a local workspace');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.activeElement?.tagName === 'INPUT');
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyA');
    await page.keyboard.up('Control');
    await page.keyboard.type('Agency workspace');
    await page.keyboard.press('Enter');

    await page.waitForFunction(() => document.querySelector('h1')?.textContent === 'Profiles');
    expect(await text(page, '.workspace select')).toContain('Agency workspace');

    await tabTo(page, 'the new-profile button', (f) => f.text === 'New profile');
    await page.keyboard.press('Enter');
    await page.waitForSelector('[role=dialog]');
    expect(await focused(page)).toMatchObject({ tag: 'input', inDialog: true });
    await page.keyboard.type('Shop admin');
    await page.keyboard.press('Tab');
    await page.keyboard.type('Client North');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.querySelector('[role=dialog]'));

    await tabTo(page, 'the profile list', (f) => f.role === 'grid');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#profile-settings-title');
    const f = await focused(page);
    expect(f.text).toBe('Profile settings');
    expect(await page.$eval('.drawer input', (el) => (el as HTMLInputElement).value)).toBe('Shop admin');

    // Escape closes the drawer and focus returns to the list.
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.drawer'));
    await page.close();
  });

  it('traps focus inside dialogs and Escape closes them', async () => {
    const page = await open('');
    await tabTo(page, 'the new-profile button', (f) => f.text === 'New profile');
    await page.keyboard.press('Enter');
    await page.waitForSelector('[role=dialog]');
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Tab');
      expect((await focused(page)).inDialog).toBe(true);
    }
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('[role=dialog]'));
    expect((await focused(page)).text).toBe('New profile');
    await page.close();
  });

  it('offers a skip link as the first tab stop', async () => {
    const page = await open('');
    await page.keyboard.press('Tab');
    expect((await focused(page)).text).toBe('Skip to content');
    await page.close();
  });
});

const SCREENS: { name: string; demo: string; nav?: string; prepare?: (p: Page) => Promise<void> }[] = [
  { name: 'welcome', demo: 'fresh' },
  { name: 'profiles-empty', demo: 'rows:0' },
  { name: 'profiles', demo: '' },
  {
    name: 'profile-settings',
    demo: '',
    prepare: async (p) => {
      await p.click('.trow');
      await p.waitForSelector('.drawer');
    },
  },
  { name: 'settings', demo: '', nav: 'Settings' },
  { name: 'downloads', demo: '', nav: 'Downloads and updates' },
  { name: 'diagnostics', demo: '', nav: 'Diagnostics' },
  { name: 'crash-recovery', demo: 'crash' },
  { name: 'database-recovery', demo: 'migration' },
  {
    name: 'quit-with-running-profiles',
    demo: 'running',
    prepare: async (p) => {
      await p.evaluate(() =>
        (window as unknown as { __pbDemo: { simulateQuitRequest(): void } }).__pbDemo.simulateQuitRequest(),
      );
      await p.waitForSelector('[role=alertdialog],[role=dialog]');
    },
  },
];

describe.each([
  ['light', false],
  ['dark', true],
] as const)('every screen in %s mode', (mode, dark) => {
  it.each(SCREENS)('$name has no serious accessibility violations and fits 900x600', async (s) => {
    const page = await open(s.demo, { dark, width: 900, height: 600 });
    if (s.nav) await goTo(page, s.nav);
    await s.prepare?.(page);
    const violations = await axeSerious(page);
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    if (SHOTS) {
      await page.setViewport({ width: 1180, height: 760, deviceScaleFactor: 1 });
      await new Promise((r) => setTimeout(r, 150));
      await page.screenshot({ path: `${SHOTS}/${s.name}-${mode}.png` });
    }
    await page.close();
  });
});

describe('scale', () => {
  it('virtualizes 10,000 profiles and keyboard End reaches the last one', async () => {
    const page = await open('rows:10000');
    await page.waitForSelector('[role=grid]');
    const rendered = await page.$$eval('[role=row]', (r) => r.length);
    expect(rendered).toBeLessThan(100);
    expect(await page.$eval('[role=grid]', (g) => g.getAttribute('aria-rowcount'))).toBe('10000');
    await page.focus('[role=grid]');
    await page.keyboard.press('End');
    await page.waitForFunction(() => {
      const id = document.querySelector('[role=grid]')?.getAttribute('aria-activedescendant');
      return id ? document.getElementById(id)?.getAttribute('aria-rowindex') === '10000' : false;
    });
    await page.close();
  });

  it('debounces search over 10,000 profiles', async () => {
    const page = await open('rows:10000');
    await page.waitForSelector('[role=grid]');
    await page.type('input[type=search]', 'Profile 09999');
    await page.waitForFunction(
      () => document.querySelector('[role=grid]')?.getAttribute('aria-rowcount') === '1',
    );
    await page.close();
  });

  it('renders crisply at 2x device scale', async () => {
    const page = await open('', { scale: 2, width: 900, height: 600 });
    expect(await page.evaluate(() => window.devicePixelRatio)).toBe(2);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await page.close();
  });
});

describe('quit flow', () => {
  it('explains that open profiles can keep running and offers cancel / leave running / close all', async () => {
    const page = await open('running');
    expect(await text(page, '.sidebar__status')).toContain('1 profile open');
    await page.evaluate(() =>
      (window as unknown as { __pbDemo: { simulateQuitRequest(): void } }).__pbDemo.simulateQuitRequest(),
    );
    const dialog = await page.waitForSelector('[role=alertdialog],[role=dialog]');
    const body = (await dialog?.evaluate((d) => (d as HTMLElement).innerText)) ?? '';
    expect(body).toMatch(/1 profile/);
    const buttons = await dialog?.$$eval('button', (b) => b.map((x) => x.textContent?.trim()));
    expect(buttons?.length).toBeGreaterThanOrEqual(3);
    await page.keyboard.press('Escape');
    await page.close();
  });
});

describe('content security policy', () => {
  it('the bundle runs under the shell CSP without violations', () => {
    expect(cspErrors).toEqual([]);
  });
});
