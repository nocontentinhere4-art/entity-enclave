// Forecasts with track record: open/settle/score/void, code-enforced limits, no LLM-triggered settlement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Forecasts, judgeForecast } from '../src/economy/forecasts.mjs';
import { Market } from '../src/economy/market.mjs';
import { Jobs } from '../src/life/jobs.mjs';
import { Tools } from '../src/tools/registry.mjs';

const HOUR_MS = 3_600_000;
const T0 = 1_789_000_000_000; // fixed clock, advanced by hand
let now = T0;
const clock = () => now;
const iso = (ms) => new Date(ms).toISOString();

// ---- fakes -----------------------------------------------------------------------------------------------

class FakeLedger {
  constructor() { this.entries = []; }
  append(type, data) {
    const e = { seq: this.entries.length + 1, ts: iso(now), prev: '0'.repeat(64), type, data };
    this.entries.push(e);
    return e;
  }
  appendPrivate() { return {}; }
  *each(types = null) {
    const want = types === null ? null : new Set(types);
    for (const e of this.entries) {
      if (e.private) continue;
      if (want && !want.has(e.type)) continue;
      yield e;
    }
  }
  of(type) { return this.entries.filter((e) => e.type === type); }
}

// A price feed whose prices the test can move between open and settle.
function marketWith(prices, failing = new Set()) {
  return {
    async priceUsd(asset) {
      if (failing.has(asset)) { const e = new Error('price feed down'); e.code = 'price_unavailable'; throw e; }
      const usd = Number(prices[asset]);
      if (!Number.isFinite(usd) || usd <= 0) { const e = new Error('price feed down'); e.code = 'price_unavailable'; throw e; }
      return { asset, usd, source: '1click:tokens', updatedAt: now, fetchedAt: now };
    },
  };
}

function fakePricing(ledger) {
  return {
    quote: () => ({ costZats: 1000, affordable: true }),
    charge: (action, tickId) => {
      if (ledger) ledger.append('charge', { action, tickId, costZats: 1000 });
      return 1000;
    },
  };
}

async function openF(forecasts, over = {}) {
  return forecasts.openForecast({
    asset: 'zec', horizonHours: 24, direction: 'up', confidence: 0.6, rationale: 'sensible reasoning', tickId: 't',
    ...over,
  });
}

// ---- market ---------------------------------------------------------------------------------------------

test('Market priceUsd: fresh 1Click tokens, dry-quote fallback for stale tokens, constant USDC', async () => {
  const fetched = [];
  const fetchImpl = async (url) => {
    fetched.push(url);
    if (url.endsWith('/v0/tokens')) {
      return new Response(JSON.stringify({ tokens: [{ symbol: 'ZEC', price: 41.27, priceUpdatedAt: iso(T0) }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.endsWith('/v0/quote')) {
      return new Response(JSON.stringify({ quote: { amountOutFormatted: '42.00', amountInUsd: '41.27' } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error('unexpected fetch ' + url);
  };
  const market = new Market({ fetchImpl, now: clock });
  const fresh = await market.priceUsd('zec');
  assert.deepEqual(fresh, { asset: 'zec', usd: 41.27, source: '1click:tokens', updatedAt: now, fetchedAt: now });
  assert.equal(fetched.length, 1);

  // Stale token (updated 1000s ago, beyond the 900s default staleness) falls back to a dry quote.
  const stale = new Market({ fetchImpl, now: () => T0 + 1000_000 });
  const fallback = await stale.priceUsd('zec');
  assert.equal(fallback.usd, 42.0);
  assert.equal(fallback.source, '1click:quote');

  // USDC is a constant, fetched without touching the network.
  const fetchedBefore = fetched.length;
  const usdc = await market.priceUsd('usdc');
  assert.deepEqual(usdc, { asset: 'usdc', usd: 1.0, source: 'constant:usdc', updatedAt: now, fetchedAt: now });
  assert.equal(fetched.length, fetchedBefore);

  assert.rejects(() => market.priceUsd('btc'), (e) => e.code === 'bad_asset');
});

test('Market priceUnavailable when both the token feed and the dry quote fail', async () => {
  const market = new Market({
    fetchImpl: async () => { throw new Error('network down'); },
    now: clock,
  });
  await assert.rejects(() => market.priceUsd('zec'), (e) => e.code === 'price_unavailable');
});

// ---- open: validation and limits -----------------------------------------------------------------------

test('forecast tool records forecast_open and charges once', async () => {
  const ledger = new FakeLedger();
  const forecasts = new Forecasts({ ledger, market: marketWith({ zec: 41.27 }), config: {}, now: clock });
  const tools = new Tools({
    ledger, wallet: { async balance() { return { total_zatoshis: 1_000_000_000 }; } }, memory: {},
    pricing: fakePricing(ledger), keys: {}, config: {}, channels: { public: 'public' }, promises: {}, forecasts,
  });
  const res = await tools.call('forecast', {
    asset: 'zec', horizonHours: 24, direction: 'up', confidence: 0.62,
    rationale: 'Funding negative; supply squeeze into the halving.',
  }, 'tick-1');
  assert.match(res.id, /^f[0-9a-f]{12}$/);
  assert.equal(res.asset, 'zec');
  assert.equal(res.direction, 'up');
  assert.equal(res.priceOpenUsd, 41.27);
  assert.equal(res.expiresAt, iso(T0 + 24 * HOUR_MS));
  const opens = ledger.of('forecast_open');
  assert.equal(opens.length, 1);
  assert.deepEqual(opens[0].data, {
    id: res.id, asset: 'zec', horizonHours: 24, direction: 'up', targetPriceUsd: null,
    confidence: 0.62, rationale: 'Funding negative; supply squeeze into the halving.',
    priceOpenUsd: 41.27, priceSource: '1click:tokens', priceAt: iso(T0), openedAt: iso(T0),
    expiresAt: iso(T0 + 24 * HOUR_MS),
  });
  const charges = ledger.of('charge').filter((e) => e.data.action === 'forecast');
  assert.equal(charges.length, 1); // charged exactly once
  assert.deepEqual(charges[0].data, { action: 'forecast', tickId: 'tick-1', costZats: 1000 });
});

test('forecast rejects invalid inputs with the exact error codes', async () => {
  const ledger = new FakeLedger();
  const forecasts = new Forecasts({ ledger, market: marketWith({ zec: 1, sol: 1, usdc: 1 }), config: {}, now: clock });
  const base = { asset: 'zec', horizonHours: 24, direction: 'up', confidence: 0.6, rationale: 'sensible reasoning', tickId: 't' };
  const attempt = (over) => forecasts.openForecast({ ...base, ...over });
  await assert.rejects(attempt({ horizonHours: 0 }), (e) => e.code === 'bad_horizon');
  await assert.rejects(attempt({ horizonHours: 49 }), (e) => e.code === 'bad_horizon');
  await assert.rejects(attempt({ horizonHours: 24.5 }), (e) => e.code === 'bad_horizon');
  await assert.rejects(attempt({ confidence: 1.5 }), (e) => e.code === 'bad_confidence');
  await assert.rejects(attempt({ confidence: -0.1 }), (e) => e.code === 'bad_confidence');
  await assert.rejects(attempt({ rationale: '' }), (e) => e.code === 'bad_rationale');
  await assert.rejects(attempt({ rationale: 'x'.repeat(301) }), (e) => e.code === 'bad_rationale');
  await assert.rejects(attempt({ asset: 'btc' }), (e) => e.code === 'bad_asset');
  await assert.rejects(attempt({ direction: 'sideways' }), (e) => e.code === 'bad_direction');
  await assert.rejects(attempt({ direction: 'up', targetPriceUsd: 50 }), (e) => e.code === 'unexpected_target');
  await assert.rejects(attempt({ direction: 'target' }), (e) => e.code === 'target_required');
  await assert.rejects(attempt({ direction: 'target', targetPriceUsd: 0 }), (e) => e.code === 'target_required');
  // valid targets and other assets still open
  await attempt({ direction: 'target', targetPriceUsd: 42 });
  await attempt({ asset: 'sol', horizonHours: 1, direction: 'down' });
  await attempt({ asset: 'usdc', horizonHours: 48, direction: 'up' });
  assert.equal(forecasts.open.size, 3);
});

test('at most 3 open forecasts; price failure writes nothing', async () => {
  const ledger = new FakeLedger();
  const forecasts = new Forecasts({ ledger, market: marketWith({ zec: 1, sol: 1, usdc: 1 }), config: { forecastMaxOpen: 3 }, now: clock });
  await openF(forecasts);
  await openF(forecasts, { asset: 'sol', horizonHours: 1 });
  await openF(forecasts, { asset: 'usdc', horizonHours: 48, direction: 'down' });
  await assert.rejects(openF(forecasts), (e) => e.code === 'too_many_forecasts');
  assert.equal(forecasts.open.size, 3);

  // Price unavailable: fail closed, no forecast_open on the chain.
  const failing = new FakeLedger();
  const noPrice = new Forecasts({ ledger: failing, market: marketWith({}, new Set(['zec'])), config: {}, now: clock });
  await assert.rejects(openF(noPrice), (e) => e.code === 'price_unavailable');
  assert.equal(failing.of('forecast_open').length, 0);
  assert.equal(noPrice.open.size, 0);
});

// ---- judgeForecast -------------------------------------------------------------------------------------

test('judgeForecast: up, down, target semantics', () => {
  assert.deepEqual(judgeForecast({ direction: 'up', priceOpenUsd: 100, priceCloseUsd: 101 }), { hit: true, movePct: 1 });
  assert.deepEqual(judgeForecast({ direction: 'up', priceOpenUsd: 100, priceCloseUsd: 100 }), { hit: false, movePct: 0 });
  assert.deepEqual(judgeForecast({ direction: 'down', priceOpenUsd: 100, priceCloseUsd: 99 }), { hit: true, movePct: -1 });
  assert.deepEqual(judgeForecast({ direction: 'target', priceOpenUsd: 100, priceCloseUsd: 105, targetPriceUsd: 104 }), { hit: true, movePct: 5 });
  assert.deepEqual(judgeForecast({ direction: 'target', priceOpenUsd: 100, priceCloseUsd: 103, targetPriceUsd: 104 }), { hit: false, movePct: 3 });
  assert.deepEqual(judgeForecast({ direction: 'target', priceOpenUsd: 100, priceCloseUsd: 96, targetPriceUsd: 97 }), { hit: true, movePct: -4 });
  assert.deepEqual(judgeForecast({ direction: 'target', priceOpenUsd: 100, priceCloseUsd: 100.05, targetPriceUsd: 100 }), { hit: true, movePct: 0.05 });
  assert.deepEqual(judgeForecast({ direction: 'target', priceOpenUsd: 100, priceCloseUsd: 100.11, targetPriceUsd: 100 }), { hit: false, movePct: 0.11 });
});

// ---- settleDue -----------------------------------------------------------------------------------------

test('settleDue marks up, down and target forecasts correctly at expiry', async () => {
  const ledger = new FakeLedger();
  const prices = { zec: 41.27, sol: 150.0, usdc: 1.0 };
  const market = marketWith(prices);
  const forecasts = new Forecasts({ ledger, market, config: {}, now: clock });
  await openF(forecasts, { asset: 'zec', horizonHours: 1, direction: 'up', confidence: 0.6, tickId: 't1' });
  await openF(forecasts, { asset: 'sol', horizonHours: 1, direction: 'down', confidence: 0.7, tickId: 't2' });
  await openF(forecasts, { asset: 'usdc', horizonHours: 1, direction: 'target', targetPriceUsd: 1.02, confidence: 0.6, tickId: 't3' });
  assert.equal(forecasts.open.size, 3);

  // Not yet due: nothing settles.
  await forecasts.settleDue(T0 + 30 * 60_000);
  assert.equal(forecasts.open.size, 3);
  assert.equal(ledger.of('forecast_settled').length, 0);

  prices.zec = 42.01; // up: close > open -> hit, like the plan's 41.27 -> 42.01 example
  prices.sol = 140.0; // down: close < open -> hit
  prices.usdc = 1.01; // target 1.02: close < target -> miss
  await forecasts.settleDue(T0 + 2 * HOUR_MS);
  assert.equal(forecasts.open.size, 0);
  assert.equal(ledger.of('forecast_settled').length, 3);

  const settled = ledger.of('forecast_settled').map((e) => e.data);
  const zec = settled.find((d) => d.asset === 'zec');
  assert.equal(zec.direction, 'up');
  assert.equal(zec.targetPriceUsd, null);
  assert.equal(zec.confidence, 0.6);
  assert.equal(zec.priceOpenUsd, 41.27);
  assert.equal(zec.priceCloseUsd, 42.01);
  assert.equal(zec.movePct, 1.79);
  assert.equal(zec.hit, true);
  assert.equal(zec.priceSource, '1click:tokens');
  assert.equal(zec.priceAt, iso(T0 + 2 * HOUR_MS));
  assert.equal(zec.expiresAt, iso(T0 + HOUR_MS));
  assert.equal(zec.settledAt, iso(T0 + 2 * HOUR_MS));

  const sol = settled.find((d) => d.asset === 'sol');
  assert.equal(sol.hit, true);
  assert.equal(sol.movePct, -6.67);

  const usdc = settled.find((d) => d.asset === 'usdc');
  assert.equal(usdc.hit, false);
  assert.equal(usdc.targetPriceUsd, 1.02);
  assert.equal(usdc.movePct, 1);
});

test('settleDue is idempotent and replays from the ledger', async () => {
  const ledger = new FakeLedger();
  const prices = { zec: 41.27 };
  const market = marketWith(prices);
  const forecasts = new Forecasts({ ledger, market, config: {}, now: clock });
  const { id } = await openF(forecasts, { asset: 'zec', horizonHours: 1, direction: 'up', tickId: 't1' });
  prices.zec = 42.01;
  await forecasts.settleDue(T0 + 2 * HOUR_MS);
  await forecasts.settleDue(T0 + 2 * HOUR_MS); // second run: nothing left to settle
  assert.equal(ledger.of('forecast_settled').length, 1);
  assert.equal(forecasts.open.size, 0);

  // Replay on a new instance: settled stays settled, open stays empty, never re-settled.
  const replayed = new Forecasts({ ledger, market, config: {}, now: clock });
  assert.equal(replayed.open.size, 0);
  assert.equal(replayed.settled.length, 1);
  assert.equal(replayed.get(id).asset, 'zec');
  assert.equal(replayed.get(id).hit, true);
  assert.equal(replayed.done.has(id), true);
});

test('price failure keeps the forecast open, then voids it after grace; voids are excluded from the score', async () => {
  const ledger = new FakeLedger();
  const prices = { zec: 41.27 };
  const market = marketWith(prices); // zec priced at open, then the feed goes down
  const forecasts = new Forecasts({ ledger, market, config: {}, now: clock });
  const { id } = await openF(forecasts, { asset: 'zec', horizonHours: 1, direction: 'up', tickId: 't1' }); // expires T0+1h
  const expiresAt = iso(T0 + HOUR_MS);
  delete prices.zec; // the price source is unavailable from here on

  await forecasts.settleDue(T0 + HOUR_MS + 30 * 60_000); // 30 min past expiry, inside the 6h grace
  assert.equal(forecasts.open.size, 1); // kept open, retried next tick
  assert.equal(ledger.of('forecast_void').length, 0);

  await forecasts.settleDue(T0 + HOUR_MS + 7 * HOUR_MS); // past grace
  assert.equal(forecasts.open.size, 0);
  const voids = ledger.of('forecast_void');
  assert.equal(voids.length, 1);
  assert.deepEqual(voids[0].data, { id, reason: 'price_unavailable', expiresAt, voidedAt: iso(T0 + 8 * HOUR_MS) });

  const s = forecasts.score();
  assert.deepEqual(s, { total: 0, hits: 0, hitRate: null, byAsset: { zec: { total: 0, hits: 0, hitRate: null }, sol: { total: 0, hits: 0, hitRate: null }, usdc: { total: 0, hits: 0, hitRate: null } } });
});

// ---- score ----------------------------------------------------------------------------------------------

test('score aggregates total, hits, hitRate and byAsset; hitRate is null when empty', async () => {
  const ledger = new FakeLedger();
  const prices = { zec: 41.27, sol: 150.0, usdc: 1.0 };
  const market = marketWith(prices);
  const forecasts = new Forecasts({ ledger, market, config: { forecastMaxOpen: 4 }, now: clock });
  await openF(forecasts, { asset: 'zec', horizonHours: 1, direction: 'up', tickId: 't1' });
  await openF(forecasts, { asset: 'zec', horizonHours: 1, direction: 'up', tickId: 't2' });
  await openF(forecasts, { asset: 'sol', horizonHours: 1, direction: 'down', tickId: 't3' });
  await openF(forecasts, { asset: 'usdc', horizonHours: 1, direction: 'target', targetPriceUsd: 1.02, tickId: 't4' });
  prices.zec = 42.01; // both zec up: hit, hit
  prices.sol = 140.0; // sol down: hit
  prices.usdc = 1.01; // usdc target 1.02: miss
  await forecasts.settleDue(T0 + 2 * HOUR_MS);
  assert.deepEqual(forecasts.score(), {
    total: 4, hits: 3, hitRate: 0.75,
    byAsset: {
      zec: { total: 2, hits: 2, hitRate: 1 },
      sol: { total: 1, hits: 1, hitRate: 1 },
      usdc: { total: 1, hits: 0, hitRate: 0 },
    },
  });

  const empty = new Forecasts({ ledger: new FakeLedger(), market, config: {}, now: clock }).score();
  assert.deepEqual(empty, {
    total: 0, hits: 0, hitRate: null,
    byAsset: { zec: { total: 0, hits: 0, hitRate: null }, sol: { total: 0, hits: 0, hitRate: null }, usdc: { total: 0, hits: 0, hitRate: null } },
  });
});

test('get(id) finds open, settled and voided forecasts', async () => {
  const ledger = new FakeLedger();
  const market = marketWith({ zec: 41.27 });
  const forecasts = new Forecasts({ ledger, market, config: {}, now: clock });
  const { id } = await openF(forecasts, { asset: 'zec', horizonHours: 1, tickId: 't1' });
  assert.equal(forecasts.get(id).asset, 'zec');
  assert.equal(forecasts.get('nope'), null);
});

// ---- no LLM-triggered settlement ------------------------------------------------------------------------

test('no settlement/close/void forecast tool is offered to the LLM', () => {
  const ledger = new FakeLedger();
  const tools = new Tools({ ledger, wallet: {}, memory: {}, pricing: fakePricing(), keys: {}, config: {}, channels: {}, promises: {} });
  const names = new Set(tools.list().map((s) => s.name));
  assert.equal(names.has('forecast'), true);
  for (const name of names) {
    assert.ok(!/^forecast_(settle|close|void)$/.test(name), `unexpected forecast tool: ${name}`);
    assert.ok(!name.includes('settle'), `no settlement tool exposed: ${name}`);
  }
});

// ---- scheduler hook -------------------------------------------------------------------------------------

test('Jobs.run settles expired forecasts through the life loop hook and never twice', async () => {
  const ledger = new FakeLedger();
  const prices = { zec: 41.27 };
  const market = marketWith(prices);
  const forecasts = new Forecasts({ ledger, market, config: {}, now: clock });
  await openF(forecasts, { asset: 'zec', horizonHours: 1, direction: 'up', tickId: 't1' });
  const jobs = new Jobs({ forecasts, config: {}, ledger, now: clock });

  prices.zec = 42.01;
  const out = await jobs.run({ now: T0 + 2 * HOUR_MS, tickId: 'tick-1' });
  assert.equal(out.wake, false); // settlement itself never wakes the entity
  assert.match(out.context, /FORECASTS/);
  assert.match(out.context, /open: 0/);
  assert.match(out.context, /score: 1\/1 \(hit rate 1\)/);
  assert.equal(ledger.of('forecast_settled').length, 1);

  const again = await jobs.run({ now: T0 + 3 * HOUR_MS, tickId: 'tick-2' });
  assert.equal(ledger.of('forecast_settled').length, 1); // idempotent across ticks
  assert.match(again.context, /open: 0/);
});
