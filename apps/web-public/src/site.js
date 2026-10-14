// Public website behaviour (R4): prices, downloads and the contact form, read from the API at view time. Text is
// only ever set with textContent: nothing from the server becomes HTML.

const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
};

async function getJson(path) {
  const res = await fetch(path, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

const TAX = {
  inclusive: 'tax included',
  exclusive: 'plus applicable tax',
  automatic: 'tax calculated at checkout from your address',
  unspecified: 'plus any applicable tax',
};
function money(minor, currency) {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency.toUpperCase() }).format(
      minor / 100,
    );
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}
const GiB = 1024 ** 3;
const limit = (n, unit) => (n === null ? `Unlimited ${unit}` : `${n.toLocaleString()} ${unit}`);

// ------------------------------------------------------------------ pricing
async function pricing(root) {
  const status = root.querySelector('#pricing-status');
  let data;
  try {
    data = await getJson('/v1/public/plans');
  } catch {
    status.textContent = 'Prices cannot be shown right now. Please try again in a moment, or contact us.';
    status.className = 'error';
    return;
  }
  const offered = data.items.filter((p) => p.available);
  if (offered.length === 0) {
    status.textContent =
      'Plans cannot be bought online right now. You can still start the free trial; prices will be shown here again soon.';
    root.append(
      el('p', {}, el('a', { class: 'button primary', href: root.dataset.start }, 'Start free trial')),
    );
    return;
  }
  const intervals = new Set(offered.flatMap((p) => p.prices.map((x) => x.interval)));
  let interval = intervals.has('month') ? 'month' : 'year';
  const list = el('ul', { class: 'plans' });
  const render = () => {
    list.replaceChildren(
      ...offered.map((p) => {
        const price = p.prices.find((x) => x.interval === interval);
        return el(
          'li',
          { class: 'plan' },
          el('h2', {}, p.name),
          el('p', { class: 'muted' }, p.description),
          price
            ? el(
                'p',
                {},
                el('span', { class: 'price' }, money(price.amount_minor, price.currency)),
                ` per ${price.interval === 'month' ? 'month' : 'year'} `,
                el('span', { class: 'small muted' }, `· ${TAX[price.tax] ?? TAX.unspecified}`),
              )
            : el(
                'p',
                { class: 'muted' },
                interval === 'year' ? 'Not offered yearly.' : 'Monthly price not offered.',
              ),
          el(
            'ul',
            {},
            el('li', {}, limit(p.limits.profiles, 'profiles')),
            el(
              'li',
              {},
              `${limit(p.limits.seats, p.limits.seats === 1 ? 'seat' : 'seats')} (owner included)`,
            ),
            el(
              'li',
              {},
              p.limits.storage_bytes === null
                ? 'Unlimited encrypted backups'
                : `${Math.round(p.limits.storage_bytes / GiB)} GB encrypted backups`,
            ),
            p.features.team_sessions ? el('li', {}, 'Shared profiles with handoff') : null,
          ),
          el(
            'a',
            { class: 'button primary', href: `/app/#/welcome?plan=${encodeURIComponent(p.id)}` },
            `Start free, then ${p.name}`,
          ),
        );
      }),
    );
  };
  status.textContent = `${data.trial_days}-day free trial on every plan, no payment details needed.`;
  status.className = '';
  if (intervals.size > 1) {
    const name = 'interval';
    root.append(
      el(
        'fieldset',
        { class: 'segmented' },
        el('legend', {}, 'Billing period'),
        ...['month', 'year'].map((i) =>
          el(
            'label',
            {},
            el('input', {
              type: 'radio',
              name,
              value: i,
              checked: i === interval,
              onchange: () => {
                interval = i;
                render();
              },
            }),
            i === 'month' ? 'Monthly' : 'Yearly',
          ),
        ),
      ),
    );
  }
  render();
  root.append(list);
}

// ------------------------------------------------------------------ download
function platformGuess() {
  const ua = navigator.userAgent;
  if (/Windows/.test(ua)) return 'windows-x64';
  if (/Macintosh|Mac OS X/.test(ua)) return 'macos-arm64';
  return null;
}
async function download(root) {
  const status = root.querySelector('#download-status');
  let d;
  try {
    d = await getJson('/v1/public/downloads');
  } catch {
    status.textContent = 'The release list cannot be loaded right now. Please try again in a moment.';
    status.className = 'error';
    return;
  }
  if (d.status !== 'available') {
    status.textContent =
      d.status === 'paused'
        ? 'Downloads are paused while a release is being checked. Please try again later.'
        : 'The desktop app is not yet available for download. Create an account now and we will e-mail you when it is.';
    status.className = 'notice';
    if (d.status !== 'paused')
      root.append(
        el('p', {}, el('a', { class: 'button primary', href: '/app/#/welcome' }, 'Create an account')),
      );
    return;
  }
  const guess = platformGuess();
  status.textContent = `Version ${d.version}, released ${new Date(d.published_at).toLocaleDateString()}.`;
  status.className = '';
  if (d.notes_url) root.append(el('p', {}, el('a', { href: d.notes_url }, 'Release notes')));
  root.append(
    el(
      'ul',
      { class: 'downloads' },
      ...d.platforms.map((p) =>
        el(
          'li',
          { class: p.platform === guess ? 'suggested' : '' },
          el(
            'a',
            { class: 'button primary', href: p.url },
            `Download for ${p.platform === 'windows-x64' ? 'Windows' : 'Mac'}`,
          ),
          el(
            'span',
            { class: 'small muted' },
            `${p.label}${p.platform === guess ? ' — suggested for this device' : ''}`,
          ),
          p.sha256 ? el('span', { class: 'mono' }, `SHA-256 ${p.sha256}`) : null,
        ),
      ),
    ),
  );
}

// ------------------------------------------------------------------ contact
function contact(form) {
  const result = form.querySelector('#contact-result');
  const button = form.querySelector('button[type=submit]');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }
    const f = new FormData(form);
    const body = {
      topic: f.get('topic'),
      name: String(f.get('name') ?? '').trim(),
      email: String(f.get('email') ?? '').trim(),
      message: String(f.get('message') ?? '').trim(),
      website: String(f.get('website') ?? ''),
    };
    button.disabled = true;
    result.className = '';
    result.textContent = 'Sending…';
    try {
      const res = await fetch('/v1/public/contact', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.status === 202) {
        form.reset();
        result.textContent = 'Thank you — your message was sent. We will answer by e-mail.';
      } else if (res.status === 429) {
        result.className = 'error';
        result.textContent = 'Too many messages from here. Please try again in an hour.';
      } else {
        result.className = 'error';
        result.textContent =
          'Please check the fields: a name, a valid e-mail address and a message of at least 10 characters.';
      }
    } catch {
      result.className = 'error';
      result.textContent = 'The message could not be sent. Check your connection and try again.';
    }
    button.disabled = false;
  });
}

// ------------------------------------------------------------------ service status link (configured by the owner)
async function statusLink() {
  try {
    const c = await getJson('/v1/web/config');
    const slot = document.getElementById('status-link');
    if (c.status_url && slot) slot.append(el('a', { href: c.status_url }, 'Service status'));
  } catch {
    /* optional */
  }
}

const pricingRoot = document.getElementById('pricing');
if (pricingRoot) void pricing(pricingRoot);
const downloadRoot = document.getElementById('download');
if (downloadRoot) void download(downloadRoot);
const form = document.getElementById('contact');
if (form) contact(form);
void statusLink();
