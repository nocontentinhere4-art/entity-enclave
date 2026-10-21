// Nostr: NIP-01 signing/serialisation and the post_nostr tool against an in-process mock relay (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { nostrIdentity, serializeEvent, eventId, verifyEvent, npubEncode, publishEvent, DEFAULT_RELAYS } from '../src/nostr.mjs';
import { Tools } from '../src/tools/registry.mjs';
import { Pricing } from '../src/economy/pricing.mjs';

const SEED = new Uint8Array(32).fill(7);

test('npub is the NIP-19 bech32 of the x-only pubkey (reference vector)', () => {
  assert.equal(npubEncode('3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d'), 'npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6');
});

test('identity is deterministic from the secret: same seed, same npub', () => {
  const a = nostrIdentity(SEED), b = nostrIdentity(Uint8Array.from(SEED));
  assert.equal(a.npub, b.npub);
  assert.match(a.pubkey, /^[0-9a-f]{64}$/);
  assert.notEqual(nostrIdentity(new Uint8Array(32).fill(8)).npub, a.npub);
});

test('NIP-01: id = sha256 of the canonical array, signature verifies, content untouched', () => {
  const id = nostrIdentity(SEED);
  const e = id.sign({ kind: 1, content: 'hello, "world" — ünïcode', tags: [['t', 'x']], created_at: 1_700_000_000 });
  const canonical = JSON.stringify([0, e.pubkey, 1_700_000_000, 1, [['t', 'x']], 'hello, "world" — ünïcode']);
  assert.equal(serializeEvent(e), canonical);
  assert.equal(e.id, createHash('sha256').update(canonical, 'utf8').digest('hex'));
  assert.equal(eventId(e), e.id);
  assert.equal(e.pubkey, id.pubkey);
  assert.equal(e.sig.length, 128);
  assert.ok(verifyEvent(e));
  assert.ok(!verifyEvent({ ...e, content: 'tampered' }));
});

// ---- mock relay: a WebSocket-shaped class driven by a per-URL behaviour table ---------------------------------
function mockWs(behaviours, log = []) {
  return class MockWebSocket {
    constructor(url) {
      this.url = url;
      log.push({ url, op: 'open' });
      const b = behaviours[url] ?? 'ok';
      setTimeout(() => {
        if (b === 'refuse') return this.onerror?.(new Error('ECONNREFUSED'));
        this.onopen?.();
      }, 1);
    }
    send(raw) {
      const [kind, ev] = JSON.parse(raw);
      log.push({ url: this.url, op: kind, id: ev.id });
      const b = behaviours[this.url] ?? 'ok';
      if (b === 'ok') setTimeout(() => this.onmessage?.({ data: JSON.stringify(['OK', ev.id, true, '']) }), 1);
      else if (b === 'reject') setTimeout(() => this.onmessage?.({ data: JSON.stringify(['OK', ev.id, false, 'blocked: spam']) }), 1);
      // 'silent': never answers → the per-relay timeout must fire
    }
    close() { log.push({ url: this.url, op: 'close' }); }
  };
}

test('publishEvent: collects acks per relay; silent, rejecting and refusing relays fail without blocking the rest', async () => {
  const id = nostrIdentity(SEED);
  const e = id.sign({ content: 'x', created_at: 1 });
  const log = [];
  const relays = ['wss://a', 'wss://b', 'wss://c', 'wss://d'];
  const r = await publishEvent(e, relays, { timeoutMs: 50, WebSocketImpl: mockWs({ 'wss://b': 'silent', 'wss://c': 'reject', 'wss://d': 'refuse' }, log) });
  assert.deepEqual(r.ok, ['wss://a']);
  assert.deepEqual(r.failed.map((f) => f.url), ['wss://b', 'wss://c', 'wss://d']);
  assert.equal(r.failed[0].reason, 'timeout');
  assert.equal(r.failed[1].reason, 'blocked: spam');
  // every socket was closed, including the timed-out one
  assert.equal(log.filter((l) => l.op === 'close').length, 4);
  // the EVENT frame carried the signed id
  assert.ok(log.some((l) => l.op === 'EVENT' && l.id === e.id && l.url === 'wss://a'));
});

// ---- the tool ------------------------------------------------------------------------------------------------
class FakeLedger {
  entries = [];
  append(type, data) { this.entries.push({ type, data }); return { type, data }; }
  appendPrivate(type) { this.entries.push({ type, private: true }); return {}; }
  of(type) { return this.entries.filter((e) => e.type === type); }
}

function makeTools({ behaviours = {}, config = {} } = {}) {
  const ledger = new FakeLedger(), log = [];
  const keys = { deriveSubkey: (label) => createHash('sha256').update(label).digest() };
  const tools = new Tools({ ledger, wallet: { async balance() { return { total_zatoshis: 1_000_000 }; } }, memory: {}, pricing: new Pricing({ ledger }), keys, config, channels: {}, promises: {} });
  tools.wsImpl = mockWs(behaviours, log);
  return { ledger, tools, log };
}

test('post_nostr: charged, signed with the derived key, sent to the default relays, public entry { id, relays_ok, bytes }', async () => {
  const { ledger, tools, log } = makeTools({ behaviours: { 'wss://nos.lol': 'silent' } });
  tools.setTreasury(1_000_000);
  const out = await tools.call('post_nostr', { text: 'first note: alive, 29 days of rent left' }, 't1');
  assert.equal(out.ok, true);
  assert.equal(out.npub, nostrIdentity(createHash('sha256').update('nostr').digest()).npub);
  assert.deepEqual(new Set(log.filter((l) => l.op === 'open').map((l) => l.url)), new Set(DEFAULT_RELAYS));
  assert.deepEqual(out.relays_ok, DEFAULT_RELAYS.filter((u) => u !== 'wss://nos.lol'));
  assert.deepEqual(ledger.of('charge')[0].data, { action: 'post_nostr', tickId: 't1', costZats: 500 });
  const entry = ledger.of('post_nostr')[0].data;
  assert.deepEqual(entry, { id: out.id, relays_ok: out.relays_ok, bytes: Buffer.byteLength('first note: alive, 29 days of rent left') });
  assert.ok(!JSON.stringify(ledger.entries).includes('first note')); // the ledger never carries the text, only the id
  assert.equal(ledger.of('tool')[0].data.ok, true);
});

test('post_nostr: NOSTR_RELAYS config overrides the list; no ack anywhere is a failure, still charged and recorded', async () => {
  const { ledger, tools, log } = makeTools({ behaviours: { 'wss://only': 'reject' }, config: { nostrRelays: ['wss://only'] } });
  tools.setTreasury(1_000_000);
  await assert.rejects(tools.call('post_nostr', { text: 'hi' }, 't2'), (e) => e.code === 'no_relay');
  assert.deepEqual(log.filter((l) => l.op === 'open').map((l) => l.url), ['wss://only']);
  assert.equal(ledger.of('charge').length, 1);
  assert.deepEqual(ledger.of('post_nostr')[0].data.relays_ok, []);
  assert.equal(ledger.of('tool')[0].data.ok, false);
});

test('post_nostr: empty or over-long text is refused before any relay is contacted', async () => {
  const { tools, log } = makeTools();
  tools.setTreasury(1_000_000);
  await assert.rejects(tools.call('post_nostr', { text: '  ' }, 't3'), (e) => e.code === 'empty');
  await assert.rejects(tools.call('post_nostr', { text: 'x'.repeat(2001) }, 't4'), (e) => e.code === 'too_long');
  assert.equal(log.length, 0);
});
