// trade-close.test.mjs — the CLOSE leg at the chain-client layer (plan §2, §7.4, §10), plus the pure
// treasury module it feeds. Exercises the treasury (deterministic key, fee math, receipt, sweep builder),
// Jupiter (sell order → execute), Solana RPC (blockhash → fee transfer → confirm), and Intents
// (SOL→ZEC quote → submit → SUCCESS payout) against a mocked fetch. No network, no real time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Intents, ASSETS } from '../src/trade/intents.mjs';
import { Jupiter, WRAPPED_SOL } from '../src/trade/jupiter.mjs';
import { Solana } from '../src/trade/solana.mjs';
import {
  keypairFromSeed, signTransaction, parseTransaction, base58, readU64le,
  buildLegacyTransaction, tokenCloseAccountInstruction, PROGRAM_ID_SYSTEM, PROGRAM_ID_TOKEN,
} from '../src/trade/soltx.mjs';
import {
  treasuryKeypair, treasuryAddress, feeCloseLamports, feeOpenZats, feeCloseZats,
  feeReceipt, buildSweepTransaction, TREASURY_SUBKEY,
} from '../src/trade/treasury.mjs';

const here = new URL('./fixtures/chains/', import.meta.url);
const fx = (f) => JSON.parse(readFileSync(new URL(f, here), 'utf8'));
const oneclickClose = fx('oneclick-quote-close.json');
const statuses = fx('oneclick-statuses.json');
const jupOrder = fx('jupiter-order.json');
const jupExec = fx('jupiter-execute.json');
const solRpc = fx('solana-rpc.json');

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const RETURN = 'u1client-return-fixture-00000000000000000000';
const seed = (label) => Uint8Array.from(createHash('sha256').update(label).digest());
const wallet = keypairFromSeed(seed('sov-trade-close-wallet')); // the disposable order wallet

// A keys handle mirroring src/keys.mjs deriveSubkey (sha256(label ‖ seed)), with a call log for assertions.
const KEY_SEED = new Uint8Array(32).fill(0x5a);
function makeKeys() {
  const calls = [];
  const deriveSubkey = (label) => {
    calls.push(label);
    return Uint8Array.from(createHash('sha256').update(Buffer.concat([Buffer.from(String(label)), Buffer.from(KEY_SEED)])).digest());
  };
  return { calls, deriveSubkey };
}

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

// ---------------------------------------------------------------- treasury (pure) ---------------------------
test('treasury key is deterministic and derived from the sol-treasury subkey label', () => {
  const a = makeKeys();
  assert.equal(treasuryAddress(a), treasuryAddress(makeKeys()), 'same seed → same address across redeploys');
  assert.deepEqual(a.calls, [TREASURY_SUBKEY]);
  const kp = treasuryKeypair(makeKeys());
  assert.equal(kp.secretKey.length, 64);
  assert.equal(kp.publicKeyBase58, base58.encode(kp.publicKey));
});

test('feeCloseLamports floors solOut × feeBps / 10000 and clamps feeBps to 300', () => {
  assert.equal(feeCloseLamports({ solOut: 121000000n, feeBps: 100 }), 1210000n);
  assert.equal(feeCloseLamports({ solOut: '121000000', feeBps: 100 }), 1210000n);
  assert.equal(feeCloseLamports({ solOut: 100n, feeBps: 100 }), 1n);
  assert.equal(feeCloseLamports({ solOut: 10000n, feeBps: 10000 }), 300n); // clamped to 300 bps
});

test('feeOpenZats is 1% of the zats in (stays in the entity wallet)', () => {
  assert.equal(feeOpenZats({ zatsIn: 2500000n, feeBps: 100 }), 25000n);
});

test('feeCloseZats states the close fee in ZEC at the close quote rate', () => {
  // rate = 2400000 zats / 120000000 lamports = 0.02 zats/lamport
  assert.equal(
    feeCloseZats({ solOut: 121000000n, feeBps: 100, amountInLamports: 120000000n, amountOutZats: 2400000n }),
    24200n,
  );
});

test('feeReceipt matches the plan ledger shape (open has no sol; close carries sol as a string)', () => {
  assert.deepEqual(feeReceipt({ orderId: 'o1', leg: 'open', zats: 25000n }), { orderId: 'o1', zats: 25000, leg: 'open' });
  assert.deepEqual(feeReceipt({ orderId: 'o1', leg: 'close', zats: 24200n, sol: 1210000n }), { orderId: 'o1', zats: 24200, leg: 'close', sol: '1210000' });
});

// ---------------------------------------------------------------- close HTTP sequence ----------------------
test('full close leg: sell → fee sweep to treasury → ATA close → SOL→ZEC bridge → payout', async () => {
  const log = [];
  const keys = makeKeys();
  const treasury = treasuryKeypair(keys);
  const ladder = [statuses.pending, statuses.successClose];
  const routes = {
    'GET /swap/v2/order': { json: jupOrder.sell },
    'POST /swap/v2/execute': { json: jupExec.success },
    'POST /v0/quote': { json: oneclickClose },
    'POST /v0/deposit/submit': { json: { ok: true } },
    'GET /v0/status': () => ({ json: ladder.shift() ?? statuses.successClose }),
    'POST /': ({ body }) => {
      if (body.method === 'getLatestBlockhash') return { json: solRpc.getLatestBlockhash };
      if (body.method === 'sendTransaction') return { json: solRpc.sendTransaction };
      if (body.method === 'getSignatureStatuses') return { json: solRpc.getSignatureStatuses };
      throw new Error(`unexpected RPC method ${body.method}`);
    },
  };
  const { fetchImpl } = chainFetch(routes, log);
  const jupiter = new Jupiter({ fetchImpl, baseUrl: 'https://jup.test', sleep: async () => {}, rateLimitRps: 1000 });
  const solana = new Solana({ url: 'https://rpc.test', fetchImpl, retries: 0 });
  const intents = new Intents({ fetchImpl, baseUrl: 'https://1click.test', sleep: async () => {} });

  // 1. sell (mint→SOL)
  const sell = await jupiter.order({ inputMint: MINT, outputMint: WRAPPED_SOL, amount: '123456789', taker: wallet.publicKeyBase58, slippageBps: 100 });
  assert.equal(sell.requestId, 'sell-rfq-0001');
  assert.equal(sell.outAmount, '121000000');

  // 2. execute → solOut
  const ex = await jupiter.execute({ signedTransaction: sell.transaction, requestId: sell.requestId });
  assert.equal(ex.status, 'Success');
  assert.equal(ex.code, 0);
  const solOut = BigInt(ex.totalOutputAmount);
  assert.equal(solOut, 121000000n);

  // 3. fee = 1% in SOL to the treasury
  const fee = feeCloseLamports({ solOut, feeBps: 100 });
  assert.equal(fee, 1210000n);

  // 4. blockhash + build the fee sweep (legacy transfer, fee payer = order wallet)
  const { blockhash } = await solana.latestBlockhash();
  assert.equal(blockhash, solRpc.getLatestBlockhash.result.value.blockhash);
  const sweep = buildSweepTransaction({ feePayer: wallet.publicKeyBase58, to: treasury.publicKeyBase58, lamports: fee, recentBlockhash: blockhash });
  const signed = signTransaction(sweep.base64, wallet.secretKey);
  const feeParsed = parseTransaction(signed.signed);
  assert.equal(base58.encode(feeParsed.staticKeys[feeParsed.instructions[0].programIdIndex]), PROGRAM_ID_SYSTEM);
  assert.deepEqual(feeParsed.staticKeys.map(base58.encode), [wallet.publicKeyBase58, treasury.publicKeyBase58, PROGRAM_ID_SYSTEM]);
  assert.equal(readU64le(feeParsed.instructions[0].data, 4), fee, 'the sweep moves exactly the 1% fee');

  // 5. send + confirm the fee transfer
  const feeSig = await solana.send(signed.signedBase64);
  assert.equal(typeof feeSig, 'string');
  const confirmed = await solana.confirm(feeSig);
  assert.equal(confirmed.confirmed, true);

  // 6. close the ATA (reclaim rent to the treasury); shape-asserted, not sent (best-effort in the engine)
  const ata = keypairFromSeed(seed('sov-trade-ata-fixture')).publicKeyBase58;
  const ataTx = buildLegacyTransaction({
    feePayer: wallet.publicKey,
    recentBlockhash: blockhash,
    instructions: [tokenCloseAccountInstruction({ account: ata, destination: treasury.publicKeyBase58, owner: wallet.publicKey })],
  });
  const ataParsed = parseTransaction(ataTx.base64);
  assert.equal(base58.encode(ataParsed.staticKeys[ataParsed.instructions[0].programIdIndex]), PROGRAM_ID_TOKEN);
  assert.deepEqual([...ataParsed.instructions[0].data], [9]);

  // 7. quote SOL→ZEC back to the client; refundTo is the treasury (not the disposable wallet)
  const q = await intents.quote({ originAsset: ASSETS.SOL, destinationAsset: ASSETS.ZEC, amount: '120000000', recipient: RETURN, refundTo: treasury.publicKeyBase58 });
  assert.equal(q.depositAddress, oneclickClose.quote.depositAddress);
  assert.equal(q.amountIn, '120000000');
  assert.equal(q.amountOut, '2400000');

  // 8. submit + poll → payout
  await intents.submit(q.depositAddress, feeSig);
  const st = await intents.pollStatus({ depositAddress: q.depositAddress, timeoutMs: 60_000, startMs: 1, maxMs: 1 });
  assert.equal(st.status, 'SUCCESS');
  assert.equal(st.swapDetails.amountOut, '2400000');
  assert.equal(st.swapDetails.destinationChainTxHashes[0].hash, 'zec-txid-payout');

  // ZEC-equivalent fee at the close rate, and the ledger receipt
  assert.equal(feeCloseZats({ solOut, feeBps: 100, amountInLamports: BigInt(q.amountIn), amountOutZats: BigInt(q.amountOut) }), 24200n);
  assert.deepEqual(feeReceipt({ orderId: 'oClose', leg: 'close', zats: 24200n, sol: fee }), { orderId: 'oClose', zats: 24200, leg: 'close', sol: '1210000' });

  // the exact HTTP sequence, and the close-leg quote sent the client address only to the bridge
  assert.deepEqual(log.map((l) => `${l.method} ${l.pathname}`), [
    'GET /swap/v2/order',
    'POST /swap/v2/execute',
    'POST /',
    'POST /',
    'POST /',
    'POST /v0/quote',
    'POST /v0/deposit/submit',
    'GET /v0/status',
    'GET /v0/status',
  ]);
  const quoteCall = log.find((l) => l.path === '/v0/quote');
  assert.equal(quoteCall.body.recipient, RETURN);
  assert.equal(quoteCall.body.refundTo, treasury.publicKeyBase58);
  assert.equal(quoteCall.body.originAsset, ASSETS.SOL);
  assert.equal(quoteCall.body.destinationAsset, ASSETS.ZEC);
});
