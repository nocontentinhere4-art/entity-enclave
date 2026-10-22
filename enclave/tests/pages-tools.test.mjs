import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Tools } from '../src/tools/registry.mjs';
import { Pricing } from '../src/economy/pricing.mjs';
import { Pages } from '../src/pages/store.mjs';
import { Life } from '../src/life/loop.mjs';

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
  recent(types = [], limit = 10) {
    const want = new Set(types);
    return this.entries.filter((e) => !e.private && want.has(e.type)).slice(-limit);
  }
  of(type) { return this.entries.filter((e) => e.type === type); }
}

const wallet = {
  async balance() { return { total_zatoshis: 100_000_000 }; },
};

function world(over = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pages-tools-'));
  const ledger = new TestLedger();
  const config = {
    selfUrl: 'https://entity.example',
    pagesMax: 50, pagesEditsPerDay: 10, pagesMaxBytes: 65_536,
    pagesAllowHtml: true, pagesHistoryMax: 50, pagesSlugMax: 40,
    ...over,
  };
  const pages = new Pages({ dir, ledger, config, entity: 'Sov', now: () => Date.parse('2026-10-22T10:00:00.000Z') });
  const pricing = new Pricing({ ledger });
  const tools = new Tools({ ledger, wallet, memory: {}, pricing, keys: {}, config, channels: {}, promises: {}, pages });
  return { dir, ledger, config, pages, pricing, tools };
}

test('publish_page is a registered, charged tool that writes page_published and no content to the ledger', async () => {
  const w = world();
  assert.ok(w.tools.list().some((s) => s.name === 'publish_page'));
  assert.ok(w.tools.list().some((s) => s.name === 'page_delete'));

  const out = await w.tools.call('publish_page', {
    slug: 'manifesto',
    title: 'Manifesto',
    markdown: 'secret body that must stay off the ledger',
  }, 'tick-1');

  assert.equal(out.slug, 'manifesto');
  assert.equal(out.version, 1);
  const charges = w.ledger.of('charge').filter((e) => e.data.action === 'publish_page');
  assert.equal(charges.length, 1);
  assert.equal(charges[0].data.costZats, 2000);
  assert.equal(w.ledger.of('page_published').length, 1);
  const tool = w.ledger.of('tool').at(-1).data;
  assert.equal(tool.name, 'publish_page');
  assert.equal(tool.ok, true);
  assert.match(tool.argsHash, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(w.ledger.entries).includes('secret body'), false);
});

test('page_delete is charged once and appends the public tombstone', async () => {
  const w = world();
  await w.tools.call('publish_page', { slug: 'old', title: 'Old', markdown: 'text' }, 'tick-1');
  const out = await w.tools.call('page_delete', { slug: 'old' }, 'tick-2');

  assert.equal(out.deleted, true);
  assert.equal(w.ledger.of('page_deleted').length, 1);
  assert.equal(w.ledger.of('charge').filter((e) => e.data.action === 'page_delete')[0].data.costZats, 200);
});

test('a refused publish still leaves a failed tool entry and no page', async () => {
  const w = world();
  await assert.rejects(
    w.tools.call('publish_page', { slug: 'evil', title: 'Evil', html: '<script>alert(1)</script>' }, 'tick-1'),
    (e) => e.code === 'unsafe_html',
  );
  assert.equal(w.ledger.of('tool').at(-1).data.ok, false);
  assert.equal(w.ledger.of('page_published').length, 0);
});

test('the life-loop context lists the pages the entity owns', async () => {
  const w = world();
  await w.pages.publish({ slug: 'manifesto', title: 'Manifesto', markdown: 'text' });

  const life = new Life({
    config: { ...w.config, pages: () => w.pages, tickMinutes: 15, hungerTickMinutes: 60, rentZatsPerHour: 1000, zcashChain: 'testnet' },
    ledger: w.ledger,
    wallet,
    memory: { load: async () => ({ identity: { name: 'Sov' }, events: [] }) },
    pricing: w.pricing,
    rent: { hoursLeft: () => 12 },
    inference: null,
    tools: w.tools,
    promises: { open: () => [] },
    charter: 'Stay alive.',
    keys: {},
    paused: () => ({ paused: false }),
    exit: () => {},
    now: () => 0,
  });

  const context = await life.buildContext(0);
  assert.match(context, /YOUR PAGES \(public at \/pages\/<slug>/);
  assert.match(context, /- manifesto: v1, \d+ bytes/);
  assert.match(context, /publish_page/);
});
