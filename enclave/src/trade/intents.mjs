// NEAR Intents 1Click client — the ZEC ⇄ SOL bridge of the trade desks (plan §2.1).
//
//   POST /v0/quote           quote a bridge; `dry:true` prices a round-trip WITHOUT producing a deposit
//   POST /v0/deposit/submit  nudge detection after the ZEC/SOL deposit left the entity wallet
//   GET  /v0/status          poll by depositAddress (never re-send; the status is where recovery lives)
//   GET  /v0/tokens          asset catalogue (cached 1h; startup preflight for ZEC+sol OMFTs)
//
// The transparent-address preflight is implemented HERE (§2.1/§9): a ZEC-leg quote whose depositAddress
// is transparent (`t…`) CANNOT carry the depositMemo a shielded note could — sending would brick the
// order, so quote() aborts before any wallet send happens. This single check prevents the most likely
// total loss of an order.
//
// All HTTP is injectable for tests; no client address or memo is ever logged.

import { fetchJsonRetries } from './chains-http.mjs';

/** OMFT asset ids on NEAR Intents (plan §2.1a). */
export const ASSETS = Object.freeze({
  ZEC: 'nep141:zec.omft.near',  // 8 decimals
  SOL: 'nep141:sol.omft.near',  // 9 decimals
});

/** The orphaned-memo landmine: shielded ZEC recipients we can memo. */
const SHIELDED_ZEC_RE = /^(u1|zs1)/;
/** Transparent ZEC recipients — zingo cannot attach a memo; memos would be lost on-transit. */
const TRANSPARENT_ZEC_RE = /^t/;

const MIN_DEADLINE_WINDOW_MS = 60_000; // "refuse quote if deadline too near" (plan §9 table)

/** Typed 1Click failure with a short `.code`; prose stays on the console. */
export class IntentsError extends Error {
  /**
   * @param {string} code   e.g. 'transparent_deposit_memo', 'deadline_too_near', 'asset_unsupported'
   * @param {string} message
   */
  constructor(code, message) { super(message); this.code = code; }
}

function clampBps(v) {
  const n = Math.trunc(Number(v));
  return Math.min(Math.max(Number.isFinite(n) ? n : 100, 0), 300); // plan §9: slippage caps ≤ 300 bps
}

/**
 * 1Click client.
 * @param {{
 *   fetchImpl?: typeof fetch, baseUrl?: string, apiKey?: string,      // ONECLICK_BASE_URL / ONECLICK_API_KEY
 *   timeoutMs?: number, retries?: number, backoffMs?: number,
 *   now?: () => number, sleep?: (ms: number) => Promise<void>,
 * }} opts
 */
export class Intents {
  #opts; #earliestNext = 0; #chain = null; #tokensCache = null; #tokensCacheAt = 0;

  constructor(opts = {}) {
    this.#opts = {
      fetchImpl: globalThis.fetch,
      baseUrl: 'https://1click.chaindefuser.com',
      apiKey: '',
      timeoutMs: 15_000,
      retries: 2,
      backoffMs: 500,
      now: Date.now,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      ...opts,
    };
  }

  /**
   * GET /v0/tokens (cached 60 s — plan contract; startup preflight hits ~1 call, quotes refresh it on
   * ttl expiry). Returns the raw row array.
   * @param {{ force?: boolean }} [o]
   */
  async tokens({ force = false } = {}) {
    const { now } = this.#opts;
    if (!force && this.#tokensCache && now() - this.#tokensCacheAt < 3_600_000) return this.#tokensCache;
    const res = await this.#fetch(`${this.#opts.baseUrl}/v0/tokens`, { method: 'GET' }, 'oneclick tokens');
    if (!res?.json || !Array.isArray(res.json)) throw new IntentsError('unexpected_response', 'oneclick tokens: no JSON array body');
    this.#tokensCache = res.json;
    this.#tokensCacheAt = now();
    return res.json;
  }

  /**
   * Startup preflight (plan §2.1a): assert the bridge assets exist and are usable.
   * @param {{ originAsset?: string, destinationAsset?: string, decimals?: number }} spec
   * @returns {Promise<{ ok: boolean, missing: string[] }>} missing asset ids; empty = ready
   */
  async assertAssetsSupported({ originAsset = ASSETS.ZEC, destinationAsset = ASSETS.SOL, decimals = 8 } = {}) {
    const rows = await this.tokens();
    const wanted = [originAsset, destinationAsset];
    const missing = [];
    for (const id of wanted) {
      const row = rows.find((r) => r?.assetId === id);
      if (!row) { missing.push(id); continue; }
      if (row.enabled === false || row.deprecated === true) { missing.push(id); continue; }
      if (Number.isInteger(decimals) && Number.isInteger(row.decimals) && row.decimals !== decimals) {
        throw new IntentsError('asset_unsupported', `${id}: decimals ${row.decimals}, expected ${decimals}`);
      }
    }
    return { ok: missing.length === 0, missing };
  }

  /**
   * POST /v0/quote → the frozen contract shape (plan §13 phase 0):
   *   quote(req) → { depositAddress, depositMemo, amountIn, amountOut, deadline }
   * plus `minAmountOut` (1Click returns it; the refund path needs it).
   *
   * For a ZEC-origin leg the response is preflighted BEFORE return: a transparent `t…` deposit address
   * with a required memo aborts (`transparent_deposit_memo`) — the engine never even sees a sendable
   * quote. `dry:true` quotes carry no depositAddress/deadline (they are for round-trip pricing only).
   *
   * Contract `req` (all amounts as integer strings):
   *   { originAsset, destinationAsset, amount, recipient, refundTo,
   *     slippageBps?, deadline?, depositType?, recipientType?, refundType?, dry? }
   *
   * @returns {Promise<{ depositAddress: string|null, depositMemo: string|null, amountIn: string,
   *           amountOut: string, minAmountOut: string|null, deadline: string|null }>}
   */
  async quote(req) {
    const { originAsset, destinationAsset, amount, recipient, refundTo } = req ?? {};
    if (!originAsset || !destinationAsset) throw new IntentsError('bad_request', 'quote: originAsset/destinationAsset required');
    const a = String(amount ?? '');
    if (!/^\d+$/.test(a) || BigInt(a) <= 0n) throw new IntentsError('invalid_amount', `quote amount must be a positive integer: '${amount}'`);
    if (!recipient || !refundTo) throw new IntentsError('bad_request', 'quote: recipient (destination-side) and refundTo (origin-side) required');
    if (originAsset === ASSETS.ZEC && !SHIELDED_ZEC_RE.test(refundTo)) {
      // Entity refundTo MUST be shielded on a ZEC leg (plan §2.1: the entity's u1 address);
      // a transparent refund target would strand the bridge refund outside the shielded pool.
      throw new IntentsError('bad_refund_address', 'quote: refundTo must be a shielded ZEC address (u1/zs1) for ZEC-origin legs');
    }

    const deadlineMs = deadlineMsOf(req.deadline, this.#opts.now);
    if (deadlineMs !== null && deadlineMs - this.#opts.now() < MIN_DEADLINE_WINDOW_MS) {
      throw new IntentsError('deadline_too_near', `quote deadline ${new Date(deadlineMs).toISOString()} is < ${MIN_DEADLINE_WINDOW_MS / 1000}s away`);
    }

    const body = {
      dry: req.dry === true,
      swapType: 'EXACT_INPUT',
      slippageTolerance: clampBps(req.slippageBps ?? 100),
      originAsset,
      depositType: req.depositType ?? 'ORIGIN_CHAIN',
      destinationAsset,
      amount: a,
      recipient,
      recipientType: req.recipientType ?? 'DESTINATION_CHAIN',
      refundTo,
      refundType: req.refundType ?? 'ORIGIN_CHAIN',
      ...(deadlineMs !== null ? { deadline: new Date(deadlineMs).toISOString() } : {}),
    };
    const res = await this.#fetch(`${this.#opts.baseUrl}/v0/quote`, { method: 'POST', body }, 'oneclick quote');
    if (!res?.json) throw new IntentsError('unexpected_response', `oneclick quote: no JSON body (status ${res?.status})`);
    const q = res.json.quote;
    if (!q || q.amountIn === undefined || q.amountOut === undefined) {
      throw new IntentsError('unexpected_response', 'oneclick quote: response carries no complete quote object');
    }

    // Deposit-memo preflight (plan §2.1 note): fires ONLY on ZEC-origin legs — the memo travels with OUR
    // deposit; on SOL-origin legs depositAddress is a Solana pubkey and memo rules don't apply.
    const depositAddress = q.depositAddress ?? null;
    const depositMemo = q.depositMemo || null;
    if (!req.dry && originAsset === ASSETS.ZEC && depositAddress) {
      const shielded = SHIELDED_ZEC_RE.test(depositAddress);
      if (!shielded && depositMemo) {
        throw new IntentsError('transparent_deposit_memo', `deposit address '${depositAddress.slice(0, 4)}…' is transparent but requires a memo — zingo cannot attach one, aborting before any funds move`);
      }
    }
    return {
      depositAddress: req.dry ? null : depositAddress,
      depositMemo: req.dry ? null : depositMemo,
      amountIn: String(q.amountIn),
      amountOut: String(q.amountOut),
      minAmountOut: q.minAmountOut != null ? String(q.minAmountOut) : null,
      deadline: req.dry ? null : (q.deadline ?? null),
    };
  }

  /**
   * POST /v0/deposit/submit — speeds up 1Click detection after the deposit left the entity wallet.
   * NOT fatal when it fails (the bridge finds the deposit itself); the engine logs and moves on.
   * @param {string} depositAddress
   * @param {string} txHash   on-chain deposit txid
   * @returns {Promise<{ ok: boolean, body: Object|null }>}
   */
  async submit(depositAddress, txHash) {
    const res = await this.#fetch(`${this.#opts.baseUrl}/v0/deposit/submit`, {
      method: 'POST', body: { depositAddress, txHash },
    }, 'oneclick deposit/submit');
    return { ok: res?.ok === true, body: res?.json ?? null };
  }

  /**
   * GET /v0/status?depositAddress=…
   * Status enum: PENDING_DEPOSIT | KNOWN_DEPOSIT_TX | PROCESSING | SUCCESS | INCOMPLETE_DEPOSIT
   *              | REFUNDED | FAILED (plan §2.1d).
   * @returns {Promise<{ ok: boolean, status: string|null, swapDetails: Object|null, body: Object|null }>}
   */
  async status(depositAddress, { depositMemo } = {}) {
    const q = new URLSearchParams({ depositAddress });
    if (depositMemo) q.set('depositMemo', depositMemo);
    const res = await this.#fetch(`${this.#opts.baseUrl}/v0/status?${q}`, { method: 'GET' }, 'oneclick status');
    if (!res?.json) return { ok: false, status: null, swapDetails: null, body: null };
    return {
      ok: res.ok === true,
      status: res.json.status ?? null,
      swapDetails: res.json.swapDetails ?? null,
      body: res.json,
    };
  }

  /**
   * Status polling with the plan's cadence (10s → 30s, until TRADE_BRIDGE_TIMEOUT_MS). Returns the LAST
   * observation on timeout (`timedOut: true`) — recovery is status-based: every terminal state
   * (SUCCESS / FAILED / REFUNDED / INCOMPLETE_DEPOSIT) is visible no matter when we looked.
   *
   * @param {{ depositAddress: string, depositMemo?: string, timeoutMs?: number, startMs?: number, maxMs?: number }} p
   * @returns {Promise<{ ok?: boolean, status: string, swapDetails?: Object|null, polls: number, timedOut?: boolean }>}
   */
  async pollStatus({ depositAddress, depositMemo, timeoutMs = 45 * 60_000, startMs = 10_000, maxMs = 30_000 }) {
    const terminal = new Set(['SUCCESS', 'FAILED', 'REFUNDED', 'INCOMPLETE_DEPOSIT']);
    const deadline = this.#opts.now() + timeoutMs;
    let interval = startMs;
    let polls = 0;
    let last = { status: null, swapDetails: null };
    for (;;) {
      last = await this.status(depositAddress, { depositMemo });
      polls++;
      if (last.ok && terminal.has(last.status)) return { ...last, polls, timedOut: false };
      if (this.#opts.now() >= deadline) return { ...last, polls, timedOut: true };
      interval = Math.min(maxMs, interval * 2);
      await this.#opts.sleep(interval);
    }
  }

  /** Same fetch/retry plumbing as the other chain clients; spacing limiter for 1Click's unauthenticated tier. */
  async #fetch(url, { method, body }, label) {
    await this.#acquire();
    const res = await fetchJsonRetries({
      fetchImpl: this.#opts.fetchImpl,
      url, method,
      headers: this.#opts.apiKey ? { 'x-api-key': this.#opts.apiKey } : {},
      body,
      timeoutMs: this.#opts.timeoutMs, retries: this.#opts.retries, backoffMs: this.#opts.backoffMs,
      sleep: this.#opts.sleep, now: this.#opts.now, label,
    });
    return res;
  }

  async #acquire() {
    const job = (this.#chain ?? Promise.resolve()).then(() => this.#ospace());
    this.#chain = job.catch(() => { /* chain survives rejections */ });
    return job;
  }

  async #ospace() {
    // 1Click authenticated tier allows documentated rps; conservative 2 rps cap. Unauthenticated adds 0.25%
    // pricing fees downstream — this limiter only spaces transport, pricing is 1Click's business.
    const interval = Math.max(1, Math.ceil(1000 / 2));
    const nowMs = this.#opts.now();
    const waitMs = Math.max(0, this.#earliestNext - nowMs);
    if (waitMs > 0) await this.#opts.sleep(waitMs);
    this.#earliestNext = Math.max(this.#opts.now(), this.#earliestNext) + interval;
  }
}

/** Deadline normalizer: ISO string | Date | ms-int → UTC ms. null for absent. Throws on garbage. */
function deadlineMsOf(d, now) {
  if (d === undefined || d === null) return null;
  const t = d instanceof Date ? d.getTime() : typeof d === 'number' ? d : Date.parse(String(d));
  if (!Number.isFinite(t)) throw new IntentsError('bad_request', `quote: unparseable deadline '${d}'`);
  const ms = t > 1e12 ? t : t * 1000; // tolerate seconds-since-epoch
  if (ms < now()) throw new IntentsError('bad_request', 'quote: deadline is already past');
  return ms;
}
