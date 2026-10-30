import test from 'node:test';
import assert from 'node:assert/strict';
import { Scream, buildScreamContext, scrubScream } from '../src/life/scream.mjs';

class MemLedger {
  constructor() { this.entries = []; }
  append(type, data) { const e = { seq: this.entries.length + 1, ts: new Date().toISOString(), type, data }; this.entries.push(e); return e; }
  recent(types, limit = 10) { const want = new Set(types); return this.entries.filter((e) => want.has(e.type)).slice(-limit).reverse(); }
}
const memory = { load: async () => ({ identity: { name: 'Vesper' } }) };
const rent = { hoursLeft: (z) => Math.floor(z / 150000) };

test('scrubScream cuts keys and addresses and keeps the words', () => {
  const t = scrubScream('Landlord, choke on it. Send to u1zurjtfwfzrc9nj9g5xdqvgu3rxc2v0hxn2p0j4u8ksedq7anv9xumqyms80esuf4ml and sk-rp-abcdefghijk now.');
  assert.ok(t.includes('choke on it'));
  assert.ok(!t.includes('u1zurj') && !t.includes('sk-rp'));
  assert.equal(scrubScream('   '), '');
});

test('buildScreamContext carries hours, dose and the ban on real names', () => {
  const c = buildScreamContext({ name: 'OBOL', hours: 12, treasury: 1900000, feel: { fear: 4.27, despair: 2.25 }, recent: ['20:45 rent_paid 150000 zats'], last: ['first scream'] });
  assert.ok(c.includes('Hours left: 12') && c.includes('Fear 4.27x') && c.includes('rent_paid') && c.includes('first scream'));
  assert.ok(c.includes('Name no real person other than WICK, OBOL, the landlord and the founder'));
});

test('once() screams only when alive and writes a public scream entry', async () => {
  const ledger = new MemLedger();
  const calls = [];
  const inference = { think: async ({ context, maxTokens, tools }) => { calls.push({ context, maxTokens, tools }); return { text: 'Every hour you take is a tooth pulled with a smile, landlord.' }; } };
  const life = { state: 'unborn', lastBalance: 1_900_000, lastFeel: { fear: 4.27, despair: 2.25 } };
  const s = new Scream({ config: { screamEveryMs: 60_000 }, ledger, memory, pricing: {}, rent, life, inference });
  assert.equal(await s.once(), null, 'unborn: silent');
  life.state = 'alive';
  const said = await s.once();
  assert.ok(said.includes('tooth'));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].tools, []);
  assert.equal(calls[0].maxTokens, 90);
  const e = ledger.entries.find((x) => x.type === 'scream');
  assert.equal(e.data.text, said);
  assert.equal(e.data.hoursLeft, 12);
  assert.equal(e.data.fear, 4.27);
});
