// trade-open.test.mjs — the OPEN leg of a trade at the chain-client layer (plan §2, §10). Exercises
// Intents (quote → deposit/submit → status), Solana RPC (balance), and Jupiter (order → execute) against a
// mocked fetch routed to the fixtures under tests/fixtures/chains/. No network, no real time (pollStatus
// sleeps are no-ops, the rate-limit spacers are inert). The transparent-address + memo abort is the
// single most likely total-loss guard, so it gets its own test (plan §2.1/§9).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Intents, ASSETS } from '../src/trade/intents.mjs';
import { Jupiter, WRAPPED_SOL } from '../src/trade/jupiter.mjs';
import { Solana } from '../src/trade/solana.mjs';
import { keypairFromSeed } from '../src/trade/soltx.mjs';

const here = new URL('./fixtures/chains/', import.meta.url);
const fx = (f) => JSON.parse(readFileSync(new URL(f, here), 'utf8'));
const oneclick = fx('oneclick-quote-open.json');
const statuses = fx('oneclick-statuses.json');
const jupOrder = fx('jupiter-order.json');
const jupExec = fx('jupiter-execute.json');
const solRpc = fx('solana-rpc.json');

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const RETURN = 'u1client-return-fixture-00000000000000000000';
const seed = (label) => Uint8Array.from(createHash('sha256').update(label).digest());
const wallet = keypairFromSeed(seed('sov-trade-open-wallet')); // the fresh per-order wallet

/** Mock fetch routing by `METHOD pathname`; logs every call for sequence/body assertions. */
function chainFetch(routes, log = []) {
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const method = (init.method || 'GET').toUpperCase();
    let body;
    if (init.body != null) { try { body = JSON.parse(init.body); } catch { body = init.body; } }
    log.push({ method, pathname: u.pathname, path: u.pathname + u.search, body });
    const route = routes[`${method} ${u.pathname}`];
    if (!route) { const e = new Error(`no mock route for ${method} ${u.pathname}`); e.code = 'no_route'; throw e; }
    const payload = typeof route === 'function' ? route({ u, body }) : route;
    if (payload instanceof Error) throw payload;
    const status = payload.status ?? 200;
    const json = payload.json !== undefined ? payload.json : payload;
    return {
      status,
      ok: status >= 200 && status < 300,
      text: async () => (json == null ? '' : JSON.stringify(json)),
      headers: { get: () => null },
    };
  };
  return { fetchImpl, log };
}

test('full open leg: quote → deposit/submit → bridge SUCCESS → balance → buy order → execute', async () => {
  const log = [];
  const ladder = [statuses.pending, statuses.processing, statuses.successOpen];
  const routes = {
    'POST /v0/quote': { json: oneclick },
    'POST /v0/deposit/submit': { json: { ok: true } },
    'GET /v0/status': () => ({ json: ladder.shift() ?? statuses.successOpen }),
    'GET /swap/v2/order': { json: jupOrder.buy },
    'POST /swap/v2/execute': { json: jupExec.success },
    'POST /': ({ body }) => { assert.equal(body.method, 'getBalance'); return { json: solRpc.getBalance }; },
  };
  const { fetchImpl } = chainFetch(routes, log);
  const intents = new Intents({ fetchImpl, baseUrl: 'https://1click.test', sleep: async () => {} });
  const jupiter = new Jupiter({ fetchImpl, baseUrl: 'https://jup.test', sleep: async () => {}, rateLimitRps: 1000 });
  const solana = new Solana({ url: 'https://rpc.test', fetchImpl, retries: 0 });

  // 1. quote (ZEC→SOL)
  const q = await intents.quote({ originAsset: ASSETS.ZEC, destinationAsset: ASSETS.SOL, amount: '2475000', recipient: wallet.publicKeyBase58, refundTo: RETURN });
  assert.equal(q.depositAddress, oneclick.quote.depositAddress);
  assert.equal(q.depositMemo, oneclick.quote.depositMemo);
  assert.equal(q.amountIn, '2475000');
  assert.equal(q.amountOut, '98000000');
  assert.equal(q.minAmountOut, '97500000');

  // 2. deposit/submit (nudge)
  const sub = await intents.submit(q.depositAddress, 'zec-txid-open');
  assert.equal(sub.ok, true);

  // 3. bridge poll → SUCCESS
  const st = await intents.pollStatus({ depositAddress: q.depositAddress, timeoutMs: 60_000, startMs: 1, maxMs: 1 });
  assert.equal(st.status, 'SUCCESS');
  assert.equal(st.swapDetails.amountOut, '98000000');

  // 4. on-chain balance check before buying (plan §2.1d: ≥ 0.99 × amountOut)
  const bal = await solana.balance(wallet.publicKeyBase58);
  assert.equal(bal, 98000000n);
  assert.ok(bal * 100n >= BigInt(st.swapDetails.amountOut) * 99n);

  // 5. Jupiter buy order (SOL→mint)
  const order = await jupiter.order({ inputMint: WRAPPED_SOL, outputMint: MINT, amount: '97500000', taker: wallet.publicKeyBase58, slippageBps: 100 });
  assert.ok(order.transaction, 'buy order must build a transaction (taker supplied)');
  assert.equal(order.requestId, 'buy-rfq-0001');
  assert.equal(order.outAmount, '123456789');

  // 6. execute
  const ex = await jupiter.execute({ signedTransaction: order.transaction, requestId: order.requestId });
  assert.equal(ex.status, 'Success');
  assert.equal(ex.code, 0);

  // exact HTTP sequence + the bodies that carried money
  assert.deepEqual(log.map((l) => `${l.method} ${l.pathname}`), [
    'POST /v0/quote',
    'POST /v0/deposit/submit',
    'GET /v0/status',
    'GET /v0/status',
    'GET /v0/status',
    'POST /',
    'GET /swap/v2/order',
    'POST /swap/v2/execute',
  ]);
  assert.equal(log[0].body.amount, '2475000');
  assert.equal(log[0].body.recipient, wallet.publicKeyBase58);
  assert.equal(log[0].body.refundTo, RETURN);
  assert.equal(log[0].body.originAsset, ASSETS.ZEC);
  assert.equal(log[0].body.destinationAsset, ASSETS.SOL);
  assert.equal(log[1].body.depositAddress, q.depositAddress);
  assert.equal(log[1].body.txHash, 'zec-txid-open');
  const orderCall = log.find((l) => l.path.startsWith('/swap/v2/order'));
  assert.match(orderCall.path, /inputMint=So111/);
  assert.match(orderCall.path, new RegExp(`outputMint=${MINT}`));
  assert.match(orderCall.path, /amount=97500000/);
  assert.match(orderCall.path, new RegExp(`taker=${wallet.publicKeyBase58}`));
  assert.match(orderCall.path, /slippageBps=100/);
});

test('open leg: transparent ZEC deposit address + required memo aborts before anything is sent', async () => {
  const log = [];
  const transparent = { ...oneclick, quote: { ...oneclick.quote, depositAddress: 't1transparentfixtureaddress', depositMemo: 'required-memo' } };
  const { fetchImpl } = chainFetch({ 'POST /v0/quote': { json: transparent } }, log);
  const intents = new Intents({ fetchImpl, baseUrl: 'https://1click.test', sleep: async () => {} });

  await assert.rejects(
    intents.quote({ originAsset: ASSETS.ZEC, destinationAsset: ASSETS.SOL, amount: '2475000', recipient: wallet.publicKeyBase58, refundTo: RETURN }),
    (e) => e.code === 'transparent_deposit_memo',
  );
  assert.equal(log.length, 1, 'only the quote was attempted — no wallet send ever happened');
});

test('open leg: a shielded deposit address with a memo passes the preflight', async () => {
  const log = [];
  const { fetchImpl } = chainFetch({ 'POST /v0/quote': { json: oneclick } }, log);
  const intents = new Intents({ fetchImpl, baseUrl: 'https://1click.test', sleep: async () => {} });
  const q = await intents.quote({ originAsset: ASSETS.ZEC, destinationAsset: ASSETS.SOL, amount: '2475000', recipient: wallet.publicKeyBase58, refundTo: RETURN });
  assert.match(q.depositAddress, /^u1/);
  assert.equal(q.depositMemo, oneclick.quote.depositMemo);
});
