#!/usr/bin/env node
/**
 * Builds the public website (R4) into dist/: one prerendered HTML page per route (dist/<path>/index.html), a 404
 * page, and content-hashed assets (CSS with the shared design tokens, and the script). Product pictures are HTML and
 * inline SVG. No inline scripts or styles: the site's Content-Security-Policy allows only its own files (no fonts).
 *
 *   node build.mjs [--out <dir>]
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { esc, LEGAL, PAGES } from './src/pages.mjs';

const ROOT = import.meta.dirname;
const outArg = process.argv.indexOf('--out');
const OUT = resolve(outArg > 0 ? process.argv[outArg + 1] : join(ROOT, 'dist'));
const BRAND = process.env.BRAND_NAME || 'Project Browser';

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, 'assets'), { recursive: true });

const assets = new Map();
function emit(name, data) {
  const hash = createHash('sha256').update(data).digest('hex').slice(0, 10);
  const dot = name.lastIndexOf('.');
  const file = `${name.slice(0, dot)}.${hash}${name.slice(dot)}`;
  writeFileSync(join(OUT, 'assets', file), data);
  assets.set(name, `/assets/${file}`);
}
emit(
  'site.css',
  Buffer.from(
    `${readFileSync(resolve(ROOT, '../../packages/ui/src/tokens.css'), 'utf8')}\n${readFileSync(join(ROOT, 'src/site.css'), 'utf8')}`,
  ),
);
emit('site.js', readFileSync(join(ROOT, 'src/site.js')));
const asset = (name) => {
  const url = assets.get(name);
  if (!url) throw new Error(`missing asset ${name}`);
  return url;
};

const NAV = [
  ['pricing', 'Pricing'],
  ['download', 'Download'],
  ['help', 'Help'],
  ['security', 'Security'],
  ['contact', 'Contact'],
];
const YEAR = new Date().getUTCFullYear();
const LOGO = `<svg class="logo" viewBox="0 0 28 28" width="28" height="28" aria-hidden="true" focusable="false"><rect x="1" y="1" width="26" height="26" rx="8" class="logo-bg"/><rect x="7" y="7.5" width="9" height="9" rx="2.5" fill="none" stroke="#fff" stroke-width="2"/><rect x="12" y="11.5" width="9" height="9" rx="2.5" fill="#fff"/></svg>`;

function layout({ path, title, description, body, bare }) {
  const isHome = path === '';
  const pageTitle = isHome ? `${BRAND} — ${title}` : `${title} · ${BRAND}`;
  const nav = NAV.map(
    ([p, label]) => `<li><a href="/${p}/"${p === path ? ' aria-current="page"' : ''}>${esc(label)}</a></li>`,
  ).join('');
  const html = body.replace(/\{\{asset:([^}]+)\}\}/g, (_, name) => (assets.has(name) ? asset(name) : ''));
  const content = bare ? html.trim() : `<div class="wrap page">\n${html.trim()}\n</div>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(pageTitle)}</title>
<meta name="description" content="${esc(description)}">
<meta name="referrer" content="strict-origin-when-cross-origin">
<meta name="color-scheme" content="light dark">
<link rel="stylesheet" href="${asset('site.css')}">
<script type="module" src="${asset('site.js')}"></script>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="top">
<div class="top-inner">
<a class="brand" href="/">${LOGO}<span>${esc(BRAND)}</span></a>
<button class="menu-toggle" type="button" aria-expanded="false" aria-controls="site-nav" hidden><span class="pb-sr-only">Menu</span><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M4 7h16M4 12h16M4 17h16"/></svg></button>
<div class="top-menu" id="site-nav">
<nav aria-label="Site"><ul>${nav}</ul></nav>
<div class="top-actions">
<a class="button ghost" href="/app/">Sign in</a>
<a class="button primary" href="/app/#/welcome">Start free trial</a>
</div>
</div>
</div>
</header>
<main id="main" tabindex="-1">
${content}
</main>
<footer class="foot">
<div class="wrap foot-grid">
<div class="foot-brand">
<a class="brand" href="/">${LOGO}<span>${esc(BRAND)}</span></a>
<p class="small muted">Separate browser profiles for every account you manage, shared with your team and backed up encrypted.</p>
</div>
<nav class="foot-nav" aria-label="Footer">
<div><h2>Product</h2><ul><li><a href="/pricing/">Pricing</a></li><li><a href="/download/">Download</a></li><li><a href="/security/">Security</a></li><li><a href="/app/">Sign in</a></li></ul></div>
<div><h2>Support</h2><ul><li><a href="/help/">Help</a></li><li><a href="/contact/">Contact</a></li><li id="status-link"></li></ul></div>
<div><h2>Legal</h2><ul><li><a href="/legal/privacy/">Privacy</a></li><li><a href="/legal/terms/">Terms</a></li><li><a href="/legal/refund/">Refunds</a></li></ul></div>
</nav>
</div>
<div class="wrap foot-base small muted"><span>© ${YEAR} Ten Tech Solutions LLC</span><span>Windows 10/11 (x64) and macOS 13+ on Apple silicon</span></div>
</footer>
</body>
</html>
`;
}

function write(path, html) {
  const file = path ? join(OUT, path, 'index.html') : join(OUT, 'index.html');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, html);
}

for (const page of PAGES) write(page.path, layout(page));

const meta = JSON.parse(readFileSync(join(ROOT, 'content/legal/meta.json'), 'utf8'));
for (const l of LEGAL) {
  const text = readFileSync(join(ROOT, 'content/legal', l.file), 'utf8');
  const banner = meta.reviewed
    ? `<p class="muted">Last updated ${esc(meta.updated ?? '')}.</p>`
    : '<p class="draft" role="note"><strong>Draft.</strong> This text has not been reviewed yet and is not in effect.</p>';
  write(
    l.path,
    layout({
      path: l.path,
      title: l.title,
      description: l.title,
      body: `<header class="page-head"><h1>${esc(l.title)}</h1>${banner}</header>\n<div class="prose">${text}</div>`,
    }),
  );
}

writeFileSync(
  join(OUT, '404.html'),
  layout({
    path: '404',
    title: 'Page not found',
    description: 'Page not found',
    body: '<header class="page-head notfound"><h1>Page not found</h1><p class="lead">This page does not exist. Try the <a href="/">home page</a> or <a href="/help/">help</a>.</p></header>',
  }),
);
writeFileSync(
  join(OUT, 'robots.txt'),
  'User-agent: *\nDisallow: /app/\nDisallow: /console/\nDisallow: /v1/\n',
);
console.log(`built ${PAGES.length + LEGAL.length + 1} pages and ${assets.size} assets into ${OUT}`);
