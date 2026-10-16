/**
 * The website's pages (R4, redesigned in R7). Plain HTML strings, prerendered by build.mjs. Rules for the copy
 * (ADR-0023):
 *  - describe what the product does today; no invisibility, "undetectable", "never banned" or fingerprint claims;
 *  - no invented customers, testimonials, counts or certifications;
 *  - prices and downloads are never written here: the page loads them from the server (site.js).
 * `esc` must wrap every value that does not come from this file. Product pictures are HTML and inline SVG with
 * sample data (no images, fonts or inline styles: the site's Content-Security-Policy allows only its own files).
 */

export const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

const START = '/app/#/welcome';

/** Stroke icons, 24×24, drawn for this site. */
const ICONS = {
  layers: '<path d="M12 3 3 8l9 5 9-5-9-5Z"/><path d="m3 12.5 9 5 9-5"/><path d="m3 17 9 5 9-5"/>',
  handoff:
    '<path d="M4 8h13.5"/><path d="m14 4.5 3.5 3.5-3.5 3.5"/><path d="M20 16H6.5"/><path d="M10 12.5 6.5 16l3.5 3.5"/>',
  users:
    '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8"/><path d="M18.2 14.2A6.5 6.5 0 0 1 21.5 20"/>',
  lock: '<rect x="4" y="10.5" width="16" height="10" rx="2.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/><path d="M12 14.5v2"/>',
  globe:
    '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z"/>',
  laptop: '<rect x="4" y="4.5" width="16" height="11" rx="1.5"/><path d="M2 19.5h20"/>',
  shield:
    '<path d="M12 3 4.5 6v5.5c0 4.5 3.2 8.2 7.5 9.5 4.3-1.3 7.5-5 7.5-9.5V6L12 3Z"/><path d="m9 12 2.2 2.2L15.5 10"/>',
  folder:
    '<path d="M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2.5h8.5A1.5 1.5 0 0 1 21 10v8.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5v-11Z"/>',
  code: '<path d="m8 8-4 4 4 4"/><path d="m16 8 4 4-4 4"/><path d="m13.5 5-3 14"/>',
  briefcase:
    '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8.5 7V5.5A1.5 1.5 0 0 1 10 4h4a1.5 1.5 0 0 1 1.5 1.5V7"/><path d="M3 12.5h18"/>',
  bag: '<path d="M5 8h14l-1.2 11.1a1.5 1.5 0 0 1-1.5 1.4H7.7a1.5 1.5 0 0 1-1.5-1.4L5 8Z"/><path d="M9 8V6.5a3 3 0 0 1 6 0V8"/>',
  checklist:
    '<path d="m4 6 1.5 1.5L8 5"/><path d="m4 12 1.5 1.5L8 11"/><path d="m4 18 1.5 1.5L8 17"/><path d="M11.5 6.5H20M11.5 12.5H20M11.5 18.5H20"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  cloud:
    '<path d="M7 18.5a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 9.5a4.5 4.5 0 0 1-.5 9H7Z"/><path d="M12 11v5"/><path d="m9.8 13.2 2.2-2.2 2.2 2.2"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 8.5-8.5"/><path d="m16.5 6.5 2.5 2.5"/><path d="m14.5 8.5 2 2"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5"/><path d="M12 7.5v.01"/>',
  download: '<path d="M12 4v11"/><path d="m7 10.5 5 5 5-5"/><path d="M5 20h14"/>',
  mail: '<rect x="3" y="5.5" width="18" height="13" rx="2"/><path d="m3.5 7 8.5 6 8.5-6"/>',
  book: '<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H11v16H5.5A1.5 1.5 0 0 1 4 18.5v-13Z"/><path d="M20 5.5A1.5 1.5 0 0 0 18.5 4H13v16h5.5a1.5 1.5 0 0 0 1.5-1.5v-13Z"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
};
export const icon = (name, cls = 'icon') =>
  `<svg class="${cls}" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`;

const pageHead = (title, lead) =>
  `<header class="page-head"><h1>${title}</h1>${lead ? `<p class="lead">${lead}</p>` : ''}</header>`;

// ------------------------------------------------------------------ product pictures (sample data)
const ROWS = [
  ['NS', 'p1', 'Shop admin', 'Northwind', 'Frankfurt proxy', 'open', 'Open here'],
  ['NA', 'p1', 'Ads manager', 'Northwind', 'Frankfurt proxy', 'free', 'Available'],
  ['LS', 'p2', 'Support desk', 'Lumen Studio', 'No proxy', 'busy', 'In use by Maya'],
  ['LM', 'p2', 'Marketplace seller', 'Lumen Studio', 'Toronto proxy', 'free', 'Available'],
  ['OC', 'p3', 'Checkout test', 'Orchard QA', 'Direct', 'free', 'Available'],
  ['OP', 'p4', 'Payments sandbox', 'Orchard QA', 'Direct', 'free', 'Available'],
];
const mockRow = ([initials, hue, name, client, proxy, state, status]) => `
        <div class="m-row${state === 'open' ? ' is-open' : ''}">
          <span class="m-tile ${hue}">${initials}</span>
          <span class="m-name"><b>${name}</b><span>${client}</span></span>
          <span class="m-proxy">${proxy}</span>
          <span class="m-status s-${state}">${state === 'busy' ? icon('lock', 'm-lock') : '<i></i>'}${status}</span>
          <span class="m-btn ghost">${state === 'busy' ? 'Ask for it' : state === 'open' ? 'Show' : 'Open'}</span>
        </div>`;

const productMock = `
<figure class="mock" aria-labelledby="mock-caption">
  <div class="mock-window" aria-hidden="true">
    <div class="mock-bar"><span class="dots"><i></i><i></i><i></i></span><span class="mock-title">Northwind Agency — Profiles</span></div>
    <div class="mock-body">
      <div class="mock-side">
        <span class="m-ws"><span class="m-tile p1 sm">NA</span>Northwind Agency</span>
        <span class="m-nav on">Profiles</span><span class="m-nav">Clients</span><span class="m-nav">Proxies</span><span class="m-nav">Team</span><span class="m-nav">Backups</span>
        <span class="m-side-foot">1 profile open on this computer</span>
      </div>
      <div class="mock-main">
        <div class="m-head"><span><b>Profiles</b><span>6 profiles in 3 clients</span></span><span class="m-btn">New profile</span></div>
        <div class="m-search"><span>Search profiles and clients</span><kbd>Ctrl K</kbd></div>
        <div class="m-cols"><span>Profile</span><span class="m-proxy">Proxy</span><span>Status</span></div>${ROWS.map(mockRow).join('')}
      </div>
    </div>
  </div>
  <div class="mock-toast" aria-hidden="true">
    <span class="m-tile p2">LS</span>
    <span class="m-toast-text"><b>Support desk is yours now</b><span>Maya closed it and its backup was saved.</span></span>
    <span class="m-btn">Open</span>
  </div>
  <figcaption id="mock-caption" class="mock-caption">The profiles of an agency workspace, grouped by client (sample data).</figcaption>
</figure>`;

const handoffMock = `
<figure class="timeline card" aria-labelledby="handoff-caption">
  <div class="tl-head">
    <span class="m-tile p2">LS</span>
    <span><b>Support desk</b><span class="muted">Lumen Studio</span></span>
  </div>
  <ol class="tl">
    <li><span class="tl-dot"></span><span><b>Maya opened the profile</b><span class="muted">It is locked to her computer while she works.</span></span><span class="tl-time">09:12</span></li>
    <li><span class="tl-dot"></span><span><b>Ben asked for it</b><span class="muted">Maya sees the request in her app.</span></span><span class="tl-time">11:40</span></li>
    <li><span class="tl-dot"></span><span><b>Maya closed it</b><span class="muted">Its encrypted backup was saved.</span></span><span class="tl-time">11:52</span></li>
    <li class="now"><span class="tl-dot"></span><span><b>Ben opened it</b><span class="muted">Same sign-ins and cookies, on his computer.</span></span><span class="tl-time">11:53</span></li>
  </ol>
  <figcaption id="handoff-caption" class="small muted">How one profile moves between two people (sample data).</figcaption>
</figure>`;

const FEATURES = [
  [
    'layers',
    'One profile per account',
    'Each profile keeps its own cookies, site storage, cache and sign-ins on your computer, so work for one client never mixes with another.',
  ],
  [
    'folder',
    'Clients and folders',
    'Group profiles by client. Each client has its own colour and overview, so you can see whose account is in front of you.',
  ],
  [
    'globe',
    'A proxy per profile',
    'Give a profile its own proxy, check that it works, and choose to block traffic if the proxy stops answering.',
  ],
  [
    'handoff',
    'Share without collisions',
    'A profile is open on one computer at a time. When someone closes it, its backup is saved and the next person continues.',
  ],
  [
    'cloud',
    'Encrypted backups',
    'Profiles are encrypted on your computer before their backup is uploaded. Restores check every file before anything is replaced.',
  ],
  [
    'code',
    'Automation API',
    'Run jobs on your own profiles from your systems, with scoped API tokens, approved sites only and signed webhooks.',
  ],
];

const FAQ = [
  [
    'What is a profile?',
    'A separate browser with its own sign-ins, cookies, storage and cache, on your computer. Use one for each account you work in.',
  ],
  [
    'Does it make profiles look like different computers?',
    'No. Profiles keep website data apart. They do not change what your computer or network looks like to websites, and they cannot stop a website from restricting an account.',
  ],
  [
    'Can two people use a profile at the same time?',
    'No. One person at a time works in a profile. Someone else can ask for it, and it is handed over when the current person closes it, with its backup saved.',
  ],
  [
    'Where is my browsing data stored?',
    'On your computer, in the profile’s own folder. What leaves it is the profile’s backup, encrypted on your computer before it is uploaded.',
  ],
  [
    'What happens when the free trial ends?',
    'Creating and opening profiles pauses until a plan is chosen. Nothing is deleted.',
  ],
  [
    'Which systems are supported?',
    'Windows 10 or 11 (64-bit) and macOS 13 or later on Apple silicon. Intel Macs, Linux and Windows on ARM are not supported yet.',
  ],
];

const HOME = `
<section class="hero">
  <div class="wrap">
    <div class="hero-copy">
      <h1>Every account you manage, in its own browser profile</h1>
      <div class="hero-side">
      <p class="lead">Keep the sign-ins, cookies and site data of each client apart. Share profiles with your team one person at a time, with encrypted backups between computers.</p>
      <div class="actions">
        <a class="button primary large" href="${START}">Start free trial</a>
        <a class="button large" href="/download/">${icon('download')}Download</a>
      </div>
      <p class="small muted hero-note">Free trial, no payment details needed. Windows 10/11 (x64) and macOS 13+ on Apple silicon.</p>
      </div>
    </div>
    ${productMock}
  </div>
</section>

<section class="uses" aria-labelledby="uses-h">
  <div class="wrap">
    <h2 id="uses-h" class="uses-title">Made for people who work in many accounts</h2>
    <ul class="uses-list">
      <li>${icon('briefcase')}<span><b>Agencies</b><span>Client ad, social and analytics accounts, each in its own profile.</span></span></li>
      <li>${icon('bag')}<span><b>E-commerce teams</b><span>Store, marketplace and payment dashboards, kept apart per brand.</span></span></li>
      <li>${icon('checklist')}<span><b>QA and support</b><span>Test and support accounts, each with a known, separate state.</span></span></li>
    </ul>
  </div>
</section>

<section class="band" aria-labelledby="features-h">
  <div class="wrap">
    <header class="section-head">
      <h2 id="features-h">What it does</h2>
      <p class="lead">A desktop app that gives every account a browser of its own, and lets a team share those browsers safely.</p>
    </header>
    <ul class="features">
      ${FEATURES.map(([i, h, p]) => `<li><span class="feature-icon">${icon(i)}</span><h3>${h}</h3><p>${p}</p></li>`).join('\n      ')}
    </ul>
  </div>
</section>

<section class="band band-alt" aria-labelledby="how-h">
  <div class="wrap">
    <header class="section-head">
      <h2 id="how-h">How it works</h2>
      <p class="lead">From sign-up to your first shared profile in a few minutes.</p>
    </header>
    <ol class="steps">
      <li>
        <span class="step-n" aria-hidden="true">1</span>
        <h3>Create a workspace</h3>
        <p>Sign up on the website and your workspace is ready with a free trial. Download the app and sign in with the same address.</p>
        <div class="step-ui" aria-hidden="true"><span class="m-input">Northwind Agency</span><span class="m-btn">Create</span></div>
      </li>
      <li>
        <span class="step-n" aria-hidden="true">2</span>
        <h3>Add a profile per account</h3>
        <p>Name it, choose its client and, if you need one, its proxy. Open it and sign in to the account as usual.</p>
        <div class="step-ui" aria-hidden="true"><span class="m-tile p1 sm">NS</span><span class="m-text">Shop admin</span><span class="m-status s-open"><i></i>Open here</span></div>
      </li>
      <li>
        <span class="step-n" aria-hidden="true">3</span>
        <h3>Invite your team</h3>
        <p>Choose exactly which profiles each person reaches. They open them in their own app, one person at a time.</p>
        <div class="step-ui" aria-hidden="true"><span class="avatars"><i class="p2">M</i><i class="p3">B</i><i class="p4">J</i></span><span class="m-text">Access to 12 profiles</span></div>
      </li>
    </ol>
  </div>
</section>

<section class="band" aria-labelledby="team-h">
  <div class="wrap split">
    <div>
      <h2 id="team-h">Built for teams that hand work over</h2>
      <p class="lead">Profiles move between people without passing passwords or cookies around, and you decide who reaches what.</p>
      <ul class="checks">
        <li>${icon('check')}<span><b>One person at a time.</b> A profile is locked to the computer it is open on, so two people never overwrite each other.</span></li>
        <li>${icon('check')}<span><b>Ask and hand over.</b> Ask for a profile that is in use; it is yours as soon as it is closed and backed up.</span></li>
        <li>${icon('check')}<span><b>Access you can preview.</b> Share all profiles, a folder or selected ones, and see what a person will reach before you invite them.</span></li>
        <li>${icon('check')}<span><b>Removal that takes effect.</b> Remove someone and the profiles they have open are closed in their app.</span></li>
      </ul>
    </div>
    ${handoffMock}
  </div>
</section>

<section class="band security-band" aria-labelledby="security-h">
  <div class="wrap">
    <header class="section-head">
      <h2 id="security-h">Security and privacy, stated plainly</h2>
      <p class="lead">What we protect, how, and where the limits are.</p>
    </header>
    <ul class="sec-grid">
      <li>${icon('laptop')}<h3>Browsing stays on your computer</h3><p>Profiles run in a browser on your computer, and their data is stored there.</p></li>
      <li>${icon('lock')}<h3>Encrypted before upload</h3><p>Backups are encrypted with AES-256-GCM on your computer, with a new key for every backup.</p></li>
      <li>${icon('key')}<h3>Access denied by default</h3><p>People see only the profiles shared with them, and the server checks every request.</p></li>
      <li>${icon('shield')}<h3>Signed releases</h3><p>Every release is signed, and the app verifies each update before installing it.</p></li>
    </ul>
    <div class="limits">
      <span class="limits-icon">${icon('info')}</span>
      <div>
        <h3>What it does not do</h3>
        <p>Separate profiles keep stored website data apart. They do not make profiles look like different devices or networks to websites, and they do not promise that an account cannot be restricted by a website. Use the product only for accounts you are authorized to work in.</p>
      </div>
      <a class="button on-dark" href="/security/">Read about security</a>
    </div>
  </div>
</section>

<section class="band" aria-labelledby="pricing-h">
  <div class="wrap">
    <div class="teaser">
      <div>
        <h2 id="pricing-h">Start with a free trial</h2>
        <p class="lead">Every new workspace starts with a free trial, no payment details needed. Plans differ by profiles, seats and backup storage.</p>
        <div class="actions">
          <a class="button primary" href="/pricing/">See plans and pricing</a>
          <a class="button" href="${START}">Start free trial</a>
        </div>
      </div>
      <ul class="checks compact">
        <li>${icon('check')}<span>A free trial on every plan</span></li>
        <li>${icon('check')}<span>Change or cancel at any time</span></li>
        <li>${icon('check')}<span>Nothing is deleted when a trial ends</span></li>
        <li>${icon('check')}<span>Payments handled by our payment provider</span></li>
      </ul>
    </div>
  </div>
</section>

<section class="band band-alt" aria-labelledby="faq-h">
  <div class="wrap faq-layout">
    <header>
      <h2 id="faq-h">Questions</h2>
      <p class="muted">More answers in <a href="/help/">Help</a>, or <a href="/contact/">ask us</a>.</p>
    </header>
    <div class="faq-list">
      ${FAQ.map(([q, a]) => `<details><summary>${q}${icon('chevron', 'icon chev')}</summary><p>${a}</p></details>`).join('\n      ')}
    </div>
  </div>
</section>

<section class="band cta-band" aria-labelledby="cta-h">
  <div class="wrap cta">
    <h2 id="cta-h">Give every account a profile of its own</h2>
    <p class="lead">Set up your workspace in the browser, then download the app for Windows or Mac.</p>
    <div class="actions">
      <a class="button primary large" href="${START}">Start free trial</a>
      <a class="button large" href="/download/">${icon('download')}Download</a>
    </div>
    <p class="small muted">Windows 10 or 11, 64-bit (x64). macOS 13 or later on Apple silicon (M1 or newer). Intel Macs, Linux and Windows on ARM are not supported yet.</p>
  </div>
</section>`;

export const PAGES = [
  {
    path: '',
    bare: true,
    title: 'Separate browser profiles for every account you manage',
    description:
      'A desktop app for teams that work in many business accounts: one browser profile per account, shared safely, backed up encrypted.',
    body: HOME,
  },
  {
    path: 'pricing',
    title: 'Pricing',
    description: 'Plans and prices, read from our billing system. Every workspace starts with a free trial.',
    body: `
${pageHead('Pricing', 'Every new workspace starts with a free trial — no payment details needed. Choose a plan when you are ready.')}
<div id="pricing" class="pricing" data-start="${START}" aria-live="polite">
  <p class="muted pricing-status" id="pricing-status">Loading prices…</p>
  <noscript><p>Prices are loaded from our billing system; please enable JavaScript, or <a href="/contact/">ask us</a>.</p></noscript>
</div>
<section class="section-gap" aria-labelledby="know-h">
  <h2 id="know-h">Good to know</h2>
  <ul class="know">
    <li>${icon('users')}<p>Seats count every member of a workspace, the owner included. Invited people use the workspace’s seats; they need no plan of their own.</p></li>
    <li>${icon('lock')}<p>Payment is handled by our payment provider; we never see card details. The checkout page shows the binding amount, currency and tax.</p></li>
    <li>${icon('layers')}<p>Change or cancel your plan at any time from your account. If a workspace uses more than a smaller plan allows, nothing is deleted: new profiles or members wait until it fits.</p></li>
    <li>${icon('book')}<p>Questions about refunds are answered in our <a href="/legal/refund/">refund policy</a>. For anything else, <a href="/contact/">ask us</a>.</p></li>
  </ul>
</section>`,
  },
  {
    path: 'download',
    title: 'Download',
    description: 'Download the desktop app for Windows or Mac.',
    body: `
${pageHead('Download', 'The desktop app runs your profiles on your own computer. Releases are signed and list their checksums.')}
<div id="download" class="download" aria-live="polite">
  <p class="muted" id="download-status">Checking the latest release…</p>
  <noscript><p>The download list is loaded from our release server; please enable JavaScript.</p></noscript>
</div>
<section class="section-gap" aria-labelledby="after-h">
  <h2 id="after-h">After installing</h2>
  <ol class="steps steps-small">
    <li><span class="step-n" aria-hidden="true">1</span><p>Open the app and choose <strong>Sign in</strong> (or <strong>Create account</strong>).</p></li>
    <li><span class="step-n" aria-hidden="true">2</span><p>Use the same e-mail address as on this website. You land in your workspace’s profiles.</p></li>
    <li><span class="step-n" aria-hidden="true">3</span><p>Choose <strong>New profile</strong>, give it a name, and open it.</p></li>
  </ol>
  <p class="muted small">Releases are signed, and the app checks every update before installing it. Each release lists its SHA-256 checksums.</p>
</section>
<section class="section-gap" aria-labelledby="other-h">
  <h2 id="other-h">Other systems</h2>
  <div class="sysgrid">
    <div class="card">${icon('laptop')}<h3>Supported</h3><p>Windows 10 or 11, 64-bit (x64). macOS 13 or later on Apple silicon (M1 or newer).</p></div>
    <div class="card">${icon('info')}<h3>Not supported yet</h3><p>Intel Macs, Linux and Windows on ARM. You can still manage your account, team and billing in the browser from any device.</p></div>
  </div>
</section>`,
  },
  {
    path: 'help',
    title: 'Help',
    description: 'Getting started, teams, billing and security questions.',
    body: `
${pageHead('Help', 'Answers about getting started, working as a team and billing.')}
<nav class="chips" aria-label="Help topics"><a href="#start">Getting started</a><a href="#teams">Teams</a><a href="#billing">Billing</a><a href="#stuck">Still stuck?</a></nav>
<section class="help-sec" id="start" aria-labelledby="start-h"><h2 id="start-h">Getting started</h2>
<dl class="faq">
<div><dt>How do I start?</dt><dd><a href="${START}">Create an account</a>, confirm your e-mail address, and your workspace is ready with a free trial. Then <a href="/download/">download the app</a> and sign in with the same address.</dd></div>
<div><dt>What is a profile?</dt><dd>A separate browser with its own sign-ins, cookies, storage and cache, on your computer. Use one per account you work in.</dd></div>
<div><dt>Does the app make profiles look like different computers?</dt><dd>No. Profiles keep website data apart. They do not change what your computer or network looks like to websites.</dd></div>
</dl></section>
<section class="help-sec" id="teams" aria-labelledby="teams-h"><h2 id="teams-h">Teams</h2>
<dl class="faq">
<div><dt>How do I share profiles?</dt><dd>In <strong>Team</strong>, invite someone and choose all profiles, a folder or selected profiles. A Member can open and use them; editing, downloading backups and billing stay off unless you allow them.</dd></div>
<div><dt>Can two people use a profile at once?</dt><dd>No. One person at a time works in a profile. Someone else can ask for it; it is handed over when the current person closes it, with its backup saved.</dd></div>
<div><dt>What happens when I remove someone?</dt><dd>They cannot open the workspace’s profiles any more, and profiles they have open are closed in their app. Data already on their computer stays there; we cannot erase other people’s computers.</dd></div>
</dl></section>
<section class="help-sec" id="billing" aria-labelledby="billing-h"><h2 id="billing-h">Billing</h2>
<dl class="faq">
<div><dt>What happens when the trial ends?</dt><dd>Creating and opening profiles pauses until a plan is chosen. Nothing is deleted.</dd></div>
<div><dt>Where are my invoices?</dt><dd>In your account under <strong>Billing</strong>. Receipts also come from our payment provider by e-mail.</dd></div>
<div><dt>A payment failed — what now?</dt><dd>Everything keeps working while the payment is retried. Update the payment method under Billing → Manage payment and plan.</dd></div>
</dl></section>
<section class="help-sec stuck" id="stuck" aria-labelledby="stuck-h"><h2 id="stuck-h">Still stuck?</h2><p><a href="/contact/">Contact us</a>. For security problems, see the <a href="/security/">security page</a>.</p></section>`,
  },
  {
    path: 'contact',
    title: 'Contact',
    description: 'Questions about plans, support, billing, privacy or security.',
    body: `
${pageHead('Contact', 'We answer by e-mail, usually within two business days.')}
<div class="contact-layout">
<form id="contact" class="stack card form-card" novalidate>
  <label>Topic
    <select name="topic" required>
      <option value="support">Help with the product</option>
      <option value="sales">Plans and teams</option>
      <option value="billing">Billing</option>
      <option value="privacy">Privacy and my data</option>
      <option value="security">Security</option>
      <option value="other">Something else</option>
    </select>
  </label>
  <label>Your name <input name="name" required maxlength="120" autocomplete="name"></label>
  <label>Your e-mail address <input name="email" type="email" required maxlength="254" autocomplete="email"></label>
  <label>Message <textarea name="message" required minlength="10" maxlength="4000" rows="6"></textarea></label>
  <div class="hp" aria-hidden="true"><label>Leave this empty <input name="website" tabindex="-1" autocomplete="off"></label></div>
  <p class="small muted">We use your message only to answer it. See our <a href="/legal/privacy/">privacy policy</a>.</p>
  <div class="actions"><button type="submit" class="button primary">Send</button></div>
  <p id="contact-result" role="status" aria-live="polite"></p>
</form>
<aside class="contact-side" aria-label="Other ways to get help">
  <div>${icon('book')}<h2>Look it up</h2><p>Most questions about profiles, teams and billing are answered in <a href="/help/">Help</a>.</p></div>
  <div>${icon('shield')}<h2>Report a security problem</h2><p>Choose the topic “Security”. The <a href="/security/">security page</a> explains how we handle reports.</p></div>
  <div>${icon('mail')}<h2>What to include</h2><p>The e-mail address of your account and what you were doing. Never send passwords or card numbers.</p></div>
</aside>
</div>`,
  },
  {
    path: 'security',
    title: 'Security',
    description: 'How accounts, backups and releases are protected, and how to report a problem.',
    body: `
${pageHead('Security', 'An overview of how the product protects your accounts and data. It describes what is built today; it is not a certification.')}
<div class="prose doc">
<section><h2>${icon('laptop')}Your data on your computer</h2>
<p>Profiles run in a browser on your computer and their data is stored there. While a profile is open, anyone with access to your signed-in computer account can see it; use disk encryption and a screen lock.</p></section>
<section><h2>${icon('cloud')}Backups</h2>
<p>Before a backup leaves your computer it is compressed and encrypted with AES-256-GCM using a new key for every backup, which is itself protected by your workspace’s key. Restores check the size and checksum of every backup before decrypting, and keep the previous data aside until the new data is in place.</p>
<p>Backups are not end-to-end encrypted: the service can technically decrypt them for restores, under access controls and audit.</p></section>
<section><h2>${icon('key')}Accounts and access</h2>
<ul>
<li>Sign-in uses a standard identity provider (OpenID Connect with PKCE). The desktop app keeps its session in your system’s keychain; the website uses a secure, HttpOnly cookie.</li>
<li>Access is denied by default: people see only the profiles shared with them, and every request is checked on the server.</li>
<li>Signing a computer out, removing a member or changing access applies at the next request; profiles they have open are closed in their app.</li>
<li>Our support staff use separate accounts with a one-time code at every sign-in. Seeing a customer’s members or activity needs a time-limited approval by a second person, and is logged.</li>
</ul></section>
<section><h2>${icon('lock')}Payments</h2>
<p>Payments are made on our payment provider’s pages. We never receive card numbers.</p></section>
<section><h2>${icon('shield')}Releases and updates</h2>
<p>Every release is signed, and the app verifies each update before installing it. Releases carry checksums, a build provenance attestation and a software bill of materials.</p></section>
<section><h2>${icon('info')}Report a vulnerability</h2>
<p>Please tell us privately: use the <a href="/contact/">contact form</a> with the topic “Security”, or GitHub’s private vulnerability reporting on our repository. Test only against your own account, do not degrade the service, and give us reasonable time to fix the problem before disclosing it.</p></section>
</div>`,
  },
];

/**
 * ADR-0029: the IP check page. The desktop app can open it as a profile's first tab (through the profile's proxy);
 * check.js asks /v1/netcheck what this server sees and compares the estimate with what the browser reports. Not
 * linked from the navigation and not indexed; it works without an account and stores nothing.
 */
export const CHECK = {
  path: 'check',
  title: 'IP check',
  description:
    'The address and estimated location this server sees for your connection, next to your browser’s time zone and language.',
  noindex: true,
  scripts: ['check.js'],
  body: `
${pageHead('IP check', 'What our server sees for this connection, and what this browser reports. Nothing is stored, and you do not need an account.')}
<div id="ipcheck" class="ipcheck">
  <div class="ipcheck-bar">
    <p id="check-status" class="muted" role="status" aria-live="polite">Checking…</p>
    <button id="check-again" type="button" class="button" disabled>Check again</button>
  </div>
  <noscript><p>This check runs in your browser; please enable JavaScript.</p></noscript>
  <div id="check-results" class="ipcheck-grid" hidden>
    <section class="card ipcheck-card" aria-labelledby="seen-h">
      <h2 id="seen-h">${icon('globe')}What this server sees</h2>
      <dl class="ipcheck-facts">
        <div><dt>IP address</dt><dd id="c-ip" class="mono"></dd></div>
        <div><dt>Country</dt><dd id="c-country"></dd></div>
        <div><dt>City</dt><dd id="c-city"></dd></div>
      </dl>
      <p class="small muted">The location is an estimate for the address, from an IP database. City-level estimates are often approximate. IP geolocation by <a href="https://db-ip.com">DB-IP</a>.</p>
    </section>
    <section class="card ipcheck-card" aria-labelledby="cmp-h">
      <h2 id="cmp-h">${icon('laptop')}Compared with this browser</h2>
      <ul class="ipcheck-compare">
        <li><h3>Time zone</h3><p><span class="small muted">For this address</span> <span id="c-tz"></span></p><p><span class="small muted">This browser</span> <span id="b-tz"></span></p><p id="s-tz" class="check-status"></p></li>
        <li><h3>Language</h3><p><span class="small muted">For this address</span> <span id="c-lang"></span></p><p><span class="small muted">This browser</span> <span id="b-lang"></span></p><p id="s-lang" class="check-status"></p></li>
        <li><h3>Local time</h3><p><span class="small muted">At this address</span> <span id="c-time"></span></p><p><span class="small muted">This browser</span> <span id="b-time"></span></p><p id="s-time" class="check-status"></p></li>
      </ul>
    </section>
  </div>
  <p class="small muted ipcheck-note">This page compares a few values only. Websites can see much more about a browser and decide for themselves what they trust; a match here does not change that.</p>
</div>`,
};

/** Legal pages: the owner supplies and reviews the text (content/legal/*.html); see content/legal/meta.json. */
export const LEGAL = [
  { path: 'legal/privacy', file: 'privacy.html', title: 'Privacy policy' },
  { path: 'legal/terms', file: 'terms.html', title: 'Terms of service' },
  { path: 'legal/refund', file: 'refund.html', title: 'Refund policy' },
];
