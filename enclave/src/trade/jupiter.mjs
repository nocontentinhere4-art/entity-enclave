// Jupiter v2 API client: token screening, order building, execution, price polling. The honeypot/freezing
// safety rules live HERE, in code (plan §9) — never prompt-enforced. Keyless traffic is limited to 0.5 rps
// upstream so a spacing limiter throttles every call; with an API key callers raise `rateLimitRps`.
// Deprecated V1 endpoints (/quote + /swap) are deliberately not implemented — they cannot be maintained.
// All HTTP is injectable (fetchImpl) for the test suite; no secrets are ever logged.

import { fetchJsonRetries } from './chains-http.mjs';
import { base58 } from './soltx.mjs';

/** Wrapped-SOL mint — the quote asset of every close leg and the price-oracle denominator. */
export const WRAPPED_SOL = 'So11111111111111111111111111111111111111112';
/** Classic SPL Token program — Token-2022 (TokenzQd…) is refused unless explicitly allowed. */
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
/** Default API base (plan §6.4: JUPITER_BASE_URL). */
export const DEFAULT_BASE = 'https://api.jup.ag';

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MAX_SLIPPAGE_BPS = 300; // plan §2.2/§9: slippage caps code-enforced

/** Typed Jupiter failure with a short `.code` for ledger refusal reasons (prose stays in the console). */
export class JupiterError extends Error {
  /**
   * @param {string} code    e.g. 'ambiguous_ticker', 'mint_authority', 'illiquid', 'not_found'
   * @param {string} message human context — console only
   */
  constructor(code, message) { super(message); this.code = code; }
}

function clampBps(v) {
  const n = Math.trunc(Number(v));
  return Math.min(Math.max(Number.isFinite(n) ? n : 100, 0), MAX_SLIPPAGE_BPS);
}

/**
 * Screen one /tokens/v2/search row against the plan's vet rules (§2.2a). Exported for unit tests.
 * Throws with the canonical refusal code on the FIRST rule violated (order matters for reproducible tests).
 *
 * @param {{ id: string, symbol?: string, name?: string, isVerified?: boolean, liquidity?: number,
 *           holderCount?: number, tokenProgram?: string,
 *           audit?: { mintAuthorityDisabled?: boolean, freezeAuthorityDisabled?: boolean,
 *                     topHoldersPercentage?: number, isSus?: boolean } }} row
 * @param {{ minLiquidityUsd?: number, allowToken2022?: boolean }} [rules]
 */
export function vetTokenRow(row, { minLiquidityUsd = 50_000, allowToken2022 = false } = {}) {
  if (!row || typeof row !== 'object' || typeof row.id !== 'string') {
    throw new JupiterError('unexpected_response', 'token row is not an object');
  }
  const audit = row.audit ?? {};
  if (audit.isSus) throw new JupiterError('sus_token', 'flagged isSus by the token audit');
  if (allowToken2022) {
    if (typeof row.tokenProgram !== 'string') throw new JupiterError('unknown_token_program', 'token row carries no tokenProgram');
  } else {
    if (typeof row.tokenProgram !== 'string') throw new JupiterError('unknown_token_program', 'token row carries no tokenProgram');
    if (row.tokenProgram !== TOKEN_PROGRAM) throw new JupiterError('token_2022', `tokenProgram ${row.tokenProgram} is not the classic SPL Token program`);
  }
  if (audit.mintAuthorityDisabled !== true) throw new JupiterError('mint_authority', 'mint authority is still active');
  if (audit.freezeAuthorityDisabled !== true) throw new JupiterError('freeze_authority', 'freeze authority is still active');
  if (!Number.isFinite(audit.topHoldersPercentage) || audit.topHoldersPercentage > 50) {
    throw new JupiterError('top_holders', `top holders concentration ${audit.topHoldersPercentage}`);
  }
  if (!Number.isFinite(row.liquidity) || row.liquidity < minLiquidityUsd) {
    throw new JupiterError('illiquid', `liquidity ${row.liquidity} below floor $${minLiquidityUsd}`);
  }
}

/** Normalize one /swap/v2/order response into the frozen contract shape (§13 phase 0). */
export function normalizeOrder(json) {
  if (json === null || typeof json !== 'object') return { transaction: null, requestId: null, outAmount: null, router: null };
  return {
    transaction: json.transaction ?? null,
    requestId: json.requestId ?? null,
    outAmount: json.outAmount != null ? String(json.outAmount) : null,
    router: json.router ?? null,
    mode: json.mode ?? null,
    feeBps: Number.isFinite(json.feeBps) ? json.feeBps : undefined,
    feeMint: json.feeMint ?? undefined,
    transactionVersion: json.transactionVersion ?? undefined,
    lastValidBlockHeight: Number.isInteger(json.lastValidBlockHeight) ? json.lastValidBlockHeight : undefined,
    priceImpactPct: Number.isFinite(json.priceImpactPct) ? json.priceImpactPct : null,
    errorCode: json.errorCode ?? undefined,
    errorMessage: json.errorMessage ?? undefined,
  };
}

/**
 * Jupiter client.
 *
 * Contract surface (frozen, plan §13 phase 0):
 *   search(query) → raw rows | tokens
 *   resolve(mintOrSymbol) → vetted { mint, symbol, name, decimals, … } or refundable error
 *   vet(row, rules) → swallows or throws
 *   order({ inputMint, outputMint, amount, taker?, slippageBps? })
 *     → { transaction, requestId, outAmount, router, … }   // transaction null ⇔ quote-only (no taker)
 *   execute({ signedTransaction, requestId })
 *     → { status, signature, code, totalInputAmount, … }   // code 0 success; -1005/-2003 → requote once
 *
 * @param {{
 *   fetchImpl?: typeof fetch, baseUrl?: string, apiKey?: string,
 *   minLiquidityUsd?: number, allowToken2022?: boolean,
 *   rateLimitRps?: number, timeoutMs?: number, retries?: number, backoffMs?: number,
 *   now?: () => number, sleep?: (ms: number) => Promise<void>,
 * }} opts
 */
export class Jupiter {
  #opts;
  #earliestNext = 0;    // earliest wall clock ms the next request may leave
  #chain = null;        // serialization of the acquire criticial section

  constructor(opts = {}) {
    this.#opts = {
      fetchImpl: globalThis.fetch,
      baseUrl: DEFAULT_BASE,
      apiKey: '',
      minLiquidityUsd: 50_000,
      allowToken2022: false,
      rateLimitRps: 0.5,       // upstream keyless limit; raise when an API key is set
      timeoutMs: 10_000,
      retries: 2,
      backoffMs: 500,
      now: Date.now,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      ...opts,
    };
  }

  /**
   * GET /tokens/v2/search?query=… — raw rows as Jupiter returns them.
   * @param {string} query  mint literal or symbol ('$' tolerated, stripped defensively)
   * @returns {Promise<Array<Object>>}
   */
  async search(query) {
    const q = encodeURIComponent(String(query ?? '').trim().replace(/^\$/, ''));
    const res = await this.#fetch(`${this.#opts.baseUrl}/tokens/v2/search?query=${q}`, { method: 'GET' }, 'jupiter search');
    throwIfNoJson(res, 'search');
    return res.json;
  }

  /** Re-run the vettability gate on one row (unit-testable; throws {JupiterError} with `.code`). */
  vet(row, rules) {
    return vetTokenRow(row, {
      minLiquidityUsd: rules?.minLiquidityUsd ?? this.#opts.minLiquidityUsd,
      allowToken2022: rules?.allowToken2022 ?? this.#opts.allowToken2022,
    });
  }

  /**
   * Resolve a ticker/mint to a vetted token. A literal 32-byte base58 mint wins over symbol search;
   * a symbol must match EXACTLY ONE verified row.
   *
   * @param {string} mintOrSymbol
   * @returns {Promise<{ mint: string, symbol: string, name: string, decimals: number, liquidity: number, holderCount: number, tokenProgram: string }>}
   */
  async resolve(mintOrSymbol) {
    const q = String(mintOrSymbol ?? '').trim().replace(/^\$/, '');
    if (!q) throw new JupiterError('bad_request', 'resolve: empty query');
    const rows = await this.search(q);
    if (!Array.isArray(rows) || rows.length === 0) throw new JupiterError('not_found', `no token matches '${q}'`);

    const isLiteral = MINT_RE.test(q) && base58.decode(q).length === 32;
    const matching = isLiteral
      ? rows.filter((r) => r.id === q)                 // literal mint: exact id match required
      : rows.filter((r) => String(r.symbol ?? '').toUpperCase() === q.toUpperCase());
    if (matching.length === 0) {
      throw new JupiterError('not_found', `no row matches '${q}'${isLiteral ? ' (mint literal)' : ''}`);
    }
    if (isLiteral) {
      if (matching.length > 1) throw new JupiterError('ambiguous_ticker', `mint literal '${q}' matched ${matching.length} rows`);
      const row = matching[0];
      this.vet(row, {});
      return shapeToken(row);
    }
    // Symbol path: exactly one VERIFIED row. Two rows with the same verified symbol → refuse (fail closed).
    const verified = matching.filter((r) => r.isVerified === true);
    if (verified.length === 0) throw new JupiterError('unverified', `symbol '${q}' has no verified row`);
    if (verified.length > 1) throw new JupiterError('ambiguous_ticker', `symbol '${q}' has ${verified.length} verified rows`);
    const row = verified[0];
    this.vet(row, {});
    return shapeToken(row);
  }

  /**
   * Jupiter /swap/v2/order. Amounts are RAW smallest-unit integers; `slippageBps` is clamped to [0, 300].
   * With `taker`: transaction is built (we sign locally). Without: `transaction === null` (quote-only).
   * With `transaction === ''`: unbuildable — see errorCode (1 insufficient funds, 2 insufficient SOL
   * for gas, 3 below gasless minimum).
   */
  async order({ inputMint, outputMint, amount, taker, slippageBps = 100 }) {
    const a = String(amount);
    if (!/^\d+$/.test(a) || BigInt(a) <= 0n) throw new JupiterError('invalid_amount', `order amount must be a positive integer: '${amount}'`);
    const q = new URLSearchParams({
      inputMint, outputMint, amount: a, slippageBps: String(clampBps(slippageBps)),
    });
    if (taker) q.set('taker', taker);
    const res = await this.#fetch(`${this.#opts.baseUrl}/swap/v2/order?${q}`, { method: 'GET' }, 'jupiter order');
    throwIfNoJson(res, 'order');
    if (typeof res.json !== 'object' || res.json === null) throw new JupiterError('unexpected_response', 'order: body is not an object');
    return normalizeOrder(res.json);
  }

  /**
   * Jupiter /swap/v2/execute — submit OUR signed transaction. On success `status === 'Success'` and
   * `code === 0`. `-1005` (blockhash expired) and `-2003` (RFQ quote expired) are the requote-once cases
   * handled by the engine, which reads `errorCode`/`code` from the result.
   */
  async execute({ signedTransaction, requestId }) {
    if (typeof signedTransaction !== 'string' || signedTransaction.length === 0) {
      throw new JupiterError('bad_request', 'execute: signedTransaction required');
    }
    const res = await this.#fetch(`${this.#opts.baseUrl}/swap/v2/execute`, {
      method: 'POST',
      body: { signedTransaction, requestId },
    }, 'jupiter execute');
    throwIfNoJson(res, 'execute');
    const j = res.json;
    if (typeof j !== 'object' || j === null) throw new JupiterError('unexpected_response', 'execute: body is not an object');
    return {
      status: j.status ?? 'Unknown',
      signature: j.signature ?? null,
      code: Number.isInteger(j.code) ? j.code : null,
      totalInputAmount: j.totalInputAmount != null ? String(j.totalInputAmount) : null,
      inputAmountResult: j.inputAmountResult != null ? String(j.inputAmountResult) : null,
      totalOutputAmount: j.totalOutputAmount != null ? String(j.totalOutputAmount) : null,
      outputAmountResult: j.outputAmountResult != null ? String(j.outputAmountResult) : null,
      error: j.error ?? undefined,
    };
  }

  /**
   * Price probe (the close-trigger oracle, plan §2.2c): quote-only sell-side quote in SOL for `amount`
   * raw tokens. Bid side — an ask-side pump on a thin pool cannot fake a close.
   */
  async priceProbe({ inputMint, outputMint = WRAPPED_SOL, amount, slippageBps = 100 }) {
    const o = await this.order({ inputMint, outputMint, amount, slippageBps }); // no taker → never builds
    if (o.transaction !== null) throw new JupiterError('quote_only_expected', 'price probe unexpectedly built a transaction');
    return o;
  }

  /** Exposed for tests: build a rate-limited HTTP GET/POST via the shared retry helper. */
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

  /** Space requests ≥ 1/rateLimitRps apart; concurrent acquirers queue on one chain promise. */
  async #acquire() {
    const job = (this.#chain ?? Promise.resolve()).then(() => this.#ospace());
    this.#chain = job.catch(() => { /* keep the chain alive */ });
    return job;
  }

  async #ospace() {
    const interval = Math.max(1, Math.ceil(1000 / (this.#opts.rateLimitRps > 0 ? this.#opts.rateLimitRps : 0.5)));
    const nowMs = this.#opts.now();
    const waitMs = Math.max(0, this.#earliestNext - nowMs);
    if (waitMs > 0) await this.#opts.sleep(waitMs);
    this.#earliestNext = Math.max(this.#opts.now(), this.#earliestNext) + interval;
  }
}

function throwIfNoJson(res, label) {
  if (!res?.json) throw new JupiterError('unexpected_response', `${label}: no JSON body (status ${res?.status ?? 'network'})`);
}

function shapeToken(row) {
  return {
    mint: row.id,
    symbol: row.symbol,
    name: row.name,
    decimals: row.decimals,
    liquidity: row.liquidity,
    holderCount: row.holderCount,
    tokenProgram: row.tokenProgram,
  };
}
