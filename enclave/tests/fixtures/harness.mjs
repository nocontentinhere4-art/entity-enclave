// Shared, network-free trade test harness. Everything is injected: no fetch, no RPC, no timers.
// Kept under tests/fixtures/ so `node --test tests/*.test.mjs` never treats it as a test file.
import { readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BECH32_CONST,
  BECH32M_CONST,
  base58Encode,
  bech32Encode,
} from '../../src/trade/address.mjs';
import { TradeEngine, normalizeTradeConfig } from '../../src/trade/engine.mjs';
import { TradeStore } from '../../src/trade/store.mjs';
import { SOL_MINT } from '../../src/trade/types.mjs';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), 'utf8'));

export const FIXTURES = {
  oneclickQuote: fixture('oneclick-quote.json'),
  oneclickStatus: fixture('oneclick-status.json'),
  jupiterOrder: fixture('jupiter-order.json'),
  jupiterExecute: fixture('jupiter-execute.json'),
  solanaV0: fixture('solana-v0-tx.json'),
};

export const U1 = bech32Encode('u', Buffer.alloc(32, 7), BECH32M_CONST);
export const U1B = bech32Encode('u', Buffer.alloc(32, 9), BECH32M_CONST);
export const ZS1 = bech32Encode('zs', Buffer.alloc(43, 3), BECH32_CONST);
export const TRANSPARENT = 't1SyntheticTransparentAddressForTestsOnly1111111';
export const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const TREASURY_PUB = base58Encode(Buffer.alloc(32, 5));

export function tempDir(prefix = 'trade-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function makeStore(dir, { key = new Uint8Array(32).fill(1), now } = {}) {
  return new TradeStore({ path: join(dir, 'trades.bin'), key, now });
}

export function makeKeys() {
  return {
    mode: 'test',
    deriveSubkey: (label) => new Uint8Array(32).fill(label.length),
    sealPrivate: (_pub, text) => Buffer.from(`sealed:${text}`, 'utf8').toString('base64'),
    signPublicKey: '00'.repeat(32),
  };
}

export function makeLedger(clock) {
  const entries = [];
  const at = () => new Date(clock?.now?.() ?? Date.now()).toISOString();
  return {
    entries,
    append(type, data) {
      const e = { seq: entries.length + 1, ts: at(), type, data };
      entries.push(e);
      return e;
    },
    appendPrivate(type, ciphertext) {
      const e = { seq: entries.length + 1, ts: at(), type, private: true, ciphertext };
      entries.push(e);
      return e;
    },
    recent(types, limit = 10) {
      const want = new Set(types);
      return entries.filter((e) => !e.private && want.has(e.type)).slice(-limit);
    },
    all() {
      return entries;
    },
    public() {
      return entries.filter((e) => !e.private);
    },
  };
}

export function makeClock(start = '2026-10-22T10:00:00.000Z') {
  const clock = {
    t: Date.parse(start),
    now() { return clock.t; },
    advance(ms) { clock.t += ms; return clock.t; },
    set(isoText) { clock.t = Date.parse(isoText); return clock.t; },
  };
  return clock;
}

export function makeZcash({ zats = 100_000_000, transfers = [] } = {}) {
  const wallet = {
    zats,
    sends: [],
    transfers,
    async balance() { return { total_zatoshis: wallet.zats }; },
    async send(to, value, memo = '') {
      wallet.sends.push({ to, zats: Number(value), memo });
      wallet.zats -= Number(value);
      return { txid: `zec-send-${wallet.sends.length}` };
    },
    async valueTransfers() { return wallet.transfers; },
  };
  return wallet;
}

export function makeSolana({ defaultBalance = 98_000_000, balances = {}, accounts = {} } = {}) {
  const solana = {
    defaultBalance,
    balances: new Map(Object.entries(balances)),
    accounts: new Map(Object.entries(accounts)),
    transfers: [],
    closed: [],
    sends: [],
    async balance(pubkey) { return solana.balances.has(pubkey) ? solana.balances.get(pubkey) : solana.defaultBalance; },
    async getTokenAccounts(owner) { return solana.accounts.get(owner) ?? []; },
    async send(tx) { solana.sends.push(tx); return `sol-send-${solana.sends.length}`; },
    async confirm() { return { confirmed: true }; },
    async transferSol(req) {
      solana.transfers.push({ ...req });
      return { signature: `sol-transfer-${solana.transfers.length}` };
    },
    async closeTokenAccount(req) {
      solana.closed.push({ ...req });
      return { signature: `sol-close-${solana.closed.length}` };
    },
  };
  return solana;
}

export function makeTreasury({ pubkey = TREASURY_PUB } = {}) {
  const treasury = {
    pubkey,
    fees: [],
    sends: [],
    async payFee({ lamports, orderId }) {
      treasury.fees.push({ lamports: Number(lamports), orderId });
      return { signature: `sol-fee-${treasury.fees.length}` };
    },
    async send({ to, lamports, orderId }) {
      treasury.sends.push({ to, lamports: Number(lamports), orderId });
      return { signature: `treasury-send-${treasury.sends.length}` };
    },
  };
  return treasury;
}

/**
 * Jupiter mock. `price` is SOL per whole token used for quote-only price probes.
 * Buy and sell executions get distinct requestIds so execute() can answer correctly.
 */
export function makeJupiter({ token = null, price = 0.0008, buyOut = '123456789', sellOut = '101500000', buyQuoteOut = '125000000' } = {}) {
  const jup = {
    token,
    price,
    orders: [],
    executes: [],
    async resolveToken() {
      return jup.token;
    },
    async order(req) {
      const entry = { ...req };
      jup.orders.push(entry);
      if (req.inputMint === SOL_MINT) {
        const requestId = req.taker ? `buy-${jup.orders.length}` : null;
        entry.requestId = requestId;
        return {
          transaction: req.taker ? FIXTURES.jupiterOrder.response.transaction : null,
          requestId,
          outAmount: req.taker ? buyOut : buyQuoteOut,
          router: 'metis',
          priceImpactPct: 0.1,
        };
      }
      if (req.taker) {
        const requestId = `sell-${jup.orders.length}`;
        entry.requestId = requestId;
        return {
          transaction: FIXTURES.jupiterOrder.response.transaction,
          requestId,
          outAmount: sellOut,
          router: 'metis',
          priceImpactPct: 0.1,
        };
      }
      const tokens = Number(req.amount) / 10 ** Number(jup.token?.decimals ?? 6);
      return {
        transaction: null,
        requestId: null,
        outAmount: String(Math.max(1, Math.floor(tokens * jup.price * 1e9))),
        router: 'metis',
        priceImpactPct: 0.05,
      };
    },
    async execute(req) {
      jup.executes.push({ ...req });
      const quote = jup.orders.find((o) => o.requestId === req.requestId);
      const sell = String(req.requestId).startsWith('sell');
      if (sell) {
        return {
          ...FIXTURES.jupiterExecute.sellSuccess,
          totalInputAmount: String(quote?.amount ?? FIXTURES.jupiterExecute.sellSuccess.totalInputAmount),
          totalOutputAmount: String(quote?.outAmount ?? FIXTURES.jupiterExecute.sellSuccess.totalOutputAmount),
        };
      }
      return {
        ...FIXTURES.jupiterExecute.success,
        totalInputAmount: String(quote?.amount ?? FIXTURES.jupiterExecute.success.totalInputAmount),
        totalOutputAmount: String(quote?.outAmount ?? FIXTURES.jupiterExecute.success.totalOutputAmount),
      };
    },
  };
  return jup;
}

export function makeIntents({
  depositAddress = null,
  depositMemo = null,
  openOut = 98_000_000,
  closeOut = 2_400_000,
  statuses = null,
  closeStatuses = null,
} = {}) {
  const q = FIXTURES.oneclickQuote;
  let openIdx = 0;
  let closeIdx = 0;
  const intents = {
    quotes: [],
    statusCalls: [],
    async quote(req) {
      intents.quotes.push({ ...req });
      if (req.dry) {
        return { ...q.dryResponse.quote, amountIn: req.amount, amountOut: String(openOut) };
      }
      if (req.direction === 'zec-to-sol') {
        return {
          ...q.response.quote,
          depositAddress: depositAddress ?? q.response.quote.depositAddress,
          depositMemo: depositMemo ?? q.response.quote.depositMemo,
          amountIn: req.amount,
          amountOut: String(openOut),
          deadline: req.deadline,
        };
      }
      return {
        ...q.closeResponse.quote,
        amountIn: req.amount,
        amountOut: String(closeOut),
        deadline: req.deadline,
      };
    },
    async status({ depositAddress: addr }) {
      intents.statusCalls.push(addr);
      const seq = addr === (q.closeResponse.quote.depositAddress) ? closeStatuses : statuses;
      const list = Array.isArray(seq) ? seq : null;
      if (!list) return { status: 'SUCCESS', swapDetails: { amountOut: '2400000', destinationChainTxHashes: [{ hash: 'payout-fixture' }] } };
      const i = addr === q.closeResponse.quote.depositAddress ? closeIdx++ : openIdx++;
      return list[Math.min(i, list.length - 1)];
    },
    async submitDeposit() { return { ok: true }; },
  };
  return intents;
}

export function makeEngine({
  dir = tempDir(),
  clock = makeClock(),
  config = {},
  zcash,
  solana,
  jupiter,
  treasury,
  intents,
  keys,
  ledger,
  store,
  rentZatsPerHour = 1_000_000,
  archivePub = 'ab'.repeat(32),
  entityZcashAddress = U1,
  entitySolanaAddress = TREASURY_PUB,
} = {}) {
  const storeImpl = store ?? makeStore(dir, { now: () => clock.now() });
  const ledgerImpl = ledger ?? makeLedger(clock);
  const engine = new TradeEngine({
    store: storeImpl,
    ledger: ledgerImpl,
    keys: keys ?? makeKeys(),
    config: {
      enabled: true,
      archivePub,
      rentZatsPerHour,
      trade: normalizeTradeConfig({ enabled: true, ...config }),
    },
    zcash,
    solana,
    jupiter,
    treasury,
    intents,
    now: () => clock.now(),
    archivePub,
    entityZcashAddress,
    entitySolanaAddress,
    rentZatsPerHour,
    logger: () => {},
  });
  return { engine, store: storeImpl, ledger: ledgerImpl, clock, dir };
}

export function buyMemo(address = U1, { target = 25, stop = 10 } = {}) {
  return `buy ${MINT} target +${target}% stop -${stop}% return ${address}`;
}

/** Run enough passes for the mocked open + close pipeline. */
export async function runPasses(engine, n = 12) {
  for (let i = 0; i < n; i++) await engine.runOnce({ maxPasses: 1 });
}
