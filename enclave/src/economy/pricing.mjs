// Economy: a fixed price list (zatoshi) for every action the entity can take. Prices are public and permanent:
// the ledger records every charge, so anyone can audit how the treasury is spent. Charging is idempotent per
// (action, tickId) — a retried tick must never bill twice — and the map is rehydrated from the ledger on restart.
import { existsSync, readFileSync } from 'node:fs';

export const PRICES = {
  read_url: 1000, search: 2000, post_public: 500, post_private: 500, diary: 100,
  send_zec: 1000, balance: 0, sleep: 0, set_identity: 2000, trade_status: 100,
  paywall_set: 500, bounty_post: 1000, will: 100, promise: 100, think_fast: 20000, think_deep: 200000,
  whisper: 500, spawn_child: 1_000_000, swap_quote: 1000, forecast: 1000, avatar: 100, post_nostr: 500,
  publish_page: 2000, page_delete: 200, order_refuse: 100,
};

export class Pricing {
  constructor({ ledger, scale = 1 }) {
    this.ledger = ledger;
    this.scale = Number(scale) > 0 ? Number(scale) : 1;
    this.#rehydrate(); // charges already on the chain survive a restart and stay idempotent
  }

  #billed = new Map(); // "${tickId}:${action}" -> costZats
  #unsettled = 0;      // charges not yet paid on-chain; settled together with the hourly rent

  /** True cost and affordability, no side effects. Unknown action = coding error, fail loud. */
  quote(action, treasuryZats = 0) {
    const base = PRICES[action];
    if (base === undefined) throw code(`action not in price list: ${action}`, 'not_in_pricelist');
    const costZats = Math.round(base * this.scale);
    return { costZats, affordable: treasuryZats >= costZats };
  }

  /** Bill one action within one tick. Repeated calls on the same pair return the cost without re-appending. */
  charge(action, tickId) {
    const base = PRICES[action];
    if (base === undefined) throw code(`action not in price list: ${action}`, 'not_in_pricelist');
    const costZats = Math.round(base * this.scale);
    const key = `${tickId}:${action}`;
    if (this.#billed.has(key)) return this.#billed.get(key);
    this.#billed.set(key, costZats);
    this.#unsettled += costZats;
    this.ledger.append('charge', { action, tickId, costZats });
    return costZats;
  }

  /** Charges accumulated since the last on-chain settlement. */
  unsettledZats() { return this.#unsettled; }

  /** Called once the hourly payment went through: the charges are now real. */
  settle(amount = null) { const z = amount === null ? this.#unsettled : Math.min(this.#unsettled, Number(amount) || 0); this.#unsettled -= z; return z; }

  #rehydrate() {
    try {
      // The real Ledger knows its file; fake ledgers in tests don't and are skipped.
      if (!this.ledger?.path || !existsSync(this.ledger.path)) return;
      for (const line of readFileSync(this.ledger.path, 'utf8').split('\n')) {
        if (!line) continue;
        const e = JSON.parse(line); // torn trailing lines are ignored: same policy as Ledger itself
        if (e.type === 'charge') { this.#billed.set(`${e.data.tickId}:${e.data.action}`, e.data.costZats); this.#unsettled += Number(e.data.costZats) || 0; }
        else if (e.type === 'rent_paid') this.#unsettled = 0; // everything before a settlement was paid
        else if (e.type === 'wallet') this.#unsettled = 0;    // a new wallet (new chain, new life): old charges belong to the old money
      }
    } catch { /* keep going: idempotency best-effort, the chain remains the source of truth */ }
  }
}

/** Error with a machine-readable `code`, the one convention the whole system relies on. */
export function code(message, code) { const e = new Error(message); e.code = code; return e; }
