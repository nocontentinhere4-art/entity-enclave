import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FIXTURES,
  MINT,
  TRANSPARENT,
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

const TOKEN = {
  id: MINT,
  symbol: 'JUP',
  decimals: 6,
  isVerified: true,
  liquidity: 1_000_000,
  tokenProgram: TOKEN_PROGRAM_ID,
  audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: 10 },
};

const OPEN_STATUS = FIXTURES.oneclickStatus.open;

function setup(overrides = {}) {
  const dir = tempDir('engine-');
  const clock = makeClock();
  const zcash = overrides.zcash ?? makeZcash({ zats: 2_000_000_000 });
  const solana = overrides.solana ?? makeSolana({ defaultBalance: 98_000_000 });
  const jupiter = overrides.jupiter ?? makeJupiter({ token: TOKEN });
  const treasury = overrides.treasury ?? makeTreasury();
  const intents = overrides.intents ?? makeIntents({ statuses: OPEN_STATUS });
  const { engine, store, ledger } = makeEngine({
    dir, clock, zcash, solana, jupiter, treasury, intents,
    config: { maxOpen: 5, maxPerClient: 5, rentReserveHours: 0 },
  });
  return { engine, store, ledger, zcash, solana, jupiter, treasury, intents, clock, dir };
}

async function openToHolding(ctx, txid = 'tx-open') {
  const res = await ctx.engine.ingest({ txid, zats: 100_000_000, text: buyMemo(U1) });
  assert.equal(res.status, 'accepted');
  await runPasses(ctx.engine, 12);
  const state = await ctx.store.load();
  const order = state.orders[res.orderId];
  return { orderId: res.orderId, order };
}

test('full open: quote → deposit → bridge → buy', async () => {
  const ctx = setup();
  const { orderId, order } = await openToHolding(ctx);
  assert.equal(order.state, 'holding');
  assert.equal(order.mint, MINT);
  assert.equal(order.decimals, 6);

  // The ZEC send carries exactly amountIn and the 1Click memo.
  assert.equal(ctx.zcash.sends.length, 1);
  assert.equal(ctx.zcash.sends[0].zats, 99_000_000);
  assert.equal(ctx.zcash.sends[0].memo, FIXTURES.oneclickQuote.response.quote.depositMemo);

  const open = ctx.ledger.entries.find((e) => e.type === 'trade_open');
  assert.deepEqual(Object.keys(open.data).sort(), ['at', 'decimals', 'mint', 'orderId', 'price', 'solIn', 'tokenOut', 'txid']);
  assert.equal(open.data.orderId, orderId);
  assert.equal(open.data.mint, MINT);
  assert.ok(Math.abs(Number(open.data.solIn) + 5_000_000 - 98_000_000) <= 5_000); // gas reserve + dust ≈ bridge output
  assert.equal(open.data.tokenOut, '123456789');

  // The open fee is 1% and stays in ZEC: no send matches it.
  const fee = ctx.ledger.entries.find((e) => e.type === 'fee' && e.data.leg === 'open');
  assert.equal(fee.data.zats, 1_000_000);
  assert.ok(ctx.zcash.sends.every((s) => s.zats !== 1_000_000));

  // Public ledger: no client address, memo, order pubkey or deposit address.
  const pub = JSON.stringify(ctx.ledger.public());
  assert.equal(pub.includes(U1), false);
  assert.equal(pub.includes(FIXTURES.oneclickQuote.response.quote.depositMemo), false);
  assert.equal(pub.includes(order.secret.solPublicKey), false);
  assert.equal(pub.includes(FIXTURES.oneclickQuote.response.quote.depositAddress), false);

  // Safe view omits the same fields.
  const view = await ctx.engine.orderInfo(orderId);
  const text = JSON.stringify(view);
  for (const secret of [U1, order.secret.solPublicKey, order.secret.auth6, FIXTURES.oneclickQuote.response.quote.depositAddress]) {
    assert.equal(text.includes(secret), false);
  }
});

test('target hit after two confirmation polls closes, pays the client and wipes the key', async () => {
  const ctx = setup();
  const { orderId, order } = await openToHolding(ctx);
  const pub = order.secret.solPublicKey;
  ctx.solana.accounts.set(pub, [{ mint: MINT, amount: '125000000', decimals: 6 }]);
  ctx.solana.defaultBalance = 101_500_000; // the sell proceeds land in the order wallet
  const entry = Number(order.entry.price);
  ctx.jupiter.price = entry * 1.3; // well above +25%

  await ctx.engine.runOnce(); // first trigger poll
  let state = await ctx.store.load();
  assert.equal(state.orders[orderId].state, 'holding', 'one poll does not close');
  assert.equal(state.orders[orderId].poll.triggerCount, 1);

  await ctx.engine.runOnce(); // second consecutive poll
  state = await ctx.store.load();
  assert.equal(state.orders[orderId].state, 'closing');
  assert.equal(state.orders[orderId].close.reason, 'target');

  await runPasses(ctx.engine, 12);
  state = await ctx.store.load();
  const closed = state.orders[orderId];
  assert.equal(closed.state, 'closed');
  assert.equal(closed.close.reason, 'target');
  assert.equal(closed.secret, null);

  // Close fee: 1% in SOL to the entity treasury.
  assert.equal(ctx.treasury.fees.length, 1);
  assert.equal(ctx.treasury.fees[0].lamports, 1_015_000);
  const closeFee = ctx.ledger.entries.find((e) => e.type === 'fee' && e.data.leg === 'close');
  assert.equal(closeFee.data.sol, 1_015_000);
  assert.equal(closeFee.data.zats, Math.floor(1_015_000 * (2_400_000 / 101_495_000)));

  // Payout went to the stored return address (only visible in the sealed quote request).
  const closeQuote = ctx.intents.quotes.find((q) => q.direction === 'sol-to-zec');
  assert.equal(closeQuote.recipient, U1);
  assert.equal(closeQuote.refundTo, ctx.treasury.pubkey);

  const close = ctx.ledger.entries.find((e) => e.type === 'trade_close');
  assert.deepEqual(Object.keys(close.data).sort(), ['heldMs', 'orderId', 'price', 'reason', 'solOut', 'txid', 'wallet']);
  assert.equal(close.data.reason, 'target');
  assert.equal(close.data.wallet, 'discarded');
  assert.equal(ctx.ledger.entries.find((e) => e.type === 'payout').data.zats, 2_400_000);

  // The client address never appears in the public chain, and the ATA was reclaimed.
  assert.equal(JSON.stringify(ctx.ledger.public()).includes(U1), false);
  assert.equal(ctx.solana.closed.length, 1);
});

test('a single wick does not close the position', async () => {
  const ctx = setup();
  const { orderId, order } = await openToHolding(ctx, 'tx-wick');
  ctx.solana.accounts.set(order.secret.solPublicKey, [{ mint: MINT, amount: '125000000', decimals: 6 }]);
  const entry = Number(order.entry.price);
  ctx.jupiter.price = entry * 1.3;
  await ctx.engine.runOnce(); // spike: one trigger
  ctx.jupiter.price = entry * 1.01; // back to normal before confirmation
  await ctx.engine.runOnce();
  const state = await ctx.store.load();
  assert.equal(state.orders[orderId].state, 'holding');
  assert.equal(state.orders[orderId].poll.triggerCount, 0);
});

test('stop hit closes with reason stop', async () => {
  const ctx = setup();
  const { orderId, order } = await openToHolding(ctx, 'tx-stop');
  ctx.solana.accounts.set(order.secret.solPublicKey, [{ mint: MINT, amount: '125000000', decimals: 6 }]);
  ctx.solana.defaultBalance = 101_500_000;
  ctx.jupiter.price = Number(order.entry.price) * 0.8;
  await ctx.engine.runOnce();
  await ctx.engine.runOnce();
  const state = await ctx.store.load();
  assert.equal(state.orders[orderId].state, 'closing');
  assert.equal(state.orders[orderId].close.reason, 'stop');
});

test('a client sell letter closes; a wrong orderId is ignored', async () => {
  const ctx = setup();
  const { orderId } = await openToHolding(ctx, 'tx-sell');
  const ignored = await ctx.engine.ingest({ txid: 'tx-sell-bad', zats: 1, text: 'sell o0000000000000000' });
  assert.equal(ignored.status, 'ignored');

  const res = await ctx.engine.ingest({ txid: 'tx-sell-letter', zats: 1, text: `sell ${orderId}` });
  assert.equal(res.status, 'accepted');
  const state = await ctx.store.load();
  assert.equal(state.orders[orderId].state, 'closing');
  assert.equal(state.orders[orderId].close.reason, 'client');
});

test('deadline closes after maxHoldHours', async () => {
  const ctx = setup();
  const { orderId } = await openToHolding(ctx, 'tx-deadline');
  ctx.clock.advance(169 * 3_600_000);
  await ctx.engine.runOnce({ advance: false, poll: false, deadlines: true });
  const state = await ctx.store.load();
  assert.equal(state.orders[orderId].state, 'closing');
  assert.equal(state.orders[orderId].close.reason, 'deadline');
});

test('a transparent deposit address plus a memo aborts before sending', async () => {
  const ctx = setup({
    intents: makeIntents({ depositAddress: TRANSPARENT, depositMemo: 'must-not-travel', statuses: OPEN_STATUS }),
  });
  const res = await ctx.engine.ingest({ txid: 'tx-preflight', zats: 100_000_000, text: buyMemo(U1) });
  assert.equal(res.status, 'accepted');
  await runPasses(ctx.engine, 6);
  // Only the refund to the client ever left the wallet.
  assert.ok(ctx.zcash.sends.every((s) => s.to === U1));
  assert.equal(ctx.zcash.sends.some((s) => s.to === TRANSPARENT), false);
  const state = await ctx.store.load();
  assert.equal(state.orders[res.orderId].state, 'refunded');
});

test('a FAILED bridge triggers a refund of zatsIn − open fee − network fee', async () => {
  const ctx = setup({
    intents: makeIntents({ statuses: [{ status: 'FAILED' }] }),
  });
  const res = await ctx.engine.ingest({ txid: 'tx-bridge-fail', zats: 100_000_000, text: buyMemo(U1) });
  assert.equal(res.status, 'accepted');
  await runPasses(ctx.engine, 10);
  const refund = ctx.ledger.entries.find((e) => e.type === 'refund');
  assert.ok(refund, 'a refund entry exists');
  assert.equal(refund.data.zats, 100_000_000 - 1_000_000 - 10_000);
  assert.equal(refund.data.reason, 'bridge_failed');
  assert.equal(ctx.zcash.sends.at(-1).to, U1);
  const state = await ctx.store.load();
  assert.equal(state.orders[res.orderId].state, 'refunded');
});
