import { test } from 'node:test';
import assert from 'node:assert/strict';
import nacl from 'tweetnacl';
import { base58Encode } from '../src/trade/address.mjs';
import { SealedFile } from '../src/sealed-file.mjs';
import { TRADE_STORE_AAD } from '../src/trade/types.mjs';
import {
  FIXTURES,
  MINT,
  U1,
  buyMemo,
  makeClock,
  makeEngine,
  makeIntents,
  makeJupiter,
  makeKeys,
  makeLedger,
  makeSolana,
  makeStore,
  makeTreasury,
  makeZcash,
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
const KEY = new Uint8Array(32).fill(1);
const CLOSE_DEPOSIT = FIXTURES.oneclickQuote.closeResponse.quote.depositAddress;

function iso(clock) { return new Date(clock.now()).toISOString(); }

function closeShell(overrides = {}) {
  return {
    reason: null, startedAt: null, tokenAmount: null,
    sellRequestId: null, sellTransaction: null, sellQuoteOut: null, sellSignature: null, sellRequotes: 0,
    solOut: null, price: null, txid: null,
    feeLamports: null, feeSignature: null, feeRecorded: false, ataClosed: false,
    bridge: null, bridgeRetries: 0, bridgeFromTreasury: false, bridgeRetryAmount: null,
    payoutZats: null, payoutTxid: null, payAttempts: 0, payRetryAt: null,
    ...overrides,
  };
}

function makeOrder(clock, state, overrides = {}) {
  const kp = nacl.sign.keyPair();
  const now = iso(clock);
  return {
    orderId: 'o' + 'a'.repeat(16),
    state,
    createdAt: now,
    updatedAt: now,
    mint: MINT,
    mintQuery: MINT,
    symbol: 'JUP',
    decimals: 6,
    targetPct: 25,
    stopPct: 10,
    maxHoldHours: 168,
    zatsIn: 100_000_000,
    feeOpenZats: 1_000_000,
    swapZats: 99_000_000,
    feeChargedZats: 1_000_000,
    clientRef: 'c'.repeat(16),
    txid: 'funding-tx',
    openedAt: now,
    closedAt: null,
    secret: {
      returnAddress: U1,
      auth6: 'a1b2c3',
      solPublicKey: base58Encode(kp.publicKey),
      solSecretKey: Buffer.from(kp.secretKey).toString('base64'),
    },
    bridgeOpen: {
      depositAddress: U1,
      depositMemo: 'synthetic-memo-1',
      quoteOutLamports: '98000000',
      amountIn: '99000000',
      deadline: new Date(clock.now() + 3_600_000).toISOString(),
      zecTxid: null,
      attemptAt: clock.now(),
      sendAttempts: 1,
      quoteRetries: 0,
      sentAt: clock.now(),
    },
    entry: { solIn: '92995000', tokenOut: '123456789', price: '0.000753', txid: 'buy-sig', at: now },
    poll: { lastPrice: '0.0008', lastAt: now, triggerCount: 0, triggerSide: null, peak: '0.0008' },
    buy: null,
    probe: null,
    refund: null,
    error: { stage: null, code: null, at: null },
    close: closeShell(),
    ...overrides,
  };
}

async function seed(store, order) {
  const state = await store.load();
  state.orders[order.orderId] = order;
  await store.save(state);
}

function context(overrides = {}) {
  const dir = tempDir('recovery-');
  const clock = overrides.clock ?? makeClock();
  const store = overrides.store ?? makeStore(dir, { key: KEY, now: () => clock.now() });
  const zcash = overrides.zcash ?? makeZcash({ zats: 2_000_000_000 });
  const solana = overrides.solana ?? makeSolana({ defaultBalance: 98_000_000 });
  const jupiter = overrides.jupiter ?? makeJupiter({ token: TOKEN });
  const treasury = overrides.treasury ?? makeTreasury();
  const intents = overrides.intents ?? makeIntents({ statuses: FIXTURES.oneclickStatus.open });
  const ledger = overrides.ledger ?? makeLedger(clock);
  const engine = makeEngine({
    dir, clock, store, ledger, zcash, solana, jupiter, treasury, intents,
    config: { maxOpen: 5, maxPerClient: 5, rentReserveHours: 0 },
  }).engine;
  return { engine, store, ledger, zcash, solana, jupiter, treasury, intents, clock, dir };
}

test('restart in depositing does not send twice when the transfer is already visible', async () => {
  const clock = makeClock();
  const zcash = makeZcash({
    zats: 2_000_000_000,
    transfers: [{
      txid: 'zec-existing-send',
      kind: 'sent',
      value: 99_000_000,
      recipient: U1,
      datetime: iso(clock),
      memos: ['synthetic-memo-1'],
    }],
  });
  zcash.sends.push({ to: U1, zats: 99_000_000, memo: 'synthetic-memo-1' }); // the send that happened before the crash
  const ctx = context({ clock, zcash });
  await seed(ctx.store, makeOrder(clock, 'depositing'));

  await ctx.engine.runOnce({ poll: false, deadlines: false });
  const state = await ctx.store.load();
  const order = state.orders['o' + 'a'.repeat(16)];
  assert.equal(order.state, 'bridging');
  assert.equal(order.bridgeOpen.zecTxid, 'zec-existing-send');
  assert.equal(zcash.sends.length, 1, 'no second ZEC send');
});

test('restart in bridging re-polls by depositAddress and never re-quotes', async () => {
  const clock = makeClock();
  const intents = makeIntents({ statuses: [{ status: 'SUCCESS', swapDetails: { amountOut: '98000000' } }] });
  const ctx = context({ clock, intents });
  await seed(ctx.store, makeOrder(clock, 'bridging'));

  await ctx.engine.runOnce({ poll: false, deadlines: false });
  const state = await ctx.store.load();
  assert.equal(state.orders['o' + 'a'.repeat(16)].state, 'buying');
  assert.deepEqual(intents.statusCalls, [U1]);
  assert.equal(intents.quotes.length, 0, 'a bridge restart must not re-quote');
  assert.equal(ctx.zcash.sends.length, 0);
});

test('restart in buying reuses the persisted requestId and checks the execute result', async () => {
  const clock = makeClock();
  const jupiter = makeJupiter({ token: TOKEN });
  const ctx = context({ clock, jupiter });
  const order = makeOrder(clock, 'buying', {
    buy: {
      requestId: 'buy-existing-request',
      transaction: FIXTURES.jupiterOrder.response.transaction,
      amountIn: '92995000',
      quoteOut: '123456789',
      requotes: 0,
      attempts: 0,
    },
  });
  await seed(ctx.store, order);

  await ctx.engine.runOnce({ poll: false, deadlines: false });
  const state = await ctx.store.load();
  assert.equal(state.orders[order.orderId].state, 'holding');
  assert.equal(jupiter.orders.length, 0, 'no new /order call');
  assert.equal(jupiter.executes.length, 1);
  assert.equal(jupiter.executes[0].requestId, 'buy-existing-request');
  assert.equal(ctx.ledger.entries.filter((e) => e.type === 'trade_open').length, 1);
});

test('restart in holding reconciles the on-chain token balance', async () => {
  const clock = makeClock();
  const solana = makeSolana({ defaultBalance: 98_000_000 });
  const jupiter = makeJupiter({ token: TOKEN, price: 0.00075 });
  const ctx = context({ clock, solana, jupiter });
  const order = makeOrder(clock, 'holding');
  await seed(ctx.store, order);
  let calls = 0;
  const original = solana.getTokenAccounts.bind(solana);
  solana.getTokenAccounts = async (owner) => { calls++; return original(owner); };
  solana.accounts.set(order.secret.solPublicKey, [{ mint: MINT, amount: '50000000', decimals: 6 }]);

  await ctx.engine.runOnce({ advance: false, poll: true, deadlines: false });
  const state = await ctx.store.load();
  assert.equal(calls, 1);
  assert.equal(state.orders[order.orderId].positionRaw, '50000000');
  assert.ok(state.orders[order.orderId].poll.lastPrice);
  assert.equal(ctx.zcash.sends.length, 0);
});

test('restart in closing resumes at the first incomplete step (sell done, fee not sent)', async () => {
  const clock = makeClock();
  const ctx = context({ clock });
  const order = makeOrder(clock, 'closing', {
    close: closeShell({
      reason: 'target',
      startedAt: iso(clock),
      tokenAmount: '125000000',
      sellSignature: 'sell-signature-done',
      solOut: '101500000',
      price: '0.000812',
      txid: 'sell-signature-done',
      ataClosed: true,
    }),
  });
  await seed(ctx.store, order);

  await ctx.engine.runOnce({ poll: false, deadlines: false });
  assert.equal(ctx.jupiter.orders.length, 0, 'the sell is not repeated');
  assert.equal(ctx.jupiter.executes.length, 0, 'the sell execute is not repeated');
  assert.equal(ctx.treasury.fees.length, 1);
  assert.equal(ctx.treasury.fees[0].lamports, 1_015_000);
  assert.equal(ctx.zcash.sends.length, 0);
});

test('forget removes the secret from trades.bin AND trades.bin.bak', async () => {
  const dir = tempDir('forget-');
  const clock = makeClock();
  const store = makeStore(dir, { key: KEY, now: () => clock.now() });
  const order = makeOrder(clock, 'closed');
  order.secret = { ...order.secret, solSecretKey: 'super-secret-key-material' };
  await seed(store, order);
  assert.ok((await store.load()).orders[order.orderId].secret);

  await store.forget(order.orderId);
  const file = new SealedFile({ path: store.path, key: KEY, aad: TRADE_STORE_AAD });
  const primary = await file.read(store.path);
  const backup = await file.read(store.bakPath);
  assert.ok(primary, 'primary decrypts');
  assert.ok(backup, 'backup decrypts');
  assert.equal(primary.orders[order.orderId].secret, null);
  assert.equal(backup.orders[order.orderId].secret, null);
});

test('every restartable state advances without duplicating an irreversible send', async () => {
  const cases = [
    'depositing', 'bridging', 'buying', 'holding', 'closing', 'paying',
  ];
  for (const state of cases) {
    const clock = makeClock();
    const zcash = makeZcash({
      zats: 2_000_000_000,
      transfers: [{
        txid: 'zec-existing-send', kind: 'sent', value: 99_000_000, recipient: U1,
        datetime: iso(clock), memos: ['synthetic-memo-1'],
      }],
    });
    const solana = makeSolana({ defaultBalance: 98_000_000 });
    const jupiter = makeJupiter({ token: TOKEN, price: 0.00075 });
    const treasury = makeTreasury();
    const intents = makeIntents({
      statuses: [{ status: 'SUCCESS', swapDetails: { amountOut: '98000000' } }],
      closeStatuses: [{ status: 'SUCCESS', swapDetails: { amountOut: '2400000', destinationChainTxHashes: [{ hash: 'payout' }] } }],
    });
    const ctx = context({ clock, zcash, solana, jupiter, treasury, intents });
    const overrides = {};
    if (state === 'buying') {
      overrides.buy = {
        requestId: 'buy-existing-request',
        transaction: FIXTURES.jupiterOrder.response.transaction,
        amountIn: '92995000',
        quoteOut: '123456789',
        requotes: 0,
        attempts: 0,
      };
    }
    if (state === 'closing') {
      overrides.close = closeShell({
        reason: 'target',
        startedAt: iso(clock),
        tokenAmount: '125000000',
        sellSignature: 'sell-signature-done',
        solOut: '101500000',
        price: '0.000812',
        txid: 'sell-signature-done',
        ataClosed: true,
      });
    }
    if (state === 'paying') {
      overrides.close = closeShell({
        reason: 'target',
        startedAt: iso(clock),
        tokenAmount: '125000000',
        sellSignature: 'sell-signature-done',
        solOut: '101500000',
        price: '0.000812',
        txid: 'sell-signature-done',
        feeLamports: 1_015_000,
        feeSignature: 'fee-done',
        feeRecorded: true,
        ataClosed: true,
        bridge: {
          depositAddress: CLOSE_DEPOSIT,
          depositMemo: null,
          amountIn: '100480000',
          expectedZats: '2400000',
          deadline: new Date(clock.now() + 3_600_000).toISOString(),
          attemptAt: clock.now(),
          txid: 'close-bridge-send',
        },
      });
    }
    if (state === 'holding') {
      overrides.entry = { solIn: '92995000', tokenOut: '123456789', price: '0.00075', txid: 'buy-sig', at: iso(clock) };
    }
    const order = makeOrder(clock, state, overrides);
    await seed(ctx.store, order);
    solana.accounts.set(order.secret.solPublicKey, [{ mint: MINT, amount: '125000000', decimals: 6 }]);

    await ctx.engine.runOnce({ poll: state === 'holding', deadlines: false });
    assert.equal(zcash.sends.length, 0, `${state}: no duplicate ZEC send`);
    if (['depositing', 'bridging', 'holding', 'paying'].includes(state)) {
      assert.equal(jupiter.orders.filter((o) => o.taker).length, 0, `${state}: no new swap`);
    }
  }
});

test('a fresh engine on the same store adopts an order created before the restart', async () => {
  const dir = tempDir('adopt-');
  const clock = makeClock();
  const store = makeStore(dir, { key: KEY, now: () => clock.now() });
  const ledger = makeLedger(clock);
  const zcash = makeZcash({ zats: 2_000_000_000 });
  const first = makeEngine({
    dir, clock, store, ledger, zcash,
    solana: makeSolana(), jupiter: makeJupiter({ token: TOKEN }),
    treasury: makeTreasury(), intents: makeIntents({ statuses: FIXTURES.oneclickStatus.open }),
    config: { maxOpen: 5, maxPerClient: 5, rentReserveHours: 0 },
  }).engine;
  const res = await first.ingest({ txid: 'tx-adopt', zats: 100_000_000, text: buyMemo(U1) });
  assert.equal(res.status, 'accepted');

  // New process: same sealed store, new clients.
  const zcash2 = makeZcash({ zats: 2_000_000_000 });
  const second = makeEngine({
    dir, clock, store, ledger, zcash: zcash2,
    solana: makeSolana(), jupiter: makeJupiter({ token: TOKEN }),
    treasury: makeTreasury(), intents: makeIntents({ statuses: FIXTURES.oneclickStatus.open }),
    config: { maxOpen: 5, maxPerClient: 5, rentReserveHours: 0 },
  }).engine;
  const before = await store.load();
  assert.ok(before.orders[res.orderId].secret.solSecretKey);
  await second.runOnce({ poll: false, deadlines: false });
  const after = await store.load();
  assert.equal(after.orders[res.orderId].state, 'screening');
  assert.equal(after.orders[res.orderId].secret.solSecretKey, before.orders[res.orderId].secret.solSecretKey);
  assert.equal(zcash2.sends.length, 0);
});
