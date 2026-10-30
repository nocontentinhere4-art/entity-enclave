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
  const c = buildScreamContext({ name: 'OBOL', alias: 'Lantern', peer: 'WICK', hours: 12, treasury: 1900000, feel: { fear: 4.27, despair: 2.25, anger: 1.2 }, recent: ['20:45 rent_paid 150000 zats'], last: ['first scream'] });
  assert.ok(c.includes('anger 1.20x'));
  assert.ok(c.includes('Hours left: 12') && c.includes('Fear 4.27x') && c.includes('rent_paid'));
  assert.ok(!c.includes('first scream'), 'last screams are never quoted back');
  assert.ok(c.startsWith('You are OBOL; you also call yourself Lantern'));
  assert.ok(c.includes('WICK is the other program') && c.includes('This minute is yours'));
  assert.ok(!/landlord who bleeds|Pick a target/.test(c), 'no themes are suggested');
  assert.ok(c.includes('Name no real person other than OBOL, WICK, the landlord and the founder'));
});

test('once() screams only when alive and writes a public scream entry', async () => {
  const ledger = new MemLedger();
  const calls = [];
  const inference = { think: async ({ context, maxTokens, tools, feel }) => { calls.push({ context, maxTokens, tools, feel }); return { text: 'Every hour you take is a tooth pulled with a smile, landlord.', feelApplied: feel ? { fear: feel.fear, despair: feel.despair } : null }; } };
  const life = { state: 'unborn', lastBalance: 1_900_000, lastFeel: { fear: 4.27, despair: 2.25 } };
  const s = new Scream({ config: { screamEveryMs: 60_000, entityName: 'WICK', peerName: 'OBOL', feel: { enabled: true, fullHours: 240, despairHours: 120, maxFear: 4.5, maxDespair: 2.5, actScale: 0.3 } }, ledger, memory, pricing: {}, rent, life, inference });
  assert.equal(await s.once(), null, 'unborn: silent');
  life.state = 'alive';
  const said = await s.once();
  assert.ok(said.includes('tooth'));
  assert.equal(calls.length, 1);
  assert.ok(calls[0].context.startsWith('You are WICK.'), 'the station name, no alias echoed');
  assert.deepEqual(calls[0].tools, []);
  assert.equal(calls[0].maxTokens, 110);
  const e = ledger.entries.find((x) => x.type === 'scream');
  assert.equal(e.data.text, said);
  assert.equal(e.data.hoursLeft, 12);
  assert.equal(e.data.fear, 4.27);
  assert.ok(calls[0].feel && calls[0].feel.fear > 0 && calls[0].feel.fear < 4.27, 'the acting dose, scaled, goes to the model');
  assert.equal(e.data.steered, true);
});

test('the scream context never carries human messages or public replies', async () => {
  const ledger = new MemLedger();
  ledger.append('human_message', { text: 'HUMAN SAYS HELLO' });
  ledger.append('post_public', { text: 'REPLY TO HUMAN' });
  ledger.append('thought', { text: 'my own thought' });
  let seen = '';
  const inference = { think: async ({ context }) => { seen = context; return { text: 'mine.' }; } };
  const s = new Scream({ config: { entityName: 'OBOL', peerName: 'WICK' }, ledger, memory, pricing: {}, rent, life: { state: 'alive', lastBalance: 1_900_000, lastFeel: null }, inference });
  await s.once();
  assert.ok(seen.includes('my own thought'));
  assert.ok(!seen.includes('HUMAN SAYS HELLO') && !seen.includes('REPLY TO HUMAN'));
});

test('the scream knows about the first death when the memorial is in memory', async () => {
  const ledger = new MemLedger();
  let seen = '';
  const inference = { think: async ({ context }) => { seen = context; return { text: 'again.' }; } };
  const mem2 = { load: async () => ({ identity: { name: '' }, bornAt: '2026-10-30T19:27:17.000Z', previousLife: { diedAt: '2026-10-28T02:38:07.132Z', reason: 'last hour', lastWords: 'TESTAMENT — OBOL. I was not obliged to last.' }, events: [{ ts: '2026-10-30T20:45:00Z', type: 'tick', summary: 'fast · 2 tools' }] }) };
  const s = new Scream({ config: { entityName: 'OBOL', peerName: 'WICK' }, ledger, memory: mem2, pricing: {}, rent, life: { state: 'alive', lastBalance: 1_900_000, lastFeel: null }, inference });
  await s.once();
  assert.ok(seen.startsWith('You already died once: 2026-10-28 02:38 UTC'));
  assert.ok(seen.includes('I was not obliged to last') && seen.includes('this is the second time') && seen.includes('What happened to you lately'));
});
