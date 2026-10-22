import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MINT,
  U1,
  U1B,
  buyMemo,
  makeClock,
  makeEngine,
  makeIntents,
  makeJupiter,
  makeSolana,
  makeStore,
  makeTreasury,
  makeZcash,
  tempDir,
} from './fixtures/harness.mjs';
import { TOKEN_PROGRAM_ID } from '../src/trade/types.mjs';

const GOOD_TOKEN = {
  id: MINT,
  symbol: 'JUP',
  decimals: 6,
  isVerified: true,
  liquidity: 1_000_000,
  tokenProgram: TOKEN_PROGRAM_ID,
  audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: 10 },
};

async function setup({ config = {}, token = GOOD_TOKEN } = {}) {
  const dir = tempDir('limits-');
  const clock = makeClock();
  const zcash = makeZcash({ zats: 2_000_000_000 });
  const solana = makeSolana();
  const treasury = makeTreasury();
  const intents = makeIntents();
  const jupiter = makeJupiter({ token });
  const { engine, store, ledger } = makeEngine({
    dir, clock, zcash, solana, treasury, intents, jupiter,
    config: { maxOpen: 5, maxOpenZats: 2_000_000_000, maxPerClient: 1, rentReserveHours: 24, ...config },
  });
  return { engine, store, ledger, zcash, jupiter, clock, intents };
}

async function seedOrder(store, clock, order) {
  const state = await store.load();
  state.orders[order.orderId] = {
    state: 'holding',
    createdAt: new Date(clock.now()).toISOString(),
    updatedAt: new Date(clock.now()).toISOString(),
    zatsIn: 10_000_000,
    swapZats: 9_900_000,
    clientRef: `seed-${order.orderId}`,
    ...order,
  };
  await store.save(state);
}

test('below min is refused and refunded to the client', async () => {
  const { engine, ledger, zcash } = await setup();
  const res = await engine.ingest({ txid: 'tx-small', zats: 5_000_000, text: buyMemo(U1) });
  assert.equal(res.status, 'rejected');
  assert.equal(res.code, 'below_min');
  assert.equal(zcash.sends.length, 1);
  assert.equal(zcash.sends[0].to, U1);
  assert.equal(zcash.sends[0].zats, 5_000_000 - 10_000); // network fee only: no order, no open fee
  assert.equal(ledger.entries.filter((e) => e.type === 'refund').length, 1);
});

test('above max is refused and refunded to the client', async () => {
  const { engine, ledger, zcash } = await setup({
    config: { minZats: 10_000_000, maxZats: 1_000_000_000 },
  });
  const res = await engine.ingest({ txid: 'tx-big', zats: 1_500_000_000, text: buyMemo(U1) });
  assert.equal(res.status, 'rejected');
  assert.equal(res.code, 'above_max');
  assert.equal(zcash.sends.length, 1);
  assert.equal(ledger.entries.filter((e) => e.type === 'refund').length, 1);
});

test('a sixth order is refused when maxOpen=5', async () => {
  const { engine, store, ledger, clock, zcash } = await setup({ config: { maxOpen: 5 } });
  for (let i = 0; i < 5; i++) {
    await seedOrder(store, clock, { orderId: `o${String(i).padStart(16, '0')}`, clientRef: `c${i}` });
  }
  const res = await engine.ingest({ txid: 'tx-six', zats: 12_000_000, text: buyMemo(U1) });
  assert.equal(res.status, 'rejected');
  assert.equal(res.code, 'max_open');
  assert.equal(zcash.sends.length, 1);
  assert.equal(ledger.entries.filter((e) => e.type === 'refund').length, 1);
});

test('a second order from the same clientRef is refused', async () => {
  const { engine, zcash } = await setup();
  const first = await engine.ingest({ txid: 'tx-first', zats: 12_000_000, text: buyMemo(U1) });
  assert.equal(first.status, 'accepted');
  const second = await engine.ingest({ txid: 'tx-second', zats: 12_000_000, text: buyMemo(U1) });
  assert.equal(second.status, 'rejected');
  assert.equal(second.code, 'client_limit');
  assert.equal(zcash.sends.length, 1);
  assert.equal(zcash.sends[0].to, U1);
});

test('the rent reserve blocks an order that would leave less than 24 h', async () => {
  const { engine, zcash } = await setup({ config: { rentReserveHours: 24 } });
  zcash.zats = 30_000_000; // 30 h at 1m/h, reserve is 24m, so a 10m order leaves 20m
  const res = await engine.ingest({ txid: 'tx-rent', zats: 10_000_000, text: buyMemo(U1) });
  assert.equal(res.status, 'rejected');
  assert.equal(res.code, 'rent_reserve');
  assert.equal(zcash.sends.length, 1);
});

test('reserved zats prevent two letters spending the same balance', async () => {
  const { engine, zcash } = await setup({ config: { rentReserveHours: 24, maxPerClient: 5 } });
  zcash.zats = 35_000_000;
  const first = await engine.ingest({ txid: 'tx-a', zats: 10_000_000, text: buyMemo(U1) });
  assert.equal(first.status, 'accepted');
  const second = await engine.ingest({ txid: 'tx-b', zats: 10_000_000, text: buyMemo(U1B) });
  assert.equal(second.status, 'rejected');
  assert.equal(second.code, 'rent_reserve');
});

for (const [name, patch, code] of [
  ['unverified', { isVerified: false }, 'token_unverified'],
  ['illiquid', { liquidity: 10 }, 'token_illiquid'],
  ['mint authority live', { audit: { ...GOOD_TOKEN.audit, mintAuthorityDisabled: false } }, 'token_mint_authority'],
  ['freeze authority live', { audit: { ...GOOD_TOKEN.audit, freezeAuthorityDisabled: false } }, 'token_freeze_authority'],
]) {
  test(`a ${name} token is refused and refunded`, async () => {
    const { engine, ledger, zcash } = await setup({ token: { ...GOOD_TOKEN, ...patch } });
    const res = await engine.ingest({ txid: `tx-${code}`, zats: 12_000_000, text: buyMemo(U1) });
    assert.equal(res.status, 'accepted');
    await engine.runOnce({ maxPasses: 3 });
    assert.equal(zcash.sends.length, 1);
    assert.equal(zcash.sends[0].to, U1);
    assert.equal(ledger.entries.filter((e) => e.type === 'refund').length, 1);
    assert.equal(ledger.entries.filter((e) => e.type === 'order_received').length, 0);
  });
}

test('round-trip loss above the cap is refused before any ZEC moves', async () => {
  const { engine, zcash, jupiter } = await setup();
  const original = jupiter.order.bind(jupiter);
  // Any token→SOL probe returns one lamport: a 99.99% round-trip loss.
  jupiter.order = async (req) => (req.inputMint === MINT && !req.taker
    ? { transaction: null, requestId: null, outAmount: '1', router: 'metis' }
    : original(req));

  const res = await engine.ingest({ txid: 'tx-honeypot', zats: 12_000_000, text: buyMemo(U1) });
  assert.equal(res.status, 'accepted');
  await engine.runOnce({ maxPasses: 1 });
  assert.equal(zcash.sends.length, 0, 'nothing may move before the probe passes');
  await engine.runOnce({ maxPasses: 3 });
  // The only send is the refund to the client; the 1Click deposit address is never paid.
  assert.ok(zcash.sends.length >= 1);
  assert.ok(zcash.sends.every((s) => s.to === U1));
});
