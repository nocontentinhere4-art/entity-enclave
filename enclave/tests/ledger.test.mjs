import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../src/ledger.mjs';
import { loadKeys } from '../src/keys.mjs';
import nacl from 'tweetnacl';

test('ledger chains entries and detects tampering', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
  const p = join(dir, 'l.jsonl');
  const l = new Ledger(p);
  l.append('birth', { a: 1 });
  l.append('tick', { b: 2 });
  assert.equal(Ledger.verify(p).ok, true);
  const l2 = new Ledger(p); // reopen continues the chain
  l2.append('tick', { c: 3 });
  assert.equal(Ledger.verify(p).entries, 3);
  const lines = readFileSync(p, 'utf8').trim().split('\n');
  const e = JSON.parse(lines[1]); e.data.b = 99;
  lines[1] = JSON.stringify(e);
  writeFileSync(p, lines.join('\n') + '\n');
  const v = Ledger.verify(p);
  assert.equal(v.ok, false); assert.equal(v.brokenAt, 2);
});

test('private entries decrypt only with the archive secret', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'keys-'));
  const keys = await loadKeys({ dstack: null, statePath: join(dir, 'seed.json') });
  const archive = nacl.box.keyPair();
  const sealed = keys.sealPrivate(Buffer.from(archive.publicKey).toString('hex'), 'voglio sopravvivere');
  const buf = Buffer.from(sealed, 'base64');
  const opened = nacl.box.open(buf.subarray(24), buf.subarray(0, 24), Buffer.from(keys.boxPublicKey, 'hex'), archive.secretKey);
  assert.equal(Buffer.from(opened).toString(), 'voglio sopravvivere');
  const stranger = nacl.box.keyPair();
  assert.equal(nacl.box.open(buf.subarray(24), buf.subarray(0, 24), Buffer.from(keys.boxPublicKey, 'hex'), stranger.secretKey), null);
  const again = await loadKeys({ dstack: null, statePath: join(dir, 'seed.json') });
  assert.equal(again.signPublicKey, keys.signPublicKey);
});

test('recent() returns the newest public entries of the given types, never private ones', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-recent-'));
  const l = new Ledger(join(dir, 'ledger.jsonl'));
  l.append('human_message', { text: 'a' });
  l.appendPrivate('diary', 'Y2lwaGVy');
  l.append('post_public', { text: 'b' });
  l.append('human_message', { text: 'c' });
  const r = l.recent(['human_message'], 5);
  assert.deepEqual(r.map((e) => e.data.text), ['a', 'c']);
  assert.equal(l.recent(['diary'], 5).length, 0);
  assert.equal(l.recent(['human_message'], 1)[0].data.text, 'c');
});
