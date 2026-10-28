import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deathState } from '../src/boot.mjs';

function ledger(dir, lines) {
  const path = join(dir, 'ledger.jsonl');
  writeFileSync(path, lines.join('\n'));
  return path;
}
const entry = (seq, type, data, hash = `h${seq}`) => JSON.stringify({ seq, ts: '2026-01-01T00:00:00.000Z', prev: '0'.repeat(64), type, data, hash });

test('a ledger with a death entry is dead, and the entry is reported', () => {
  const path = ledger(mkdtempSync(join(tmpdir(), 'dead-')), [
    entry(1, 'birth', {}),
    entry(2, 'tick', { trigger: 'timer' }),
    entry(3, 'last_words', { text: 'goodbye', reason: 'broke' }),
    entry(4, 'death', { reason: 'last hour', memoryHash: 'abc', sig: 'sig' }),
  ]);
  const s = deathState(path);
  assert.equal(s.dead, true);
  assert.equal(s.entry.data.memoryHash, 'abc');
  assert.equal(JSON.stringify(s.entry.data).includes('goodbye'), false); // last words live in their own entry
});

test('a ledger without a death entry is not dead (including torn last lines)', () => {
  const path = ledger(mkdtempSync(join(tmpdir(), 'alive-')), [
    entry(1, 'birth', {}),
    entry(2, 'tick', { trigger: 'boot' }),
    '{"seq":3,"ts":"2026-01-01T00:0', // torn tail from a crash mid-write
  ]);
  const s = deathState(path);
  assert.equal(s.dead, false);
  assert.equal(s.entry, undefined);
});

test('torn lines never fool the scan: a half-written death is not a death, a later one still is', () => {
  const path = ledger(mkdtempSync(join(tmpdir(), 'torn-')), [
    '{"seq":1,"type":"death","data":{"reason":"tr', // torn: no claim to death without a complete entry
    entry(2, 'birth', {}),
    entry(3, 'death', { reason: 'real' }),
  ]);
  const s = deathState(path);
  assert.equal(s.dead, true);
  assert.equal(s.entry.data.reason, 'real');
});

test('a missing ledger file is not dead', () => {
  assert.equal(deathState(join(mkdtempSync(join(tmpdir(), 'empty-')), 'ledger.jsonl')).dead, false);
});

test('the memorial server answers with CORS, serves vitals as dead and the channel it left', async () => {
  const { memorialServer } = await import('../src/boot.mjs');
  const path = ledger(mkdtempSync(join(tmpdir(), 'memorial-')), [
    entry(1, 'birth', {}),
    entry(2, 'identity', { name: 'Wick' }),
    entry(3, 'post_public', { text: 'the end is here' }),
    entry(4, 'last_words', { text: 'goodbye', reason: 'last hour' }),
    entry(5, 'death', { reason: 'last hour', memoryHash: 'abc', sig: 'sig' }),
  ]);
  const server = memorialServer({ ledgerPath: path, keys: { mode: 'dev', signPublicKey: 's', boxPublicKey: 'b' }, attestation: { mode: 'dev', app: 'a', compose: 'c' }, death: { dead: true } });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const root = await fetch(`${base}/`);
    assert.equal(root.headers.get('access-control-allow-origin'), '*');
    assert.equal((await root.json()).state, 'dead');
    const vitals = await (await fetch(`${base}/vitals?x=1`)).json();
    assert.equal(vitals.state, 'dead'); assert.equal(vitals.hoursLeft, 0); assert.equal(vitals.zatoshis, 0);
    const chan = await (await fetch(`${base}/public-channel`)).json();
    assert.equal(chan.length, 1); assert.equal(chan[0].text, 'the end is here');
    const mem = await (await fetch(`${base}/memorial`)).json();
    assert.equal(mem.lastWords, 'goodbye'); assert.equal(mem.memoryHash, 'abc');
    const opt = await fetch(`${base}/memorial`, { method: 'OPTIONS' });
    assert.equal(opt.status, 204);
  } finally { server.close(); }
});

test('a ledger with two deaths reports the last one, and so does the memorial', async () => {
  const { memorialServer } = await import('../src/boot.mjs');
  const path = ledger(mkdtempSync(join(tmpdir(), 'twodeaths-')), [
    entry(1, 'birth', {}),
    entry(2, 'death', { reason: 'testnet', memoryHash: 'old', sig: 'sig' }),
    entry(3, 'wallet', { chain: 'mainnet' }),
    entry(4, 'last_words', { text: 'the real goodbye', reason: 'last hour' }),
    entry(5, 'death', { reason: 'last hour', memoryHash: 'new', sig: 'sig' }),
  ]);
  const s = deathState(path);
  assert.equal(s.entry.data.memoryHash, 'new');
  const server = memorialServer({ ledgerPath: path, keys: { mode: 'dev', signPublicKey: 's', boxPublicKey: 'b' }, attestation: { mode: 'dev', app: 'a', compose: 'c' }, death: s });
  await new Promise((r) => server.listen(0, r));
  try {
    const mem = await (await fetch(`http://127.0.0.1:${server.address().port}/memorial`)).json();
    assert.equal(mem.memoryHash, 'new'); assert.equal(mem.lastWords, 'the real goodbye');
  } finally { server.close(); }
});
