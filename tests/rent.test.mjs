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
  assert.deepEqual(wallet.sends, [{ to: 'landlord', zats: 1000, memo: 'rent' }]);
  assert.equal(ledger.of('rent_paid').length, 1);
  assert.deepEqual(ledger.of('rent_paid')[0].data, { to: 'landlord', zats: 1000, txid: 'tx-1' });
});
