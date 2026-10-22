// The trade engine: a persistent state machine, not a function call.
//
// Every step follows the same rule: persist the intent BEFORE the external action, then persist the result. A
// crash therefore resumes from the store instead of repeating the action. All chain/HTTP work is delegated to
// injected clients, so the whole machine is testable with mocks and no network:
//
//   intents.quote / status / submitDeposit      (W2: src/trade/intents.mjs)
//   jupiter.order / execute / resolveToken      (W2: src/trade/jupiter.mjs)
//   solana.balance / getTokenAccounts / send / confirm / transferSol / closeTokenAccount
//   treasury.payFee / send                      (W2: src/trade/treasury.mjs)
//   zcash.balance / send / valueTransfers        (the entity's Zcash wallet)
//
// The scheduler is its own setTimeout chain (plan §7.2): price polling must not depend on the LLM tick, which can
// be 60 minutes or skipped entirely by `sleep`.
import { createHash } from 'node:crypto';
import nacl from 'tweetnacl';
import {
  base58Encode,
  isValidMint,
  isValidSolanaAddress,
  zcashDepositPreflight,
} from './address.mjs';
import {
  TradeMemoError,
  checkOrderLimits,
  clampSlippageBps,
  closeFeeLamports,
  deriveAuth6,
  deriveClientRef,
  deriveOrderId,
  parseMemo,
  screenToken,
  splitOpenFee,
} from './orders.mjs';
import { summarizeTrades, orderDetail } from './stats.mjs';
import {
  CLOSE_REASONS,
  EXPOSED_STATES,
  SOL_MINT,
  TERMINAL_STATES,
  TRADE_LEDGER_TYPES,
} from './types.mjs';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const DEFAULT_DEPOSIT_LEAD_MS = 60_000;
const LAMPORTS_DUST = 5_000;

/** Config defaults, mirroring plan §6.4. W3 builds `config.trade`; the engine stays usable without it. */
export const TRADE_DEFAULTS = Object.freeze({
  enabled: false,
  minZats: 10_000_000,
  maxZats: 1_000_000_000,
  maxOpen: 5,
  maxOpenZats: 2_000_000_000,
  maxPerClient: 1,
  rentReserveHours: 24,
  feeBps: 100,
  slippageBps: 100,
  intentsSlippageBps: 100,
  gasReserveLamports: 5_000_000,
  maxHoldHours: 168,
  pollMs: 60_000,
  bridgeTimeoutMs: 45 * 60_000,
  depositWindowMs: 60 * 60_000,
  depositGraceMs: 120_000,
  minLiquidityUsd: 50_000,
  maxPriceImpactPct: 5,
  maxRoundTripLossPct: 20,
  minSolLamports: 10_000_000,
  refundMinZats: 50_000,
  networkFeeZats: 10_000,
  allowToken2022: false,
  confirmPolls: 2,
  ackZats: 0,
});

/** Merge + clamp. Slippage and fee are capped in code, never trusted from env. */
export function normalizeTradeConfig(raw = {}) {
  const c = { ...TRADE_DEFAULTS, ...(raw ?? {}) };
  c.feeBps = Math.max(0, Math.min(Number(c.feeBps) || 100, 300));
  c.slippageBps = clampSlippageBps(c.slippageBps);
  c.intentsSlippageBps = clampSlippageBps(c.intentsSlippageBps);
  for (const k of ['minZats', 'maxZats', 'maxOpen', 'maxOpenZats', 'maxPerClient', 'rentReserveHours',
    'gasReserveLamports', 'maxHoldHours', 'pollMs', 'bridgeTimeoutMs', 'depositWindowMs', 'depositGraceMs',
    'minLiquidityUsd', 'maxPriceImpactPct', 'maxRoundTripLossPct', 'minSolLamports', 'refundMinZats',
    'networkFeeZats', 'confirmPolls', 'ackZats']) {
    const n = Number(c[k]);
    c[k] = Number.isFinite(n) ? n : TRADE_DEFAULTS[k];
  }
  c.confirmPolls = Math.max(1, Math.floor(c.confirmPolls));
  return c;
}

const iso = (ms) => new Date(Number(ms)).toISOString();
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const toBig = (v) => {
  try { return BigInt(String(v ?? '0')); } catch { return 0n; }
};
const pow10 = (decimals) => 10n ** BigInt(Math.max(0, Math.floor(Number(decimals) || 0)));

/** SOL per whole token, as a plain decimal string (no exponent). */
function formatPrice(solLamports, tokenRaw, decimals) {
  const tokens = num(tokenRaw) / 10 ** num(decimals);
  const sol = num(solLamports) / 1e9;
  if (!(tokens > 0) || !(sol > 0)) return null;
  const s = (sol / tokens).toFixed(12).replace(/0+$/, '').replace(/\.$/, '');
  return s || '0';
}

function pctChange(from, to) {
  const a = num(from);
  if (!(a > 0)) return null;
  return (num(to) / a - 1) * 100;
}

function round(n, digits = 1) {
  if (!Number.isFinite(n)) return null;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/** Public-safe error digest: a code and a message hash, never the message (which may contain an address). */
function digest(e) {
  const msg = String(e?.message ?? e ?? '');
  return {
    code: typeof e?.code === 'string' ? e.code : (e?.name && e.name !== 'Error' ? e.name : 'error'),
    msgHash: createHash('sha256').update(msg).digest('hex').slice(0, 16),
  };
}

function coded(code, message) {
  return Object.assign(new Error(message ?? code), { code });
}

function emptyOrderShell() {
  return {
    entry: { solIn: null, tokenOut: null, price: null, txid: null, at: null },
    poll: { lastPrice: null, lastAt: null, triggerCount: 0, triggerSide: null, peak: null },
    close: {
      reason: null, startedAt: null, tokenAmount: null,
      sellRequestId: null, sellTransaction: null, sellQuoteOut: null, sellSignature: null, sellRequotes: 0,
      solOut: null, price: null, txid: null,
      feeLamports: null, feeSignature: null, feeRecorded: false, ataClosed: false,
      bridge: null, bridgeRetries: 0, bridgeFromTreasury: false, bridgeRetryAmount: null,
      payoutZats: null, payoutTxid: null, payAttempts: 0, payRetryAt: null,
    },
    buy: null,
    probe: null,
    refund: null,
    error: { stage: null, code: null, at: null },
  };
}

function isExposed(order) {
  return order && EXPOSED_STATES.includes(order.state);
}

function isTerminal(order) {
  return order && TERMINAL_STATES.includes(order.state);
}

/** The complete engine. Construct with injected clients; never with network defaults. */
export class TradeEngine {
  constructor({
    store,
    ledger,
    keys = null,
    config = {},
    zcash = null,
    wallet = null,
    intents = null,
    jupiter = null,
    solana = null,
    treasury = null,
    now = () => Date.now(),
    fetch = globalThis.fetch,
    archivePub = null,
    entityZcashAddress = null,
    entitySolanaAddress = null,
    rentZatsPerHour = 0,
    logger = null,
    tickMs = 15_000,
  } = {}) {
    if (!store) throw new Error('TradeEngine needs a store');
    if (!ledger) throw new Error('TradeEngine needs a ledger');
    this.store = store;
    this.ledger = ledger;
    this.keys = keys;
    this.config = config;
    this.cfg = normalizeTradeConfig(config?.trade ?? config);
    this.enabled = Boolean(config?.trade?.enabled ?? config?.enabled ?? false);
    this.zcash = zcash ?? wallet;
    this.intents = intents;
    this.jupiter = jupiter;
    this.solana = solana;
    this.treasury = treasury;
    this.nowMs = now;
    this.fetch = fetch;
    this.archivePub = archivePub ?? config?.archivePub ?? '';
    this.entityZcashAddress = entityZcashAddress ?? this.cfg.entityZcashAddress ?? config?.zcashAddress ?? null;
    this.entitySolanaAddress = entitySolanaAddress ?? this.cfg.entitySolanaAddress ?? treasury?.pubkey ?? null;
    this.rentZatsPerHour = num(rentZatsPerHour ?? config?.rentZatsPerHour ?? 0);
    this.log = logger ?? ((code, detail) => console.error(`[trade] ${code}${detail ? ` ${detail}` : ''}`));
    this.tickMs = Math.max(1_000, Number(tickMs) || 15_000);
    this.draining = false;
    this.running = false;
    this.timer = null;
    this.lastPollAt = 0;
    this.lastDeadlineAt = 0;
    this.writeChain = Promise.resolve();
    this.orderChains = new Map();
  }

  // ---- store plumbing -----------------------------------------------------------------------------------------

  /** Serialise whole-document writes so two orders progressing in parallel cannot lose each other's update. */
  #withStore(fn) {
    const run = this.writeChain.then(fn, fn);
    this.writeChain = run.then(() => {}, () => {});
    return run;
  }

  /** One async mutex per order: orders progress in parallel, each order one step at a time. */
  #withOrder(orderId, fn) {
    const prev = this.orderChains.get(orderId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    this.orderChains.set(orderId, run.then(() => {}, () => {}));
    return run;
  }

  async #loadOrder(orderId) {
    const state = await this.store.load();
    return state.orders?.[orderId] ?? null;
  }

  async #saveOrder(order) {
    order.updatedAt = iso(this.nowMs());
    await this.#withStore(async () => {
      const state = await this.store.load();
      state.orders[order.orderId] = order;
      await this.store.save(state);
    });
  }

  async #journal(entry) {
    if (typeof this.store.journal !== 'function') return null;
    try {
      return await this.store.journal(entry);
    } catch (e) {
      const d = digest(e);
      this.log('journal_error', `${d.code}/${d.msgHash}`);
      return null;
    }
  }

  async #clearJournal(id) {
    if (typeof this.store.clearJournal !== 'function') return;
    try { await this.store.clearJournal(id); } catch { /* the entry is informational */ }
  }

  async #setState(order, state, patch = {}) {
    order.state = state;
    Object.assign(order, patch);
    await this.#saveOrder(order);
  }

  #recordError(order, stage, e) {
    const d = digest(e);
    order.error = { stage, code: d.code, at: iso(this.nowMs()) };
    this.log(`trade_${stage}_error`, `${order.orderId} ${d.code}/${d.msgHash}`);
    return d;
  }

  // ---- ingestion ---------------------------------------------------------------------------------------------

  /**
   * Accept one confirmed memo-bearing letter. Never blocks on the network: it parses, applies pure limits,
   * persists the order + archive escrow, and returns. Screening and funding happen later in the scheduler.
   *
   * @param {import('./types.mjs').IngestInput} input
   * @returns {Promise<import('./types.mjs').IngestResult>}
   */
  async ingest({ txid, zats, text, at } = {}) {
    if (!this.enabled || this.draining) return { status: 'ignored', code: this.draining ? 'draining' : 'disabled' };
    const amount = num(zats);
    if (!txid || !(amount > 0)) return { status: 'ignored', code: 'not_a_payment' };

    let memo;
    try {
      memo = parseMemo(text);
    } catch (e) {
      if (!(e instanceof TradeMemoError)) throw e;
      const address = e.returnAddress;
      if (address) {
        const orderId = deriveOrderId(txid, address);
        await this.#refundDirect({ orderId, returnAddress: address, zatsIn: amount, feeChargedZats: 0, reason: e.code });
      }
      return { status: 'rejected', code: e.code };
    }
    if (!memo) return { status: 'ignored', code: 'not_a_trade' };
    if (memo.kind === 'sell') return this.#ingestSell(memo);
    return this.#ingestBuy(memo, { txid, zats: amount, at });
  }

  async #ingestSell(memo) {
    const order = await this.#loadOrder(memo.orderId);
    if (!order) return { status: 'ignored', code: 'unknown_order' };
    if (order.state !== 'holding') return { status: 'ignored', code: 'not_holding' };
    if (memo.auth6 && order.secret?.auth6 !== memo.auth6) return { status: 'rejected', code: 'auth_mismatch' };
    const ok = await this.#beginClose(order.orderId, 'client', { auth: memo.auth6 ? 'key' : 'none' });
    return ok ? { status: 'accepted', orderId: order.orderId } : { status: 'ignored', code: 'not_holding' };
  }

  async #ingestBuy(memo, { txid, zats, at }) {
    const returnAddress = memo.returnAddress;
    const orderId = deriveOrderId(txid, returnAddress);
    const state = await this.store.load();
    if (state.orders?.[orderId]) return { status: 'duplicate', orderId };

    const clientRef = deriveClientRef(returnAddress);
    const { feeOpenZats, swapZats } = splitOpenFee(zats, this.cfg.feeBps);
    const orders = Object.values(state.orders ?? {});

    if (!this.archivePub || typeof this.keys?.sealPrivate !== 'function') {
      await this.#refundDirect({ orderId, returnAddress, zatsIn: zats, feeChargedZats: 0, reason: 'archive_missing' });
      return { status: 'rejected', code: 'archive_missing' };
    }

    let balance = 0;
    try {
      balance = num((await this.zcash?.balance())?.total_zatoshis);
    } catch {
      balance = 0;
    }
    const limit = checkOrderLimits({
      zats,
      limits: this.cfg,
      orders,
      clientRef,
      balance,
      rentZatsPerHour: this.rentZatsPerHour,
    });
    if (!limit.ok) {
      await this.#refundDirect({ orderId, returnAddress, zatsIn: zats, feeChargedZats: 0, reason: limit.code });
      return { status: 'rejected', code: limit.code };
    }

    let keypair;
    try { keypair = nacl.sign.keyPair(); } catch (e) {
      await this.#refundDirect({ orderId, returnAddress, zatsIn: zats, feeChargedZats: 0, reason: 'keygen' });
      return { status: 'rejected', code: 'keygen' };
    }
    const solPublicKey = base58Encode(keypair.publicKey);

    // Archive escrow BEFORE any value can move (plan §4.2). Without this entry the entity's death would strand
    // the order wallet forever; with it the archive can recover the position.
    try {
      this.ledger.appendPrivate('trade_secret', this.keys.sealPrivate(this.archivePub, JSON.stringify({
        orderId,
        zatsIn: zats,
        mint: memo.mint,
        returnAddress,
        solSecretKey: base58Encode(keypair.secretKey),
      })));
    } catch (e) {
      this.log('trade_escrow_error', digest(e).code);
      await this.#refundDirect({ orderId, returnAddress, zatsIn: zats, feeChargedZats: 0, reason: 'escrow_failed' });
      return { status: 'rejected', code: 'escrow_failed' };
    }

    const now = this.nowMs();
    const order = {
      orderId,
      state: 'received',
      createdAt: at ?? iso(now),
      updatedAt: iso(now),
      mint: memo.mint,
      mintQuery: memo.mintOrTicker,
      symbol: null,
      decimals: null,
      targetPct: memo.targetPct,
      stopPct: memo.stopPct,
      maxHoldHours: this.cfg.maxHoldHours,
      zatsIn: zats,
      feeOpenZats,
      swapZats,
      feeChargedZats: 0,
      clientRef,
      txid,
      openedAt: null,
      closedAt: null,
      secret: {
        returnAddress,
        auth6: deriveAuth6(returnAddress),
        solPublicKey,
        solSecretKey: Buffer.from(keypair.secretKey).toString('base64'),
      },
      bridgeOpen: null,
      ...emptyOrderShell(),
    };

    await this.#saveOrder(order);
    return { status: 'accepted', orderId };
  }

  /** Immediate refund for a payment that never became an order (limits, malformed memo, missing archive). */
  async #refundDirect({ orderId, returnAddress, zatsIn, feeChargedZats = 0, reason }) {
    const amount = Math.max(0, num(zatsIn) - num(feeChargedZats) - num(this.cfg.networkFeeZats));
    if (!returnAddress) return { skipped: true, reason: 'no_return' };
    if (amount < this.cfg.refundMinZats) {
      this.ledger.append('refund_skipped', { orderId, zats: amount, reason: 'below_min' });
      return { skipped: true, reason: 'below_min' };
    }
    try {
      const res = await this.zcash.send(returnAddress, amount, `refund ${orderId}`);
      this.ledger.append('refund', { orderId, zats: amount, txid: res?.txid ?? null, reason });
      return { zats: amount, txid: res?.txid ?? null };
    } catch (e) {
      const d = digest(e);
      this.log('trade_refund_error', `${orderId} ${d.code}/${d.msgHash}`);
      return { skipped: true, reason: d.code };
    }
  }

  // ---- public, secret-free views -----------------------------------------------------------------------------

  #entries() {
    if (typeof this.ledger.all === 'function') return this.ledger.all();
    if (typeof this.ledger.recent === 'function') return this.ledger.recent([...TRADE_LEDGER_TYPES], 100_000);
    return [];
  }

  /** Safe order view: no return address, auth6, clientRef, order pubkey, secret, deposit address or memo. */
  publicOrder(order) {
    if (!order) return null;
    const heldMs = order.openedAt
      ? Math.max(0, this.nowMs() - Date.parse(order.openedAt))
      : 0;
    return {
      orderId: order.orderId,
      state: order.state,
      mint: order.mint,
      symbol: order.symbol,
      decimals: order.decimals,
      openedAt: order.openedAt ?? order.createdAt ?? null,
      closedAt: order.closedAt ?? null,
      reason: order.close?.reason ?? null,
      targetPct: order.targetPct,
      stopPct: order.stopPct,
      entryPrice: order.entry?.price ?? null,
      currentPrice: order.poll?.lastPrice ?? null,
      unrealizedPct: round(pctChange(order.entry?.price, order.poll?.lastPrice) ?? 0, 1),
      solIn: order.entry?.solIn ?? null,
      tokenOut: order.entry?.tokenOut ?? null,
      txids: { open: order.entry?.txid ?? null, close: order.close?.txid ?? null },
      payoutZats: num(order.close?.payoutZats) || null,
      heldMs,
    };
  }

  /** `trade_status` for the LLM: counts, own open positions, last closes. No client data. */
  async publicStatus() {
    const state = await this.store.load();
    const orders = Object.values(state.orders ?? {});
    const openOrders = orders.filter(isExposed).map((o) => this.publicOrder(o));
    const summary = summarizeTrades(this.#entries(), { recentLimit: 3 });
    return {
      enabled: this.enabled && !this.draining,
      open: summary.open,
      closed: summary.closed,
      feesZats: summary.feesZats,
      feesZatsOpen: summary.feesZatsOpen,
      winRate: summary.winRate,
      openOrders,
      recent: summary.recent,
    };
  }

  /** One screen of text for `loop.buildContext`. Secret-free by construction. */
  async contextBlock() {
    if (!this.enabled) return 'TRADE DESK\n(disabled)';
    const state = await this.store.load();
    const orders = Object.values(state.orders ?? {});
    const open = orders.filter(isExposed);
    const exposure = open.reduce((s, o) => s + num(o.swapZats ?? o.zatsIn), 0);
    const summary = summarizeTrades(this.#entries(), { recentLimit: 3 });
    const lines = [
      'TRADE DESK',
      `enabled: yes · open: ${open.length}/${this.cfg.maxOpen} · exposure: ${(exposure / 1e8).toFixed(4)} ZEC · fees: ${summary.feesZats} zats`,
    ];
    for (const o of open.slice(0, 8)) {
      const pnl = round(pctChange(o.entry?.price, o.poll?.lastPrice) ?? 0, 1);
      lines.push(
        `- ${o.orderId} ${o.symbol ?? '?'} ${o.state} entry ${o.entry?.price ?? '?'} now ${o.poll?.lastPrice ?? '?'} ` +
        `(${pnl ?? 0}%) target ${o.targetPct ?? '—'}% stop ${o.stopPct ?? '—'}%`,
      );
    }
    for (const r of summary.recent) {
      lines.push(`- closed ${r.orderId} ${r.symbol ?? '?'} ${r.reason ?? '?'} ${r.returnPct}%`);
    }
    return lines.join('\n');
  }

  /** GET /trades/<id> input: ledger + optional live snapshot. Returns null for unknown ids. */
  async orderInfo(orderId) {
    const order = await this.#loadOrder(orderId);
    return orderDetail(orderId, { entries: this.#entries(), order, now: this.nowMs() });
  }

  // ---- scheduler ---------------------------------------------------------------------------------------------

  /**
   * One deterministic pass. Tests use this; production calls it from the setTimeout chain.
   * @param {{advance?:boolean, poll?:boolean, deadlines?:boolean, maxPasses?:number}} [opts]
   */
  async runOnce({ advance = true, poll = true, deadlines = true, maxPasses = 1 } = {}) {
    const passes = Math.max(1, Math.floor(Number(maxPasses) || 1));
    for (let i = 0; i < passes; i++) {
      if (advance) await this.advanceAll();
      if (poll) await this.pollPrices();
      if (deadlines) await this.checkDeadlines();
    }
    return this.publicStatus();
  }

  /** Advance every non-terminal order by exactly one step (plan §7.2). */
  async advanceAll() {
    if (!this.enabled) return;
    const state = await this.store.load();
    const ids = Object.values(state.orders ?? {})
      .filter((o) => o && (!isTerminal(o) || o.wipePending))
      .map((o) => o.orderId);
    for (const id of ids) {
      await this.#withOrder(id, async () => {
        let order = await this.#loadOrder(id);
        if (!order) return;
        if (order.wipePending) return this.#finishWipe(order);
        if (isTerminal(order)) return;
        const from = order.state;
        try {
          await this.#advance(order);
        } catch (e) {
          const d = this.#recordError(order, order.state, e);
          if (order.state === from) await this.#saveOrder(order);
          if (d.code === 'trade_corrupt') throw e;
        }
      });
    }
  }

  async #advance(order) {
    switch (order.state) {
      case 'received': return this.#advanceReceived(order);
      case 'screening': return this.#advanceScreening(order);
      case 'quoted': return this.#advanceQuoted(order);
      case 'depositing': return this.#advanceDepositing(order);
      case 'bridging': return this.#advanceBridging(order);
      case 'buying': return this.#advanceBuying(order);
      case 'holding': return; // price polling owns this state
      case 'closing': return this.#advanceClosing(order);
      case 'paying': return this.#advancePaying(order);
      case 'refunding': return this.#advanceRefunding(order);
      default: return;
    }
  }

  /** Start the self-scheduled chain. A slow tick never overlaps the next one. */
  async start() {
    if (!this.enabled || this.running) return;
    this.running = true;
    try {
      if (typeof this.store.acquireLock === 'function') await this.store.acquireLock();
      await this.#sweepSecrets();
    } catch (e) {
      const d = digest(e);
      this.log('trade_start_error', `${d.code}/${d.msgHash}`);
    }
    const tick = async () => {
      const now = this.nowMs();
      try {
        await this.runOnce({
          poll: now - this.lastPollAt >= this.cfg.pollMs,
          deadlines: now - this.lastDeadlineAt >= 60_000,
        });
        if (now - this.lastPollAt >= this.cfg.pollMs) this.lastPollAt = now;
        if (now - this.lastDeadlineAt >= 60_000) this.lastDeadlineAt = now;
      } catch (e) {
        const d = digest(e);
        this.log('trade_tick_error', `${d.code}/${d.msgHash}`);
      }
      if (!this.running) return;
      this.timer = setTimeout(tick, this.tickMs);
      this.timer.unref?.();
    };
    void tick();
  }

  async stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try {
      if (typeof this.store.releaseLock === 'function') await this.store.releaseLock();
    } catch { /* best effort */ }
  }

  /** Forget secrets left behind by a crash between "closed/refunded" and `store.forget`. */
  async #sweepSecrets() {
    const state = await this.store.load();
    for (const order of Object.values(state.orders ?? {})) {
      if (order.wipePending || (order.secret && (order.state === 'closed' || order.state === 'refunded'))) {
        await this.#finishWipe(order);
      }
    }
  }

  async #finishWipe(order) {
    await this.store.forget(order.orderId);
    order.secret = null;
    order.wipePending = false;
    await this.#saveOrder(order);
  }

  // ---- open pipeline (plan §7.3) -----------------------------------------------------------------------------

  async #advanceReceived(order) {
    if (typeof this.jupiter?.resolveToken !== 'function') {
      return this.#refundOrder(order, 'screener_unavailable', 'screen');
    }
    let token;
    try {
      token = await this.jupiter.resolveToken({
        query: order.mintQuery,
        minLiquidityUsd: this.cfg.minLiquidityUsd,
        allowToken2022: this.cfg.allowToken2022,
      });
    } catch (e) {
      return this.#refundOrder(order, digest(e).code, 'screen');
    }
    const gate = screenToken(token, this.cfg);
    if (!gate.ok) return this.#refundOrder(order, gate.code, 'screen');
    if (!isValidMint(token.id)) return this.#refundOrder(order, 'token_mint_invalid', 'screen');
    if (order.mint && token.id !== order.mint) return this.#refundOrder(order, 'token_mismatch', 'screen');

    order.mint = token.id;
    order.symbol = String(token.symbol ?? '');
    order.decimals = Number(token.decimals);

    // The public receipt exists only once the token is known (a ticker is not a mint). The open-leg fee is
    // recorded at the same moment, so public accounting and the refund formula agree from here on.
    if (!order.feeChargedZats) {
      this.ledger.append('order_received', {
        orderId: order.orderId,
        zats: num(order.zatsIn),
        mint: order.mint,
        symbol: order.symbol,
        targetPct: order.targetPct ?? null,
        stopPct: order.stopPct ?? null,
        maxHoldHours: num(order.maxHoldHours),
        clientRef: order.clientRef,
        txid: order.txid,
      });
      this.ledger.append('fee', { orderId: order.orderId, zats: num(order.feeOpenZats), leg: 'open' });
      order.feeChargedZats = num(order.feeOpenZats);
    }
    await this.#setState(order, 'screening');
  }

  async #advanceScreening(order) {
    try {
      await this.#probeRoundTrip(order);
    } catch (e) {
      if (e?.tradeFatal) return this.#refundOrder(order, e.code ?? 'probe_failed', 'screen');
      order.probeFailures = num(order.probeFailures) + 1;
      this.#recordError(order, 'screen', e);
      if (order.probeFailures >= 3) return this.#refundOrder(order, 'probe_unavailable', 'screen');
      return this.#saveOrder(order);
    }
    try {
      await this.#quoteLive(order);
      await this.#saveOrder(order);
    } catch (e) {
      order.quoteFailures = num(order.quoteFailures) + 1;
      this.#recordError(order, 'quote', e);
      if (order.quoteFailures >= 2) return this.#refundOrder(order, e.code ?? 'quote_failed', 'quote');
      await this.#saveOrder(order);
    }
  }

  /**
   * Honeypot / rug gate: quote the round trip before any ZEC moves. A token that cannot be sold back for a
   * sane amount is refused while the client's money is still in the entity wallet.
   */
  async #probeRoundTrip(order) {
    const pub = order.secret?.solPublicKey;
    if (!pub) throw coded('secret_missing', 'order has no wallet');
    const amount = String(order.swapZats);
    const dry = await this.intents.quote({
      direction: 'zec-to-sol',
      amount,
      recipient: pub,
      refundTo: this.entityZcashAddress ?? undefined,
      slippageBps: this.cfg.intentsSlippageBps,
      dry: true,
    });
    const usable = num(dry?.amountOut) - this.cfg.gasReserveLamports;
    if (!(usable >= this.cfg.minSolLamports)) {
      throw Object.assign(coded('bridge_too_small', 'bridge output cannot cover gas'), { tradeFatal: true });
    }

    const buy = await this.jupiter.order({
      inputMint: SOL_MINT,
      outputMint: order.mint,
      amount: String(Math.floor(usable)),
      slippageBps: this.cfg.slippageBps,
    });
    if (!buy?.outAmount || buy.transaction === '' || toBig(buy.outAmount) <= 0n) {
      throw Object.assign(coded('probe_buy_failed', 'no token quote for the bridge output'), { tradeFatal: true });
    }
    const back = await this.jupiter.order({
      inputMint: order.mint,
      outputMint: SOL_MINT,
      amount: String(buy.outAmount),
      slippageBps: this.cfg.slippageBps,
    });
    if (!back?.outAmount || back.transaction === '' || toBig(back.outAmount) <= 0n) {
      throw Object.assign(coded('roundtrip_failed', 'token cannot be sold back'), { tradeFatal: true });
    }
    const lossPct = 100 * (1 - num(back.outAmount) / usable);
    if (!Number.isFinite(lossPct) || lossPct > this.cfg.maxRoundTripLossPct) {
      throw Object.assign(coded('roundtrip_loss', 'round-trip loss above the cap'), { tradeFatal: true });
    }
    const impact = Math.max(num(buy.priceImpactPct), num(back.priceImpactPct));
    if (impact > this.cfg.maxPriceImpactPct) {
      throw Object.assign(coded('price_impact', 'price impact above the cap'), { tradeFatal: true });
    }
    order.probe = { lossPct: round(lossPct, 2), priceImpactPct: round(impact, 2), at: iso(this.nowMs()) };
  }

  /** Obtain (or refresh) the live ZEC→SOL 1Click quote and validate the deposit preflight. */
  async #quoteLive(order) {
    const pub = order.secret?.solPublicKey;
    if (!pub) throw coded('secret_missing', 'order has no wallet');
    const q = await this.intents.quote({
      direction: 'zec-to-sol',
      amount: String(order.swapZats),
      recipient: pub,
      refundTo: this.entityZcashAddress ?? undefined,
      slippageBps: this.cfg.intentsSlippageBps,
      deadline: iso(this.nowMs() + this.cfg.depositWindowMs),
      dry: false,
    });
    if (!q?.depositAddress) throw coded('quote_no_deposit_address', '1Click returned no deposit address');
    const pre = zcashDepositPreflight(q.depositAddress, q.depositMemo);
    if (!pre.ok) throw coded(pre.code ?? 'deposit_preflight', 'deposit address failed preflight');
    if (num(q.amountOut) < this.cfg.gasReserveLamports + this.cfg.minSolLamports) {
      throw coded('quote_too_small', 'bridge output below gas + minimum');
    }
    if (q.amountIn && num(q.amountIn) > order.swapZats) throw coded('quote_amount', 'quote asks for more than the order');
    const deadline = Date.parse(q.deadline);
    if (!Number.isFinite(deadline) || deadline < this.nowMs() + DEFAULT_DEPOSIT_LEAD_MS) {
      throw coded('quote_deadline', 'quote deadline too near');
    }
    order.bridgeOpen = {
      depositAddress: q.depositAddress,
      depositMemo: q.depositMemo ?? null,
      quoteOutLamports: String(q.amountOut),
      amountIn: String(q.amountIn ?? order.swapZats),
      deadline: q.deadline,
      zecTxid: null,
      attemptAt: null,
      sendAttempts: 0,
      quoteRetries: num(order.bridgeOpen?.quoteRetries),
      sentAt: null,
    };
    order.state = 'quoted';
  }

  async #advanceQuoted(order) {
    const b = order.bridgeOpen;
    if (!b?.depositAddress) {
      order.state = 'screening';
      return this.#saveOrder(order);
    }
    if (Date.parse(b.deadline) < this.nowMs()) {
      b.quoteRetries = num(b.quoteRetries) + 1;
      if (b.quoteRetries > 2) return this.#refundOrder(order, 'quote_expired', 'quote');
      try {
        await this.#quoteLive(order);
        await this.#saveOrder(order);
      } catch (e) {
        this.#recordError(order, 'quote', e);
        if (b.quoteRetries >= 2) return this.#refundOrder(order, e.code ?? 'quote_failed', 'quote');
        await this.#saveOrder(order);
      }
      return;
    }

    // Persist the intent before the irreversible action.
    b.attemptAt = this.nowMs();
    b.sendAttempts = 0;
    order.state = 'depositing';
    await this.#journal({ id: `zec_send:${order.orderId}:${b.attemptAt}`, op: 'zec_send', orderId: order.orderId });
    await this.#saveOrder(order);
    await this.#sendDeposit(order);
  }

  async #sendDeposit(order) {
    const b = order.bridgeOpen;
    if (!b?.depositAddress) return this.#refundOrder(order, 'deposit_address_missing', 'deposit');
    const amount = Number(b.amountIn);
    try {
      const res = await this.zcash.send(b.depositAddress, amount, b.depositMemo ?? '');
      b.zecTxid = res?.txid ?? null;
      b.sentAt = this.nowMs();
      b.sendAttempts = num(b.sendAttempts) + 1;
      order.state = 'bridging';
      await this.#saveOrder(order);
      await this.#clearJournal(`zec_send:${order.orderId}:${b.attemptAt}`);
      if (b.zecTxid && typeof this.intents?.submitDeposit === 'function') {
        try {
          await this.intents.submitDeposit({ depositAddress: b.depositAddress, txHash: b.zecTxid });
        } catch (e) {
          // Optional accelerator: status polling still works without it.
          this.log('trade_deposit_submit_error', digest(e).code);
        }
      }
    } catch (e) {
      b.sendAttempts = num(b.sendAttempts) + 1;
      this.#recordError(order, 'deposit', e);
      await this.#saveOrder(order);
      if (b.sendAttempts >= 5) return this.#refundOrder(order, 'deposit_send_failed', 'deposit');
    }
  }

  async #advanceDepositing(order) {
    const b = order.bridgeOpen;
    if (b?.zecTxid) {
      order.state = 'bridging';
      return this.#saveOrder(order);
    }
    // Reconcile first: the send may have landed before the crash that lost the txid.
    const transfers = await this.#valueTransfers();
    const found = this.#findSentTransfer(order, transfers);
    if (found) {
      b.zecTxid = found;
      b.sentAt = this.nowMs();
      order.state = 'bridging';
      await this.#clearJournal(`zec_send:${order.orderId}:${b.attemptAt}`);
      return this.#saveOrder(order);
    }
    const waited = b?.attemptAt ? this.nowMs() - b.attemptAt : Infinity;
    if (waited < this.cfg.depositGraceMs) return; // give the wallet a sync before considering a re-send
    if (num(b?.sendAttempts) >= 3) return this.#refundOrder(order, 'deposit_unconfirmed', 'deposit');
    await this.#sendDeposit(order);
  }

  async #valueTransfers() {
    if (typeof this.zcash?.valueTransfers !== 'function') return [];
    try { return await this.zcash.valueTransfers(); } catch { return []; }
  }

  #findSentTransfer(order, transfers) {
    const b = order.bridgeOpen ?? {};
    const amount = num(b.amountIn);
    const memo = b.depositMemo ? String(b.depositMemo) : null;
    const after = b.attemptAt ? b.attemptAt - 300_000 : 0;
    for (const t of Array.isArray(transfers) ? transfers : []) {
      if (!t || !['sent', 'spent'].includes(String(t.kind))) continue;
      if (b.depositAddress && t.recipient && t.recipient !== b.depositAddress) continue;
      if (num(t.value) !== amount) continue;
      if (after && t.datetime && Date.parse(t.datetime) < after) continue;
      if (memo && Array.isArray(t.memos) && t.memos.length && !t.memos.some((m) => String(m).includes(memo))) continue;
      return t.txid;
    }
    return null;
  }

  async #advanceBridging(order) {
    if (typeof this.intents?.status !== 'function') {
      return this.#refundOrder(order, 'status_unavailable', 'bridge');
    }
    const b = order.bridgeOpen ?? {};
    let status;
    try {
      status = await this.intents.status({ depositAddress: b.depositAddress, depositMemo: b.depositMemo ?? undefined });
    } catch (e) {
      this.#recordError(order, 'bridge', e);
      await this.#saveOrder(order);
      if (this.#bridgeTimedOut(order)) return this.#refundOrder(order, 'bridge_timeout', 'bridge');
      return;
    }
    const s = String(status?.status ?? '').toUpperCase();
    if (s === 'SUCCESS') {
      const expected = num(b.quoteOutLamports ?? status?.swapDetails?.amountOut);
      let balance = 0;
      try { balance = num(await this.solana.balance(order.secret.solPublicKey)); } catch { balance = 0; }
      if (expected > 0 && balance >= expected * 0.99) {
        order.bridgeOpen.quoteOutLamports = String(expected);
        return this.#setState(order, 'buying');
      }
      if (this.#bridgeTimedOut(order)) return this.#refundOrder(order, 'bridge_delivery_short', 'bridge');
      await this.#saveOrder(order);
      return;
    }
    if (['FAILED', 'REFUNDED', 'INCOMPLETE_DEPOSIT'].includes(s)) {
      return this.#refundOrder(order, `bridge_${s.toLowerCase()}`, 'bridge');
    }
    if (this.#bridgeTimedOut(order)) return this.#refundOrder(order, 'bridge_timeout', 'bridge');
    await this.#saveOrder(order);
  }

  #bridgeTimedOut(order) {
    const since = num(order.bridgeOpen?.sentAt ?? order.bridgeOpen?.attemptAt ?? Date.parse(order.createdAt));
    return Number.isFinite(since) && this.nowMs() - since > this.cfg.bridgeTimeoutMs;
  }

  async #advanceBuying(order) {
    const pub = order.secret?.solPublicKey;
    const secretKey = order.secret ? new Uint8Array(Buffer.from(order.secret.solSecretKey, 'base64')) : null;
    if (!pub || !secretKey) return this.#fail(order, 'buy', 'secret_missing', { keepSecret: false });

    if (!order.buy?.requestId) {
      let balance = 0;
      try { balance = num(await this.solana.balance(pub)); } catch { balance = 0; }
      const spend = Math.floor(balance - this.cfg.gasReserveLamports - LAMPORTS_DUST);
      if (spend <= 0) {
        const attempts = num(order.buy?.attempts) + 1;
        order.buy = { ...(order.buy ?? {}), attempts };
        await this.#saveOrder(order);
        if (attempts >= 2) return this.#refundOrder(order, 'buy_no_gas', 'buy');
        return;
      }
      const q = await this.jupiter.order({
        inputMint: SOL_MINT,
        outputMint: order.mint,
        amount: String(spend),
        taker: pub,
        slippageBps: this.cfg.slippageBps,
      });
      if (!q?.transaction) {
        const attempts = num(order.buy?.attempts) + 1;
        order.buy = { ...(order.buy ?? {}), attempts };
        this.#recordError(order, 'buy', coded(q?.errorCode ?? 'buy_unbuildable', 'Jupiter did not build a transaction'));
        await this.#saveOrder(order);
        if (attempts >= 2) return this.#refundOrder(order, 'buy_unbuildable', 'buy');
        return;
      }
      order.buy = {
        requestId: q.requestId ?? null,
        transaction: q.transaction,
        amountIn: String(spend),
        quoteOut: String(q.outAmount ?? ''),
        requotes: num(order.buy?.requotes),
        attempts: 0,
      };
      await this.#journal({ id: `buy:${order.orderId}:${q.requestId}`, op: 'jupiter_execute', orderId: order.orderId });
      await this.#saveOrder(order); // persist before /execute: the requestId is the idempotency key
    }

    let res;
    try {
      res = await this.jupiter.execute({
        transaction: order.buy.transaction,
        requestId: order.buy.requestId,
        secretKey,
      });
    } catch (e) {
      order.buy.attempts = num(order.buy.attempts) + 1;
      this.#recordError(order, 'buy', e);
      await this.#saveOrder(order);
      if (order.buy.attempts >= 3) return this.#refundOrder(order, 'buy_execute_error', 'buy');
      return;
    }

    const code = Number(res?.code ?? res?.errorCode ?? res?.error?.code);
    const ok = (res?.status === 'Success' || code === 0) && Boolean(res?.signature);
    if (!ok) {
      if (code === -1005 || code === -2003) {
        order.buy.requotes = num(order.buy.requotes) + 1;
        if (order.buy.requotes > 1) return this.#refundOrder(order, 'buy_quote_expired', 'buy');
        order.buy = { ...order.buy, requestId: null, transaction: null };
        await this.#saveOrder(order);
        return;
      }
      order.buy.attempts = num(order.buy.attempts) + 1;
      this.#recordError(order, 'buy', coded(String(code ?? 'buy_failed'), res?.error ?? 'Jupiter execute failed'));
      await this.#saveOrder(order);
      if (order.buy.attempts >= 2) return this.#refundOrder(order, 'buy_failed', 'buy');
      return;
    }

    const solIn = String(res.totalInputAmount ?? order.buy.amountIn);
    const tokenOut = String(res.totalOutputAmount ?? res.outputAmountResult ?? order.buy.quoteOut ?? '0');
    if (toBig(tokenOut) <= 0n) return this.#refundOrder(order, 'buy_zero_tokens', 'buy');
    const price = formatPrice(solIn, tokenOut, order.decimals) ?? '0';
    const at = iso(this.nowMs());
    order.entry = { solIn, tokenOut, price, txid: res.signature, at };
    order.openedAt = at;
    order.buy = { ...order.buy, signature: res.signature, result: { solIn, tokenOut } };
    order.poll = { lastPrice: price, lastAt: at, triggerCount: 0, triggerSide: null, peak: price };
    this.ledger.append('trade_open', {
      orderId: order.orderId,
      mint: order.mint,
      solIn,
      tokenOut,
      decimals: num(order.decimals),
      price,
      txid: res.signature,
      at,
    });
    await this.#clearJournal(`buy:${order.orderId}:${order.buy.requestId}`);
    await this.#setState(order, 'holding');
  }

  // ---- holding: price oracle and triggers (plan §7.5) ---------------------------------------------------------

  /** Poll every holding order once. The bid side is used for both target and stop, so an ask-side wick cannot fire. */
  async pollPrices() {
    if (!this.enabled) return;
    const state = await this.store.load();
    const ids = Object.values(state.orders ?? {}).filter((o) => o?.state === 'holding').map((o) => o.orderId);
    for (const id of ids) {
      await this.#withOrder(id, async () => {
        const order = await this.#loadOrder(id);
        if (!order || order.state !== 'holding') return;
        try {
          await this.#pollOne(order);
        } catch (e) {
          this.#recordError(order, 'holding', e);
          await this.#saveOrder(order);
        }
      });
    }
  }

  async #pollOne(order) {
    const pub = order.secret?.solPublicKey;
    if (!pub) return this.#fail(order, 'holding', 'secret_missing', { keepSecret: false });
    let raw = toBig(order.entry?.tokenOut);
    if (typeof this.solana?.getTokenAccounts === 'function') {
      const accounts = await this.solana.getTokenAccounts(pub);
      const account = (Array.isArray(accounts) ? accounts : []).find((a) => a.mint === order.mint);
      raw = toBig(account?.amount ?? 0);
      order.positionRaw = String(raw);
    }
    // A zero balance from a lagging RPC must never be read as a -100% price and fire the stop.
    if (raw <= 0n) {
      await this.#saveOrder(order);
      return;
    }
    const unit = pow10(order.decimals);
    const hundredth = raw / 100n;
    const probe = hundredth > unit ? hundredth : unit;
    const quote = await this.jupiter.order({
      inputMint: order.mint,
      outputMint: SOL_MINT,
      amount: String(probe),
      slippageBps: this.cfg.slippageBps,
    });
    if (!quote?.outAmount || toBig(quote.outAmount) <= 0n) {
      await this.#saveOrder(order);
      return;
    }
    const probeTokens = num(probe) / 10 ** num(order.decimals);
    const price = num(quote.outAmount) / 1e9 / probeTokens;
    if (!(price > 0)) {
      await this.#saveOrder(order);
      return;
    }
    const priceText = formatPrice(quote.outAmount, String(probe), order.decimals) ?? '0';
    const last = num(order.poll?.lastPrice);
    // Anti-manipulation band: a >60% move in one poll is not a price, it is an incident.
    if (last > 0 && Math.abs(price / last - 1) > 0.6) {
      this.ledger.append('trade_price_jump', { orderId: order.orderId, from: order.poll.lastPrice, to: priceText });
      order.poll = { ...order.poll, lastAt: iso(this.nowMs()) };
      await this.#saveOrder(order);
      return;
    }

    order.poll = {
      ...(order.poll ?? {}),
      lastPrice: priceText,
      lastAt: iso(this.nowMs()),
      peak: !order.poll?.peak || price > num(order.poll.peak) ? priceText : order.poll.peak,
    };

    const entry = num(order.entry?.price);
    let side = null;
    if (entry > 0) {
      if (order.targetPct != null && price >= entry * (1 + num(order.targetPct) / 100)) side = 'target';
      else if (order.stopPct != null && price <= entry * (1 - num(order.stopPct) / 100)) side = 'stop';
    }
    if (!side) {
      order.poll.triggerSide = null;
      order.poll.triggerCount = 0;
      await this.#saveOrder(order);
      return;
    }
    const consecutive = order.poll.triggerSide === side ? num(order.poll.triggerCount) + 1 : 1;
    order.poll.triggerSide = side;
    order.poll.triggerCount = consecutive;
    await this.#saveOrder(order);
    if (consecutive >= this.cfg.confirmPolls) {
      await this.#beginClose(order.orderId, side);
    }
  }

  // ---- closing (plan §7.4) -----------------------------------------------------------------------------------

  /** Compare-and-set holding → closing. The reason is persisted before any close action. */
  async #beginClose(orderId, reason, extra = {}) {
    if (!CLOSE_REASONS.includes(reason)) throw coded('close_reason', `unknown close reason ${reason}`);
    return this.#withStore(async () => {
      const state = await this.store.load();
      const order = state.orders?.[orderId];
      if (!order || order.state !== 'holding') return false;
      order.state = 'closing';
      order.close = {
        ...(order.close ?? emptyOrderShell().close),
        ...extra,
        reason,
        startedAt: iso(this.nowMs()),
      };
      order.updatedAt = iso(this.nowMs());
      await this.store.save(state);
      return true;
    });
  }

  async #advanceClosing(order) {
    const c = order.close;
    const pub = order.secret?.solPublicKey;
    if (!pub || !order.secret) return this.#fail(order, 'sell', 'secret_missing', { keepSecret: false });

    // 1. Read the real token balance; never trust the cached entry amount.
    if (c.tokenAmount == null) {
      let raw = toBig(order.entry?.tokenOut ?? 0);
      if (typeof this.solana?.getTokenAccounts === 'function') {
        const accounts = await this.solana.getTokenAccounts(pub);
        raw = toBig((Array.isArray(accounts) ? accounts : []).find((a) => a.mint === order.mint)?.amount ?? 0);
      }
      c.tokenAmount = String(raw);
      return this.#saveOrder(order);
    }

    if (toBig(c.tokenAmount) <= 0n && !c.sellSignature) {
      // Nothing to sell (already gone): continue to fee/ATA/bridge so the wallet is discarded cleanly.
      c.noTokens = true;
      c.solOut = c.solOut ?? '0';
      c.price = c.price ?? '0';
      return this.#saveOrder(order);
    }

    // 2. Sell the full position. The quote and its requestId are persisted before /execute.
    if (!c.sellSignature && !c.noTokens) {
      if (c.sellRequestId && c.sellTransaction) {
        let res;
        try {
          res = await this.jupiter.execute({
            transaction: c.sellTransaction,
            requestId: c.sellRequestId,
            secretKey: new Uint8Array(Buffer.from(order.secret.solSecretKey, 'base64')),
          });
        } catch (e) {
          c.sellAttempts = num(c.sellAttempts) + 1;
          this.#recordError(order, 'sell', e);
          await this.#saveOrder(order);
          if (c.sellAttempts >= 3) return this.#fail(order, 'sell', 'sell_execute_error', { keepSecret: true });
          return;
        }
        const code = Number(res?.code ?? res?.errorCode ?? res?.error?.code);
        const ok = (res?.status === 'Success' || code === 0) && Boolean(res?.signature);
        if (!ok) {
          if (code === -1005 || code === -2003) {
            c.sellRequotes = num(c.sellRequotes) + 1;
            c.sellRequestId = null;
            c.sellTransaction = null;
            await this.#saveOrder(order);
            if (c.sellRequotes > 2) return this.#fail(order, 'sell', 'sell_quote_expired', { keepSecret: true });
            return;
          }
          c.sellAttempts = num(c.sellAttempts) + 1;
          this.#recordError(order, 'sell', coded(String(code ?? 'sell_failed'), res?.error ?? 'sell failed'));
          await this.#saveOrder(order);
          if (c.sellAttempts >= 3) return this.#fail(order, 'sell', 'sell_failed', { keepSecret: true });
          return;
        }
        c.sellSignature = res.signature;
        c.txid = res.signature;
        c.solOut = String(res.totalOutputAmount ?? res.outputAmountResult ?? c.sellQuoteOut ?? '0');
        c.price = formatPrice(c.solOut, c.tokenAmount, order.decimals) ?? '0';
        return this.#saveOrder(order);
      }

      const slippageBps = num(c.sellAttempts) >= 2 ? 300 : this.cfg.slippageBps;
      const q = await this.jupiter.order({
        inputMint: order.mint,
        outputMint: SOL_MINT,
        amount: String(c.tokenAmount),
        taker: pub,
        slippageBps,
      });
      if (!q?.transaction) {
        c.sellAttempts = num(c.sellAttempts) + 1;
        this.#recordError(order, 'sell', coded(q?.errorCode ?? 'sell_unbuildable', 'Jupiter did not build the sell'));
        await this.#saveOrder(order);
        if (c.sellAttempts >= 3) return this.#fail(order, 'sell', 'sell_unbuildable', { keepSecret: true });
        return;
      }
      c.sellRequestId = q.requestId ?? null;
      c.sellTransaction = q.transaction;
      c.sellQuoteOut = String(q.outAmount ?? '');
      c.sellAttempts = num(c.sellAttempts) + 1;
      return this.#saveOrder(order);
    }

    // Recovery: the sell landed but the result was lost. Confirm, then fall back to the quoted output.
    if (c.sellSignature && c.solOut == null) {
      let confirmed = false;
      try {
        confirmed = Boolean((await this.solana.confirm(c.sellSignature, { timeoutMs: 30_000 }))?.confirmed);
      } catch { confirmed = false; }
      if (confirmed) {
        c.solOut = String(c.sellQuoteOut ?? '0');
        c.price = formatPrice(c.solOut, c.tokenAmount, order.decimals) ?? '0';
        return this.#saveOrder(order);
      }
      if (this.nowMs() - Date.parse(c.startedAt) > this.cfg.bridgeTimeoutMs) {
        return this.#fail(order, 'sell', 'sell_unconfirmed', { keepSecret: true });
      }
      return;
    }

    // 3. Close fee in SOL to the entity treasury (1% by default).
    if (!c.feeSignature && !c.feeRecorded) {
      const lamports = closeFeeLamports(num(c.solOut), this.cfg.feeBps);
      if (lamports <= 0) {
        c.feeRecorded = true;
        return this.#saveOrder(order);
      }
      if (typeof this.treasury?.payFee !== 'function') throw coded('treasury_unavailable', 'no treasury.payFee');
      await this.#journal({ id: `fee:${order.orderId}`, op: 'sol_fee', orderId: order.orderId, lamports });
      const r = await this.treasury.payFee({
        secretKey: new Uint8Array(Buffer.from(order.secret.solSecretKey, 'base64')),
        lamports,
        orderId: order.orderId, // treasury must treat this as an idempotency key
      });
      c.feeLamports = lamports;
      c.feeSignature = r?.signature ?? null;
      if (!c.feeSignature) throw coded('fee_not_sent', 'treasury returned no signature');
      await this.#clearJournal(`fee:${order.orderId}`);
      return this.#saveOrder(order);
    }

    // 4. Reclaim ATA rent. Best-effort: the wallet is discarded anyway and the rent is small.
    if (!c.ataClosed) {
      c.ataClosed = true;
      if (typeof this.solana?.closeTokenAccount === 'function') {
        try {
          await this.solana.closeTokenAccount({
            secretKey: new Uint8Array(Buffer.from(order.secret.solSecretKey, 'base64')),
            mint: order.mint,
          });
        } catch (e) {
          this.log('trade_ata_close_error', `${order.orderId} ${digest(e).code}`);
        }
      }
      return this.#saveOrder(order);
    }

    // 5. Quote SOL→ZEC to the client, with the treasury as the refund destination (never the dead wallet).
    if (!c.bridge) {
      if (c.payRetryAt && this.nowMs() < c.payRetryAt) return;
      const treasuryPub = this.treasury?.pubkey ?? this.entitySolanaAddress;
      if (!treasuryPub) return this.#fail(order, 'bridge_close', 'treasury_missing', { keepSecret: true });
      let amount;
      if (c.bridgeFromTreasury) {
        amount = num(c.bridgeRetryAmount);
      } else {
        let balance = 0;
        try { balance = num(await this.solana.balance(pub)); } catch { balance = 0; }
        amount = Math.floor(balance - LAMPORTS_DUST);
      }
      if (!(amount > 0)) return this.#fail(order, 'bridge_close', 'no_lamports_to_bridge', { keepSecret: true });
      const q = await this.intents.quote({
        direction: 'sol-to-zec',
        amount: String(Math.floor(amount)),
        recipient: order.secret.returnAddress,
        refundTo: treasuryPub,
        slippageBps: this.cfg.intentsSlippageBps,
        deadline: iso(this.nowMs() + this.cfg.depositWindowMs),
        dry: false,
      });
      if (!q?.depositAddress || !isValidSolanaAddress(q.depositAddress)) {
        throw coded('close_deposit_address', '1Click returned an invalid Solana deposit address');
      }
      c.bridge = {
        depositAddress: q.depositAddress,
        depositMemo: q.depositMemo ?? null,
        amountIn: String(q.amountIn ?? amount),
        expectedZats: String(q.amountOut ?? ''),
        deadline: q.deadline,
        attemptAt: null,
        txid: null,
      };
      // The close fee is recorded in ZEC using the close quote's own rate (plan §7.4.3).
      if (!c.feeRecorded && c.feeLamports != null) {
        const rate = num(q.amountOut) / num(q.amountIn || amount);
        const zats = Math.floor(num(c.feeLamports) * (Number.isFinite(rate) && rate > 0 ? rate : 0));
        this.ledger.append('fee', { orderId: order.orderId, zats, leg: 'close', sol: num(c.feeLamports) });
        c.feeRecorded = true;
      }
      return this.#saveOrder(order);
    }

    // 6. Send the SOL deposit, then wait for the payout.
    if (!c.bridge.txid) {
      c.bridge.attemptAt = this.nowMs();
      c.bridgeAttempts = num(c.bridgeAttempts) + 1;
      await this.#journal({ id: `close_bridge:${order.orderId}:${c.bridge.attemptAt}`, op: 'sol_bridge_send', orderId: order.orderId });
      await this.#saveOrder(order);
      let sig;
      try {
        if (c.bridgeFromTreasury) {
          if (typeof this.treasury?.send !== 'function') throw coded('treasury_unavailable', 'no treasury.send');
          sig = (await this.treasury.send({ to: c.bridge.depositAddress, lamports: num(c.bridge.amountIn), orderId: order.orderId }))?.signature;
        } else {
          if (typeof this.solana?.transferSol !== 'function') throw coded('transfer_unavailable', 'no solana.transferSol');
          sig = (await this.solana.transferSol({
            secretKey: new Uint8Array(Buffer.from(order.secret.solSecretKey, 'base64')),
            to: c.bridge.depositAddress,
            lamports: num(c.bridge.amountIn),
            orderId: order.orderId,
          }))?.signature;
        }
      } catch (e) {
        this.#recordError(order, 'bridge_close', e);
        await this.#saveOrder(order);
        if (c.bridgeAttempts >= 3) return this.#fail(order, 'bridge_close', 'close_bridge_send_failed', { keepSecret: true });
        return;
      }
      if (!sig) return this.#fail(order, 'bridge_close', 'close_bridge_no_signature', { keepSecret: true });
      c.bridge.txid = sig;
      order.state = 'paying';
      await this.#saveOrder(order);
      if (typeof this.intents?.submitDeposit === 'function') {
        try { await this.intents.submitDeposit({ depositAddress: c.bridge.depositAddress, txHash: sig }); } catch { /* optional */ }
      }
      await this.#clearJournal(`close_bridge:${order.orderId}:${c.bridge.attemptAt}`);
      return;
    }
    order.state = 'paying';
    return this.#saveOrder(order);
  }

  /** Deadlines: max hold, with the same compare-and-set path as target/stop. */
  async checkDeadlines() {
    if (!this.enabled) return;
    const state = await this.store.load();
    for (const order of Object.values(state.orders ?? {})) {
      if (order.state !== 'holding') continue;
      const opened = Date.parse(order.openedAt ?? order.createdAt);
      if (Number.isFinite(opened) && this.nowMs() >= opened + num(order.maxHoldHours) * HOUR_MS) {
        await this.#beginClose(order.orderId, 'deadline');
      }
    }
  }

  // ---- payout (plan §7.4.6, §7.4.7) --------------------------------------------------------------------------

  async #advancePaying(order) {
    const c = order.close;
    const b = c.bridge;
    if (!b?.depositAddress) {
      order.state = 'closing';
      return this.#saveOrder(order);
    }
    let status;
    try {
      status = await this.intents.status({ depositAddress: b.depositAddress, depositMemo: b.depositMemo ?? undefined });
    } catch (e) {
      this.#recordError(order, 'payout', e);
      await this.#saveOrder(order);
      if (this.#closeBridgeTimedOut(order)) await this.#retryCloseBridge(order, 'payout_timeout');
      return;
    }
    const s = String(status?.status ?? '').toUpperCase();
    if (s === 'SUCCESS') {
      const out = num(status?.swapDetails?.amountOut ?? b.expectedZats);
      if (!(out > 0)) {
        this.#recordError(order, 'payout', coded('payout_zero', 'SUCCESS with no amount'));
        await this.#saveOrder(order);
        return;
      }
      const txid = status?.swapDetails?.destinationChainTxHashes?.[0]?.hash ?? null;
      this.ledger.append('payout', { orderId: order.orderId, zats: out, txid });
      const heldMs = Math.max(0, this.nowMs() - Date.parse(order.openedAt ?? order.createdAt));
      this.ledger.append('trade_close', {
        orderId: order.orderId,
        reason: c.reason ?? 'client',
        solOut: String(c.solOut ?? '0'),
        price: String(c.price ?? '0'),
        txid: c.txid ?? null,
        heldMs,
        wallet: 'discarded',
      });
      c.payoutZats = String(out);
      c.payoutTxid = txid;
      order.state = 'closed';
      order.closedAt = iso(this.nowMs());
      order.wipePending = true;
      await this.#saveOrder(order);
      // Write the secret-free version to primary AND .bak. `forget` clears the in-memory copy too.
      await this.store.forget(order.orderId);
      order.secret = null;
      order.wipePending = false;
      return this.#saveOrder(order);
    }
    if (['REFUNDED', 'FAILED', 'INCOMPLETE_DEPOSIT'].includes(s)) {
      return this.#retryCloseBridge(order, `payout_${s.toLowerCase()}`);
    }
    if (this.#closeBridgeTimedOut(order)) return this.#retryCloseBridge(order, 'payout_timeout');
    await this.#saveOrder(order);
  }

  #closeBridgeTimedOut(order) {
    const since = num(order.close?.bridge?.attemptAt ?? Date.parse(order.close?.startedAt ?? order.createdAt));
    return Number.isFinite(since) && this.nowMs() - since > this.cfg.bridgeTimeoutMs;
  }

  /**
   * The close bridge refunded to the treasury. Re-quote from the treasury (the order wallet may be empty) up to
   * two immediate attempts, then every 15 minutes for 24 h; only then declare the payout failed and keep the
   * client address sealed for a manual settlement.
   */
  async #retryCloseBridge(order, code) {
    const c = order.close;
    c.bridgeRetries = num(c.bridgeRetries) + 1;
    const started = Date.parse(c.startedAt ?? order.createdAt);
    if (Number.isFinite(started) && this.nowMs() - started > 24 * HOUR_MS) {
      return this.#fail(order, 'payout', code, { keepSecret: true });
    }
    c.bridgeRetryAmount = c.bridgeRetryAmount ?? c.bridge?.amountIn ?? null;
    c.bridgeFromTreasury = true;
    c.bridge = null;
    if (c.bridgeRetries > 2) c.payRetryAt = this.nowMs() + 15 * 60_000;
    order.state = 'closing';
    return this.#saveOrder(order);
  }

  // ---- refunds (plan §7.7) -----------------------------------------------------------------------------------

  async #refundOrder(order, reason, stage, { leg = 'zec' } = {}) {
    order.state = 'refunding';
    order.refund = {
      leg,
      reason: String(reason ?? 'failed'),
      stage: String(stage ?? 'holding'),
      attempts: 0,
      bridge: null,
      txid: null,
      nextAttemptAt: null,
      fromTreasury: false,
      retryAmount: null,
    };
    order.error = { stage: String(stage ?? 'holding'), code: String(reason ?? 'failed'), at: iso(this.nowMs()) };
    return this.#saveOrder(order);
  }

  async #advanceRefunding(order) {
    const r = order.refund;
    if (!r) {
      order.refund = { leg: 'zec', reason: 'failed', stage: 'holding', attempts: 0, bridge: null, txid: null, nextAttemptAt: null };
      return this.#saveOrder(order);
    }
    if (r.nextAttemptAt && this.nowMs() < r.nextAttemptAt) return;
    return r.leg === 'sol' ? this.#refundSol(order) : this.#refundZec(order);
  }

  async #refundZec(order) {
    const r = order.refund;
    const returnAddress = order.secret?.returnAddress;
    if (!returnAddress) return this.#fail(order, r.stage, 'return_address_missing', { keepSecret: false });
    const amount = Math.max(0, num(order.zatsIn) - num(order.feeChargedZats) - num(this.cfg.networkFeeZats));
    if (amount < this.cfg.refundMinZats) {
      this.ledger.append('refund_skipped', { orderId: order.orderId, zats: amount, reason: 'below_min' });
      return this.#finishRefund(order);
    }
    try {
      const res = await this.zcash.send(returnAddress, amount, `refund ${order.orderId}`);
      this.ledger.append('refund', { orderId: order.orderId, zats: amount, txid: res?.txid ?? null, reason: r.reason });
      return this.#finishRefund(order);
    } catch (e) {
      r.attempts = num(r.attempts) + 1;
      r.nextAttemptAt = this.nowMs() + 30_000;
      this.#recordError(order, 'refund', e);
      await this.#saveOrder(order);
      // Keep retrying: the origin funds may still be on their way back from 1Click.
      if (r.attempts >= 40) return this.#fail(order, r.stage, 'refund_failed', { keepSecret: true });
    }
  }

  /** Buy failed after SOL arrived: bridge the SOL back to ZEC and pay the client. */
  async #refundSol(order) {
    const r = order.refund;
    const pub = order.secret?.solPublicKey;
    if (!pub || !order.secret) return this.#fail(order, r.stage, 'secret_missing', { keepSecret: false });
    const treasuryPub = this.treasury?.pubkey ?? this.entitySolanaAddress;
    if (!treasuryPub) return this.#fail(order, r.stage, 'treasury_missing', { keepSecret: true });

    if (!r.bridge) {
      let amount;
      if (r.fromTreasury) amount = num(r.retryAmount);
      else {
        let bal = 0;
        try { bal = num(await this.solana.balance(pub)); } catch { bal = 0; }
        amount = Math.floor(bal - LAMPORTS_DUST);
      }
      if (!(amount > 0)) {
        // Nothing left to refund: close the wallet honestly rather than keep a liability forever.
        r.attempts = num(r.attempts) + 1;
        if (r.attempts >= 3) return this.#finishRefund(order);
        r.nextAttemptAt = this.nowMs() + 30_000;
        return this.#saveOrder(order);
      }
      const q = await this.intents.quote({
        direction: 'sol-to-zec',
        amount: String(Math.floor(amount)),
        recipient: order.secret.returnAddress,
        refundTo: treasuryPub,
        slippageBps: this.cfg.intentsSlippageBps,
        deadline: iso(this.nowMs() + this.cfg.depositWindowMs),
        dry: false,
      });
      if (!q?.depositAddress || !isValidSolanaAddress(q.depositAddress)) {
        throw coded('refund_deposit_address', '1Click returned an invalid Solana deposit address');
      }
      r.bridge = {
        depositAddress: q.depositAddress,
        depositMemo: q.depositMemo ?? null,
        amountIn: String(q.amountIn ?? amount),
        expectedZats: String(q.amountOut ?? ''),
        deadline: q.deadline,
        attemptAt: null,
        txid: null,
      };
      return this.#saveOrder(order);
    }

    if (!r.bridge.txid) {
      r.bridge.attemptAt = this.nowMs();
      await this.#journal({ id: `refund_bridge:${order.orderId}:${r.bridge.attemptAt}`, op: 'sol_refund_send', orderId: order.orderId });
      await this.#saveOrder(order);
      try {
        const sig = r.fromTreasury
          ? (await this.treasury.send({ to: r.bridge.depositAddress, lamports: num(r.bridge.amountIn), orderId: order.orderId }))?.signature
          : (await this.solana.transferSol({
            secretKey: new Uint8Array(Buffer.from(order.secret.solSecretKey, 'base64')),
            to: r.bridge.depositAddress,
            lamports: num(r.bridge.amountIn),
            orderId: order.orderId,
          }))?.signature;
        if (!sig) throw coded('refund_no_signature', 'refund transfer returned no signature');
        r.bridge.txid = sig;
        await this.#saveOrder(order);
        if (typeof this.intents?.submitDeposit === 'function') {
          try { await this.intents.submitDeposit({ depositAddress: r.bridge.depositAddress, txHash: sig }); } catch { /* optional */ }
        }
        await this.#clearJournal(`refund_bridge:${order.orderId}:${r.bridge.attemptAt}`);
      } catch (e) {
        r.attempts = num(r.attempts) + 1;
        r.nextAttemptAt = this.nowMs() + 30_000;
        this.#recordError(order, 'refund', e);
        await this.#saveOrder(order);
        if (r.attempts >= 5) return this.#fail(order, r.stage, 'refund_bridge_failed', { keepSecret: true });
      }
      return;
    }

    let status;
    try {
      status = await this.intents.status({ depositAddress: r.bridge.depositAddress, depositMemo: r.bridge.depositMemo ?? undefined });
    } catch (e) {
      this.#recordError(order, 'refund', e);
      return this.#saveOrder(order);
    }
    const s = String(status?.status ?? '').toUpperCase();
    if (s === 'SUCCESS') {
      const zats = num(status?.swapDetails?.amountOut ?? r.bridge.expectedZats);
      const txid = status?.swapDetails?.destinationChainTxHashes?.[0]?.hash ?? null;
      this.ledger.append('refund', { orderId: order.orderId, zats, txid, reason: r.reason });
      return this.#finishRefund(order);
    }
    if (['REFUNDED', 'FAILED', 'INCOMPLETE_DEPOSIT'].includes(s)) {
      r.attempts = num(r.attempts) + 1;
      r.retryAmount = r.retryAmount ?? r.bridge.amountIn;
      r.bridge = null;
      r.fromTreasury = true;
      r.nextAttemptAt = this.nowMs() + 60_000;
      await this.#saveOrder(order);
      if (r.attempts >= 3) return this.#fail(order, r.stage, 'refund_bridge_refunded', { keepSecret: true });
      return;
    }
    if (r.bridge.attemptAt && this.nowMs() - r.bridge.attemptAt > this.cfg.bridgeTimeoutMs) {
      r.attempts = num(r.attempts) + 1;
      r.retryAmount = r.retryAmount ?? r.bridge.amountIn;
      r.bridge = null;
      r.fromTreasury = true;
      r.nextAttemptAt = this.nowMs() + 60_000;
      await this.#saveOrder(order);
      if (r.attempts >= 3) return this.#fail(order, r.stage, 'refund_timeout', { keepSecret: true });
    }
  }

  async #finishRefund(order) {
    order.state = 'refunded';
    order.closedAt = iso(this.nowMs());
    order.wipePending = true;
    await this.#saveOrder(order);
    await this.store.forget(order.orderId);
    order.secret = null;
    order.wipePending = false;
    return this.#saveOrder(order);
  }

  async #fail(order, stage, code, { keepSecret = true } = {}) {
    this.ledger.append('trade_failed', { orderId: order.orderId, stage: String(stage), code: String(code) });
    order.state = 'failed';
    order.error = { stage: String(stage), code: String(code), at: iso(this.nowMs()) };
    order.closedAt = iso(this.nowMs());
    if (keepSecret) return this.#saveOrder(order);
    order.wipePending = true;
    await this.#saveOrder(order);
    await this.store.forget(order.orderId);
    order.secret = null;
    order.wipePending = false;
    return this.#saveOrder(order);
  }

  // ---- death (plan §7.6) -------------------------------------------------------------------------------------

  /**
   * Stop accepting orders and try to settle every open position within the budget. Anything unfinished is
   * recorded as `trade_abandoned`; its key remains in the archive escrow, which is the honest recovery path.
   * Never throws: death must proceed even if settlement fails.
   */
  async settleOnDeath(budgetMs = 10 * 60_000) {
    this.draining = true;
    const deadline = this.nowMs() + Math.max(0, num(budgetMs));
    const out = { settled: [], abandoned: [] };
    let state;
    try { state = await this.store.load(); } catch { return out; }
    const open = Object.values(state.orders ?? {}).filter((o) => !isTerminal(o));
    for (const original of open) {
      const id = original.orderId;
      try {
        await this.#withOrder(id, async () => {
          let order = await this.#loadOrder(id);
          if (!order || isTerminal(order)) return;
          if (order.state === 'holding') {
            await this.#beginClose(id, 'death');
            order = await this.#loadOrder(id);
          } else if (['received', 'screening', 'quoted'].includes(order.state)) {
            await this.#refundOrder(order, 'death', order.state);
            order = await this.#loadOrder(id);
          }
          let steps = 0;
          while (order && !isTerminal(order) && steps < 200) {
            if (this.nowMs() > deadline) break;
            await this.#advance(order);
            steps++;
            order = await this.#loadOrder(id);
          }
          if (order && !isTerminal(order)) {
            this.ledger.append('trade_abandoned', { orderId: id, stage: order.state, escrow: 'archive' });
            order.state = 'abandoned';
            order.error = { stage: order.error?.stage ?? order.state, code: 'death_budget', at: iso(this.nowMs()) };
            await this.#saveOrder(order);
            out.abandoned.push(id);
          } else if (order) {
            out.settled.push(id);
          }
        });
      } catch (e) {
        const d = digest(e);
        this.log('trade_death_error', `${id} ${d.code}/${d.msgHash}`);
        out.abandoned.push(id);
      }
    }
    return out;
  }

  // __ENGINE_CHUNK_5__
}

