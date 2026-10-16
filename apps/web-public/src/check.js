// IP check page (/check/, ADR-0029). The desktop app can open it as a profile's first tab. It asks this server's
// /v1/netcheck (same origin, so through the profile's proxy) which address it saw and where the IP database estimates
// that address to be, and puts next to it what this browser itself reports (time zone, language). Nothing is stored
// and no account is needed. Text is only ever set with textContent: nothing from the server becomes HTML.

/** The first value of each `key=value` line (Cloudflare trace format). */
export function parseTrace(text) {
  const out = {};
  for (const raw of String(text).split('\n')) {
    const line = raw.replace(/\r$/, '');
    const i = line.indexOf('=');
    if (i <= 0) continue;
    const key = line.slice(0, i).trim();
    if (!(key in out)) out[key] = line.slice(i + 1).trim();
  }
  return out;
}

const COUNTRY = /^[A-Z]{2}$/;
const ZONE = /^(UTC|[A-Z][A-Za-z]{1,19}(\/[A-Za-z0-9_+-]{1,30}){1,2})$/;
const LANG = /^[a-z]{2,3}-[A-Z]{2}$/;
const IP = /^[0-9A-Fa-f:.]{2,45}$/;

/** The check answer's values that have the expected shape (anything else is treated as unknown). */
export function readCheck(text) {
  const t = parseTrace(text);
  const pick = (v, ok) => (typeof v === 'string' && ok(v) ? v : null);
  return {
    ip: pick(t.ip, (v) => IP.test(v)),
    country: pick(t.loc, (v) => COUNTRY.test(v) && v !== 'XX' && v !== 'ZZ'),
    city: pick(t.city, (v) => v.length >= 1 && v.length <= 64 && !/[<>]/.test(v)),
    timezone: pick(t.tz, (v) => ZONE.test(v)),
    language: pick(t.lang, (v) => LANG.test(v)),
  };
}

/** A zone's canonical name in this browser (`Asia/Calcutta` and `Asia/Kolkata` are the same zone). */
function canonicalZone(zone) {
  try {
    return new Intl.DateTimeFormat('en', { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/** `match` | `mismatch` | `unknown` (the check gave no time zone, or this browser does not know it). */
export function compareZone(proxyZone, browserZone) {
  if (!proxyZone || !browserZone) return 'unknown';
  const a = canonicalZone(proxyZone);
  const b = canonicalZone(browserZone);
  if (!a || !b) return 'unknown';
  return a === b ? 'match' : 'mismatch';
}

/** Same language (`en-GB` and `en-US` match; the region may differ); `unknown` without a value. */
export function compareLanguage(proxyLang, browserLang) {
  if (!proxyLang || !browserLang) return 'unknown';
  const base = (t) => String(t).toLowerCase().split(/[-_]/)[0];
  return base(proxyLang) === base(browserLang) ? 'match' : 'mismatch';
}

const countryName = (cc) => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(cc) ?? cc;
  } catch {
    return cc;
  }
};
const languageName = (tag) => {
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'language' }).of(tag);
    return name && name !== tag ? `${name} (${tag})` : tag;
  } catch {
    return tag;
  }
};
const timeIn = (zone) => {
  try {
    return new Intl.DateTimeFormat('en', {
      timeZone: zone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date());
  } catch {
    return null;
  }
};

const STATUS = {
  match: ['✅', 'Match'],
  mismatch: ['⚠️', 'Mismatch'],
  unknown: ['–', 'Not compared'],
};

function setStatus(node, state) {
  const [mark, label] = STATUS[state];
  node.className = `check-status is-${state}`;
  const m = document.createElement('span');
  m.setAttribute('aria-hidden', 'true');
  m.textContent = mark;
  node.replaceChildren(m, document.createTextNode(` ${label}`));
}

function setText(id, value, fallback = 'Not known') {
  const node = document.getElementById(id);
  if (!node) return;
  node.textContent = value ?? fallback;
  node.classList.toggle('muted', value === null || value === undefined);
}

async function run(root) {
  const status = root.querySelector('#check-status');
  const results = root.querySelector('#check-results');
  const again = root.querySelector('#check-again');
  status.className = 'muted';
  status.textContent = 'Checking…';
  again.disabled = true;
  let found;
  try {
    const res = await fetch('/v1/netcheck', { cache: 'no-store', headers: { accept: 'text/plain' } });
    if (!res.ok) throw new Error(String(res.status));
    found = readCheck(await res.text());
    if (!found.ip) throw new Error('no address');
  } catch {
    results.hidden = true;
    status.className = 'error';
    status.textContent =
      'The check could not be completed. The connection or the proxy may be down, or the check is busy. Try again in a moment.';
    again.disabled = false;
    return;
  }
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
  const lang = navigator.languages?.[0] || navigator.language || null;

  setText('c-ip', found.ip);
  setText('c-country', found.country ? `${countryName(found.country)} (${found.country})` : null);
  setText('c-city', found.city);
  setText('c-tz', found.timezone?.replaceAll('_', ' ') ?? null);
  setText('b-tz', zone?.replaceAll('_', ' ') ?? null);
  setText('c-lang', found.language ? languageName(found.language) : null);
  setText('b-lang', lang ? languageName(lang) : null);
  setText('c-time', found.timezone ? timeIn(found.timezone) : null);
  setText('b-time', zone ? timeIn(zone) : null);
  const tz = compareZone(found.timezone, zone);
  const lg = compareLanguage(found.language, lang);
  setStatus(root.querySelector('#s-tz'), tz);
  setStatus(root.querySelector('#s-lang'), lg);
  setStatus(root.querySelector('#s-time'), tz);

  const located = Boolean(found.country || found.timezone);
  status.className = located ? (tz === 'mismatch' || lg === 'mismatch' ? 'notice warn' : 'notice') : 'notice';
  status.textContent = !located
    ? 'This server has no location estimate for the address (its IP database is not set up), so only the address is shown.'
    : tz === 'mismatch' || lg === 'mismatch'
      ? 'This browser’s time zone or language differs from the estimate for this address. Sites that compare them may ask you to verify. In the app, “Match timezone, language and location to the proxy” sets them from the proxy.'
      : 'This browser’s time zone and language match the estimate for this address.';
  results.hidden = false;
  again.disabled = false;
}

const root = typeof document === 'undefined' ? null : document.getElementById('ipcheck');
if (root) {
  root.querySelector('#check-again')?.addEventListener('click', () => void run(root));
  void run(root);
}
