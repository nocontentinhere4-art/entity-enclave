// Pure aggregation for GET /trades and GET /trades/<orderId> (plan §8).
//
// Input is ledger entries only (plus, for the single-order view, the optional sealed order snapshot the engine
// already passed through `publicOrder`). Nothing here reads the store or the network, so the same numbers are
// reproducible by anyone replaying the public chain.
//
// Deliberate small deviation from the plan's literal wording: an order that ended in `refund`, `trade_failed`
// or `trade_abandoned` is not counted as `open` even though it has no `trade_close`. Those are reported under
// `refunded` / `failed`; calling them "open" would make the public count grow forever. Everything else follows
// the fixed definitions in §8.

const round = (n, digits = 1) => {
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

function median(values) {
  const xs = values.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!xs.length) return 0;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : Math.round((xs[mid - 1] + xs[mid]) / 2);
}

function index(entries) {
  const received = new Map();
  const opens = new Map();
  const closes = new Map();
  const payouts = new Map();
  const refunds = new Map();
  const failures = new Map();
  const abandoned = new Map();
  const fees = [];
  const priceJumps = [];

  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || e.private) continue;
    const d = e.data ?? {};
    switch (e.type) {
      case 'order_received': if (!received.has(d.orderId)) received.set(d.orderId, { ...e, data: d }); break;
      case 'trade_open': if (d.orderId) opens.set(d.orderId, { ...e, data: d }); break;
      case 'trade_close': if (d.orderId) closes.set(d.orderId, { ...e, data: d }); break;
      case 'payout': if (d.orderId) payouts.set(d.orderId, { ...e, data: d }); break;
      case 'refund': if (d.orderId) refunds.set(d.orderId, { ...e, data: d }); break;
      case 'trade_failed': if (d.orderId) failures.set(d.orderId, { ...e, data: d }); break;
      case 'trade_abandoned': if (d.orderId) abandoned.set(d.orderId, { ...e, data: d }); break;
      case 'fee': if (d.orderId) fees.push({ ...e, data: d }); break;
      case 'trade_price_jump': if (d.orderId) priceJumps.push({ ...e, data: d }); break;
      default: break;
    }
  }
  return { received, opens, closes, payouts, refunds, failures, abandoned, fees, priceJumps };
}

function feeCloseZats(idx, orderId) {
  return idx.fees
    .filter((f) => f.data.orderId === orderId && f.data.leg === 'close')
    .reduce((s, f) => s + num(f.data.zats), 0);
}

function feeOpenZats(idx, orderId) {
  return idx.fees
    .filter((f) => f.data.orderId === orderId && f.data.leg === 'open')
    .reduce((s, f) => s + num(f.data.zats), 0);
}

/**
 * GET /trades.
 * @param {Array<{type:string,data:object,ts:string,private?:boolean}>} entries public ledger entries
 * @param {{now?:number|string, recentLimit?:number}} [opts]
 */
export function summarizeTrades(entries, { recentLimit = 20 } = {}) {
  const idx = index(entries);
  const closedIds = new Set(idx.closes.keys());
  const refundedIds = new Set([...idx.refunds.keys()]);
  const failedIds = new Set([...idx.failures.keys(), ...idx.abandoned.keys()]);
  const openIds = [...idx.received.keys()].filter((id) => !closedIds.has(id) && !refundedIds.has(id) && !failedIds.has(id));

  // Open-leg fees always count; close-leg fees count only for orders that actually closed (plan §8).
  const feesZats = idx.fees.reduce(
    (sum, f) => sum + (f.data.leg === 'close' && !closedIds.has(f.data.orderId) ? 0 : num(f.data.zats)),
    0,
  );
  const openFeesOnOpen = openIds.reduce((sum, id) => sum + feeOpenZats(idx, id), 0);

  let wins = 0;
  const holds = [];
  const byReason = {};
  for (const id of closedIds) {
    const rec = idx.received.get(id);
    const close = idx.closes.get(id);
    const pay = idx.payouts.get(id);
    const zatsIn = num(rec?.data?.zats);
    const got = num(pay?.data?.zats) + feeCloseZats(idx, id);
    if (got > zatsIn) wins++;
    if (Number.isFinite(Number(close?.data?.heldMs))) holds.push(Number(close.data.heldMs));
    const reason = close?.data?.reason ?? 'unknown';
    byReason[reason] = (byReason[reason] ?? 0) + 1;
  }

  const recent = [...closedIds]
    .map((id) => {
      const rec = idx.received.get(id);
      const close = idx.closes.get(id);
      const pay = idx.payouts.get(id);
      const zatsIn = num(rec?.data?.zats);
      const payout = num(pay?.data?.zats);
      const fee = feeCloseZats(idx, id);
      return {
        orderId: id,
        state: 'closed',
        mint: rec?.data?.mint ?? null,
        symbol: rec?.data?.symbol ?? null,
        openedAt: rec?.ts ?? null,
        closedAt: close?.ts ?? null,
        reason: close?.data?.reason ?? null,
        returnPct: zatsIn > 0 ? round(((payout + fee - zatsIn) / zatsIn) * 100, 1) : 0,
        _ts: Date.parse(close?.ts ?? 0) || 0,
      };
    })
    .sort((a, b) => b._ts - a._ts)
    .slice(0, recentLimit)
    .map(({ _ts, ...rest }) => rest);

  return {
    generatedAt: new Date().toISOString(),
    open: openIds.length,
    closed: closedIds.size,
    winRate: closedIds.size ? round(wins / closedIds.size, 4) : 0,
    feesZats,
    feesZatsOpen: openFeesOnOpen,
    medianHoldMs: median(holds),
    byReason,
    refunded: refundedIds.size,
    failed: failedIds.size,
    recent,
    openOrders: openIds.map((id) => ({
      orderId: id,
      mint: idx.received.get(id)?.data?.mint ?? null,
      symbol: idx.received.get(id)?.data?.symbol ?? null,
      openedAt: idx.received.get(id)?.ts ?? null,
    })),
  };
}

/**
 * GET /trades/<orderId>, safe subset only (plan §8).
 *
 * @param {string} orderId
 * @param {object} input
 * @param {Array<{type:string,data:object,ts:string}>} input.entries
 * @param {import('./types.mjs').Order|null} [input.order] optional live snapshot from the engine
 * @param {number} [input.now]
 * @returns {object|null} null → 404
 */
export function orderDetail(orderId, { entries = [], order = null, now = Date.now() } = {}) {
  const idx = index(entries);
  const rec = idx.received.get(orderId);
  if (!rec && !order) return null;
  const open = idx.opens.get(orderId);
  const close = idx.closes.get(orderId);
  const pay = idx.payouts.get(orderId);
  const refund = idx.refunds.get(orderId);
  const fail = idx.failures.get(orderId) ?? idx.abandoned.get(orderId);

  let state = order?.state;
  if (!state) {
    if (close) state = 'closed';
    else if (refund) state = 'refunded';
    else if (fail) state = 'failed';
    else state = 'open';
  }

  const mint = order?.mint ?? rec?.data?.mint ?? null;
  const openedAt = order?.openedAt ?? open?.data?.at ?? rec?.ts ?? null;
  const closedAt = order?.closedAt ?? close?.ts ?? null;
  const entryPrice = order?.entry?.price ?? open?.data?.price ?? null;
  const currentPrice = order?.poll?.lastPrice ?? null;
  const payoutZats = num(pay?.data?.zats) || null;
  const heldMs = Number.isFinite(Number(close?.data?.heldMs))
    ? Number(close.data.heldMs)
    : openedAt
      ? Math.max(0, Number(now) - Date.parse(openedAt))
      : null;

  return {
    orderId,
    state,
    mint,
    symbol: order?.symbol ?? rec?.data?.symbol ?? null,
    decimals: order?.decimals ?? open?.data?.decimals ?? null,
    openedAt,
    closedAt,
    reason: order?.close?.reason ?? close?.data?.reason ?? null,
    targetPct: order?.targetPct ?? rec?.data?.targetPct ?? null,
    stopPct: order?.stopPct ?? rec?.data?.stopPct ?? null,
    entryPrice,
    currentPrice,
    unrealizedPct: entryPrice && currentPrice ? round((num(currentPrice) / num(entryPrice) - 1) * 100, 1) : null,
    solIn: order?.entry?.solIn ?? open?.data?.solIn ?? null,
    tokenOut: order?.entry?.tokenOut ?? open?.data?.tokenOut ?? null,
    txids: { open: order?.entry?.txid ?? open?.data?.txid ?? null, close: order?.close?.txid ?? close?.data?.txid ?? null },
    payoutZats,
    heldMs,
  };
}

/** Alias kept short for the HTTP layer. */
export const tradesSummary = summarizeTrades;
