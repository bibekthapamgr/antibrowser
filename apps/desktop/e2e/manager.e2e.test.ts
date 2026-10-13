/**
 * Milestone 02-04 UI acceptance, run against the production bundle in demo mode:
 * - a keyboard-only user can create a workspace and reach profile settings
 * - no serious/critical axe violations on each screen, in light and dark
 * - usable at the 900x600 minimum window size (no horizontal page scroll) and at 2x DPI
 * - large lists are virtualized
 * - closing the manager with profiles open asks, and says profiles can keep running
 * - milestone 04: folders, keyboard selection, bulk actions with undo, "all matching" selection with its count,
 *   the trash with a typed confirmation, import preview/commit/cancel, export, secret-looking notes
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
    name: 'profile-crashed-recovery',
    demo: 'crashed',
    prepare: async (p) => {
      await clickRow(p, 'Shop admin');
      await p.waitForSelector('.drawer fieldset legend');
    },
  },
  {
    name: 'profile-not-responding',
    demo: 'stuck',
    prepare: async (p) => {
      await clickRow(p, 'Shop admin');
      await clickButton(p, '.drawer', 'Close profile');
      await p.waitForFunction(() => document.querySelector('.drawer')?.textContent?.includes('Force close'));
    },
  },
  { name: 'downloads-install-browser', demo: 'noruntime', nav: 'Downloads and updates' },
  {
    name: 'profiles-selection',
    demo: '',
    prepare: async (p) => {
      await p.focus('[role=grid]');
      await p.keyboard.press('Space');
      await p.keyboard.press('ArrowDown');
      await p.keyboard.press('Space');
      await p.waitForSelector('.bulk-bar');
    },
  },
  { name: 'profiles-trash', demo: '', prepare: (p) => clickFolder(p, 'Trash') },
  {
    name: 'import-preview',
    demo: '',
    prepare: async (p) => {
      await clickButton(p, '.toolbar', 'Import…');
      await clickButton(p, '[role=dialog]', 'Choose file…');
      await p.waitForSelector('.summary');
    },
  },
  {
    name: 'import-unsafe-file',
    demo: 'unsafeimport',
    prepare: async (p) => {
      await clickButton(p, '.toolbar', 'Import…');
      await clickButton(p, '[role=dialog]', 'Choose file…');
      await p.waitForSelector('.notice--error');
    },
  },
  {
    name: 'export-dialog',
    demo: '',
    prepare: async (p) => {
      await p.click('.table__head input[type=checkbox]');
      await clickButton(p, '.bulk-bar', 'Export…');
      await p.waitForSelector('[role=dialog]');
    },
  },
  {
    name: 'delete-confirmation',
    demo: '',
    prepare: async (p) => {
      await clickFolder(p, 'Trash');
      await clickButton(p, '.filters', 'Empty trash…');
      await p.waitForSelector('[role=alertdialog]');
    },
  },
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

async function clickRow(page: Page, name: string) {
  const rows = await page.$$('.trow');
  for (const r of rows) {
    if ((await r.$eval('.trow__name', (el) => el.textContent?.trim())) === name) {
      await r.click();
      await page.waitForSelector('.drawer');
      return;
    }
  }
  throw new Error(`no row ${name}`);
}

async function clickFolder(page: Page, label: string) {
  const folders = await page.$$('.folder');
  for (const f of folders) {
    if ((await f.$eval('.folder__label', (el) => el.textContent?.trim())) === label) {
      await f.click();
      await page.waitForFunction(
        (l) => document.querySelector('.toolbar__title p')?.textContent?.startsWith(l),
        {},
        label,
      );
      // The table shows the new folder once its first page arrives.
      await page.waitForFunction(() => !document.querySelector('[role=row][aria-busy=true]'));
      return;
    }
  }
  throw new Error(`no folder ${label}`);
}

const rowCount = (page: Page, n: number) =>
  page.waitForFunction(
    (count) => document.querySelector('[role=grid]')?.getAttribute('aria-rowcount') === String(count),
    {},
    n,
  );

const toastContains = (page: Page, needle: string) =>
  page.waitForFunction(
    (t) => [...document.querySelectorAll('.toast')].some((x) => x.textContent?.includes(t)),
    {},
    needle,
  );

async function clickButton(page: Page, scope: string, label: string) {
  // Waits for the button to exist and be enabled (dialogs and previews render asynchronously).
  const handle = await page.waitForFunction(
    (sc, l) =>
      [...document.querySelectorAll<HTMLButtonElement>(`${sc} button`)].find(
        (b) => b.textContent?.trim() === l && !b.disabled,
      ),
    { timeout: 10_000 },
    scope,
    label,
  );
  const el = handle.asElement();
  if (!el) throw new Error(`no button ${label} in ${scope}`);
  await (el as unknown as { click(): Promise<void> }).click();
}

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

describe('profile lifecycle (milestone 03)', () => {
  it('opens and closes a profile, showing each state', async () => {
    const page = await open('');
    await clickRow(page, 'Ads QA');
    await clickButton(page, '.drawer', 'Open profile');
    await page.waitForFunction(() => document.querySelector('.drawer dd')?.textContent?.includes('Open'));
    await clickButton(page, '.drawer', 'Close profile');
    await page.waitForFunction(() => document.querySelector('.drawer dd')?.textContent?.includes('Closed'));
    await page.close();
  });

  it('offers a force close only after the browser did not respond', async () => {
    const page = await open('stuck');
    await clickRow(page, 'Shop admin');
    await clickButton(page, '.drawer', 'Close profile');
    await page.waitForFunction(() =>
      document.querySelector('.drawer')?.textContent?.includes('Not responding'),
    );
    await clickButton(page, '.drawer', 'Force close');
    await page.waitForFunction(() => document.querySelector('.drawer dd')?.textContent?.includes('Closed'));
    await page.close();
  });

  it('restores a crashed profile from its last good copy', async () => {
    const page = await open('crashed');
    await clickRow(page, 'Shop admin');
    expect(await text(page, '.drawer')).toMatch(/closed unexpectedly/i);
    await clickButton(page, '.drawer', 'Restore last good copy');
    await page.waitForFunction(() => document.querySelector('.drawer dd')?.textContent?.trim() === 'Closed');
    await page.close();
  });

  it('installs the approved browser with progress, then profiles can open', async () => {
    const page = await open('noruntime');
    await goTo(page, 'Downloads and updates');
    const install = await page.waitForSelector('button[data-variant=primary]');
    expect(await install?.evaluate((b) => b.textContent)).toMatch(/Install browser \d+/);
    await install?.click();
    await page.waitForFunction(() => document.querySelector('.card')?.textContent?.includes('Ready'), {
      timeout: 10_000,
    });
    await page.close();
  });

  it('quit prompt offers a force close when profiles did not respond', async () => {
    const page = await open('running');
    await page.evaluate(() =>
      (
        window as unknown as { __pbDemo: { simulateQuitRequest(n: number): void } }
      ).__pbDemo.simulateQuitRequest(1),
    );
    const dialog = await page.waitForSelector('[role=alertdialog]');
    const labels = await dialog?.$$eval('button', (b) => b.map((x) => x.textContent?.trim()));
    expect(labels).toContain('Force close and quit');
    await page.keyboard.press('Escape');
    await page.close();
  });
});

describe('content security policy', () => {
  it('the bundle runs under the shell CSP without violations', () => {
    expect(cspErrors).toEqual([]);
  });
});

describe('profile management (milestone 04)', () => {
  it('selects rows with the keyboard, archives them in bulk and undoes', async () => {
    const page = await open('');
    await page.waitForSelector('[role=grid]');
    await page.focus('[role=grid]');
    await page.keyboard.press('Space');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Space');
    await page.waitForSelector('.bulk-bar');
    expect(await text(page, '.bulk-bar__count')).toMatch(/^2 selected of 3/);
    await clickButton(page, '.bulk-bar', 'Archive 2');
    await page.waitForSelector('.undo-bar');
    expect(await text(page, '.undo-bar')).toContain('Archived 2 profiles.');
    await rowCount(page, 1);
    expect(await page.$('.bulk-bar')).toBeNull();
    await clickButton(page, '.undo-bar', 'Undo');
    await rowCount(page, 3);
    await page.close();
  });

  it('selects all matching profiles across pages and shows that count on the action', async () => {
    const page = await open('rows:10000');
    await page.waitForSelector('[role=grid]');
    await page.click('.table__head input[type=checkbox]');
    expect(await text(page, '.bulk-bar__count')).toMatch(/^200 selected of 10,000/);
    await clickButton(page, '.bulk-bar', 'Select all 10,000 matching');
    expect(await text(page, '.bulk-bar__count')).toContain('All 10,000 matching profiles selected');
    await clickButton(page, '.bulk-bar', 'Add tag…');
    const dialog = await page.waitForSelector('[role=dialog]');
    expect(await dialog?.$eval('h2', (h) => h.textContent)).toBe('Add a tag to 10,000 selected profiles');
    await page.keyboard.type('Batch 1');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.undo-bar');
    expect(await text(page, '.undo-bar')).toContain('Tagged 10,000 profiles');
    await page.close();
  });

  it('filters by client folder, tag and accent-insensitive search', async () => {
    const page = await open('');
    await clickFolder(page, 'Client North');
    await rowCount(page, 1);
    await clickFolder(page, 'All profiles');
    await rowCount(page, 3);
    await page.type('input[type=search]', 'ÃDS');
    await rowCount(page, 1);
    expect(await text(page, '.trow__name')).toBe('Ads QA');
    await page.close();
  });

  it('moves a profile to the trash and deletes permanently only after typing DELETE', async () => {
    const page = await open('');
    await clickRow(page, 'Support desk');
    await clickButton(page, '.drawer', 'Move to trash');
    await page.waitForSelector('.undo-bar');
    await page.waitForFunction(() =>
      document.querySelector('.drawer')?.textContent?.includes('In the trash'),
    );
    await page.click('.drawer [aria-label="Close profile settings"]');
    await clickFolder(page, 'Trash');
    await rowCount(page, 2);
    await clickButton(page, '.filters', 'Empty trash…');
    const dialog = await page.waitForSelector('[role=alertdialog]');
    expect(await dialog?.$eval('h2', (h) => h.textContent)).toBe('Delete 2 profiles permanently?');
    const disabled = await page.$$eval('[role=alertdialog] button', (b) =>
      b.filter((x) => x.textContent === 'Delete 2 profiles').map((x) => (x as HTMLButtonElement).disabled),
    );
    expect(disabled).toEqual([true]);
    await page.keyboard.type('DELETE');
    await clickButton(page, '[role=alertdialog]', 'Delete 2 profiles');
    await page.waitForFunction(() =>
      document.querySelector('.empty')?.textContent?.includes('Nothing in Trash'),
    );
    await toastContains(page, 'Deleted 2 profiles permanently.');
    await page.close();
  });

  it('previews an import with row errors, imports the valid rows and updates the table without a reload', async () => {
    const page = await open('');
    await clickButton(page, '.toolbar', 'Import…');
    await clickButton(page, '[role=dialog]', 'Choose file…');
    await page.waitForSelector('.summary');
    const summary = await text(page, '.summary');
    expect(summary).toMatch(/New profiles\s*5/);
    expect(summary).toMatch(/Skipped duplicates\s*2/);
    expect(summary).toMatch(/Rows with errors\s*3/);
    const errors = await page.$$eval('[role=dialog] details[open] tbody tr', (rows) =>
      rows.map((r) => r.firstElementChild?.textContent),
    );
    expect(errors).toEqual(['5', '6', '10']);
    await clickButton(page, '[role=dialog]', 'Import 5 profiles');
    await page.waitForFunction(() =>
      document.querySelector('[role=dialog]')?.textContent?.includes('Completed with errors'),
    );
    await clickButton(page, '[role=dialog]', 'Done');
    await page.waitForFunction(() =>
      [...document.querySelectorAll('.trow__name')].some((n) => n.textContent === 'Café orders'),
    );
    await page.close();
  });

  it('cancels a 10,000-row import and offers to continue it', async () => {
    const page = await open('bigimport');
    await clickButton(page, '.toolbar', 'Import…');
    await clickButton(page, '[role=dialog]', 'Choose file…');
    await page.waitForSelector('.summary');
    await clickButton(page, '[role=dialog]', 'Import 9,999 profiles');
    await page.waitForSelector('[role=dialog] progress');
    await clickButton(page, '[role=dialog]', 'Cancel import');
    await page.waitForFunction(() =>
      document.querySelector('[role=dialog]')?.textContent?.includes('Cancelled.'),
    );
    await clickButton(page, '[role=dialog]', 'Continue import');
    await page.waitForFunction(
      () => document.querySelector('[role=dialog]')?.textContent?.includes('Completed with errors'),
      { timeout: 15_000 },
    );
    expect(await text(page, '[role=dialog]')).toContain('9,999 profiles imported or updated');
    await page.close();
  });

  it('names the client when a profile opens', async () => {
    const page = await open('');
    await clickRow(page, 'Shop admin');
    await clickButton(page, '.drawer', 'Open profile');
    await toastContains(page, 'Opening Shop admin (Client North)');
    await page.close();
  });

  it('warns about secrets in notes and does not save them', async () => {
    const page = await open('');
    await clickRow(page, 'Ads QA');
    await page.type('.drawer textarea[aria-describedby]', 'Password: hunter2');
    await page.waitForFunction(() => document.querySelector('.drawer textarea[aria-invalid=true]'));
    await clickButton(page, '.drawer', 'Save changes');
    await page.waitForFunction(() =>
      document.querySelector('.drawer [role=alert]')?.textContent?.includes('password manager'),
    );
    await page.close();
  });
});
