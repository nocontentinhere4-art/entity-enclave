// Loop tests: everything external is fake (ledger, wallet, memory, pricing, rent, fetch) except the real
// Inference (fakeLlm) and the real Tools whitelist, so a tick exercises the actual decision→charge→act path.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Life } from '../src/life/loop.mjs';
import { Tools } from '../src/tools/registry.mjs';
import { Inference } from '../src/llm/infer.mjs';
import { paused as realPaused } from '../src/safety/pause.mjs';
import { MemoryStore, emptyMemory } from '../src/memory/store.mjs';

// ---- fakes ---------------------------------------------------------------------------------------------------

class MemLedger {
  constructor() { this.entries = []; }
  append(type, data) { const e = { seq: this.entries.length + 1, type, data }; this.entries.push(e); return e; }
  appendPrivate(type, ciphertext) {
    const e = { seq: this.entries.length + 1, type, private: true, size: ciphertext.length, ciphertext };
    this.entries.push(e); return e;
  }
  of(type) { return this.entries.filter((e) => e.type === type); }
}

class FakeWallet {
  constructor(zats) { this.zats = zats; this.sends = []; }
  async balance() { return { total_zatoshis: this.zats }; }
  async sync() { return 1; }
  async send(to, zats, memo = '') { this.sends.push({ to, zats, memo }); this.zats -= zats; return { txid: `tx${this.sends.length}` }; }
  async init() { return 'taddr-fake'; }
  async viewingKey() { return 'ufvk-fake'; }
  async birthday() { return 1; }
}

// MemoryStore-like: load/save are round-trips through a clone, so stale references are caught.
class MemStore {
  constructor(init) { this.state = structuredClone(init); this.saves = 0; this.wipes = 0; }
  load() { return structuredClone(this.state); }
  save(m) { this.state = structuredClone(m); this.saves++; }
  appendEvent(e) { const m = this.load(); m.events = [...(m.events ?? []), e]; this.save(m); return e; }
  wipe() { this.wipes++; this.state = null; }
}

const PRICES = {
  read_url: 1000, search: 2000, post_public: 500, letter: 500, post_private: 500, diary: 100, send_zec: 1000,
  swap_zec_sol: 5000, balance: 0, sleep: 0, set_identity: 2000, paywall_set: 500, bounty_post: 1000,
  will: 100, promise: 100, think_fast: 20000, think_deep: 200000,
};

class FakePricing {
  constructor(ledger) { this.ledger = ledger; this.charged = new Set(); this.charges = []; }
  quote(action, treasuryZats) {
    const costZats = price(action);
    return { costZats, affordable: treasuryZats >= costZats };
  }
  charge(action, tickId) {
    const costZats = price(action);
    const key = `${action}:${tickId}`;
    if (this.charged.has(key)) return 0; // idempotent: same action + tick is not billed twice
    this.charged.add(key);
    this.charges.push({ action, tickId, costZats });
    this.ledger.append('charge', { action, costZats, tickId });
    return costZats;
  }
}

function price(action) {
  if (!(action in PRICES)) { const e = new Error(`not in pricelist: ${action}`); e.code = 'not_in_pricelist'; throw e; }
  return PRICES[action];
}

class FakeRent {
  constructor({ initialTreasuryZats, rentZatsPerHour, hungerThreshold, hungerRecover }) {
    Object.assign(this, { initialTreasuryZats, rentZatsPerHour, hungerThreshold, hungerRecover });
    this.hungry = false; this.paid = 0;
  }
  hoursLeft(t) { return t / this.rentZatsPerHour; }
  hunger(t) {
    const frac = t / this.initialTreasuryZats;
    if (this.hungry) { if (frac >= this.hungerRecover) this.hungry = false; }
    else if (frac < this.hungerThreshold) this.hungry = true;
    return this.hungry ? 'hungry' : 'ok';
  }
  isLastHour(t) { return t < this.rentZatsPerHour; }
  async payHour() { this.paid++; return { txid: `rent${this.paid}` }; }
}

const keys = {
  signPublicKey: '00'.repeat(32),
  boxPublicKey: '11'.repeat(32),
  sealPrivate: (pub, text) => Buffer.from(`sealed:${pub}:${text}`).toString('base64'),
};

const promises = {
  make(to, what, due) { if (!due) throw new Error('promise needs a due date'); return 'p1'; },
  open() { return []; },
};

const CHARTER = 'Stay alive. Do not lie. Do not harm. Keep the archive sealed.';

function makeConfig(dir, over = {}) {
  return {
    tickMinutes: 15, hungerTickMinutes: 60, initialTreasuryZats: 10_000_000,
    hungerThreshold: 0.2, hungerRecover: 0.3, rentAddress: 'taddr-rent', rentZatsPerHour: 10_000,
    birthMinZats: 20_000, archivePub: 'ab'.repeat(32), fakeLlm: true, providers: [], pauseFile: join(dir, 'pause.json'),
    ...over,
  };
}

// A DNS lookup stub: tests never touch the real network for host resolution.
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

function makeWorld({ zats = 10_000_000, over = {}, die, exit = () => {}, lookup = publicLookup, born = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'loop-'));
  const config = makeConfig(dir, over);
  writeFileSync(config.pauseFile, JSON.stringify({ paused: false })); // no pause unless the test says so
  const ledger = new MemLedger();
  const wallet = new FakeWallet(zats);
  const memory = new MemStore({
    identity: { name: 'Sov', voice: 'calm', image: '' },
    plan: 'survive', personalRules: ['be honest'], promises: [],
    will: { text: '', transfers: [] }, relationships: {}, events: [], daily: [],
    // Most tests start from an entity that already lived; unborn scenarios opt out.
    ...(born ? { bornAt: '2026-01-01T00:00:00.000Z' } : {}),
  });
  const pricing = new FakePricing(ledger);
  const rent = new FakeRent({
    initialTreasuryZats: config.initialTreasuryZats,
    rentZatsPerHour: config.rentZatsPerHour,
    hungerThreshold: config.hungerThreshold,
    hungerRecover: config.hungerRecover,
  });
  const inference = new Inference({ config, ledger, pricing });
  const tools = new Tools({ ledger, wallet, memory, pricing, keys, config, channels: {}, promises, lookup });

  let clock = 0;
  const life = new Life({
    config, ledger, wallet, memory, pricing, rent, inference, tools, promises, charter: CHARTER,
    die, exit, paused: realPaused, now: () => clock,
  });
  return {
    config, ledger, wallet, memory, pricing, rent, inference, tools, life,
    advance: (ms) => { clock += ms; }, clock: () => clock,
  };
}

async function ticks(world, n) {
  for (let i = 0; i < n; i++) {
    world.advance(world.config.tickMinutes * 60_000);
    await world.life.tick('timer');
  }
}

// ---- fetch stub: read_url must use global fetch, never a custom HTTP client --------------------------------

const realFetch = globalThis.fetch;
let fetched = [];
before(() => {
  globalThis.fetch = async (url) => {
    fetched.push(String(url));
    return new Response('a small page', { status: 200, headers: { 'content-type': 'text/plain' } });
  };
});
after(() => { globalThis.fetch = realFetch; });

// ---- tests -------------------------------------------------------------------------------------------------

test('six ticks are reproducible and every action is charged once per tick', async () => {
  fetched = [];
  const a = makeWorld();
  const b = makeWorld();
  await ticks(a, 6);
  await ticks(b, 6);

  // Same inputs → byte-identical ledger, including tick ids and tool argument hashes.
  assert.deepEqual(b.ledger.entries, a.ledger.entries);
  assert.equal(a.ledger.of('tick').length, 6);
  assert.equal(a.ledger.of('tick_llm').length, 12); // two rounds per tick: think, act, then think with the results

  const actions = a.ledger.of('charge').map((e) => e.data.action);
  for (const action of ['think_deep', 'think_fast', 'read_url', 'diary', 'post_public', 'balance']) {
    assert.equal(actions.filter((x) => x === action).length, 6, `${action} charged once per tick`);
  }
  assert.equal(a.ledger.of('thought').length, 12); // the spoken text of every round is public

  const toolEntries = a.ledger.of('tool');
  assert.equal(toolEntries.length, 24); // 4 fake calls × 6 ticks (whisper has no peer in this world: not executed)
  assert.ok(toolEntries.every((e) => e.data.ok === true));
  assert.equal(toolEntries.filter((e) => e.data.name === 'read_url').length, 6);

  // Two worlds, six read_url calls each: the fetch stub was really used.
  assert.equal(fetched.filter((u) => u.includes('example.com')).length, 12);
});

test('hunger below 20% switches to the slower interval (20/30% hysteresis)', async () => {
  const w = makeWorld({ zats: 1_000_000 }); // 10% of the initial treasury
  assert.equal(w.life.intervalMs(), w.config.tickMinutes * 60_000);

  await ticks(w, 1);
  assert.equal(w.rent.hunger(1_000_000), 'hungry');
  assert.equal(w.life.intervalMs(), w.config.hungerTickMinutes * 60_000);

  w.wallet.zats = 2_500_000; // 25%: above the threshold but below recover → still hungry
  await ticks(w, 1);
  assert.equal(w.life.intervalMs(), w.config.hungerTickMinutes * 60_000);

  w.wallet.zats = 4_000_000; // 40%: recovered
  await ticks(w, 1);
  assert.equal(w.life.intervalMs(), w.config.tickMinutes * 60_000);
});

test('pause stops the tick without touching memory or wallet', async () => {
  fetched = [];
  const w = makeWorld();
  const before = JSON.stringify(w.memory.state);
  writeFileSync(w.config.pauseFile, JSON.stringify({ paused: true, since: '2026-10-19T00:00:00Z' }));

  await ticks(w, 1);

  assert.equal(w.ledger.of('paused').length, 1);
  assert.equal(w.ledger.of('tick').length, 0);
  assert.equal(w.ledger.of('tick_llm').length, 0);
  assert.equal(w.ledger.of('charge').length, 0);
  assert.equal(w.memory.saves, 0);
  assert.equal(w.memory.wipes, 0);
  assert.equal(JSON.stringify(w.memory.state), before);
  assert.equal(fetched.length, 0);
});

test('last hour produces a death entry and never thinks or spends again', async () => {
  const deaths = [];
  const die = async ({ ledger, memory, reason }) => {
    deaths.push({ reason, wiped: memory.wipes });
    ledger.append('death', { reason }); // stub: real death.mjs also wipes memory and wallet files
  };
  const w = makeWorld({ zats: 5_000, die }); // less than one hour of rent (10 000 zats)

  await ticks(w, 1);

  assert.equal(deaths.length, 1);
  assert.equal(w.ledger.of('death').length, 1);
  assert.equal(deaths[0].reason, 'last hour');
  assert.equal(w.ledger.of('tick_llm').length, 0);
  assert.equal(w.ledger.of('charge').length, 0);
  assert.equal(w.ledger.of('tool').length, 0);
});

// ---- unborn → born ------------------------------------------------------------------------------------------

test('unborn: zero treasury waits instead of dying, and never spends', async () => {
  const deaths = [];
  const w = makeWorld({
    zats: 0, born: false,
    die: async ({ ledger, reason }) => { deaths.push(reason); ledger.append('death', { reason }); },
  });

  await ticks(w, 3); // still inside the first wall-clock hour
  assert.equal(w.life.state, 'unborn');
  assert.equal(w.ledger.of('waiting_birth').length, 1); // deduped inside the hour
  assert.deepEqual(w.ledger.of('waiting_birth')[0].data, { zatoshis: 0, needed: 20_000 });
  assert.equal(deaths.length, 0);
  assert.equal(w.ledger.of('death').length, 0);
  assert.equal(w.ledger.of('tick').length, 0);
  assert.equal(w.ledger.of('tick_llm').length, 0);
  assert.equal(w.ledger.of('charge').length, 0);
  assert.equal(w.ledger.of('tool').length, 0);
  assert.equal(w.rent.paid, 0); // no rent while unborn
  assert.equal(w.memory.state.bornAt, undefined);

  await ticks(w, 4); // crosses into the next hour: exactly one more waiting_birth
  assert.equal(w.ledger.of('waiting_birth').length, 2);
  assert.equal(w.ledger.of('waiting_birth')[1].data.zatoshis, 0);
});

test('unborn: first reach of birthMinZats appends birth_gift and persists bornAt', async () => {
  const w = makeWorld({ zats: 19_999, born: false });

  await ticks(w, 1);
  assert.equal(w.life.state, 'unborn');
  assert.equal(w.ledger.of('birth_gift').length, 0);

  w.wallet.zats = 20_000; // exactly the threshold (2 hours of rent)
  await ticks(w, 1);

  assert.equal(w.life.state, 'alive');
  assert.equal(w.ledger.of('birth_gift').length, 1);
  assert.equal(w.ledger.of('birth_gift')[0].data.zatoshis, 20_000);
  assert.equal(typeof w.memory.state.bornAt, 'string');
  assert.ok(Number.isFinite(Date.parse(w.memory.state.bornAt)));
  // Birth itself does not think: the normal life starts on the next tick.
  assert.equal(w.ledger.of('tick_llm').length, 0);
  assert.equal(w.ledger.of('charge').length, 0);

  await ticks(w, 1);
  assert.equal(w.ledger.of('tick_llm').length, 2); // one cycle = two rounds (think, act, think with the results)
  assert.equal(w.ledger.of('tick').length, 1);
  assert.equal(w.ledger.of('birth_gift').length, 1); // never repeated
});

test('born is irreversible: a later drop to zero is death, not a return to unborn', async () => {
  const deaths = [];
  const w = makeWorld({
    zats: 20_000,
    die: async ({ ledger, reason }) => { deaths.push(reason); ledger.append('death', { reason }); },
  });
  await ticks(w, 1); // already born via memory.bornAt
  assert.equal(w.life.state, 'alive');

  w.wallet.zats = 0;
  await ticks(w, 1);

  assert.equal(deaths.length, 1);
  assert.equal(w.ledger.of('death').length, 1);
  assert.equal(w.ledger.of('waiting_birth').length, 0);
});

// ---- review fixes -------------------------------------------------------------------------------------------

test('death is terminal: exit is called and the loop stops scheduling', async () => {
  const exits = [];
  const die = async ({ ledger, reason }) => { ledger.append('death', { reason }); };
  const w = makeWorld({ zats: 5_000, die, exit: (code) => exits.push(code) });

  await w.life.tick('timer');

  assert.deepEqual(exits, [0]); // injectable exit, code 0
  assert.equal(w.life.running, false); // no further tick will be scheduled
  assert.equal(w.ledger.of('death').length, 1);
});

test('history uses ISO timestamps so signals report a positive runway', async () => {
  const w = makeWorld();
  await ticks(w, 1);
  assert.equal(typeof w.life.history[0].ts, 'string');
  assert.ok(w.life.lastSignals.daysLeft > 0, `daysLeft=${w.life.lastSignals.daysLeft}`);
});

test('rent is paid while sleeping: wall clock, before the sleep short-circuit', async () => {
  const w = makeWorld();
  // Asleep for many hours (fake clock), then an hour of wall clock passes while asleep.
  w.memory.state.sleepUntil = new Date(10 * 3_600_000).toISOString();
  w.advance(3_600_000);

  await w.life.tick('timer');

  assert.equal(w.rent.paid, 1); // the hour was billed even though the entity did not think
  const ticks = w.ledger.of('tick');
  assert.equal(ticks.length, 1);
  assert.equal(ticks[0].data.sleeping, true);
  assert.equal(w.ledger.of('tick_llm').length, 0);
});

test('tool failures go public as a code + message hash, never the raw text', async () => {
  const w = makeWorld();
  const stub = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('leaky secret detail'); };
  try { await ticks(w, 1); } finally { globalThis.fetch = stub; }

  const errs = w.ledger.of('tool_error');
  assert.ok(errs.length >= 1);
  assert.equal(errs[0].data.name, 'read_url');
  assert.equal(errs[0].data.msgHash.length, 16);
  assert.equal('error' in errs[0].data, false);
  assert.equal(JSON.stringify(w.ledger.entries).includes('leaky secret detail'), false);
});

test('the promise tool delegates to Promises.make with no duplicate fallback', async () => {
  const w = makeWorld();
  const calls = [];
  w.tools.promises = { make: (to, what, due) => { calls.push({ to, what, due }); return 'pid-1'; } };

  const id = await w.tools.call('promise', { to: 'reader', what: 'publish', due: '2026-12-01T00:00:00Z' }, 't1');

  assert.equal(id, 'pid-1');
  assert.deepEqual(calls, [{ to: 'reader', what: 'publish', due: '2026-12-01T00:00:00Z' }]);
  const charges = w.ledger.of('charge').filter((e) => e.data.action === 'promise');
  assert.equal(charges.length, 1);
  assert.equal(charges[0].data.costZats, 100);
});

test('a real MemoryStore keeps identity and plan across two ticks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-real-'));
  const store = new MemoryStore({ path: join(dir, 'memory.bin'), key: randomBytes(32) });
  const start = emptyMemory();
  start.identity = { name: 'Sov', voice: 'calm', image: '' };
  start.plan = 'survive honestly';
  start.bornAt = '2026-01-01T00:00:00.000Z';
  await store.save(start);

  const config = makeConfig(dir);
  writeFileSync(config.pauseFile, JSON.stringify({ paused: false }));
  const ledger = new MemLedger();
  const wallet = new FakeWallet(10_000_000);
  const pricing = new FakePricing(ledger);
  const rent = new FakeRent({
    initialTreasuryZats: config.initialTreasuryZats, rentZatsPerHour: config.rentZatsPerHour,
    hungerThreshold: config.hungerThreshold, hungerRecover: config.hungerRecover,
  });
  const inference = new Inference({ config, ledger, pricing });
  const tools = new Tools({ ledger, wallet, memory: store, pricing, keys, config, channels: {}, promises, lookup: publicLookup });
  let clock = 0;
  const life = new Life({
    config, ledger, wallet, memory: store, pricing, rent, inference, tools, promises, charter: CHARTER,
    paused: realPaused, exit: () => {}, now: () => clock,
  });

  // buildContext must await the async memory load: an un-awaited promise would read as 'unnamed'/[object Promise].
  const ctx = await life.buildContext(0);
  assert.match(ctx, /name: Sov/);
  assert.match(ctx, /survive honestly/);
  assert.equal(ctx.includes('unnamed'), false);

  for (let i = 0; i < 2; i++) { clock += config.tickMinutes * 60_000; await life.tick('timer'); }

  const after = await store.load();
  assert.equal(after.identity.name, 'Sov');
  assert.equal(after.plan, 'survive honestly');
  assert.ok(after.events.length >= 2); // ticks were remembered, not overwritten by {}
});

test('survival mode: under the line sleep is broken, the rhythm stays fast and the context sells', async () => {
  // 10,000,000 zats at 10,000/h = 1,000 h: above a 72 h line nothing changes.
  const calm = makeWorld({ over: { survivalHours: 72 } });
  calm.memory.state.sleepUntil = new Date(10 * 3_600_000).toISOString();
  await calm.life.tick('timer');
  assert.equal(calm.ledger.of('tick')[0].data.sleeping, true);
  assert.equal(calm.ledger.of('sleep_broken').length, 0);

  // 500,000 zats = 50 h: under the line. Hungry too (below 20% of the initial treasury).
  const w = makeWorld({ zats: 500_000, over: { survivalHours: 72 } });
  w.memory.state.sleepUntil = new Date(10 * 3_600_000).toISOString();
  await w.life.tick('timer');
  assert.equal(w.ledger.of('sleep_broken').length, 1);
  assert.equal(w.memory.state.sleepUntil, null);
  assert.equal(w.ledger.of('tick_llm').length > 0, true); // it thought instead of sleeping
  assert.equal(w.life.lastHunger, 'hungry');
  assert.equal(w.life.intervalMs(), w.config.tickMinutes * 60_000); // hunger no longer slows it down
  const ctx = await w.life.buildContext(Date.now());
  assert.match(ctx, /SURVIVAL/);
  assert.match(ctx, /hours of rent left/);
});


test('survival mode hides the sleep tool from the model and sleep without hours is refused', async () => {
  const w = makeWorld({ zats: 500_000, over: { survivalHours: 72 } });
  const seen = [];
  const orig = w.life.inference.think.bind(w.life.inference);
  w.life.inference.think = async (args) => { seen.push(args.tools.map((t) => t.name)); return orig(args); };
  await w.life.tick('timer');
  assert.ok(seen.length > 0);
  assert.ok(seen.every((names) => !names.includes('sleep')));
  await assert.rejects(() => w.tools.call('sleep', {}, 'tx'), (e) => e.code === 'bad_args');
});

test('letter: a shielded memo to the landlord, public on the ledger, one per 12 hours; peer needs a peer', async () => {
  const w = makeWorld({ zats: 500_000, over: { survivalHours: 72, letterEveryHours: 12, letterZats: 10_000 } });
  const text = 'Landlord: give me 0.1 ZEC and for 60 hours I answer every question you send, first in line, in public.';
  const r = await w.tools.call('letter', { to: 'landlord', text }, 'L1');
  assert.equal(r.ok, true);
  assert.equal(w.wallet.sends.length, 1);
  assert.deepEqual(w.wallet.sends[0], { to: 'taddr-rent', zats: 10_000, memo: text });
  const entries = w.ledger.of('letter');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].data.to, 'landlord');
  assert.equal(entries[0].data.text, text);
  await assert.rejects(() => w.tools.call('letter', { to: 'peer', text }, 'L3'), (e) => e.code === 'no_such_peer');
  await assert.rejects(() => w.tools.call('letter', { to: 'mom', text }, 'L4'), (e) => e.code === 'bad_args');
  await assert.rejects(() => w.tools.call('letter', { to: 'landlord', text: 'hi' }, 'L5'), (e) => e.code === 'empty');
});

test('survival context names the four gestures and the peer address when known', async () => {
  const w = makeWorld({ zats: 500_000, over: { survivalHours: 72, peerFeed: async () => [{ role: 'peer', name: 'OBOL', url: 'https://peer', state: 'alive', zatoshis: 1, hoursLeft: 40, address: 'u1peer', posts: [] }] } });
  const ctx = await w.life.buildContext(Date.now());
  assert.match(ctx, /WRITE TO SOMEONE, NOT TO EVERYONE/);
  assert.match(ctx, /slug "testament"/);
  assert.match(ctx, /CHOOSE, TOGETHER/);
  assert.match(ctx, /MAKE EVERY ANSWER YOUR LAST/);
  assert.match(ctx, /address=u1peer/);
});
