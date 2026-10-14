// Checks on the built site (run `node build.mjs` first): every page has a title, one h1 and a description; no
// inline scripts, styles or event handlers (the CSP would block them); internal links and assets resolve; no copy
// promises what the product does not do; legal drafts are marked as drafts.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = mkdtempSync(join(tmpdir(), 'pb-site-'));
execFileSync(process.execPath, [join(ROOT, 'build.mjs'), '--out', OUT], { stdio: 'pipe' });

function htmlFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return htmlFiles(p);
    return name.endsWith('.html') ? [p] : [];
  });
}
const pages = htmlFiles(OUT).map((file) => ({
  file: file.slice(OUT.length),
  html: readFileSync(file, 'utf8'),
}));

test('the expected pages exist', () => {
  const names = pages.map((p) => p.file).sort();
  for (const want of [
    '/index.html',
    '/pricing/index.html',
    '/download/index.html',
    '/help/index.html',
    '/contact/index.html',
    '/security/index.html',
    '/legal/privacy/index.html',
    '/legal/terms/index.html',
    '/legal/refund/index.html',
    '/404.html',
  ])
    assert.ok(names.includes(want), want);
});

test('every page has a title, a description, exactly one h1 and a language', () => {
  for (const { file, html } of pages) {
    assert.match(html, /<html lang="en">/, file);
    assert.match(html, /<title>[^<]{3,}<\/title>/, file);
    assert.match(html, /<meta name="description" content="[^"]{3,}">/, file);
    assert.equal((html.match(/<h1[\s>]/g) ?? []).length, 1, file);
  }
});

test('no inline scripts, styles or event handlers', () => {
  for (const { file, html } of pages) {
    for (const tag of html.match(/<script\b[^>]*>/g) ?? [])
      assert.match(tag, /\ssrc="\/assets\//, `${file}: ${tag}`);
    assert.doesNotMatch(html, /<script\b[^>]*>[^<]+<\/script>/, file);
    assert.doesNotMatch(html, /<style\b/, file);
    assert.doesNotMatch(html, /\sstyle="/, file);
    assert.doesNotMatch(html, /\son[a-z]+="/, file);
    assert.doesNotMatch(html, /href="javascript:/i, file);
  }
});

test('internal links and assets resolve; no unreplaced placeholders', () => {
  for (const { file, html } of pages) {
    assert.doesNotMatch(html, /\{\{/, file);
    for (const [, url] of html.matchAll(/(?:href|src)="(\/[^"#?]*)/g)) {
      if (url.startsWith('/app/') || url.startsWith('/v1/')) continue; // served by the portal and the API
      const target = url.endsWith('/') ? join(OUT, url, 'index.html') : join(OUT, url);
      assert.ok(existsSync(target), `${file} links to ${url}`);
    }
    assert.doesNotMatch(html, /<img src=""/, file);
  }
});

test('no promises the product does not keep', () => {
  const forbidden =
    /undetect|invisib|anti[- ]?detect|never (get )?banned|ban[- ]?proof|bypass|spoof|fingerprint (protection|masking)|guarantee|certified|ISO 27001|SOC ?2|HIPAA|GDPR[- ]compliant|trusted by|\d[\d,]* (customers|teams|users)/i;
  for (const { file, html } of pages) {
    const text = html.replace(/<[^>]+>/g, ' ');
    const m = text.match(forbidden);
    assert.equal(m, null, `${file}: “${m?.[0]}”`);
  }
});

test('prices and download links are never written into the pages', () => {
  for (const { file, html } of pages) {
    assert.doesNotMatch(html.replace(/<[^>]+>/g, ' '), /[$€£]\s?\d/, file);
    assert.doesNotMatch(html, /\.(exe|dmg|msi)"/, file);
  }
});

test('legal pages are marked as drafts until the owner has reviewed them', () => {
  const meta = JSON.parse(readFileSync(join(ROOT, 'content/legal/meta.json'), 'utf8'));
  for (const { file, html } of pages.filter((p) => p.file.startsWith('/legal/'))) {
    if (meta.reviewed) assert.doesNotMatch(html, /class="draft"/, file);
    else assert.match(html, /class="draft"/, file);
  }
});

test('asset names carry a content hash (safe to cache forever)', () => {
  for (const name of readdirSync(join(OUT, 'assets'))) assert.match(name, /\.[0-9a-f]{10}\.[a-z]+$/, name);
});
