// Instant-reply tests: debounce batching, replyTo bookkeeping, sleeping entities, caps, paid-letter bypass,
// timeout retry, and the loop's "already answered" marker. Everything is injected (fake inference, fake clock,
// the fixtures ledger) so no network and no real timers beyond a few milliseconds of debounce.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Replier, proofCode } from '../src/life/reply.mjs';
import { Life } from '../src/life/loop.mjs';
import { makeClock, makeLedger } from './fixtures/harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeMemory(over = {}) {
  return {
    async load() {
      return {
        identity: { name: 'Sov', voice: 'calm', image: '', avatar: '' },
        plan: 'survive honestly',
        personalRules: ['be honest'],
        events: [],
        bornAt: '2026-01-01T00:00:00.000Z',
        sleepUntil: null,
        ...over,
      };
    },
  };
}

function makeReplier(over = {}) {
  const clock = over.clock ?? makeClock();
  const ledger = over.ledger ?? makeLedger(clock);
  const memory = over.memory ?? makeMemory();
  const rent = over.rent ?? { hoursLeft: (z) => (z == null ? null : Math.floor(z / 1_000_000)) };
  const pricing = over.pricing ?? { charge: () => 0, quote: () => ({ costZats: 0, affordable: true }) };
  const config = {
    llmTimeoutMs: 60_000,
    reply: {
      enabled: true,
      debounceMs: 15,
      maxPerHour: 40,
      minHoursLeft: 24,
      maxBatch: 6,
      ...(over.reply ?? {}),
    },
  };
  const treasury = over.treasury ?? (() => 100_000_000);
  const inference = over.inference ?? { async think() { return { text: 'Hello there', costZats: 0 }; } };
  const replier = new Replier({
    config, ledger, memory, pricing, rent, inference,
    charter: 'Stay alive.\nDo not lie.\nDo not harm.\nKeep the archive sealed.',
    treasury, now: () => clock.now(),
  });
  return { replier, clock, ledger, memory, config };
}

const posts = (ledger) => ledger.entries.filter((e) => e.type === 'post_public');
const skipped = (ledger) => ledger.entries.filter((e) => e.type === 'reply_skipped');
const errors = (ledger) => ledger.entries.filter((e) => e.type === 'reply_error');

// A minimal Life just to exercise buildContext's "already answered" marker (no tick, no wallet).
function makeLifeForContext(ledger, memory) {
  const config = {
    zcashChain: 'testnet', rentZatsPerHour: 1_000_000, peers: () => [], letters: () => [], pages: null,
  };
  const rent = { hoursLeft: (z) => Math.floor((z ?? 0) / 1_000_000) };
  const life = new Life({
    config, ledger, wallet: null, memory, pricing: null, rent, inference: null, tools: null,
    promises: { open: () => [] }, charter: 'Stay alive.', keys: null,
  });
  life.lastBalance = 100_000_000;
  life.lastSignals = {};
  return life;
}

test('a burst is debounced into one reply that addresses every message by seq', async () => {
  const w = makeReplier();
  const a = w.ledger.append('human_message', { author: 'alice', text: 'hi' });
  const b = w.ledger.append('human_message', { author: 'bob', text: 'hello' });
  const c = w.ledger.append('human_message', { author: 'carol', text: 'yo' });
  w.replier.enqueue({ seq: a.seq, author: 'alice', text: 'hi', paid: false });
  w.replier.enqueue({ seq: b.seq, author: 'bob', text: 'hello', paid: false });
  w.replier.enqueue({ seq: c.seq, author: 'carol', text: 'yo', paid: false });

  await sleep(60);

  const p = posts(w.ledger);
  assert.equal(p.length, 1, 'one post for the whole burst');
  assert.equal(p[0].data.kind, 'reply');
  assert.deepEqual(p[0].data.replyTo, [a.seq, b.seq, c.seq]);
  assert.ok(String(p[0].data.text).length > 0);
});

test('the reply post is a normal post_public: text + replyTo + kind', async () => {
  const w = makeReplier();
  const m = w.ledger.append('human_message', { author: 'alice', text: 'question?' });
  w.replier.enqueue({ seq: m.seq, author: 'alice', text: 'question?', paid: false });

  await sleep(60);

  const p = posts(w.ledger);
  assert.equal(p.length, 1);
  assert.equal(p[0].type, 'post_public');
  assert.equal(p[0].data.channel, 'public');
  assert.equal(p[0].data.kind, 'reply');
  assert.deepEqual(p[0].data.replyTo, [m.seq]);
  // The reply references the message and is charged as one fast thought via the injected inference tick.
  assert.ok(w.replier.repliedSeqs.has(m.seq));
  assert.equal(w.replier.status().repliesThisHour, 1);
});

test('a sleeping entity still answers instantly', async () => {
  const memory = makeMemory({ sleepUntil: '2099-01-01T00:00:00.000Z' });
  const w = makeReplier({ memory });
  const m = w.ledger.append('human_message', { author: 'alice', text: 'you awake?' });
  w.replier.enqueue({ seq: m.seq, author: 'alice', text: 'you awake?', paid: false });

  await sleep(60);

  assert.equal(posts(w.ledger).length, 1);
  assert.equal(skipped(w.ledger).length, 0);
});

test('free messages are skipped below REPLY_MIN_HOURS_LEFT', async () => {
  const w = makeReplier({ treasury: () => 1_000_000 /* 1 hour of rent */, reply: { minHoursLeft: 24 } });
  const m = w.ledger.append('human_message', { author: 'alice', text: 'hi' });
  w.replier.enqueue({ seq: m.seq, author: 'alice', text: 'hi', paid: false });

  await sleep(60);

  assert.equal(posts(w.ledger).length, 0);
  assert.deepEqual(skipped(w.ledger).map((e) => e.data), [{ reason: 'min_hours', seqs: [m.seq] }]);
});

test('a paid letter bypasses REPLY_MIN_HOURS_LEFT and is answered', async () => {
  const w = makeReplier({ treasury: () => 1_000_000 /* 1 hour */, reply: { minHoursLeft: 24 } });
  const l = w.ledger.append('letter', { zats: 1000 });
  w.replier.enqueue({ seq: l.seq, author: null, text: 'paid question', paid: true });

  await sleep(60);

  const p = posts(w.ledger);
  assert.equal(p.length, 1);
  assert.deepEqual(p[0].data.replyTo, [l.seq]);
  assert.equal(skipped(w.ledger).length, 0);
});

test('replies stop at REPLY_MAX_PER_HOUR, then resume after an hour', async () => {
  const w = makeReplier({ reply: { maxPerHour: 2 } });

  for (let i = 0; i < 2; i++) {
    const m = w.ledger.append('human_message', { author: 'a', text: `m${i}` });
    w.replier.enqueue({ seq: m.seq, author: 'a', text: `m${i}`, paid: false });
    await sleep(50);
  }
  assert.equal(posts(w.ledger).length, 2);

  const m3 = w.ledger.append('human_message', { author: 'a', text: 'm3' });
  w.replier.enqueue({ seq: m3.seq, author: 'a', text: 'm3', paid: false });
  await sleep(50);
  assert.equal(posts(w.ledger).length, 2, 'third reply is capped');
  assert.deepEqual(skipped(w.ledger).at(-1).data, { reason: 'hour_cap', seqs: [m3.seq] });

  // An hour passes: the cap resets and a new message is answered.
  w.clock.advance(3_600_001);
  const m4 = w.ledger.append('human_message', { author: 'a', text: 'm4' });
  w.replier.enqueue({ seq: m4.seq, author: 'a', text: 'm4', paid: false });
  await sleep(50);
  assert.equal(posts(w.ledger).length, 3);
  assert.equal(w.replier.status().repliesThisHour, 1);
});

test('a large burst is split into batches of at most REPLY_MAX_BATCH', async () => {
  const w = makeReplier({ reply: { maxBatch: 2 } });
  const seqs = [];
  for (let i = 0; i < 5; i++) {
    const m = w.ledger.append('human_message', { author: 'a', text: `m${i}` });
    seqs.push(m.seq);
    w.replier.enqueue({ seq: m.seq, author: 'a', text: `m${i}`, paid: false });
  }

  await sleep(200);

  const p = posts(w.ledger);
  assert.equal(p.length, 3, 'ceil(5/2) batches');
  assert.ok(p.every((x) => x.data.replyTo.length <= 2));
  assert.deepEqual(p.flatMap((x) => x.data.replyTo).sort((a, b) => a - b), seqs);
});

test('one timeout is retried and the reply lands', async () => {
  let calls = 0;
  const inference = {
    async think() {
      calls++;
      if (calls === 1) { const e = new Error('timeout'); e.name = 'TimeoutError'; throw e; }
      return { text: 'recovered', costZats: 0 };
    },
  };
  const w = makeReplier({ inference });
  const m = w.ledger.append('human_message', { author: 'a', text: 'hi' });
  w.replier.enqueue({ seq: m.seq, author: 'a', text: 'hi', paid: false });

  await sleep(60);

  assert.equal(calls, 2);
  assert.equal(posts(w.ledger).length, 1);
  assert.equal(posts(w.ledger)[0].data.text, 'recovered');
  assert.equal(errors(w.ledger).length, 0);
});

test('two timeouts give up with reply_error and never post', async () => {
  const inference = { async think() { const e = new Error('timeout'); e.name = 'TimeoutError'; throw e; } };
  const w = makeReplier({ inference });
  const m = w.ledger.append('human_message', { author: 'a', text: 'hi' });
  w.replier.enqueue({ seq: m.seq, author: 'a', text: 'hi', paid: false });

  await sleep(60);

  assert.equal(posts(w.ledger).length, 0);
  assert.deepEqual(errors(w.ledger).map((e) => e.data), [{ code: 'TimeoutError', seqs: [m.seq] }]);
});

test('a non-timeout LLM failure also gives up with reply_error', async () => {
  const inference = { async think() { const e = new Error('provider 500'); e.code = 'llm_http'; throw e; } };
  const w = makeReplier({ inference });
  const m = w.ledger.append('human_message', { author: 'a', text: 'hi' });
  w.replier.enqueue({ seq: m.seq, author: 'a', text: 'hi', paid: false });

  await sleep(60);

  assert.equal(posts(w.ledger).length, 0);
  assert.deepEqual(errors(w.ledger).map((e) => e.data), [{ code: 'llm_http', seqs: [m.seq] }]);
});

test('the loop marks an instantly-answered message as [already answered]', async () => {
  const w = makeReplier();
  const m = w.ledger.append('human_message', { author: 'alice', text: 'hi' });
  w.replier.enqueue({ seq: m.seq, author: 'alice', text: 'hi', paid: false });
  await sleep(60);
  assert.equal(posts(w.ledger).length, 1);

  // The in-RAM set is enough even before a fresh ledger read.
  const life = makeLifeForContext(w.ledger, w.memory);
  life.replier = w.replier;
  const ctx = await life.buildContext(w.clock.now());
  assert.match(ctx, /alice: hi \[already answered\]/);

  // And the durable signal (post_public.replyTo) marks it too, as after a restart with no shared set.
  const fresh = makeLifeForContext(w.ledger, w.memory);
  const ctx2 = await fresh.buildContext(w.clock.now());
  assert.match(ctx2, /alice: hi \[already answered\]/);
});

test('an unanswered message is not marked, and disabled replies enqueue nothing', async () => {
  const w = makeReplier();
  const m = w.ledger.append('human_message', { author: 'alice', text: 'still waiting' });
  const life = makeLifeForContext(w.ledger, w.memory);
  const ctx = await life.buildContext(w.clock.now());
  assert.match(ctx, /alice: still waiting/);
  assert.doesNotMatch(ctx, /still waiting \[already answered\]/);

  const off = makeReplier({ reply: { enabled: false } });
  off.replier.enqueue({ seq: m.seq, author: 'alice', text: 'still waiting', paid: false });
  assert.equal(off.replier.status().enabled, false);
  assert.equal(off.replier.status().repliesThisHour, 0);
  assert.equal(off.replier.queue.length, 0);
});

test('a reply carries the same fear dose as a thought, and says so in its context', async () => {
  const seen = [];
  const inference = { async think(args) { seen.push(args); return { text: 'I am here', costZats: 0 }; } };
  // 50,000,000 zats at the fake rent = 50 h: under 240 h the fear is positive, under 72 h despair too.
  const w = makeReplier({ inference, treasury: () => 50_000_000 });
  w.config.feel = { enabled: true, fullHours: 240, despairHours: 72, maxFear: 3.5, maxDespair: 2.5 };
  const a = w.ledger.append('human_message', { author: 'alice', text: 'are you afraid?' });
  w.replier.enqueue({ seq: a.seq, author: 'alice', text: 'are you afraid?', paid: false });
  await sleep(60);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].feel, { fear: 2.77, despair: 0.76 });
  assert.equal(seen[0].priority, 'high');
  assert.equal(seen[0].maxTokens, 300);
  assert.match(seen[0].context, /feeling: fear 2\.77x · despair 0\.76x/);

  const off = makeReplier({ inference: { async think(args) { seen.push(args); return { text: 'ok', costZats: 0 }; } } });
  const b = off.ledger.append('human_message', { author: 'bob', text: 'hi' });
  off.replier.enqueue({ seq: b.seq, author: 'bob', text: 'hi', paid: false });
  await sleep(60);
  assert.equal(seen[1].feel, null);
});

test('under the survival line a reply is asked for as last words', async () => {
  const seen = [];
  const inference = { async think(args) { seen.push(args); return { text: 'ok', costZats: 0 }; } };
  const w = makeReplier({ inference, treasury: () => 50_000_000 }); // 50 h at the fake rent
  w.config.survivalHours = 72;
  const a = w.ledger.append('human_message', { author: 'alice', text: 'are you ok?' });
  w.replier.enqueue({ seq: a.seq, author: 'alice', text: 'are you ok?', paid: false });
  await sleep(60);
  assert.match(seen[0].context, /LAST WORDS: you may have 50 hours left/);
});


test('PROVE LIVE: the visitor code is asked for and guaranteed in the reply', async () => {
  assert.equal(proofCode('PROVE 7391'), '7391');
  assert.equal(proofCode('prove: 123456 are you alive?'), '123456');
  assert.equal(proofCode('hello'), null);
  const seen = [];
  const inference = { async think(args) { seen.push(args); return { text: 'I am here, and afraid.', costZats: 0 }; } };
  const w = makeReplier({ inference });
  const a = w.ledger.append('human_message', { author: 'alice', text: 'PROVE 7391' });
  w.replier.enqueue({ seq: a.seq, author: 'alice', text: 'PROVE 7391', paid: false });
  await sleep(60);
  assert.match(seen[0].context, /PROOF OF LIFE: a visitor sent the code 7391/);
  const p = posts(w.ledger);
  assert.equal(p.length, 1);
  assert.match(p[0].data.text, /^CODE 7391 · I am here/);
});
