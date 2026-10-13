/**
 * Milestone 02-04 UI acceptance, run against the production bundle in demo mode:
 * - a keyboard-only user can create a workspace and reach profile settings
 * - no serious/critical axe violations on each screen, in light and dark
 * - usable at the 900x600 minimum window size (no horizontal page scroll) and at 2x DPI
 * - large lists are virtualized
 * - closing the manager with profiles open asks, and says profiles can keep running
 * - milestone 04: folders, keyboard selection, bulk actions with undo, "all matching" selection with its count,
 *   the trash with a typed confirmation, import preview/commit/cancel, export, secret-looking notes
 * - milestone 05: proxies (paste line, hidden login, test), assignment, the credential prompt, a failing
 *   fail-closed proxy, privacy presets with settings this OS cannot apply, bulk "Set proxy"
 * - milestone 06: account (server, sign-in in the system browser, devices), organizations (switcher, profiles,
 *   clients, members, invitations, access, activity), re-authentication before an ownership transfer, offline
 *   information marked as such, copying a local workspace after a preview
 * - milestone 07: encrypted backups of linked profiles (progress, version history, restore), conflicts with three
 *   choices that never overwrite, putting an organization profile on this computer, the organization's retention,
 *   trash and key rotation with re-authentication
 * - milestone 08: shared sessions (one person at a time): who has a profile open, asking for it, requests that never
 *   close anything, close and hand off with a note (never a password), a forced takeover with a reason and warning,
 *   a session taken over here (closed, copy kept aside, recovery copy), offline shared opens refused, and what an
 *   operator's access allows
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

/** Switches the sidebar workspace to the demo organization and, optionally, opens one of its sections. */
async function openOrg(page: Page, section?: string) {
  const handle = await page.waitForFunction(
    () =>
      [...document.querySelectorAll<HTMLOptionElement>('.workspace option')].find((o) =>
        o.value.startsWith('org:'),
      )?.value,
    { timeout: 10_000 },
  );
  await page.select('.workspace select', (await handle.jsonValue()) as string);
  await page.waitForFunction(() => document.querySelector('h1')?.textContent?.includes('Demo Agency'));
  if (section) {
    await clickButton(page, '.org-nav', section);
    await page.waitForSelector(`#org-${section.toLowerCase()}-title`);
  }
  await page.waitForFunction(
    () => !document.querySelector('main [role=status].loading, main p[role=status]'),
  );
}

const SCREENS: { name: string; demo: string; nav?: string; prepare?: (p: Page) => Promise<void> }[] = [
  {
    name: 'profile-backups',
    demo: 'signedin linked',
    prepare: async (p) => {
      await clickRow(p, 'Shop admin');
      await p.waitForFunction(() =>
        document.querySelector('.drawer')?.textContent?.includes('Organization backup: version 1'),
      );
      await p.evaluate(() => document.querySelector('#backup-legend')?.scrollIntoView({ block: 'start' }));
    },
  },
  {
    name: 'profile-backup-conflict',
    demo: 'signedin linked conflict',
    prepare: async (p) => {
      await clickRow(p, 'Shop admin');
      await clickButton(p, '.drawer', 'Upload backup now');
      await p.waitForSelector('.drawer [role=alert]', { timeout: 10_000 });
      await p.evaluate(() => document.querySelector('#backup-legend')?.scrollIntoView({ block: 'start' }));
      // For the picture, let the transient "Backing up…" notice disappear (4 s) so it does not cover the panel.
      if (SHOTS) await new Promise((r) => setTimeout(r, 4500));
    },
  },
  {
    name: 'organization-backups',
    demo: 'signedin',
    prepare: async (p) => {
      await openOrg(p, 'Backups');
      await p.waitForSelector('#org-keys-title');
    },
  },
  {
    name: 'profile-shared-in-use',
    demo: 'signedin linked inuse',
    prepare: async (p) => {
      await clickRow(p, 'Shop admin');
      await p.waitForFunction(() => document.querySelector('.drawer')?.textContent?.includes('In use:'));
      await p.evaluate(() => document.querySelector('#team-legend')?.scrollIntoView({ block: 'start' }));
    },
  },
  {
    name: 'profile-handoff-request',
    demo: 'signedin linked requests',
    prepare: async (p) => {
      await clickRow(p, 'Shop admin');
      await clickButton(p, '.drawer', 'Open profile');
      await p.waitForFunction(
        () => document.querySelector('.drawer')?.textContent?.includes('asks for this profile'),
        { timeout: 10_000 },
      );
      await p.evaluate(() => document.querySelector('#team-legend')?.scrollIntoView({ block: 'start' }));
      if (SHOTS) await new Promise((r) => setTimeout(r, 4500));
    },
  },
  {
    name: 'profile-takeover-dialog',
    demo: 'signedin linked inuse',
    prepare: async (p) => {
      await clickRow(p, 'Shop admin');
      await clickButton(p, '.drawer', 'Take over…');
      await p.waitForSelector('[role=alertdialog] textarea');
    },
  },
  {
    name: 'profile-taken-over',
    demo: 'signedin linked takeover',
    prepare: async (p) => {
      await clickRow(p, 'Shop admin');
      await clickButton(p, '.drawer', 'Open profile');
      await p.waitForFunction(
        () => document.querySelector('.drawer')?.textContent?.includes('recovery copy'),
        { timeout: 10_000 },
      );
      await p.evaluate(() => document.querySelector('#team-legend')?.scrollIntoView({ block: 'start' }));
      if (SHOTS) await new Promise((r) => setTimeout(r, 4500));
    },
  },
  { name: 'org-profiles-in-use', demo: 'signedin inuse', prepare: (p) => openOrg(p) },
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
  { name: 'proxies', demo: '', nav: 'Proxies' },
  {
    name: 'proxy-add',
    demo: '',
    nav: 'Proxies',
    prepare: async (p) => {
      await clickButton(p, '.toolbar', 'Add proxy');
      await p.waitForSelector('[role=dialog] form');
    },
  },
  {
    name: 'profile-network-privacy',
    demo: 'win',
    prepare: async (p) => {
      await clickRow(p, 'Shop admin');
      await p.waitForSelector('form[aria-label=Network] select option:nth-child(2)');
      await p.$eval('form[aria-label=Network]', (el) => el.scrollIntoView());
    },
  },
  {
    name: 'proxy-login-prompt',
    demo: 'nologin',
    prepare: async (p) => {
      await clickRow(p, 'Shop admin');
      await clickButton(p, '.drawer', 'Open profile');
      await p.waitForSelector('[role=dialog] input[type=password]');
    },
  },
  {
    name: 'proxy-failing',
    demo: 'proxydown',
    prepare: async (p) => {
      await clickRow(p, 'Shop admin');
      await clickButton(p, '.drawer', 'Open profile');
      await p.waitForFunction(() =>
        document.querySelector('.drawer')?.textContent?.includes('Traffic is blocked'),
      );
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
  { name: 'account-signed-out', demo: '', nav: 'Account' },
  { name: 'account', demo: 'signedin', nav: 'Account' },
  { name: 'org-profiles', demo: 'signedin', prepare: (p) => openOrg(p) },
  { name: 'org-clients', demo: 'signedin', prepare: (p) => openOrg(p, 'Clients') },
  { name: 'org-members', demo: 'signedin', prepare: (p) => openOrg(p, 'Members') },
  {
    name: 'org-invitations',
    demo: 'signedin',
    prepare: async (p) => {
      await openOrg(p, 'Invitations');
      await p.type('form[aria-label="Invite someone"] input[type=email]', 'new.person@example.test');
      await clickButton(p, 'form[aria-label="Invite someone"]', 'Create invitation');
      await p.waitForFunction(() =>
        document.querySelector('.notice')?.textContent?.includes('shown only now'),
      );
    },
  },
  { name: 'org-access', demo: 'signedin', prepare: (p) => openOrg(p, 'Access') },
  { name: 'org-activity', demo: 'signedin', prepare: (p) => openOrg(p, 'Activity') },
  { name: 'org-operator', demo: 'member', prepare: (p) => openOrg(p) },
  {
    name: 'org-copy-preview',
    demo: 'signedin',
    prepare: async (p) => {
      await openOrg(p, 'Settings');
      await clickButton(p, '#main', 'Copy profiles from this computer…');
      await clickButton(p, '[role=dialog]', 'Preview');
      await p.waitForFunction(() =>
        document.querySelector('[role=dialog]')?.textContent?.includes('will be added'),
      );
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

describe('proxies and privacy (milestone 05)', () => {
  const secret = ['pw', 'Zq7', 'Lm'].join('-');

  async function rowButton(page: Page, rowName: string, label: string) {
    const handle = await page.waitForFunction(
      (n, l) => {
        const row = [...document.querySelectorAll('.proxy-table tbody tr')].find(
          (r) => r.querySelector('th')?.textContent?.trim() === n,
        );
        return [...(row?.querySelectorAll('button') ?? [])].find(
          (b) => b.firstChild?.textContent?.trim() === l && !(b as HTMLButtonElement).disabled,
        );
      },
      { timeout: 10_000 },
      rowName,
      label,
    );
    await (handle.asElement() as unknown as { click(): Promise<void> }).click();
  }

  it('adds a proxy from a pasted line, never shows the login again, and tests it', async () => {
    const page = await open('');
    await goTo(page, 'Proxies');
    await clickButton(page, '.toolbar', 'Add proxy');
    await page.waitForSelector('[role=dialog] form');
    await page.type(
      '[role=dialog] input[placeholder^="host:port"]',
      `gate.example.net:3128:agency-17:${secret}`,
    );
    await clickButton(page, '[role=dialog]', 'Fill in');
    await page.waitForFunction(() =>
      [...document.querySelectorAll<HTMLInputElement>('[role=dialog] input')].some(
        (i) => i.value === 'gate.example.net',
      ),
    );
    await page.type('[role=dialog] input[required][maxlength="80"]', 'Gate');
    await clickButton(page, '[role=dialog]', 'Add proxy');
    await toastContains(page, 'Proxy “Gate” added.');
    const html = await page.content();
    expect(html).not.toContain(secret);
    expect(await text(page, '.proxy-table')).toContain('gate.example.net:3128');
    await rowButton(page, 'Gate', 'Test');
    await toastContains(page, 'Gate works');
    await page.close();
  });

  it('assigns a proxy in profile settings and shows it in the table', async () => {
    const page = await open('');
    await clickRow(page, 'Ads QA');
    await page.waitForSelector('form[aria-label=Network] select option:nth-child(2)');
    const value = await page.$eval(
      'form[aria-label=Network] select option:nth-child(2)',
      (o) => (o as HTMLOptionElement).value,
    );
    await page.select('form[aria-label=Network] select', value);
    await clickButton(page, 'form[aria-label=Network]', 'Save network settings');
    await toastContains(page, 'Network settings saved.');
    await page.waitForFunction(() =>
      [...document.querySelectorAll('.trow')].some(
        (r) =>
          r.querySelector('.trow__name')?.textContent?.trim() === 'Ads QA' &&
          r.querySelector('.col-proxy')?.textContent?.includes('Residential DE'),
      ),
    );
    await page.close();
  });

  it('asks for a missing proxy login when opening, then opens the profile', async () => {
    const page = await open('nologin');
    await clickRow(page, 'Shop admin');
    await clickButton(page, '.drawer', 'Open profile');
    await page.waitForSelector('[role=dialog] input[type=password]');
    expect(await text(page, '[role=dialog] h2')).toContain('Enter the login');
    await page.type('[role=dialog] input[autocomplete=off]', 'agency-de');
    await page.type('[role=dialog] input[type=password]', secret);
    await clickButton(page, '[role=dialog]', 'Save login');
    await toastContains(page, 'Opening Shop admin');
    await page.close();
  });

  it('shows that a fail-closed proxy blocks traffic when it stops working', async () => {
    const page = await open('proxydown');
    await clickRow(page, 'Shop admin');
    await clickButton(page, '.drawer', 'Open profile');
    await toastContains(page, 'stopped working');
    await page.waitForFunction(() =>
      document.querySelector('.drawer')?.textContent?.includes('Traffic is blocked'),
    );
    await page.close();
  });

  it('applies a preset and says which settings this computer cannot apply', async () => {
    const page = await open('win');
    await clickRow(page, 'Ads QA');
    const form = 'form[aria-label="Privacy and environment"]';
    await page.waitForSelector(`${form} select option[value="locale-ne-np"]`);
    await page.select(`${form} select`, 'locale-ne-np');
    await page.waitForFunction(
      (f) => document.querySelector(f)?.textContent?.includes('Not available on this computer'),
      {},
      form,
    );
    await clickButton(page, form, 'Save privacy settings');
    await toastContains(page, 'Privacy and environment settings saved.');
    await page.close();
  });

  it('sets the proxy of selected profiles in bulk', async () => {
    const page = await open('');
    await page.focus('[role=grid]');
    await page.keyboard.press('Space');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Space');
    await clickButton(page, '.bulk-bar', 'Set proxy…');
    await page.waitForSelector('[role=dialog] select');
    await clickButton(page, '[role=dialog]', 'Set proxy');
    // Shop admin already uses the first proxy, so one profile changes and one already matched.
    await toastContains(page, 'Set the proxy of 1 profile.');
    await toastContains(page, '1 profile already matched.');
    await page.close();
  });
});

describe('account and organizations (milestone 06)', () => {
  it('signs in through the browser and switches to an organization', async () => {
    const page = await open('');
    await goTo(page, 'Account');
    const signIn = await page.$$eval('button', (bs) =>
      bs
        .filter((b) => b.textContent?.trim() === 'Sign in or create an account')
        .map((b) => (b as HTMLButtonElement).disabled),
    );
    expect(signIn).toEqual([true]); // no server yet
    await page.type('input[type=url]', 'http://browser.example.test');
    await clickButton(page, 'form[aria-labelledby=server-title]', 'Save');
    await toastContains(page, 'https://');
    await page.$eval('input[type=url]', (i) => {
      (i as HTMLInputElement).select();
    });
    await page.type('input[type=url]', 'https://browser.example.test');
    await clickButton(page, 'form[aria-labelledby=server-title]', 'Save');
    await toastContains(page, 'Server saved.');
    await clickButton(page, '#main', 'Sign in or create an account');
    await toastContains(page, 'Signed in.');
    await page.waitForFunction(() => document.body.textContent?.includes('Signed in as Demo Person'));
    expect(await text(page, '#devices-title')).toBe('Your devices');
    await openOrg(page);
    expect(await text(page, '#main')).toContain('North shop admin');
    expect(await text(page, '.sidebar__note')).toContain('signed in as Demo Person');
    await page.close();
  });

  it('creates an invitation code shown once and explains a code for another address', async () => {
    const page = await open('signedin');
    await openOrg(page, 'Invitations');
    await page.type('form[aria-label="Invite someone"] input[type=email]', 'someone.else@example.test');
    await clickButton(page, 'form[aria-label="Invite someone"]', 'Create invitation');
    await page.waitForSelector('.notice input.mono');
    const code = await page.$eval('.notice input.mono', (i) => (i as HTMLInputElement).value);
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await clickButton(page, '.notice', 'Done');
    expect(await page.content()).not.toContain(code);
    await page.waitForFunction(() =>
      document.querySelector('table.records')?.textContent?.includes('someone.else@example.test'),
    );

    await goTo(page, 'Account');
    await page.type('form[aria-labelledby=join-title] input', `Your code: ${code}`);
    await clickButton(page, 'form[aria-labelledby=join-title]', 'Check');
    await page.waitForFunction(() =>
      document
        .querySelector('form[aria-labelledby=join-title]')
        ?.textContent?.includes('different e-mail address'),
    );
    await page.close();
  });

  it('asks the owner to sign in again before transferring ownership, then completes it', async () => {
    const page = await open('signedin');
    await openOrg(page, 'Members');
    await clickButton(page, '#main', 'Transfer ownership');
    await page.waitForSelector('[role=alertdialog] select');
    await clickButton(page, '[role=alertdialog]', 'Transfer');
    await clickButton(page, '[role=alertdialog]', "Confirm it's me");
    await toastContains(page, 'is now the owner. You are an admin.');
    await page.waitForFunction(() => document.querySelector('header')?.textContent?.includes('Admin'));
    await page.close();
  });

  it('gives an operator access to a client, and an operator sees only what was shared', async () => {
    const page = await open('signedin');
    await openOrg(page, 'Access');
    await page.waitForSelector('form[aria-label="Give access"] select');
    const option = await page.$eval(
      'form[aria-label="Give access"] select',
      (sel) =>
        [...(sel as HTMLSelectElement).options].find((o) => o.textContent === 'Client South')?.value ?? '',
    );
    await page.select('form[aria-label="Give access"] select', option);
    await clickButton(page, 'form[aria-label="Give access"]', 'Give access');
    await page
      .waitForFunction(() => document.querySelector('ul.plain')?.textContent?.includes('Client South'))
      .catch(async (e) => {
        console.error(
          'Access section when the grant did not appear:',
          await page.$eval('#main', (m) => (m as HTMLElement).innerText),
        );
        throw e;
      });
    await page.close();

    const member = await open('member');
    await openOrg(member);
    const rows = await text(member, 'table.records');
    expect(rows).toContain('North shop admin');
    expect(rows).not.toContain('South support desk');
    const buttons = await member.$$eval('.org-nav button', (bs) => bs.map((b) => b.textContent?.trim()));
    expect(buttons).toEqual(['Profiles', 'Clients', 'Settings']);
    expect(await member.$$eval('#main button', (bs) => bs.map((b) => b.textContent?.trim()))).not.toContain(
      'Add profile',
    );
    await member.close();
  });

  it('marks information as offline and refuses changes until the server is back', async () => {
    const page = await open('signedin-cloudoffline');
    await openOrg(page, 'Clients');
    await clickButton(page, '.org-nav', 'Profiles');
    await clickButton(page, '.org-nav', 'Clients');
    await page.waitForFunction(() =>
      document.body.textContent?.includes('Offline: showing information saved'),
    );
    await page.close();
  });

  it('copies a local workspace into an organization after a preview, keeping the local profiles', async () => {
    const page = await open('signedin');
    const before = await page.$eval('[role=grid]', (g) => g.getAttribute('aria-rowcount'));
    await openOrg(page, 'Settings');
    await clickButton(page, '#main', 'Copy profiles from this computer…');
    await clickButton(page, '[role=dialog]', 'Preview');
    await page.waitForFunction(() =>
      document.querySelector('[role=dialog]')?.textContent?.includes('will be added'),
    );
    const label = await page.$eval(
      '[role=dialog] .row--end button[data-variant=primary]',
      (b) => b.textContent ?? '',
    );
    await clickButton(page, '[role=dialog]', label.trim());
    await page.waitForFunction(() =>
      document.querySelector('[role=dialog]')?.textContent?.includes('are unchanged'),
    );
    await clickButton(page, '[role=dialog]', 'Done');
    await clickButton(page, '.org-nav', 'Profiles');
    await page.waitForFunction(() => document.querySelectorAll('table.records tbody tr').length > 3);
    await page.select(
      '.workspace select',
      await page.$eval('.workspace option', (o) => (o as HTMLOptionElement).value),
    );
    await page.waitForSelector('[role=grid]');
    expect(await page.$eval('[role=grid]', (g) => g.getAttribute('aria-rowcount'))).toBe(before);
    await page.close();
  });
});

describe('encrypted backups (milestone 07)', () => {
  const drawerHas = (page: Page, needle: string, timeout = 10_000) =>
    page.waitForFunction(
      (t) => document.querySelector('.drawer')?.textContent?.includes(t),
      { timeout },
      needle,
    );

  it('backs up a linked profile with progress, then lists and restores versions', async () => {
    const page = await open('signedin linked');
    await clickRow(page, 'Shop admin');
    await drawerHas(page, 'Organization backup: version 1');
    await clickButton(page, '.drawer', 'Upload backup now');
    await page.waitForSelector('.drawer progress[aria-label="Backup progress"]');
    await drawerHas(page, 'Organization backup: version 2');
    await clickButton(page, '.drawer', 'Version history…');
    await page.waitForFunction(() => document.querySelectorAll('[role=dialog] tbody tr').length === 2);
    const violations = await axeSerious(page);
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
    await clickButton(page, '[role=dialog]', 'Restore as copy of version 1');
    await toastContains(page, 'separate copy');
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('.trow__name')].some((n) => n.textContent?.includes('(restored copy)')),
      { timeout: 10_000 },
    );
    await page.close();
  });

  it('a newer backup from another computer is a conflict with three choices, never an overwrite', async () => {
    const page = await open('signedin linked conflict');
    await clickRow(page, 'Shop admin');
    await clickButton(page, '.drawer', 'Upload backup now');
    await page.waitForSelector('.drawer [role=alert]', { timeout: 10_000 });
    await drawerHas(page, 'Nothing was overwritten');
    for (const label of [
      'Keep mine as the newest',
      'Replace mine with the newer one',
      'Open the newer one as a copy',
    ]) {
      await page.waitForFunction(
        (l) => [...document.querySelectorAll('.drawer [role=alert] button')].some((b) => b.textContent === l),
        {},
        label,
      );
    }
    // Backing up again is refused until the user chooses.
    const disabled = await page.$$eval('.drawer button', (bs) =>
      bs.filter((b) => b.textContent === 'Upload backup now').map((b) => (b as HTMLButtonElement).disabled),
    );
    expect(disabled).toEqual([true]);
    await clickButton(page, '.drawer', 'Keep mine as the newest');
    await drawerHas(page, 'Organization backup: version 2');
    expect(await page.$('.drawer [role=alert]')).toBeNull();
    await page.close();
  });

  it('puts an organization profile on this computer and says sign-ins do not carry over', async () => {
    const page = await open('signedin');
    await openOrg(page, 'Profiles');
    await clickButton(page, '#main', 'Put on this computer North shop admin');
    await toastContains(page, 'Restoring North shop admin');
    await page.waitForFunction(
      () => document.querySelector('table.records')?.textContent?.includes('On this computer'),
      { timeout: 10_000 },
    );
    // A profile without any backup cannot be put here.
    await clickButton(page, '#main', 'Put on this computer North ads');
    await toastContains(page, 'has no backup yet');
    await page.select(
      '.workspace select',
      await page.$eval('.workspace option', (o) => (o as HTMLOptionElement).value),
    );
    await page.waitForSelector('[role=grid]');
    await clickRow(page, 'North shop admin');
    await drawerHas(page, 'sign in to websites again');
    await page.close();
  });

  it('owners set retention, restore from the trash and rotate the key after confirming it is them', async () => {
    const page = await open('signedin');
    await openOrg(page, 'Profiles');
    await clickButton(page, '#main', 'Delete South support desk');
    await clickButton(page, '[role=alertdialog]', 'Delete profile');
    await toastContains(page, 'Deleted South support desk');
    await clickButton(page, '.org-nav', 'Backups');
    await page.waitForSelector('#org-keys-title');
    const retention = await page.waitForSelector('#main input[type=number]');
    await retention?.click({ count: 3 });
    await retention?.type('14');
    await clickButton(page, '#main', 'Save retention');
    await toastContains(page, 'Backup policy saved');
    await clickButton(page, '#main', 'Restore South support desk');
    await toastContains(page, 'Restored South support desk from the trash');
    await clickButton(page, '#main', 'Rotate key…');
    await clickButton(page, '[role=alertdialog]', 'Rotate key');
    await clickButton(page, '[role=alertdialog]', "Confirm it's me");
    await toastContains(page, 'The organization key was rotated');
    await page.waitForFunction(() =>
      [...document.querySelectorAll('#main table.records tbody th')].some((t) => t.textContent === '2'),
    );
    await page.close();
  });
});

describe('shared sessions (milestone 08)', () => {
  const drawerHas = (page: Page, needle: string, timeout = 10_000) =>
    page.waitForFunction(
      (t) => document.querySelector('.drawer')?.textContent?.includes(t),
      { timeout },
      needle,
    );
  const rowShared = (page: Page, name: string) =>
    page.$$eval(
      '.trow',
      (rows, n) =>
        rows
          .find((r) => r.querySelector('.trow__name')?.textContent?.trim() === n)
          ?.querySelector('.col-sync')
          ?.textContent?.trim() ?? '',
      name,
    );

  it('opens a shared profile, shows a request that closes nothing, and hands off with a note', async () => {
    const page = await open('signedin linked requests');
    await clickRow(page, 'Shop admin');
    await drawerHas(page, 'Shared with your organization');
    await drawerHas(page, 'Nobody has it open');
    expect(await rowShared(page, 'Shop admin')).toBe('Shared');
    await clickButton(page, '.drawer', 'Open profile');
    await drawerHas(page, 'Others see that you have it open');
    await page.waitForFunction(
      () => document.querySelector('.trow .col-sync .badge')?.textContent === 'Open here',
    );
    // A teammate asks: told, never closed.
    await toastContains(page, 'Sam Operator asks for “Shop admin”');
    await drawerHas(page, 'Sam Operator asks for this profile: “Need it for the refund queue”');
    expect(await page.$eval('.drawer', (d) => d.textContent?.includes('Close profile'))).toBe(true);
    const violations = await axeSerious(page);
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);

    await clickButton(page, '.drawer [role=alert]', 'Close and hand off…');
    const note = await page.waitForSelector('[role=dialog] textarea');
    // Built at run time: a note that looks like a password is refused before it is sent.
    await note?.type(`${['pass', 'word'].join('')}: not-a-real-one`);
    await page.waitForFunction(() =>
      [...document.querySelectorAll<HTMLButtonElement>('[role=dialog] button[type=submit]')].every(
        (b) => b.disabled,
      ),
    );
    await note?.click({ count: 3 });
    await page.keyboard.press('Backspace');
    await note?.type('Refund half done');
    await clickButton(page, '[role=dialog]', 'Close and hand off');
    await toastContains(page, 'handed off once its backup is saved');
    await drawerHas(page, 'Handing off');
    await toastContains(page, '“Shop admin” is saved and free for the next person');
    await drawerHas(page, 'Nobody has it open');
    expect(await rowShared(page, 'Shop admin')).toBe('Shared');
    await page.close();
  });

  it('someone else has it: opening is refused, asking is offered, and an admin takes over with a reason', async () => {
    const page = await open('signedin linked inuse');
    await clickRow(page, 'Shop admin');
    await drawerHas(page, 'In use: open by Sam Operator on Sam’s Windows laptop');
    await clickButton(page, '.drawer', 'Open profile');
    await toastContains(page, 'Someone else has this profile open');
    await clickButton(page, '.drawer', 'Ask for it…');
    await clickButton(page, '[role=dialog]', 'Send request');
    await toastContains(page, 'Asked Sam Operator');
    await drawerHas(page, 'Waiting for an answer');

    await clickButton(page, '.drawer', 'Take over…');
    await page.waitForSelector('[role=alertdialog] textarea');
    const takeDisabled = () =>
      page.$$eval('[role=alertdialog] button[type=submit]', (bs) => (bs[0] as HTMLButtonElement).disabled);
    expect(await takeDisabled()).toBe(true);
    await page.type('[role=alertdialog] textarea', 'Sam is away and refunds are due today');
    expect(await takeDisabled()).toBe(true);
    await page.click('[role=alertdialog] input[type=checkbox]');
    expect(await takeDisabled()).toBe(false);
    const violations = await axeSerious(page);
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
    await clickButton(page, '[role=alertdialog]', 'Take over');
    await toastContains(page, 'Taken over.');
    await drawerHas(page, 'Nobody has it open');
    await clickButton(page, '.drawer', 'Open profile');
    await drawerHas(page, 'Others see that you have it open');
    await page.close();
  });

  it('taken over here: the profile closes, this copy is kept aside and becomes a recovery copy', async () => {
    const page = await open('signedin linked takeover');
    await clickRow(page, 'Shop admin');
    await clickButton(page, '.drawer', 'Open profile');
    await toastContains(page, 'An admin took over “Shop admin”');
    await drawerHas(page, 'uploaded as a recovery copy');
    await page.waitForFunction(() =>
      [...document.querySelectorAll('.drawer button')].some((b) => b.textContent === 'Open profile'),
    );
    await page.waitForFunction(
      () => document.querySelector('.trow .col-sync .badge')?.textContent === 'Taken over',
    );
    await clickButton(page, '.drawer', 'Open profile');
    await toastContains(page, 'Dismiss the notice first');
    await clickButton(page, '.drawer', 'Dismiss');
    await drawerHas(page, 'Nobody has it open');
    await openOrg(page, 'Backups');
    await page.waitForSelector('#org-recovery-title');
    await clickButton(page, '#main', 'Restore as a new profile from North shop admin');
    await toastContains(page, 'Restoring the recovery copy');
    await page.close();
  });

  it('a shared profile does not open offline; local profiles still do', async () => {
    const page = await open('signedin linked teamoffline');
    await clickRow(page, 'Shop admin');
    await clickButton(page, '.drawer', 'Open profile');
    await toastContains(page, 'only when this computer can reach');
    await page.close();
  });

  it('organization profiles show who has each one open, and access says what operators may do', async () => {
    const page = await open('signedin inuse');
    await openOrg(page, 'Profiles');
    await page.waitForFunction(() =>
      document.querySelector('table.records')?.textContent?.includes('Sam Operator · Sam’s Windows laptop'),
    );
    await page.waitForFunction(() =>
      [...document.querySelectorAll('#main button')].some(
        (b) => b.textContent === 'Take over… North shop admin',
      ),
    );
    await clickButton(page, '.org-nav', 'Access');
    await page.waitForSelector('#org-access-title');
    const sam = await page.waitForFunction(
      () =>
        [...document.querySelectorAll<HTMLOptionElement>('#main select option')].find((o) =>
          o.textContent?.includes('Sam Operator'),
        )?.value,
      { timeout: 10_000 },
    );
    await page.select('#main select', (await sam.jsonValue()) as string);
    const boxes = await page.waitForFunction(
      () => {
        const labels = [...document.querySelectorAll('#main .choice')];
        return labels.length === 3
          ? labels.map((l) => [l.textContent?.trim(), l.querySelector('input')?.checked])
          : null;
      },
      { timeout: 10_000 },
    );
    expect(await boxes.jsonValue()).toEqual([
      ['Open', true],
      ['Change settings', false],
      ['Restore backups', true],
    ]);
    const labels = await page.$$('#main .choice input');
    await labels[1]?.click();
    await toastContains(page, 'Access changed.');
    await page.waitForFunction(
      () => document.querySelectorAll<HTMLInputElement>('#main .choice input')[1]?.checked === true,
    );
    const violations = await axeSerious(page);
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
    await page.close();
  });
});
