#!/usr/bin/env node
/**
 * Builds the public website (R4) into dist/: one prerendered HTML page per route (dist/<path>/index.html), a 404
 * page, and content-hashed assets (CSS with the shared design tokens, the script, product screenshots). No inline
 * scripts or styles: the site's Content-Security-Policy allows only its own files.
 *
 *   node build.mjs [--out <dir>]
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { esc, LEGAL, PAGES } from './src/pages.mjs';

const ROOT = import.meta.dirname;
const outArg = process.argv.indexOf('--out');
const OUT = resolve(outArg > 0 ? process.argv[outArg + 1] : join(ROOT, 'dist'));
const BRAND = process.env.BRAND_NAME || 'Project Browser';
const DESIGN = resolve(ROOT, '../../docs/design');
const SCREENSHOTS = ['r3-profiles-light.png', 'r3-invite-wizard-light.png'];

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
for (const shot of SCREENSHOTS) {
  const src = join(DESIGN, shot);
  if (existsSync(src)) emit(shot, readFileSync(src));
}
const asset = (name) => {
  const url = assets.get(name);
  if (!url) throw new Error(`missing asset ${name}`);
  return url;
};

const NAV = [
  ['', 'Home'],
  ['pricing', 'Pricing'],
  ['download', 'Download'],
  ['help', 'Help'],
  ['security', 'Security'],
];

function layout({ path, title, description, body }) {
  const isHome = path === '';
  const pageTitle = isHome ? `${BRAND} — ${title}` : `${title} · ${BRAND}`;
  const nav = NAV.map(
    ([p, label]) =>
      `<li><a href="/${p ? `${p}/` : ''}"${p === path ? ' aria-current="page"' : ''}>${esc(label)}</a></li>`,
  ).join('');
  const html = body.replace(/\{\{asset:([^}]+)\}\}/g, (_, name) => {
    if (!assets.has(name)) return '';
    return asset(name);
  });
  // A screenshot whose file is missing is dropped with its figure, never left as a broken image.
  const cleaned = html.replace(/<figure class="shot"><img src="" [\s\S]*?<\/figure>/g, '');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(pageTitle)}</title>
<meta name="description" content="${esc(description)}">
<meta name="referrer" content="strict-origin-when-cross-origin">
<link rel="stylesheet" href="${asset('site.css')}">
<script type="module" src="${asset('site.js')}"></script>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="top">
<a class="brand" href="/">${esc(BRAND)}</a>
<nav aria-label="Site"><ul>${nav}</ul></nav>
<a class="button" href="/app/">Sign in</a>
<a class="button primary" href="/app/#/welcome">Start free</a>
</header>
<main id="main" tabindex="-1">
${cleaned.trim()}
</main>
<footer class="foot">
<a href="/contact/">Contact</a>
<a href="/legal/privacy/">Privacy</a>
<a href="/legal/terms/">Terms</a>
<a href="/legal/refund/">Refunds</a>
<span id="status-link"></span>
<span class="muted">© ${new Date().getUTCFullYear()} Ten Tech Solutions LLC</span>
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
      body: `<h1>${esc(l.title)}</h1>\n${banner}\n${text}`,
    }),
  );
}

writeFileSync(
  join(OUT, '404.html'),
  layout({
    path: '404',
    title: 'Page not found',
    description: 'Page not found',
    body: '<h1>Page not found</h1><p>This page does not exist. Try the <a href="/">home page</a> or <a href="/help/">help</a>.</p>',
  }),
);
writeFileSync(
  join(OUT, 'robots.txt'),
  'User-agent: *\nDisallow: /app/\nDisallow: /console/\nDisallow: /v1/\n',
);
console.log(`built ${PAGES.length + LEGAL.length + 1} pages and ${assets.size} assets into ${OUT}`);
