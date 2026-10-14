/**
 * The website's pages (R4). Plain HTML strings, prerendered by build.mjs. Rules for the copy (ADR-0023):
 *  - describe what the product does today; no invisibility, "undetectable", "never banned" or fingerprint claims;
 *  - no invented customers, testimonials, counts or certifications;
 *  - prices and downloads are never written here: the page loads them from the server (site.js).
 * `esc` must wrap every value that does not come from this file.
 */

export const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

const START = '/app/#/welcome';

const shot = (file, alt, caption) =>
  `<figure class="shot"><img src="{{asset:${file}}}" alt="${esc(alt)}" width="1180" height="760" loading="lazy"><figcaption>${esc(caption)}</figcaption></figure>`;

export const PAGES = [
  {
    path: '',
    title: 'Separate browser profiles for every account you manage',
    description:
      'A desktop app for teams that work in many business accounts: one browser profile per account, shared safely, backed up encrypted.',
    body: `
<section class="hero">
  <h1>Separate browser profiles for every account you manage</h1>
  <p class="lead">Keep the sign-ins, cookies and site data of each client account in its own profile. Share profiles with your team one person at a time, with encrypted backups between computers.</p>
  <div class="actions">
    <a class="button primary" href="${START}">Start free</a>
    <a class="button" href="/download/">Download</a>
    <a class="button" href="/app/">Sign in</a>
  </div>
  <p class="small muted">Free trial, no payment details needed. Windows 10/11 (x64) and macOS 13+ on Apple silicon.</p>
</section>
${shot('r3-profiles-light.png', 'The Profiles screen of the desktop app: three profiles with their status, last backup and Open buttons.', 'Profiles of a workspace in the desktop app (sample data).')}
<section>
  <h2>What it does</h2>
  <ul class="features">
    <li><h3>One profile per account</h3><p>Each profile has its own cookies, site storage, cache and sign-ins on your computer, so work for one client never mixes with another.</p></li>
    <li><h3>Share without collisions</h3><p>A profile is open on one computer at a time. When someone closes it, its backup is saved and the next person continues where they left off.</p></li>
    <li><h3>Give exactly the access you mean</h3><p>Invite people and choose all profiles, a folder or selected profiles. A preview shows what they will reach before you send the invitation.</p></li>
    <li><h3>Encrypted backups</h3><p>Profiles are encrypted on the computer before their backup is uploaded. Restores check every file before anything is replaced.</p></li>
    <li><h3>Proxies per profile</h3><p>Give a profile its own proxy on your computer, with a check that it works and an option to block traffic if it does not.</p></li>
    <li><h3>Runs on your computer</h3><p>The browser runs locally, with a supported browser build that is tested before each release.</p></li>
  </ul>
</section>
${shot('r3-invite-wizard-light.png', 'Inviting a teammate: choosing which profiles they will reach before sending.', 'Choosing which profiles a teammate can open (sample data).')}
<section class="note">
  <h2>What it does not do</h2>
  <p>Separate profiles keep stored website data apart. They do not make profiles look like different devices or networks to websites, and they do not promise that an account cannot be restricted by a website. Use the product only for accounts you are authorized to work in.</p>
</section>
<section>
  <h2>Supported systems</h2>
  <ul>
    <li>Windows 10 or 11, 64-bit (x64)</li>
    <li>macOS 13 or later on Apple silicon (M1 or newer)</li>
  </ul>
  <p class="muted">Intel Macs, Linux and Windows on ARM are not supported yet.</p>
</section>`,
  },
  {
    path: 'pricing',
    title: 'Pricing',
    description: 'Plans and prices, read from our billing system. Every workspace starts with a free trial.',
    body: `
<h1>Pricing</h1>
<p class="lead">Every new workspace starts with a free trial — no payment details needed. Choose a plan when you are ready.</p>
<div id="pricing" data-start="${START}" aria-live="polite">
  <p class="muted" id="pricing-status">Loading prices…</p>
  <noscript><p>Prices are loaded from our billing system; please enable JavaScript, or <a href="/contact/">ask us</a>.</p></noscript>
</div>
<section>
  <h2>Good to know</h2>
  <ul>
    <li>Seats count every member of a workspace, the owner included. Invited people use the workspace’s seats; they need no plan of their own.</li>
    <li>Payment is handled by our payment provider; we never see card details. The checkout page shows the binding amount, currency and tax.</li>
    <li>Change or cancel your plan at any time from your account. If a workspace uses more than a smaller plan allows, nothing is deleted: new profiles or members wait until it fits.</li>
    <li>Questions about refunds are answered in our <a href="/legal/refund/">refund policy</a>.</li>
  </ul>
</section>`,
  },
  {
    path: 'download',
    title: 'Download',
    description: 'Download the desktop app for Windows or Mac.',
    body: `
<h1>Download</h1>
<div id="download" aria-live="polite">
  <p class="muted" id="download-status">Checking the latest release…</p>
  <noscript><p>The download list is loaded from our release server; please enable JavaScript.</p></noscript>
</div>
<section>
  <h2>After installing</h2>
  <ol>
    <li>Open the app and choose <strong>Sign in</strong> (or <strong>Create account</strong>).</li>
    <li>Use the same e-mail address as on this website. You land in your workspace’s profiles.</li>
    <li>Choose <strong>New profile</strong>, give it a name, and open it.</li>
  </ol>
  <p class="muted">Releases are signed, and the app checks every update before installing it. Each release lists its SHA-256 checksums.</p>
</section>
<section>
  <h2>Other systems</h2>
  <p>Intel Macs, Linux and Windows on ARM are not supported yet. You can still manage your account, team and billing in the browser from any device.</p>
</section>`,
  },
  {
    path: 'help',
    title: 'Help',
    description: 'Getting started, teams, billing and security questions.',
    body: `
<h1>Help</h1>
<section><h2>Getting started</h2>
<dl class="faq">
<dt>How do I start?</dt><dd><a href="${START}">Create an account</a>, confirm your e-mail address, and your workspace is ready with a free trial. Then <a href="/download/">download the app</a> and sign in with the same address.</dd>
<dt>What is a profile?</dt><dd>A separate browser with its own sign-ins, cookies, storage and cache, on your computer. Use one per account you work in.</dd>
<dt>Does the app make profiles look like different computers?</dt><dd>No. Profiles keep website data apart. They do not change what your computer or network looks like to websites.</dd>
</dl></section>
<section><h2>Teams</h2>
<dl class="faq">
<dt>How do I share profiles?</dt><dd>In <strong>Team</strong>, invite someone and choose all profiles, a folder or selected profiles. A Member can open and use them; editing, downloading backups and billing stay off unless you allow them.</dd>
<dt>Can two people use a profile at once?</dt><dd>No. One person at a time works in a profile. Someone else can ask for it; it is handed over when the current person closes it, with its backup saved.</dd>
<dt>What happens when I remove someone?</dt><dd>They cannot open the workspace’s profiles any more, and profiles they have open are closed in their app. Data already on their computer stays there; we cannot erase other people’s computers.</dd>
</dl></section>
<section><h2>Billing</h2>
<dl class="faq">
<dt>What happens when the trial ends?</dt><dd>Creating and opening profiles pauses until a plan is chosen. Nothing is deleted.</dd>
<dt>Where are my invoices?</dt><dd>In your account under <strong>Billing</strong>. Receipts also come from our payment provider by e-mail.</dd>
<dt>A payment failed — what now?</dt><dd>Everything keeps working while the payment is retried. Update the payment method under Billing → Manage payment and plan.</dd>
</dl></section>
<section><h2>Still stuck?</h2><p><a href="/contact/">Contact us</a>. For security problems, see the <a href="/security/">security page</a>.</p></section>`,
  },
  {
    path: 'contact',
    title: 'Contact',
    description: 'Questions about plans, support, billing, privacy or security.',
    body: `
<h1>Contact</h1>
<p class="lead">We answer by e-mail, usually within two business days.</p>
<form id="contact" class="stack card" novalidate>
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
</form>`,
  },
  {
    path: 'security',
    title: 'Security',
    description: 'How accounts, backups and releases are protected, and how to report a problem.',
    body: `
<h1>Security</h1>
<p class="lead">An overview of how the product protects your accounts and data. It describes what is built today; it is not a certification.</p>
<section><h2>Your data on your computer</h2>
<p>Profiles run in a browser on your computer and their data is stored there. While a profile is open, anyone with access to your signed-in computer account can see it; use disk encryption and a screen lock.</p></section>
<section><h2>Backups</h2>
<p>Before a backup leaves your computer it is compressed and encrypted with AES-256-GCM using a new key for every backup, which is itself protected by your workspace’s key. Restores check the size and checksum of every backup before decrypting, and keep the previous data aside until the new data is in place.</p>
<p>Backups are not end-to-end encrypted: the service can technically decrypt them for restores, under access controls and audit.</p></section>
<section><h2>Accounts and access</h2>
<ul>
<li>Sign-in uses a standard identity provider (OpenID Connect with PKCE). The desktop app keeps its session in your system’s keychain; the website uses a secure, HttpOnly cookie.</li>
<li>Access is denied by default: people see only the profiles shared with them, and every request is checked on the server.</li>
<li>Signing a computer out, removing a member or changing access applies at the next request; profiles they have open are closed in their app.</li>
<li>Our support staff use separate accounts with a one-time code at every sign-in. Seeing a customer’s members or activity needs a time-limited approval by a second person, and is logged.</li>
</ul></section>
<section><h2>Payments</h2>
<p>Payments are made on our payment provider’s pages. We never receive card numbers.</p></section>
<section><h2>Releases and updates</h2>
<p>Every release is signed, and the app verifies each update before installing it. Releases carry checksums, a build provenance attestation and a software bill of materials.</p></section>
<section><h2>Report a vulnerability</h2>
<p>Please tell us privately: use the <a href="/contact/">contact form</a> with the topic “Security”, or GitHub’s private vulnerability reporting on our repository. Test only against your own account, do not degrade the service, and give us reasonable time to fix the problem before disclosing it.</p></section>`,
  },
];

/** Legal pages: the owner supplies and reviews the text (content/legal/*.html); see content/legal/meta.json. */
export const LEGAL = [
  { path: 'legal/privacy', file: 'privacy.html', title: 'Privacy policy' },
  { path: 'legal/terms', file: 'terms.html', title: 'Terms of service' },
  { path: 'legal/refund', file: 'refund.html', title: 'Refund policy' },
];
