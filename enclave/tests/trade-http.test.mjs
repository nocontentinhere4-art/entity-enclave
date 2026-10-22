import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeTrades, orderDetail } from '../src/trade/stats.mjs';
import { tradesHttp } from '../src/trade/http.mjs';
import {
  FIXTURES,
  MINT,
  U1,
  buyMemo,
  makeClock,
  makeEngine,
  makeIntents,
  makeJupiter,
  makeSolana,
  makeTreasury,
  makeZcash,
  runPasses,
  tempDir,
} from './fixtures/harness.mjs';
import { TOKEN_PROGRAM_ID } from '../src/trade/types.mjs';

const ISO = '2026-10-22T10:00:00.000Z';
const entry = (type, data, ts = ISO) => ({ type, data, ts });

// A ledger that tells one closed story: received → open → fee(open) → close → payout → fee(close).
function fixtureLedger() {
  return [
    entry('order_received', { orderId: 'o1', zats: 100_000_000, mint: MINT, symbol: 'JUP', targetPct: 25, stopPct: 10, maxHoldHours: 168, clientRef: 'c1', txid: 'tx-open' }),
    entry('trade_open', { orderId: 'o1', mint: MINT, solIn: '98000000', tokenOut: '123456789', decimals: 6, price: '0.0008', txid: 'buy-sig', at: ISO }),
    entry('fee', { orderId: 'o1', zats: 1_000_000, leg: 'open' }),
    entry('trade_close', { orderId: 'o1', reason: 'target', solOut: '101500000', price: '0.00104', txid: 'sell-sig', heldMs: 3_600_000, wallet: 'discarded' }),
    entry('payout', { orderId: 'o1', zats: 105_000_000, txid: 'payout-tx' }),
    entry('fee', { orderId: 'o1', zats: 2_000_000, leg: 'close', sol: 1_015_000 }),
  ];
}

function makeRes() {
  return {
    headers: {},
    status: 0,
    body: '',
    setHeader(k, v) { this.headers[k] = v; },
    writeHead(code) { this.status = code; },
    end(text) { this.body = text; },
  };
}

test('summarizeTrades: counts, fees, win rate and recent return from ledger entries only', () => {
  const s = summarizeTrades(fixtureLedger(), { recentLimit: 20 });
  assert.equal(s.open, 0);
  assert.equal(s.closed, 1);
  assert.equal(s.refunded, 0);
  assert.equal(s.failed, 0);
  assert.equal(s.feesZats, 3_000_000); // open + close
  assert.equal(s.feesZatsOpen, 0); // no open order left
  assert.equal(s.winRate, 1); // payout + close fee > zatsIn
  assert.equal(s.medianHoldMs, 3_600_000);
  assert.deepEqual(s.byReason, { target: 1 });
  assert.equal(s.recent.length, 1);
  assert.equal(s.recent[0].orderId, 'o1');
  assert.equal(s.recent[0].state, 'closed');
  assert.equal(s.recent[0].reason, 'target');
  assert.equal(s.recent[0].returnPct, 7.0);
});

test('summarizeTrades: refunded and failed orders never count as open', () => {
  const entries = [
    entry('order_received', { orderId: 'o1', zats: 100_000_000, mint: MINT }),
    entry('order_received', { orderId: 'o2', zats: 100_000_000, mint: MINT }),
    entry('refund', { orderId: 'o1', zats: 98_990_000, reason: 'bridge_failed' }),
    entry('trade_failed', { orderId: 'o2', stage: 'buy', code: 'buy_failed' }),
  ];
  const s = summarizeTrades(entries);
  assert.equal(s.open, 0);
  assert.equal(s.closed, 0);
  assert.equal(s.refunded, 1);
  assert.equal(s.failed, 1);
});

test('orderDetail: exact, secret-free key set for a closed order', () => {
  const d = orderDetail('o1', { entries: fixtureLedger() });
  assert.equal(d.orderId, 'o1');
  assert.equal(d.state, 'closed');
  assert.equal(d.mint, MINT);
  assert.equal(d.symbol, 'JUP');
  assert.equal(d.reason, 'target');
  assert.equal(d.payoutZats, 105_000_000);
  assert.deepEqual(d.txids, { open: 'buy-sig', close: 'sell-sig' });
  // The plan §8 projection has exactly these keys — and none of the sealed client fields.
  assert.deepEqual(Object.keys(d).sort(), [
    'closedAt', 'currentPrice', 'decimals', 'entryPrice', 'heldMs', 'mint', 'openedAt',
    'orderId', 'payoutZats', 'reason', 'solIn', 'state', 'stopPct', 'symbol', 'targetPct',
    'tokenOut', 'txids', 'unrealizedPct',
  ]);
});

test('orderDetail: unknown id is null (→ 404)', () => {
  assert.equal(orderDetail('oNOPE', { entries: fixtureLedger() }), null);
});

test('tradesHttp: disabled desk returns the enabled:false stub', async () => {
  const res = makeRes();
  await tradesHttp().serve({ url: '/trades' }, res, { trades: null });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { enabled: false, open: 0, closed: 0 });
});

test('tradesHttp: unknown order id is a 404', async () => {
  const trades = { async orderInfo() { return null; } };
  const res = makeRes();
  await tradesHttp().serve({ url: '/trades/oNOPE' }, res, { trades });
  assert.equal(res.status, 404);
  assert.deepEqual(JSON.parse(res.body), { error: 'not_found' });
});

test('tradesHttp: /trades/<id> passes orderInfo through and omits secrets', async () => {
  const detail = orderDetail('o1', { entries: fixtureLedger() });
  const trades = { async orderInfo(id) { return id === 'o1' ? detail : null; } };
  const res = makeRes();
  await tradesHttp().serve({ url: '/trades/o1' }, res, { trades });
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.orderId, 'o1');
  assert.equal(body.state, 'closed');
  for (const forbidden of ['secret', 'auth6', 'clientRef', 'returnAddress', 'solSecretKey', 'depositAddress', 'depositMemo']) {
    assert.equal(res.body.includes(forbidden), false, `projection must not leak ${forbidden}`);
  }
});

test('tradesHttp: /trades is cached for the ttl, then re-reads', async () => {
  let now = 1_000;
  let calls = 0;
  const trades = { async publicStatus() { calls++; return { enabled: true, open: calls, closed: 0 }; } };
  const view = tradesHttp({ now: () => now, ttlMs: 5_000 });
  const r1 = makeRes(); await view.serve({ url: '/trades' }, r1, { trades });
  const r2 = makeRes(); await view.serve({ url: '/trades' }, r2, { trades });
  assert.equal(calls, 1); // second read hits the cache
  assert.equal(JSON.parse(r1.body).open, 1);
  assert.equal(JSON.parse(r2.body).open, 1);
  now += 6_000; // past the ttl
  const r3 = makeRes(); await view.serve({ url: '/trades' }, r3, { trades });
  assert.equal(calls, 2);
  assert.equal(JSON.parse(r3.body).open, 2);
});

// Integration: the mocked engine runs a full open → close → payout, and the HTTP projection is secret-free.
const TOKEN = {
  id: MINT,
  symbol: 'JUP',
  decimals: 6,
  isVerified: true,
  liquidity: 1_000_000,
  tokenProgram: TOKEN_PROGRAM_ID,
  audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: 10 },
};

test('integration: engine lifecycle projects through /trades without leaking secrets', async () => {
  const dir = tempDir('http-int-');
  const clock = makeClock();
  const zcash = makeZcash({ zats: 2_000_000_000 });
  const solana = makeSolana({ defaultBalance: 98_000_000 });
  const jupiter = makeJupiter({ token: TOKEN });
  const treasury = makeTreasury();
  const intents = makeIntents({ statuses: FIXTURES.oneclickStatus.open });
  const { engine, store, ledger } = makeEngine({
    dir, clock, zcash, solana, jupiter, treasury, intents,
    config: { maxOpen: 5, maxPerClient: 5, rentReserveHours: 0 },
  });

  // Open.
  const ingest = await engine.ingest({ txid: 'tx-open', zats: 100_000_000, text: buyMemo(U1) });
  assert.equal(ingest.status, 'accepted');
  await runPasses(engine, 12);
  let state = await store.load();
  const orderId = ingest.orderId;
  const pub = state.orders[orderId].secret.solPublicKey;
  assert.equal(state.orders[orderId].state, 'holding');

  // Target hit → close → payout.
  solana.accounts.set(pub, [{ mint: MINT, amount: '125000000', decimals: 6 }]);
  solana.defaultBalance = 101_500_000;
  jupiter.price = Number(state.orders[orderId].entry.price) * 1.3;
  await engine.runOnce();
  await engine.runOnce();
  await runPasses(engine, 12);
  state = await store.load();
  assert.equal(state.orders[orderId].state, 'closed');
  assert.equal(state.orders[orderId].secret, null);

  // The whole public chain, plus the projected views, never carry the client address or the wallet key.
  const publicJson = JSON.stringify(ledger.public());
  assert.equal(publicJson.includes(U1), false);
  assert.equal(publicJson.includes(pub), false);

  const status = await engine.publicStatus();
  assert.equal(status.enabled, true);
  assert.equal(status.open, 0);
  assert.equal(status.closed, 1);

  const detail = await engine.orderInfo(orderId);
  assert.equal(detail.state, 'closed');
  assert.equal(detail.payoutZats, 2_400_000);

  // Serve both endpoints through the real HTTP layer.
  const view = tradesHttp();
  const listRes = makeRes();
  await view.serve({ url: '/trades' }, listRes, { trades: engine });
  assert.equal(listRes.status, 200);
  assert.equal(JSON.parse(listRes.body).closed, 1);

  const oneRes = makeRes();
  await view.serve({ url: `/trades/${orderId}` }, oneRes, { trades: engine });
  assert.equal(oneRes.status, 200);
  const body = oneRes.body;
  for (const secret of [U1, pub, state.orders[orderId]?.secret, FIXTURES.oneclickQuote.response.quote.depositAddress]) {
    if (secret == null) continue;
    assert.equal(body.includes(String(secret)), false, 'HTTP projection must not leak a secret');
  }
});
