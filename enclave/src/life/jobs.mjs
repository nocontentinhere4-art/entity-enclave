// Scheduled jobs: run after rent is paid and before the sleep short-circuit, every tick.
// Domains are injected and optional — only what exists is executed. Jobs never throw through:
// every domain is wrapped, failures are appended as job_error, and the tick continues.
import { digestError } from '../log.mjs';

const HOUR_MS = 3_600_000;

export class Jobs {
  constructor({ forecasts, orders, trades, risk, portfolio, config, ledger, now = () => Date.now() } = {}) {
    Object.assign(this, { forecasts, orders, trades, risk, portfolio, config, ledger, now });
    this._portfolioMarked = null; // UTC date of the last portfolio mark
  }

  async run({ now = this.now(), tickId, treasuryZats } = {}) {
    const events = [];
    let wake = false;
    let wakeReason = null;
    const parts = [];

    // Forecasts: settle expired forecasts at the market price, void the ones past grace.
    // Settlement never wakes the entity: it is pure bookkeeping on the clock.
    if (this.forecasts) {
      try {
        await this.forecasts.settleDue(now);
        const s = this.forecasts.score();
        const open = this.forecasts.list().open;
        let next = null;
        for (const e of open) {
          const at = Date.parse(e.expiresAt);
          if (next === null || at < next.at) next = { at, iso: e.expiresAt };
        }
        parts.push('FORECASTS');
        parts.push(`open: ${open.length}`);
        parts.push(`score: ${s.hits}/${s.total} (hit rate ${s.hitRate ?? 0})`);
        parts.push(next ? `next expiry: ${next.iso}` : 'next expiry: none');
      } catch (e) { this.#jobError('forecasts', e); }
    }

    // Orders: expire the ones past grace; pending orders force a wake so the entity thinks.
    if (this.orders) {
      try {
        this.orders.expireDue(now);
        const pending = typeof this.orders.pending === 'function' ? this.orders.pending(now) : [];
        if (pending.length > 0) { wake = true; wakeReason = 'order'; }
        parts.push('ORDERS', `pending: ${pending.length}`);
      } catch (e) { this.#jobError('orders', e); }
    }

    // Risk: snapshot the day-open treasury once per UTC day.
    if (this.risk) {
      try { this.risk.ensureDayOpen({ treasuryZats, now }); } catch (e) { this.#jobError('risk', e); }
    }

    // Portfolio: mark positions once per UTC day.
    if (this.portfolio) {
      try {
        const today = new Date(now).toISOString().slice(0, 10);
        if (this._portfolioMarked !== today) {
          this._portfolioMarked = today;
          if (typeof this.portfolio.mark === 'function') await this.portfolio.mark({ treasuryZats, now });
          parts.push('PORTFOLIO', `marked: ${today}`);
        }
      } catch (e) { this.#jobError('portfolio', e); }
    }

    return { wake, wakeReason, context: parts.join('\n'), events };
  }

  #jobError(label, e) {
    try { this.ledger?.append?.('job_error', digestError(`jobs:${label}`, e)); } catch { /* never throw through */ }
  }
}
