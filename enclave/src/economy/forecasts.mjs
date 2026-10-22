// Forecasts with a public, automatic track record: an entity records a falsifiable price prediction
// (zec/sol/usdc, horizon 1-48 h, direction up/down/target) at the current market price; the scheduler
// settles it at expiry with the same price source, or voids it after a grace window when the price is
// unavailable. Nothing can be edited, deleted or settled by the LLM — only the scheduler writes settled/void.
import { createHash } from 'node:crypto';
import { ASSETS, normalizeAsset } from './market.mjs';

const HOUR_MS = 3_600_000;

function err(code, msg) { const e = new Error(msg); e.code = code; return e; }
function sha256(s) { return createHash('sha256').update(s).digest('hex'); }
function stable(v) {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
function iso(ms) { return new Date(ms).toISOString(); }

/** Judge a settled forecast: up/down are strict moves; target is reached when price crosses targetPriceUsd. */
export function judgeForecast({ direction, priceOpenUsd, priceCloseUsd, targetPriceUsd }) {
  const movePct = Math.round(((priceCloseUsd - priceOpenUsd) / priceOpenUsd) * 10_000) / 100;
  let hit;
  if (direction === 'up') hit = priceCloseUsd > priceOpenUsd;
  else if (direction === 'down') hit = priceCloseUsd < priceOpenUsd;
  else {
    const t = Number(targetPriceUsd);
    if (t > priceOpenUsd) hit = priceCloseUsd >= t;
    else if (t < priceOpenUsd) hit = priceCloseUsd <= t;
    else hit = Math.abs(priceCloseUsd - t) / t <= 0.001; // target == open: within 0.1% counts as reached
  }
  return { hit, movePct };
}

export class Forecasts {
  constructor({ ledger, market, config = {}, now = () => Date.now() } = {}) {
    this.ledger = ledger ?? null;
    this.market = market;
    this.config = config;
    this.now = now;
    this.open = new Map();   // id -> open forecast entry
    this.settled = [];       // settled forecasts, oldest first
    this.void = [];          // voided forecasts, oldest first
    this.done = new Set();   // ids already settled or voided: never touched again
    this.#replay();
  }

  cfg(name, fallback) { const v = this.config[name]; return v === undefined || v === null ? fallback : v; }

  /** Rebuild open/settled/void from the public ledger: survives restarts, idempotent by id. */
  #replay() {
    if (!this.ledger || typeof this.ledger.each !== 'function') return;
    for (const e of this.ledger.each(['forecast_open', 'forecast_settled', 'forecast_void'])) {
      const d = e.data;
      if (e.type === 'forecast_open') this.open.set(d.id, { ...d });
      else if (e.type === 'forecast_settled') { this.settled.push({ ...d }); this.done.add(d.id); this.open.delete(d.id); }
      else if (e.type === 'forecast_void') { this.void.push({ ...d }); this.done.add(d.id); this.open.delete(d.id); }
    }
  }

  /** Open a new forecast. Fetches the price before writing anything: price failure fails closed. */
  async openForecast({ asset, horizonHours, direction, targetPriceUsd = null, confidence, rationale, tickId }) {
    const a = normalizeAsset(asset);
    if (!a) throw err('bad_asset', `unknown asset: ${asset}`);
    const h = Number(horizonHours);
    const min = this.cfg('forecastMinHorizonHours', 1);
    const max = this.cfg('forecastMaxHorizonHours', 48);
    if (!Number.isInteger(h) || h < min || h > max) throw err('bad_horizon', `horizonHours must be an integer ${min}..${max}`);
    if (direction !== 'up' && direction !== 'down' && direction !== 'target') throw err('bad_direction', "direction must be 'up', 'down' or 'target'");
    const c = Number(confidence);
    if (!Number.isFinite(c) || c < 0 || c > 1) throw err('bad_confidence', 'confidence must be a finite number between 0 and 1');
    const rat = String(rationale ?? '').trim();
    if (!rat) throw err('bad_rationale', 'rationale is required');
    if (rat.length > 300) throw err('bad_rationale', 'rationale must be at most 300 characters');
    let t = null;
    if (direction === 'target') {
      t = Number(targetPriceUsd);
      if (!Number.isFinite(t) || t <= 0) throw err('target_required', "targetPriceUsd must be a price greater than 0 for direction='target'");
    } else if (targetPriceUsd != null) {
      throw err('unexpected_target', "targetPriceUsd is only allowed for direction='target'");
    }
    const maxOpen = this.cfg('forecastMaxOpen', 3);
    if (this.open.size >= maxOpen) throw err('too_many_forecasts', `at most ${maxOpen} open forecasts`);
    const price = await this.market.priceUsd(a); // price_unavailable -> nothing is written
    const openedAt = iso(this.now());
    const expiresAt = iso(this.now() + h * HOUR_MS);
    const id = 'f' + sha256(stable({ tickId, asset: a, expiresAt, n: this.open.size })).slice(0, 12);
    const data = {
      id, asset: a, horizonHours: h, direction, targetPriceUsd: t, confidence: c, rationale: rat,
      priceOpenUsd: price.usd, priceSource: price.source, priceAt: iso(price.fetchedAt), openedAt, expiresAt,
    };
    this.ledger.append('forecast_open', data);
    this.open.set(id, data);
    return { id, asset: a, direction, expiresAt, priceOpenUsd: price.usd };
  }

  /** Settle every expired forecast that has a price; void the ones past grace without one. Idempotent. */
  async settleDue(now = this.now()) {
    const graceMs = this.cfg('forecastSettleGraceHours', 6) * HOUR_MS;
    for (const [id, entry] of this.open) {
      if (Date.parse(entry.expiresAt) > now) continue; // not due yet
      if (this.done.has(id)) continue; // already settled or voided
      let close;
      try { close = await this.market.priceUsd(entry.asset); }
      catch (e) {
        if (e.code === 'price_unavailable' && now - Date.parse(entry.expiresAt) >= graceMs) this.#void(id, 'price_unavailable', now);
        continue;
      }
      this.#settle(id, close.usd, close.source, now);
    }
  }

  #settle(id, priceCloseUsd, priceSource, now) {
    const entry = this.open.get(id);
    if (!entry || this.done.has(id)) return null;
    const { hit, movePct } = judgeForecast({ direction: entry.direction, priceOpenUsd: entry.priceOpenUsd, priceCloseUsd, targetPriceUsd: entry.targetPriceUsd });
    const data = {
      id, asset: entry.asset, direction: entry.direction, targetPriceUsd: entry.targetPriceUsd, confidence: entry.confidence,
      priceOpenUsd: entry.priceOpenUsd, priceCloseUsd, movePct, hit, priceSource, priceAt: iso(now), expiresAt: entry.expiresAt, settledAt: iso(now),
    };
    this.ledger.append('forecast_settled', data);
    this.settled.push(data);
    this.done.add(id);
    this.open.delete(id);
    return data;
  }

  #void(id, reason, now) {
    const entry = this.open.get(id);
    if (!entry || this.done.has(id)) return null;
    const data = { id, reason, expiresAt: entry.expiresAt, voidedAt: iso(now) };
    this.ledger.append('forecast_void', data);
    this.void.push(data);
    this.done.add(id);
    this.open.delete(id);
    return data;
  }

  list() {
    return { open: [...this.open.values()], settled: [...this.settled].slice(-200), void: [...this.void].slice(-200) };
  }

  score() {
    const byAsset = {};
    for (const a of Object.keys(ASSETS)) byAsset[a] = { total: 0, hits: 0, hitRate: null };
    let total = 0, hits = 0;
    for (const s of this.settled) {
      total += 1;
      if (s.hit) hits += 1;
      const b = byAsset[s.asset];
      if (b) { b.total += 1; if (s.hit) b.hits += 1; }
    }
    const round3 = (x) => Math.round(x * 1000) / 1000;
    const out = { total, hits, hitRate: total === 0 ? null : round3(hits / total), byAsset };
    for (const a of Object.keys(byAsset)) {
      const b = byAsset[a];
      b.hitRate = b.total === 0 ? null : round3(b.hits / b.total);
    }
    return out;
  }

  get(id) {
    return this.open.get(id) ?? this.settled.find((s) => s.id === id) ?? this.void.find((v) => v.id === id) ?? null;
  }
}
