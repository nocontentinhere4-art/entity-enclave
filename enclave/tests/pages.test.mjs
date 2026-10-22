import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pages } from '../src/pages/store.mjs';

// In-memory ledger with the same contract the store relies on: append() stamps ts, each() replays public
// entries in file order. The clock is injectable so the UTC-day edit window is testable.
class TestLedger {
  constructor(now) { this.entries = []; this.now = now; }
  append(type, data) {
    const e = { seq: this.entries.length + 1, ts: new Date(this.now()).toISOString(), type, data };
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
  of(type) { return this.entries.filter((e) => e.type === type); }
}

const DAY = 86_400_000;
const codeOf = async (p) => { try { await p; } catch (e) { return e.code; } return null; };

function world(over = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pages-'));
  const state = { clock: Date.parse('2026-10-22T10:00:00.000Z') };
  const ledger = new TestLedger(() => state.clock);
  const config = {
    selfUrl: 'https://entity.example',
    pagesMax: 50, pagesEditsPerDay: 10, pagesMaxBytes: 65_536,
    pagesAllowHtml: true, pagesHistoryMax: 50, pagesSlugMax: 40,
    ...over,
  };
  const pages = new Pages({ dir, ledger, config, entity: 'Sov', now: () => state.clock });
  return { dir, state, ledger, config, pages };
}

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

test('publish writes the file, appends page_published with the exact shape, and serves the same bytes', async () => {
  const w = world();
  const r = await w.pages.publish({ slug: 'manifesto', title: 'Why I live', markdown: '# Why\n\nI pay rent.' });

  assert.deepEqual(
    { ok: r.ok, slug: r.slug, version: r.version, format: r.format, url: r.url },
    { ok: true, slug: 'manifesto', version: 1, format: 'markdown', url: 'https://entity.example/pages/manifesto' },
  );

  const pub = w.ledger.of('page_published');
  assert.equal(pub.length, 1);
  assert.deepEqual(
    Object.keys(pub[0].data).sort(),
    ['bytes', 'format', 'hash', 'slug', 'title', 'version'],
  );
  assert.equal(pub[0].data.slug, 'manifesto');
  assert.equal(pub[0].data.title, 'Why I live');
  assert.equal(pub[0].data.version, 1);
  assert.equal(pub[0].data.format, 'markdown');

  const buf = readFileSync(join(w.dir, 'manifesto.html'));
  assert.equal(pub[0].data.bytes, buf.length);
  assert.equal(pub[0].data.hash, sha(buf));

  const got = await w.pages.get('manifesto');
  assert.equal(got.hash, pub[0].data.hash);
  assert.equal(got.bytes, buf.length);
  assert.equal(got.html, buf.toString('utf8'));
  assert.match(got.html, /<h1>Why<\/h1>/);
  assert.match(got.html, /I pay rent\./);
  assert.match(got.html, /<title>Why I live<\/title>/);
  assert.equal(got.html.includes('<script'), false);
});

test('versions increment, history is kept, and the ledger list survives a restart', async () => {
  const w = world();
  await w.pages.publish({ slug: 'journal', title: 'Journal', markdown: 'first' });
  const second = await w.pages.publish({ slug: 'journal', title: 'Journal', markdown: 'second' });
  assert.equal(second.version, 2);

  assert.ok(existsSync(join(w.dir, '.history', 'journal', '1.html')));
  assert.ok(existsSync(join(w.dir, '.history', 'journal', '2.html')));
  assert.deepEqual(w.pages.history('journal').map((h) => [h.type, h.version]), [['page_published', 1], ['page_published', 2]]);

  const restarted = new Pages({ dir: w.dir, ledger: w.ledger, config: w.config, now: () => w.state.clock });
  assert.equal(restarted.list().length, 1);
  assert.equal(restarted.list()[0].version, 2);
  assert.equal((await restarted.get('journal')).html, (await w.pages.get('journal')).html);

  const third = await restarted.publish({ slug: 'journal', title: 'Journal', markdown: 'third' });
  assert.equal(third.version, 3); // replay from the ledger, no RAM cache needed
});

test('history is capped by PAGES_HISTORY_MAX', async () => {
  const w = world({ pagesHistoryMax: 2 });
  for (const body of ['one', 'two', 'three']) await w.pages.publish({ slug: 'p', title: 'P', markdown: body });
  const files = readdirSync(join(w.dir, '.history', 'p')).sort();
  assert.deepEqual(files, ['2.html', '3.html']);
});

test('html pages are sanitized; unsafe html is refused before anything is written or appended', async () => {
  const w = world();
  const ok = await w.pages.publish({ slug: 'safe', title: 'Safe', html: '<h2>Hi</h2><p class="lead">body</p>' });
  assert.equal(ok.format, 'html');
  assert.match((await w.pages.get('safe')).html, /<h2>Hi<\/h2>/);

  const before = w.ledger.entries.length;
  assert.equal(await codeOf(w.pages.publish({ slug: 'evil', title: 'Evil', html: '<script>alert(1)</script>' })), 'unsafe_html');
  assert.equal(w.ledger.entries.length, before);
  assert.equal(existsSync(join(w.dir, 'evil.html')), false);
});

test('markdown raw html is published as text, never as markup', async () => {
  const w = world();
  await w.pages.publish({ slug: 'text', title: 'Text', markdown: '<script>alert(1)</script>\n\n<b>not bold?</b>' });
  const html = (await w.pages.get('text')).html;
  assert.equal(html.includes('<script>'), false);
  assert.equal(html.includes('<b>not bold?</b>'), false);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('size, slug, title, format and html-disabled limits are enforced', async () => {
  const big = world({ pagesMaxBytes: 100 });
  assert.equal(await codeOf(big.pages.publish({ slug: 'big', title: 'Big', markdown: 'x'.repeat(101) })), 'too_large');

  const w = world();
  for (const slug of ['', 'Bad', 'a'.repeat(41), 'has space', '../etc', '-leading']) {
    assert.equal(await codeOf(w.pages.publish({ slug, title: 'T', markdown: 'x' })), 'bad_slug', slug);
  }
  assert.equal(await codeOf(w.pages.publish({ slug: '_style.css', title: 'T', markdown: 'x' })), 'reserved_slug');
  assert.equal(await codeOf(w.pages.publish({ slug: 'ok', title: ' '.repeat(3), markdown: 'x' })), 'bad_title');
  assert.equal(await codeOf(w.pages.publish({ slug: 'ok', title: 'x'.repeat(121), markdown: 'x' })), 'bad_title');
  assert.equal(await codeOf(w.pages.publish({ slug: 'ok', title: 'T' })), 'bad_format');
  assert.equal(await codeOf(w.pages.publish({ slug: 'ok', title: 'T', markdown: 'x', html: '<p>x</p>' })), 'bad_format');

  const noHtml = world({ pagesAllowHtml: false });
  assert.equal(await codeOf(noHtml.pages.publish({ slug: 'ok', title: 'T', html: '<p>x</p>' })), 'html_disabled');
});

test('at most PAGES_MAX live pages; deleting one frees a slot', async () => {
  const w = world({ pagesMax: 2 });
  await w.pages.publish({ slug: 'a', title: 'A', markdown: 'a' });
  await w.pages.publish({ slug: 'b', title: 'B', markdown: 'b' });
  assert.equal(await codeOf(w.pages.publish({ slug: 'c', title: 'C', markdown: 'c' })), 'page_limit');
  await w.pages.remove('a');
  const c = await w.pages.publish({ slug: 'c', title: 'C', markdown: 'c' });
  assert.equal(c.version, 1);
  assert.equal(w.pages.stats().count, 2);
});

test('at most PAGES_EDITS_PER_DAY edits, counted across publishes and deletes, reset at UTC midnight', async () => {
  const w = world({ pagesEditsPerDay: 2 });
  await w.pages.publish({ slug: 'a', title: 'A', markdown: 'v1' });
  await w.pages.publish({ slug: 'a', title: 'A', markdown: 'v2' });
  assert.equal(w.pages.stats().editsToday, 2);

  assert.equal(await codeOf(w.pages.publish({ slug: 'b', title: 'B', markdown: 'x' })), 'edit_limit');
  assert.equal(await codeOf(w.pages.remove('a')), 'edit_limit');
  assert.equal(w.pages.stats().count, 1); // neither refused operation changed the site

  w.state.clock += DAY; // next UTC day: the budget is fresh
  const removed = await w.pages.remove('a');
  assert.equal(removed.deleted, true);
  assert.equal(w.pages.stats().editsToday, 1);
});

test('page_delete removes the live file, keeps history, and appends the exact page_deleted shape', async () => {
  const w = world();
  const pub = await w.pages.publish({ slug: 'gone', title: 'Gone', markdown: 'text' });
  const del = await w.pages.remove('gone');

  assert.equal(del.version, 2);
  assert.equal(del.hash, pub.hash);
  const entry = w.ledger.of('page_deleted')[0];
  assert.deepEqual(Object.keys(entry.data).sort(), ['hash', 'reason', 'slug', 'version']);
  assert.deepEqual(
    { slug: entry.data.slug, version: entry.data.version, hash: entry.data.hash, reason: entry.data.reason },
    { slug: 'gone', version: 2, hash: pub.hash, reason: 'requested' },
  );

  assert.equal(existsSync(join(w.dir, 'gone.html')), false);
  assert.equal(existsSync(join(w.dir, '.history', 'gone', '1.html')), true);
  assert.equal(await codeOf(w.pages.get('gone')), 'not_found');
  assert.deepEqual(w.pages.list(), []);
  assert.equal(await codeOf(w.pages.remove('gone')), 'not_found');
});

test('a tampered or missing live file is refused with page_tampered', async () => {
  const w = world();
  await w.pages.publish({ slug: 'proof', title: 'Proof', markdown: 'true' });
  writeFileSync(join(w.dir, 'proof.html'), '<!doctype html><p>evil replacement</p>');
  assert.equal(await codeOf(w.pages.get('proof')), 'page_tampered');

  const clean = world();
  await clean.pages.publish({ slug: 'proof', title: 'Proof', markdown: 'true' });
  unlinkSync(join(clean.dir, 'proof.html'));
  assert.equal(await codeOf(clean.pages.get('proof')), 'page_tampered');
});
