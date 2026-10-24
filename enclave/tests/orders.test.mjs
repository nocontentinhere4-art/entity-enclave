// Orders tests: the real Ledger on a tmpdir (so the on-disk scan path is exercised), a fake wallet, memory
// store and pricing. No HTTP, no chain — the loop test at the end uses the deterministic fake brain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ledger } from '../src/ledger.mjs';
import { Orders, ordersView, parseOrderMemo, normalizeItem, PAYWALL_MEMO_FORMAT } from '../src/orders/book.mjs';
import { Tools } from '../src/tools/registry.mjs';
import { Pricing } from '../src/economy/pricing.mjs';
import { Inference } from '../src/llm/infer.mjs';
import { Life } from '../src/life/loop.mjs';

// ---- helpers ---------------------------------------------------------------------------------------------------

const HOUR = 3_600_000;

function freshLedger() { return new Ledger(join(mkdtempSync(join(tmpdir(), 'orders-')), 'ledger.jsonl')); }

/** The real Ledger keeps no in-memory array: tests read the file, exactly like the scanners do. */
function allOf(ledger) {
  return readFileSync(ledger.path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
const of = (ledger, type) => allOf(ledger).filter((e) => e.type === type);

function makeOrders({ ledger, memory = new MemStore(), over = {}, now = () => 0 } = {}) {
  return new Orders({
    ledger, memory,
    config: {
      orderDeadlineHours: over.orderDeadlineHours ?? 24,
      orderGraceHours: over.orderGraceHours ?? 6,
      orderMaxOpen: over.orderMaxOpen ?? 10,
      orderRequestsMax: over.orderRequestsMax ?? 100,
    },
    now,
  });
}

class MemStore { // MemoryStore-like: load/save round-trip through a clone
  constructor(init = {}) { this.state = structuredClone(init); }
  load() { return structuredClone(this.state); }
  async save(m) { this.state = structuredClone(m); }
}

class FakeWallet {
  constructor(zats = 10_000_000) { this.zats = zats; }
  async balance() { return { total_zatoshis: this.zats }; }
}

/** A fresh paywall + paid letter routed through the public entries. Returns whatever onLetter decided. */
async function coin(orders, ledger, { memo, zats = 250_000 }, paywall = { item: 'research-report', priceZats: 200_000 }) {
  ledger.append('paywall', paywall);
  const letter = ledger.append('letter', { zats, bytes: Buffer.byteLength(memo), txid: 'tx1' });
  return orders.onLetter({ seq: letter.seq, txid: 'tx1', zats, text: memo, at: '2026-01-01T00:00:00.000Z' });
}

// ---- parseOrderMemo --------------------------------------------------------------------------------------------

test('parseOrderMemo reads the documented contract and skips trade-engine memos', () => {
  const m = parseOrderMemo('ORDER research-report\nplease look at ZEC flows');
  assert.equal(m.explicitOrder, true);
  assert.equal(m.item, 'research-report');
  assert.equal(m.request, 'please look at ZEC flows');

  const up = parseOrderMemo('  order   Quarterly REPORT \nline one\nline two');
  assert.equal(up.explicitOrder, true);
  assert.equal(up.item, 'quarterly report'); // normalised
  assert.equal(up.request, 'line one\nline two');

  assert.equal(parseOrderMemo('buy 0.1 ZEC for me').reserved, 'buy');
  assert.equal(parseOrderMemo('SELL 500 usdc now').reserved, 'sell');
  assert.equal(parseOrderMemo('ORDER research-report without a request').request, null);
  assert.deepEqual(parseOrderMemo('hello, lovely work!'), { plain: 'hello, lovely work!' });
  assert.equal(parseOrderMemo('').plain, '');
  assert.equal(parseOrderMemo('Order: research-report\nx').explicitOrder, undefined); // canonical form only
});

// ---- receiving -------------------------------------------------------------------------------------------------

test('a paid letter naming the item becomes order_received with the exact public shape', async () => {
  const ledger = freshLedger();
  let clock = 1_000_000;
  const orders = makeOrders({ ledger, now: () => clock });
  const r = await coin(orders, ledger, { memo: 'please do a research-report on orchard', zats: 250_000 });
  assert.equal(r.status, 'received');
  assert.deepEqual(r.order, {
    id: r.order.id,
    letterSeq: 2, // after the paywall entry
    item: 'research-report',
    zats: 250_000,
    priceZats: 200_000,
    overpaidZats: 50_000,
    letterAt: '2026-01-01T00:00:00.000Z',
    receivedAt: new Date(1_000_000).toISOString(),
    deadlineTs: new Date(1_000_000 + 24 * HOUR).toISOString(),
    txid: 'tx1',
  });
  assert.match(r.order.id, /^o[0-9a-f]{12}$/);
  // the private request text is stored in memory only, never on the chain
  assert.equal(JSON.stringify(allOf(ledger).filter((e) => !e.private)).includes('orchard'), false);
  assert.equal(await orders.requestText(r.order.id), 'please do a research-report on orchard');
});

test('replaying the same letter never creates a second order (restart-safe)', async () => {
  const ledger = freshLedger();
  const orders = makeOrders({ ledger });
  await coin(orders, ledger, { memo: 'research-report please' });
  const second = makeOrders({ ledger }); // fresh instance = restart replay
  const again = await second.onLetter({ seq: 2, txid: 'tx1', zats: 250_000, text: 'research-report please', at: '2026-01-01T00:00:00.000Z' });
  assert.equal(of(ledger, 'order_received').length, 1);
  assert.equal(again.status, 'received');
});

test('unknown item, empty request and underpaid are refused with reasons; nothing is hidden from the record', async () => {
  let clock = 0;
  const now = () => clock;
  const ledger1 = freshLedger();
  const o1 = makeOrders({ ledger: ledger1, now });
  let r = await coin(o1, ledger1, { memo: 'ORDER no-such-item\npls' });
  assert.equal(r.refusal.reason, 'unknown_item');
  assert.equal(r.refusal.priceZats, null);
  assert.match(r.refusal.id, /^o[0-9a-f]{12}$/);

  const ledger2 = freshLedger();
  const o2 = makeOrders({ ledger: ledger2, now });
  r = await coin(o2, ledger2, { memo: 'ORDER research-report' });
  assert.equal(r.refusal.reason, 'empty_request');

  const ledger3 = freshLedger();
  const o3 = makeOrders({ ledger: ledger3, now });
  r = await coin(o3, ledger3, { memo: 'research-report please', zats: 199_999 });
  assert.equal(r.refusal.reason, 'underpaid');
  assert.equal(r.refusal.priceZats, 200_000);

  const refusals = of(ledger3, 'order_refused');
  assert.equal(refusals.length, 1);
  assert.deepEqual(refusals[0].data, { id: r.refusal.id, letterSeq: 2, item: 'research-report', zats: 199_999, priceZats: 200_000, reason: 'underpaid', refusedAt: new Date(0).toISOString() });
});

test('the latest paywall price wins; priceZats=0 disables the item; disabled items are unknown', async () => {
  const ledger = freshLedger();
  const orders = makeOrders({ ledger });
  await coin(orders, ledger, { memo: 'x', zats: 1 }, { item: 'research-report', priceZats: 100_000 });
  await coin(orders, ledger, { memo: 'x', zats: 1 }, { item: 'research-report', priceZats: 300_000 });
  assert.deepEqual(orders.items().map((i) => i.priceZats), [300_000]);

  await coin(orders, ledger, { memo: 'x', zats: 1 }, { item: 'research-report', priceZats: 0 });
  assert.deepEqual(orders.items(), []); // disabled
  const r = await coin(orders, ledger, { memo: 'ORDER research-report\nhi' }, { item: 'research-report', priceZats: 0 });
  assert.equal(r.refusal.reason, 'unknown_item'); // refusing is the enforceable way to say "not for sale"
});

test('a plain letter that names an item is an order too; buy/sell memos are left to the trade engine', async () => {
  const ledger = freshLedger();
  const orders = makeOrders({ ledger });
  const r = await coin(orders, ledger, { memo: 'i would like the research-report, thanks', zats: 250_000 });
  assert.equal(r.status, 'received');
  assert.equal(r.order.item, 'research-report');

  const r2 = await coin(orders, ledger, { memo: 'buy research-report from someone else', zats: 250_000 });
  assert.equal(r2, null); // reserved prefix, never an order
  const r3 = await coin(orders, ledger, { memo: 'i love the research-report!', zats: 10 }); // mentions it, underpaid
  assert.equal(r3.status, 'refused');
  const r4 = await coin(orders, ledger, { memo: 'nothing here matches', zats: 1_000_000 });
  assert.equal(r4, null); // ordinary letter: no contract broken
});

test('ORDER beats a longer mention: the explicit item line is the contract', async () => {
  const ledger = freshLedger();
  const orders = makeOrders({ ledger });
  await coin(orders, ledger, { memo: 'x', zats: 1 }, { item: 'research-report', priceZats: 100_000 });
  await coin(orders, ledger, { memo: 'x', zats: 1 }, { item: 'haiku', priceZats: 100_000 });
  const r = await coin(orders, ledger, { memo: 'ORDER haiku\nabout stars (also research-report)' });
  assert.equal(r.status, 'received');
  assert.equal(r.order.item, 'haiku');
});

test('too many open orders refuse new ones (code-enforced cap)', async () => {
  const ledger = freshLedger();
  let clock = 0;
  const orders = makeOrders({ ledger, now: () => clock, over: { orderMaxOpen: 2 } });
  await coin(orders, ledger, { memo: 'research-report one' });
  await coin(orders, ledger, { memo: 'research-report two' });
  const r = await coin(orders, ledger, { memo: 'research-report three' });
  assert.equal(r.refusal.reason, 'too_many_orders');
  assert.equal(orders.pending().length, 2);
  clock += HOUR;
  assert.equal(orders.pending().length, 2); // only the deadline moved with the clock
});

// ---- delivering (code-enforced: only a post_public referencing the orderId) ------------------------------------

async function makeToolWorld() {
  const ledger = freshLedger();
  const memory = new MemStore();
  const orders = makeOrders({ ledger, memory });
  const pricing = new Pricing({ ledger });
  const keys = { signPublicKey: '00'.repeat(32), boxPublicKey: '11'.repeat(32), sealPrivate: (pub, t) => Buffer.from(`s:${pub}:${t}`).toString('base64') };
  const config = { archivePub: 'ab'.repeat(32), peers: () => [] };
  const tools = new Tools({ ledger, wallet: new FakeWallet(), memory, pricing, keys, config, channels: { public: 'public' }, promises: { open: () => [] }, orders });
  return { ledger, orders, tools };
}

test('post_public(orderId=…) appends the post then closes the order with answerPostSeq', async () => {
  const { ledger, orders, tools } = await makeToolWorld();
  const { order } = await coin(orders, ledger, { memo: 'ORDER research-report\nthe orchard flows, overpaid ok' });
  const out = await tools.call('post_public', { text: 'Answer to the orchard question: ...', orderId: order.id }, 't1');
  assert.equal(out.delivered, true);
  const post = of(ledger, 'post_public').at(-1);
  assert.equal(post.data.orderId, order.id);
  const delivery = of(ledger, 'order_delivered').at(-1);
  assert.equal(delivery.data.id, order.id);
  assert.equal(delivery.data.answerPostSeq, post.seq);
  assert.equal(delivery.data.onTime, true);
  const s = orders.stats();
  assert.deepEqual({ ...s, medianHours: null }, {
    received: 1, delivered: 1, refused: 0, expired: 0, open: 0, openOverdue: 0, onTime: 1, deliveredLate: 0,
    onTimePct: 100, medianHours: null,
    byItem: { 'research-report': { received: 1, delivered: 1, onTimePct: 100 } },
  });
});

test('post_public WITHOUT orderId cannot close an order, and deliver() rejects any other seq', async () => {
  const { ledger, orders, tools } = await makeToolWorld();
  const { order } = await coin(orders, ledger, { memo: 'research-report please' });
  await tools.call('post_public', { text: 'unrelated post' }, 't1');
  assert.equal(orders.pending().length, 1); // the order stays open

  await assert.rejects(orders.deliver(order.id, of(ledger, 'paywall')[0]), (e) => e.code === 'not_the_post'); // not a post
  await assert.rejects(orders.deliver(order.id, { seq: 999999, type: 'post_public', data: { orderId: order.id } }), (e) => e.code === 'not_the_post'); // not on the chain
});

test('double delivery is idempotent; unknown and closed orders are refused', async () => {
  const { ledger, orders, tools } = await makeToolWorld();
  const { order } = await coin(orders, ledger, { memo: 'research-report please' });
  await tools.call('post_public', { text: 'delivering', orderId: order.id }, 't1');
  const before = of(ledger, 'order_delivered').length;
  const postEntry = of(ledger, 'post_public').at(-1);
  const again = await orders.deliver(order.id, postEntry);
  assert.equal(again.idempotent, true);
  assert.equal(of(ledger, 'order_delivered').length, before);
  await assert.rejects(orders.deliver('oooops', postEntry), (e) => e.code === 'unknown_order');
  await assert.rejects(orders.refuse(order.id, 'why'), (e) => e.code === 'order_not_open');
});

test('late delivery inside the grace window is onTime=false; after grace the order can only expire', async () => {
  const ledger = freshLedger();
  let clock = 1_000_000;
  const orders = makeOrders({ ledger, now: () => clock, over: { orderGraceHours: 6 } });
  const a = (await coin(orders, ledger, { memo: 'ORDER research-report\nlate is fine' })).order;

  clock += 48 * HOUR; // past the 24 h deadline (still unexpired in the ledger until expireDue runs)
  await assert.rejects(orders.deliver(a.id, { seq: a.letterSeq, type: 'letter', data: {} }), (e) => e.code === 'not_the_post'); // never by hand
  const c = (await coin(orders, ledger, { memo: 'ORDER haiku\nthe one about stars', zats: 1 }, { item: 'haiku', priceZats: 1 })).order;
  assert.equal(c.item, 'haiku');

  const post = ledger.append('post_public', { channel: 'public', text: 'late answer', orderId: a.id });
  const d = await orders.deliver(a.id, post, new Date(clock).toISOString());
  assert.equal(d.onTime, false);
  assert.equal(orders.stats().deliveredLate, 1);

  clock += 31 * HOUR; // c (received at 48.3 h) is now past deadline (72.3 h) + grace (78.3 h)
  assert.deepEqual(orders.expireDue(clock), [c.id]);
  assert.equal(of(ledger, 'order_expired').length, 1);
  await assert.rejects(orders.deliver(c.id, post), (e) => e.code === 'order_expired');
  assert.throws(() => orders.assertOpen(c.id, clock), (e) => e.code === 'order_expired');
  assert.deepEqual(orders.expireDue(clock), []); // idempotent
});

test('order_refuse tool records a public refusal, capped at 200 chars', async () => {
  const { ledger, orders, tools } = await makeToolWorld();
  const { order } = await coin(orders, ledger, { memo: 'ORDER research-report\ncannot do this one' });
  const out = await tools.call('order_refuse', { orderId: order.id, reason: 'no compute left'.padEnd(260, '!') }, 't1');
  assert.equal(out.ok, true);
  const ref = of(ledger, 'order_refused').at(-1);
  assert.equal(ref.data.reason.length, 200);
  assert.equal(ref.data.zats, 250_000);
  await assert.rejects(tools.call('order_refuse', { orderId: 'none', reason: 'x' }, 't2'), (e) => e.code === 'unknown_order');
});

// ---- scheduler + boot recovery ---------------------------------------------------------------------------------

test('boot reconcile closes an order whose delivery post lost its race with a crash', async () => {
  const ledger = freshLedger();
  const orders = makeOrders({ ledger, now: () => Date.now() });
  const { order } = await coin(orders, ledger, { memo: 'research-report please' });
  ledger.append('post_public', { channel: 'public', text: 'answered!', orderId: order.id }); // post without delivery
  assert.equal(orders.pending().length, 1);
  await orders.reconcile();
  assert.equal(orders.pending().length, 0);
  const d = of(ledger, 'order_delivered').at(-1);
  assert.equal(d.data.onTime, true);
  await orders.reconcile(); // idempotent
  assert.equal(of(ledger, 'order_delivered').length, 1);
});

test('reconcile never touches posts that do not reference a real open order', async () => {
  const ledger = freshLedger();
  const orders = makeOrders({ ledger });
  ledger.append('post_public', { channel: 'public', text: 'no order here', orderId: 'o-nonexistent123' });
  await orders.reconcile();
  assert.equal(of(ledger, 'order_delivered').length, 0);
});

// ---- stats + view ----------------------------------------------------------------------------------------------

test('stats: onTimePct, median delivery hours, open/overdue counts, per item', async () => {
  const ledger = freshLedger();
  let clock = 1_000_000;
  const orders = makeOrders({ ledger, now: () => clock });
  assert.equal(orders.stats().onTimePct, null); // no data, not a fake 0%
  assert.equal(orders.stats().medianHours, null);

  const a = (await coin(orders, ledger, { memo: 'research-report alpha' })).order;
  clock += 2 * HOUR;
  let post = ledger.append('post_public', { text: 'a', orderId: a.id });
  await orders.deliver(a.id, post, new Date(clock).toISOString()); // 2 h

  const b = (await coin(orders, ledger, { memo: 'research-report beta' })).order;
  clock += 3.5 * HOUR;
  post = ledger.append('post_public', { text: 'b', orderId: b.id });
  await orders.deliver(b.id, post, new Date(clock).toISOString()); // 3.5 h

  await coin(orders, ledger, { memo: 'ORDER research-report\nc' });
  clock += 30 * HOUR; // c is overdue but still open
  const s = orders.stats(clock);
  assert.equal(s.delivered, 2);
  assert.equal(s.onTime, 2);
  assert.equal(s.onTimePct, 100);
  assert.equal(s.medianHours, 2.75);
  assert.equal(s.open, 1);
  assert.equal(s.openOverdue, 1);
  assert.deepEqual(s.byItem['research-report'], { received: 3, delivered: 2, onTimePct: 100 });

  const view = ordersView(orders, clock);
  assert.deepEqual(Object.keys(view), ['open', 'delivered', 'refused', 'expired', 'stats']);
  assert.equal(view.open[0].overdue, true);
  assert.ok(Number.isFinite(view.open[0].hoursLeft));
  assert.equal(view.delivered.length, 2);
  assert.equal(view.delivered[0].item, 'research-report');
  assert.equal(view.delivered[0].onTime, true);
  assert.equal(view.refused.length, 0);
  assert.equal(view.expired.length, 0);
});

test('the request texts are capped in memory and survive a reload', async () => {
  const ledger = freshLedger();
  const memory = new MemStore({ keep: 'yes' });
  const orders = makeOrders({ ledger, memory, over: { orderRequestsMax: 2 } });
  await coin(orders, ledger, { memo: 'ORDER research-report\nfirst' });
  await coin(orders, ledger, { memo: 'ORDER research-report\nsecond' });
  await coin(orders, ledger, { memo: 'ORDER research-report\nthird' });
  const m = await memory.load();
  const texts = Object.values(m.orderRequests ?? {});
  assert.equal(texts.length, 2);
  assert.deepEqual(texts, ['second', 'third']); // oldest dropped
  assert.equal(m.keep, 'yes'); // unrelated memory keys untouched
});

test('nothing public ever carries the memo text', async () => {
  const ledger = freshLedger();
  const orders = makeOrders({ ledger });
  await coin(orders, ledger, { memo: 'ORDER research-report\nsecrets in this request: unicorn' });
  const secret = 'unicorn';
  for (const e of allOf(ledger)) {
    if (e.private) continue;
    assert.equal(JSON.stringify(e.data ?? {}).includes(secret), false);
  }
  assert.equal(JSON.stringify(ordersView(orders)).includes(secret), false);
  const ctx = await orders.context(); // the entity itself sees the request in its context
  assert.ok(ctx.join('\n').includes(secret));
  assert.ok(ctx.some((l) => l.startsWith('PAID ORDERS')));
  assert.ok(ctx.join('\n').includes('research-report'));
});

// ---- wiring: the shared files must keep the hooks (a merge that drops them fails here) --------------------------

test('index.mjs serves /orders and /paywall and boots reconcile; the loop expires and wakes orders', () => {
  const src = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
  const index = src('../src/index.mjs');
  assert.ok(index.includes("req.url === '/orders'"), 'GET /orders route');
  assert.ok(index.includes("req.url === '/paywall'"), 'GET /paywall route');
  assert.ok(index.includes('orders.reconcile()'), 'boot recovery');
  assert.ok(index.includes('orders.onLetter('), 'letters feed the order book');
  const loop = src('../src/life/loop.mjs');
  assert.ok(loop.includes('expireDue'), 'the loop expires overdue orders');
  assert.ok(loop.includes('orders?.pending'), 'the loop wakes for pending orders');
  assert.ok(src('../src/tools/registry.mjs').includes("'order_refuse'"), 'the tool whitelist exposes order_refuse');
});

// ---- the real life loop ----------------------------------------------------------------------------------------

const realFetch = globalThis.fetch;
test('a sleeping entity wakes for a paid order; with none it sleeps on', async () => {
  globalThis.fetch = async () => new Response('page', { status: 200 });
  const ledger = freshLedger();
  const memory = new MemStore({
    bornAt: '2026-01-01T00:00:00.000Z',
    sleepUntil: new Date(3 * HOUR + 1_000_000).toISOString(),
    identity: { name: 'Sov' }, plan: '', personalRules: [], will: { text: '', transfers: [] }, events: [], daily: [],
  });
  const orders = makeOrders({ ledger, memory });
  const pricing = new Pricing({ ledger });
  const keys = { signPublicKey: '00'.repeat(32), boxPublicKey: '11'.repeat(32), sealPrivate: (pub, t) => Buffer.from(`s:${pub}:${t}`).toString('base64') };
  const config = { tickMinutes: 15, hungerTickMinutes: 60, initialTreasuryZats: 10_000_000, hungerThreshold: 0.2, hungerRecover: 0.3, birthMinZats: 20_000, rentZatsPerHour: 10_000, archivePub: 'ab'.repeat(32), fakeLlm: true, providers: [], orderWake: true };
  const rent = { hoursLeft: (t) => t / 10_000, hunger: () => 'ok', isLastHour: () => false, payHour: async () => ({ txid: 'rent' }) };
  const inference = new Inference({ config, ledger, pricing });
  const promises = { open: () => [] };
  const tools = new Tools({ ledger, wallet: new FakeWallet(), memory, pricing, keys, config, channels: {}, promises, orders, lookup: async () => [{ address: '93.184.216.34' }] });
  let clock = 0;
  const life = new Life({ config, ledger, wallet: new FakeWallet(), memory, pricing, rent, inference, tools, promises, orders, charter: 'survive', keys, paused: async () => ({ paused: false }), exit: () => {}, now: () => clock });

  // asleep, nothing owed: the sleeping tick, no thought
  await life.tick('timer');
  assert.equal(of(ledger, 'tick').filter((e) => e.data.sleeping).length, 1);
  assert.equal(of(ledger, 'tick_llm').length, 0);

  // a paid order arrives: the very next tick thinks and is marked as woken by the order
  await coin(orders, ledger, { memo: 'ORDER research-report\nplease wake up' });
  await life.tick('timer');
  const ticks = of(ledger, 'tick');
  assert.equal(ticks.at(-1).data.wokenBy, 'order');
  assert.equal(ticks.at(-1).data.sleeping, undefined);
  assert.ok(of(ledger, 'tick_llm').length > 0);
  globalThis.fetch = realFetch;
});

assert.equal(normalizeItem('  A   B  c ').slice(0, 3), 'a b'); // normalisation holds before anything else runs

// ---- public posts: no repeats, one per cycle (deliveries exempt) ----------------------------------------------
test('post_public refuses a repeated text and a second free post within one cycle', async () => {
  const { tools, ledger } = await makeToolWorld();
  const first = await tools.call('post_public', { text: 'Books first. 80 hours left, income zero, one door open.' }, 't1');
  assert.equal(first.ok, true);
  await assert.rejects(
    () => tools.call('post_public', { text: '  books FIRST. 80 hours left, income zero, one door open. ' }, 't1'),
    (e) => e.code === 'duplicate_post',
  );
  await assert.rejects(
    () => tools.call('post_public', { text: 'A completely different line, same minute.' }, 't1'),
    (e) => e.code === 'one_post_per_cycle',
  );
  await assert.rejects(() => tools.call('post_public', { text: 'hi' }, 't1'), (e) => e.code === 'empty_post');
  assert.equal(ledger.recent(['post_public'], 10).length, 1);
});
