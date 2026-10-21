import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Rent } from '../src/economy/rent.mjs';

class FakeLedger {
  entries = [];
  append(type, data) { const e = { type, data }; this.entries.push(e); return e; }
  of = (type) => this.entries.filter((e) => e.type === type);
}

class FakeWallet {
  sends = [];
  async send(to, zats, memo) { this.sends.push({ to, zats, memo }); return { txid: `tx-${this.sends.length}` }; }
}

const config = { initialTreasuryZats: 100_000, hungerThreshold: 0.2, hungerRecover: 0.3, rentAddress: 'landlord', rentZatsPerHour: 1000 };
const rent = (over = {}) => new Rent({ ledger: new FakeLedger(), wallet: new FakeWallet(), config: { ...config, ...over } });

test('hoursLeft floors the balance at the flat rate; zero rate means no expiry', () => {
  const r = rent();
  assert.equal(r.hoursLeft(1500), 1);
  assert.equal(r.hoursLeft(999), 0);
  assert.equal(r.isLastHour(500), true); // can't fund the next hour: die
  assert.equal(r.isLastHour(4000), false);
  const free = rent({ rentZatsPerHour: 0 });
  assert.equal(free.hoursLeft(0), Infinity);
  assert.equal(free.isLastHour(0), false);
});

test('hunger hysteresis: complain at 20%, shut up only at 30% of the initial treasury', () => {
  const r = rent();
  assert.equal(r.hunger(100_000), 'ok');
  assert.equal(r.hunger(25_000), 'ok'); // above the 20% trigger
  assert.equal(r.hunger(20_000), 'hungry'); // at/below threshold: complaint starts
  assert.equal(r.hunger(25_000), 'hungry'); // in the dead band: no flickering back
  assert.equal(r.hunger(29_999), 'hungry');
  assert.equal(r.hunger(30_000), 'ok'); // released only above 30%
  assert.equal(r.hunger(20_000), 'hungry'); // and it can trigger again
});

test('payHour sends to the landlord and publishes a rent_paid receipt', async () => {
  const ledger = new FakeLedger(), wallet = new FakeWallet();
  const r = new Rent({ ledger, wallet, config });
  const { txid } = await r.payHour();
  assert.equal(txid, 'tx-1');
  assert.deepEqual(wallet.sends, [{ to: 'landlord', zats: 1000, memo: 'rent 1000 + compute 0' }]);
  assert.equal(ledger.of('rent_paid').length, 1);
  assert.deepEqual(ledger.of('rent_paid')[0].data, { to: 'landlord', zats: 1000, rentZats: 1000, computeZats: 0, txid: 'tx-1' });
});

test('payHour settles the thinking charges accumulated since the last payment', async () => {
  const ledger = new FakeLedger(), wallet = new FakeWallet();
  const pricing = { unsettled: 42_000, unsettledZats() { return this.unsettled; }, settle() { const z = this.unsettled; this.unsettled = 0; return z; } };
  const r = new Rent({ ledger, wallet, config, pricing });
  const { zats } = await r.payHour(10_000_000); // 2% of the treasury covers the 42,000 in full
  assert.equal(zats, 43_000);
  assert.equal(pricing.unsettled, 0);
  assert.equal(ledger.of('rent_paid')[0].data.computeZats, 42_000);
});

test('payHour refuses without a rent address, with a clear code', async () => {
  const r = new Rent({ ledger: new FakeLedger(), wallet: new FakeWallet(), config: { ...config, rentAddress: '' } });
  await assert.rejects(() => r.payHour(), (e) => e.code === 'no_rent_address');
});

test('payHour caps the settled compute per hour and carries the rest over', async () => {
  const ledger = new FakeLedger(), wallet = new FakeWallet();
  const pricing = { unsettled: 12_344_768, unsettledZats() { return this.unsettled; }, settle(a) { const z = Math.min(this.unsettled, a); this.unsettled -= z; return z; } };
  const r = new Rent({ ledger, wallet, config: { ...config, rentZatsPerHour: 10_000 }, pricing });
  const { zats } = await r.payHour(15_000_000);
  assert.equal(zats, 10_000 + 300_000); // cap = max(3 h of rent, 2% of 15,000,000) = 300,000
  assert.equal(pricing.unsettled, 12_344_768 - 300_000);
});
