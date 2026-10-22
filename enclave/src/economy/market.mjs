// Market prices: the same 1Click rail that prices swap_quote (GET /v0/tokens, with a dry POST /v0/quote
// fallback for 1 whole unit against USDC). fetch is injectable so tests never touch the network. USDC is a
// constant 1.0. Prices are indicative, not an oracle: see the plan's risk notes.

export const ASSETS = {
  zec: { symbol: 'ZEC', decimals: 8, oneclickId: 'nep141:zec.omft.near' },
  sol: { symbol: 'SOL', decimals: 9, oneclickId: 'nep141:sol.omft.near', mint: 'So11111111111111111111111111111111111111112' },
  usdc: { symbol: 'USDC', decimals: 6, oneclickId: 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
};

const QUOTE_TIMEOUT_MS = 10_000;
const TOKENS_PATH = '/v0/tokens';
const QUOTE_PATH = '/v0/quote';

function err(code, msg) { const e = new Error(msg); e.code = code; return e; }

export function normalizeAsset(asset) {
  const a = String(asset ?? '').toLowerCase().trim();
  return a in ASSETS ? a : undefined;
}

export function toUnits(asset, amount) {
  const a = normalizeAsset(asset);
  if (!a) throw err('bad_asset', `unknown asset: ${asset}`);
  const units = Math.round(Number(amount) * 10 ** ASSETS[a].decimals);
  if (!Number.isFinite(units) || units < 0) throw err('bad_amount', 'amount must be a positive number of units');
  return units;
}

export function fromUnits(asset, units) {
  const a = normalizeAsset(asset);
  if (!a) throw err('bad_asset', `unknown asset: ${asset}`);
  const u = Number(units);
  if (!Number.isFinite(u) || u < 0) throw err('bad_amount', 'units must be a positive number');
  return u / 10 ** ASSETS[a].decimals;
}

/** USD prices for zec/sol/usdc. `fetchImpl` defaults to global fetch but is injected in tests. */
export class Market {
  constructor({ fetchImpl = null, now = () => Date.now(), ttlMs = 60_000, baseUrl = 'https://1click.chaindefuser.com', maxStaleMs = 900_000 } = {}) {
    this.fetchImpl = fetchImpl ?? globalThis.fetch;
    this.now = now;
    this.ttlMs = ttlMs;
    this.baseUrl = String(baseUrl ?? '').replace(/\/+$/, '');
    this.maxStaleMs = maxStaleMs;
    this._tokens = null;
    this._tokensAt = 0;
  }

  /** Token prices from GET /v0/tokens, cached for ttlMs; a torn or failed response keeps the old cache. */
  async tokens() {
    const now = this.now();
    if (this._tokens && now - this._tokensAt < this.ttlMs) return this._tokens;
    let res;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${TOKENS_PATH}`, { signal: AbortSignal.timeout(QUOTE_TIMEOUT_MS) });
    } catch {
      return this._tokens ?? [];
    }
    if (!res.ok) return this._tokens ?? [];
    let j;
    try { j = await res.json(); } catch { return this._tokens ?? []; }
    const raw = Array.isArray(j) ? j : (Array.isArray(j?.tokens) ? j.tokens : (Array.isArray(j?.data) ? j.data : []));
    const list = [];
    for (const t of raw) {
      if (!t || typeof t !== 'object') continue;
      const symbol = String(t.symbol ?? '').toLowerCase();
      if (!symbol || !(symbol in ASSETS)) continue;
      const price = Number(t.price ?? t.priceUsd ?? 0);
      const updatedAt = t.priceUpdatedAt != null ? Date.parse(t.priceUpdatedAt) : 0;
      if (Number.isFinite(price) && price > 0 && Number.isFinite(updatedAt)) list.push({ symbol, price, updatedAt });
    }
    this._tokens = list;
    this._tokensAt = now;
    return list;
  }

  /** { asset, usd, source, updatedAt, fetchedAt }. Throws price_unavailable when no price can be had. */
  async priceUsd(asset) {
    const a = normalizeAsset(asset);
    if (!a) throw err('bad_asset', `unknown asset: ${asset}`);
    const fetchedAt = this.now();
    if (a === 'usdc') return { asset: 'usdc', usd: 1.0, source: 'constant:usdc', updatedAt: fetchedAt, fetchedAt };

    let best = null;
    for (const token of await this.tokens()) {
      if (token.symbol !== a) continue;
      if (token.price > 0 && fetchedAt - token.updatedAt <= this.maxStaleMs) {
        best = { usd: token.price, source: '1click:tokens', updatedAt: token.updatedAt };
        break;
      }
    }
    if (!best) {
      // Fallback: price 1 whole unit of `a` against USDC with a dry quote, the same rail as swap_quote.
      const quote = await this.#dryQuote(a, 'usdc');
      if (quote) best = { usd: quote, source: '1click:quote', updatedAt: fetchedAt };
    }
    if (!best) throw err('price_unavailable', `market: no price for ${asset}`);
    return { asset: a, usd: best.usd, source: best.source, updatedAt: best.updatedAt, fetchedAt };
  }

  async prices() {
    const out = {};
    for (const a of Object.keys(ASSETS)) out[a] = await this.priceUsd(a);
    return out;
  }

  async #dryQuote(from, to) {
    const body = {
      dry: true, swapType: 'EXACT_INPUT', slippageTolerance: 100,
      originAsset: ASSETS[from].oneclickId, depositType: 'ORIGIN_CHAIN',
      destinationAsset: ASSETS[to].oneclickId,
      amount: String(10 ** ASSETS[from].decimals),
      refundTo: ASSETS[from].sample ?? ASSETS[to].sample,
      refundType: 'ORIGIN_CHAIN',
      recipient: ASSETS[to].sample,
      recipientType: 'DESTINATION_CHAIN',
      deadline: new Date(this.now() + 3_600_000).toISOString(),
    };
    let res;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${QUOTE_PATH}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        signal: AbortSignal.timeout(QUOTE_TIMEOUT_MS),
      });
    } catch { return null; }
    if (!res.ok) return null;
    let j;
    try { j = await res.json(); } catch { return null; }
    const q = j?.quote ?? {};
    const out = Number(q?.amountOutFormatted);
    if (Number.isFinite(out) && out > 0) return out;
    const inUsd = Number(q?.amountInUsd);
    if (Number.isFinite(inUsd) && inUsd > 0) return inUsd;
    return null;
  }
}
