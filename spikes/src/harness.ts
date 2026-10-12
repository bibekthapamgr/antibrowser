/**
 * Shared harness for the milestone 01 browser spikes.
 *
 * Browser selection (in order): --browser <path>, PB_SPIKE_BROWSER, or the Linux CI harness build at
 * /opt/pb-chromium/chromium (headless Chromium extracted from @sparticuz/chromium; see docs/spikes/README.md).
 * On Windows/macOS pass the pinned Chromium/Chrome executable you are evaluating.
 *
 * Launch flags are deliberately minimal and security-preserving: the sandbox, site isolation and web security
 * are NEVER disabled. Running as root is refused because Chromium would require --no-sandbox.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import puppeteer, { type Browser } from 'puppeteer-core';

export interface Options {
  browser: string;
  headless: 'shell' | true | false;
  extraArgs: string[];
  outDir: string;
  port: number;
}

export function parseOptions(argv: string[], defaults: Partial<Options> = {}): Options & { rest: string[] } {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const browser = get('--browser') ?? process.env.PB_SPIKE_BROWSER ?? '/opt/pb-chromium/chromium';
  const harnessBuild = browser.startsWith('/opt/pb-chromium/');
  const headlessFlag = get('--headless') ?? (harnessBuild ? 'shell' : 'new');
  const extraArgs = harnessBuild ? ['--disable-gpu'] : []; // the container has no GPU; real devices do
  if (process.platform !== 'win32' && process.getuid?.() === 0) {
    throw new Error('Run spikes as a non-root user so the Chromium sandbox stays enabled.');
  }
  return {
    browser,
    headless: headlessFlag === 'shell' ? 'shell' : headlessFlag !== 'false',
    extraArgs,
    outDir: get('--out-dir') ?? join(import.meta.dirname, '..', '.out'),
    port: Number(get('--port') ?? defaults.port ?? 0),
    rest: argv,
  };
}

export function browserEnv(opts: Options): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of [
    'PATH',
    'HOME',
    'USERPROFILE',
    'LOCALAPPDATA',
    'APPDATA',
    'TEMP',
    'TMP',
    'SYSTEMROOT',
    'DISPLAY',
  ]) {
    const v = process.env[k];
    if (v) env[k] = v;
  }
  if (opts.browser.startsWith('/opt/pb-chromium/')) {
    env.LD_LIBRARY_PATH = '/opt/pb-chromium/al2023/lib';
    env.FONTCONFIG_PATH = '/opt/pb-chromium/fonts';
  }
  return env;
}

export async function launch(opts: Options, userDataDir: string): Promise<Browser> {
  mkdirSync(userDataDir, { recursive: true });
  return puppeteer.launch({
    executablePath: opts.browser,
    headless: opts.headless,
    userDataDir,
    args: ['--no-first-run', '--no-default-browser-check', ...opts.extraArgs],
    env: browserEnv(opts),
    timeout: 30_000,
  });
}

/** The page served on the controlled origin. All three storage mechanisms are exercised. */
const PAGE = `<!doctype html><meta charset="utf-8"><title>pb isolation probe</title><script>
function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('pb_probe', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbPut(v) {
  const db = await idb();
  await new Promise((res, rej) => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(v, 'k'); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  db.close();
}
async function idbGet() {
  const db = await idb();
  const v = await new Promise((res, rej) => { const r = db.transaction('kv').objectStore('kv').get('k'); r.onsuccess = () => res(r.result ?? null); r.onerror = () => rej(r.error); });
  db.close();
  return v;
}
window.pbSet = async (v) => {
  localStorage.setItem('pb_ls', v);
  await idbPut(v);
  await fetch('/set-cookie?v=' + encodeURIComponent(v));
  return true;
};
window.pbRead = async () => {
  const echo = await (await fetch('/echo-cookie')).json();
  return { cookie: echo.pb_cookie ?? null, localStorage: localStorage.getItem('pb_ls'), indexedDB: await idbGet() };
};
</script><p>probe</p>`;

export interface ProbeValues {
  cookie: string | null;
  localStorage: string | null;
  indexedDB: string | null;
}

export async function startOrigin(
  port: number,
): Promise<{ server: Server; origin: string; cookieLog: string[] }> {
  const cookieLog: string[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    cookieLog.push(req.headers.cookie ?? '');
    if (url.pathname === '/set-cookie') {
      const v = url.searchParams.get('v') ?? '';
      // Persistent, HttpOnly cookie: stored by the browser profile, invisible to page script.
      res.setHeader(
        'set-cookie',
        `pb_cookie=${encodeURIComponent(v)}; Path=/; Max-Age=86400; HttpOnly; SameSite=Lax`,
      );
      res.end('{}');
    } else if (url.pathname === '/echo-cookie') {
      const cookies = Object.fromEntries(
        (req.headers.cookie ?? '')
          .split(';')
          .map((c) => c.trim().split('='))
          .filter(([k]) => k)
          .map(([k, v]) => [k, decodeURIComponent(v ?? '')]),
      );
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(cookies));
    } else {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(PAGE);
    }
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  return { server, origin: `http://127.0.0.1:${actualPort}`, cookieLog };
}

export async function setValues(browser: Browser, origin: string, value: string): Promise<void> {
  const page = await browser.newPage();
  await page.goto(`${origin}/`, { waitUntil: 'load' });
  await page.evaluate(
    (v) => (window as unknown as { pbSet: (v: string) => Promise<boolean> }).pbSet(v),
    value,
  );
  await page.close();
}

export async function readValues(browser: Browser, origin: string): Promise<ProbeValues> {
  const page = await browser.newPage();
  await page.goto(`${origin}/`, { waitUntil: 'load' });
  const values = await page.evaluate(() =>
    (window as unknown as { pbRead: () => Promise<ProbeValues> }).pbRead(),
  );
  await page.close();
  return values;
}

export function environmentFacts(opts: Options, version: string): Record<string, unknown> {
  const uname = spawnSync('uname', ['-srm'], { encoding: 'utf8' });
  return {
    browser_executable: opts.browser,
    browser_version: version,
    headless: opts.headless,
    extra_args: opts.extraArgs,
    sandbox: 'enabled (no --no-sandbox; non-root user; Chromium refuses to start without a usable sandbox)',
    platform: `${process.platform}-${process.arch}`,
    os: uname.stdout?.trim() || process.platform,
    node: process.version,
    run_at: new Date().toISOString(),
  };
}
