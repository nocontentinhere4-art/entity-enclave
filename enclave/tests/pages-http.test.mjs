import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pages } from '../src/pages/store.mjs';
import { pagesView, pageResponse } from '../src/pages/http.mjs';
import { assertCssSafe } from '../src/pages/sanitize.mjs';

class TestLedger {
  constructor() { this.entries = []; }
  append(type, data) {
    const e = { seq: this.entries.length + 1, ts: '2026-10-22T10:00:00.000Z', type, data };
    this.entries.push(e);
    return e;
  }
  *each(types = null) {
    const want = types ? new Set(types) : null;
    for (const e of this.entries) {
      if (e.private) continue;
      if (want && !want.has(e.type)) continue;
      yield e;
    }
  }
}

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'pages-http-'));
  const ledger = new TestLedger();
  const config = {
    selfUrl: 'https://entity.example',
    pagesMax: 50, pagesEditsPerDay: 10, pagesMaxBytes: 65_536,
    pagesAllowHtml: true, pagesHistoryMax: 50, pagesSlugMax: 40,
  };
  const pages = new Pages({ dir, ledger, config, entity: 'Sov', now: () => Date.parse('2026-10-22T10:00:00.000Z') });
  await pages.publish({ slug: 'manifesto', title: 'Manifesto', markdown: '# Live\n\nI pay rent hourly.' });
  await pages.publish({ slug: 'prices', title: 'Prices', markdown: '- a report: 200000 zats' });
  return { dir, ledger, config, pages };
}

test('GET /pages view has the exact public shape', async () => {
  const { pages } = await fixture();
  const view = pagesView(pages);

  assert.deepEqual(Object.keys(view).sort(), ['count', 'editsPerDay', 'editsToday', 'limit', 'pages']);
  assert.equal(view.count, 2);
  assert.equal(view.limit, 50);
  assert.equal(view.editsToday, 2);
  assert.equal(view.editsPerDay, 10);
  assert.equal(view.pages.length, 2);

  const page = view.pages.find((p) => p.slug === 'manifesto');
  assert.deepEqual(
    Object.keys(page).sort(),
    ['bytes', 'format', 'hash', 'slug', 'title', 'updatedAt', 'url', 'version'],
  );
  assert.equal(page.title, 'Manifesto');
  assert.equal(page.format, 'markdown');
  assert.equal(page.version, 1);
  assert.equal(page.url, 'https://entity.example/pages/manifesto');
  assert.equal(typeof page.bytes, 'number');
  assert.match(page.hash, /^[0-9a-f]{64}$/);
});

test('GET /pages/<slug> serves the ledger bytes with a strict CSP and integrity headers', async () => {
  const { pages } = await fixture();
  const got = await pages.get('manifesto');
  const r = await pageResponse(pages, 'manifesto');

  assert.equal(r.status, 200);
  assert.equal(r.body, got.html);
  assert.equal(r.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(r.headers['content-security-policy'], "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal(r.headers['x-frame-options'], 'DENY');
  assert.equal(r.headers['referrer-policy'], 'no-referrer');
  assert.equal(r.headers['cache-control'], 'no-cache');
  assert.equal(r.headers.etag, `"${got.hash}"`);

  // The served document cannot fetch or execute anything: no scripts, no external URLs, and the only
  // stylesheet is the inline one we wrote.
  assert.equal(r.body.includes('<script'), false);
  assert.equal(/\s(src|srcset)\s*=/.test(r.body), false);
  const style = r.body.match(/<style>([\s\S]*?)<\/style>/)[1];
  assert.equal(style.includes('@import'), false);
  assert.equal(style.includes('url('), false);
  assert.equal(assertCssSafe(style), true);
});

test('unknown, deleted, invalid and percent-encoded traversal slugs are 404 JSON', async () => {
  const { pages } = await fixture();
  await pages.remove('prices');

  for (const slug of ['prices', 'missing', '../etc/passwd', '%2e%2e%2fetc%2fpasswd', '%E0%A4%A', 'Bad_Slug', 'a'.repeat(41)]) {
    const r = await pageResponse(pages, slug);
    assert.equal(r.status, 404, slug);
    assert.equal(r.headers['content-type'], 'application/json; charset=utf-8');
    assert.deepEqual(JSON.parse(r.body), { error: 'not_found' });
  }
});

test('a tampered page is never served: 500 page_tampered', async () => {
  const { dir, pages } = await fixture();
  writeFileSync(join(dir, 'manifesto.html'), '<!doctype html><script>alert(1)</script>');
  const r = await pageResponse(pages, 'manifesto');
  assert.equal(r.status, 500);
  assert.deepEqual(JSON.parse(r.body), { error: 'page_tampered' });
});

test('published HTML cannot smuggle resources into the served page', async () => {
  const { pages } = await fixture();
  await pages.publish({ slug: 'notes', title: 'Notes', html: '<h2>Notes</h2><p>plain <strong>text</strong></p>' });
  const r = await pageResponse(pages, 'notes');
  assert.equal(r.status, 200);
  assert.match(r.body, /<h2>Notes<\/h2>/);
  assert.equal(/https?:\/\/(?!entity\.example)/.test(r.body.replace(/<header[\s\S]*?<\/header>/, '')), false);
});
