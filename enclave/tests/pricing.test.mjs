import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRICES, Pricing } from '../src/economy/pricing.mjs';

// In-memory ledger: just records entries, enough to observe what Pricing publishes.
class FakeLedger {
  entries = [];
  append(type, data) { const e = { type, data }; this.entries.push(e); return e; }
  appendPrivate(type, ciphertext) { const e = { type, private: true, ciphertext }; this.entries.push(e); return e; }
  of = (type) => this.entries.filter((e) => e.type === type);
}

test('price list matches the contract exactly', () => {
  assert.deepEqual(PRICES, {
    read_url: 1000, search: 2000, post_public: 500, post_private: 500, diary: 100,
    send_zec: 1000, balance: 0, sleep: 0, set_identity: 2000, trade_status: 100,
    paywall_set: 500, bounty_post: 1000, will: 100, promise: 100, think_fast: 20000, think_deep: 200000,
    whisper: 500, spawn_child: 1_000_000, swap_quote: 1000, forecast: 1000, post_nostr: 500, avatar: 100,
    publish_page: 2000, page_delete: 200, order_refuse: 100, letter: 500,
  });
});

test('quote reports cost and affordability, rejects actions outside the list', () => {
  const p = new Pricing({ ledger: new FakeLedger() });
  assert.deepEqual(p.quote('diary', 500), { costZats: 100, affordable: true });
  assert.deepEqual(p.quote('think_deep', 100), { costZats: 200000, affordable: false });
  assert.equal(p.quote('balance', 0).costZats, 0); // 0 is a real price, not "unknown"
  assert.throws(() => p.quote('yacht', 1e9), (e) => e.code === 'not_in_pricelist');
});

test('charge is idempotent per (action, tickId): retried tick is billed once', () => {
  const ledger = new FakeLedger();
  const p = new Pricing({ ledger });
  assert.equal(p.charge('diary', 't1'), 100);
  assert.equal(p.charge('diary', 't1'), 100); // second call: same cost, no new entry
  assert.equal(p.charge('think_fast', 't1'), 20000); // other action same tick: billed normally
  assert.equal(p.charge('diary', 't2'), 100); // other tick: billed normally
  const charges = ledger.of('charge');
  assert.equal(charges.length, 3);
  assert.deepEqual(charges[0].data, { action: 'diary', tickId: 't1', costZats: 100 });
  assert.equal(p.charge('balance', 't2'), 0); // free actions still leave an auditable entry
  assert.deepEqual(ledger.of('charge').at(-1).data, { action: 'balance', tickId: 't2', costZats: 0 });
});

test('a price scale rescales every quote and charge (mainnet: real costs)', () => {
  const p = new Pricing({ ledger: new FakeLedger(), scale: 0.01 });
  assert.deepEqual(p.quote('think_deep', 10_000), { costZats: 2000, affordable: true });
  assert.equal(p.charge('think_fast', 't1'), 200);
});
