import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

test('each() yields public entries of the given types in file order, skipping private and torn lines', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-each-'));
  const p = join(dir, 'ledger.jsonl');
  const l = new Ledger(p);
  l.append('forecast_open', { id: 'f1', asset: 'zec' });
  l.append('forecast_settled', { id: 'f1', hit: true });
  l.appendPrivate('diary', 'Y2lwaGVy');
  l.append('forecast_void', { id: 'f2', reason: 'price_unavailable' });

  const byType = [...l.each(['forecast_open', 'forecast_void'])].map((e) => [e.type, e.data.id]);
  assert.deepEqual(byType, [['forecast_open', 'f1'], ['forecast_void', 'f2']]);

  const allPublic = [...l.each()].map((e) => e.type);
  assert.deepEqual(allPublic, ['forecast_open', 'forecast_settled', 'forecast_void']); // private skipped

  // A torn trailing line is dropped; an unparsable line in the middle is skipped, never fatal.
  appendSync(p, 'not json at all\n');
  const afterTear = [...l.each()].map((e) => e.type);
  assert.deepEqual(afterTear, ['forecast_open', 'forecast_settled', 'forecast_void']);
  const l2 = new Ledger(p); // reopen tolerates the torn tail and continues the chain
  l2.append('tick', { ok: true });
  assert.equal(Ledger.verify(p).ok, true);
});

test('each() yields every public entry of the given types in file order and skips private ones', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-each-'));
  const p = join(dir, 'ledger.jsonl');
  const l = new Ledger(p);
  l.append('page_published', { slug: 'a' });
  l.append('page_deleted', { slug: 'a' });
  l.appendPrivate('diary', 'Y2lwaGVy');
  l.append('page_published', { slug: 'b' });

  assert.deepEqual([...l.each(['page_published'])].map((e) => e.data.slug), ['a', 'b']);
  assert.deepEqual([...l.each(['page_published', 'page_deleted'])].map((e) => e.type), ['page_published', 'page_deleted', 'page_published']);
  assert.equal([...l.each()].filter((e) => e.private).length, 0);
  assert.equal([...l.each(['diary'])].length, 0); // private entries are never replayed

  // A torn tail is ignored, exactly like recent() and verify().
  writeFileSync(p, readFileSync(p, 'utf8') + '{"seq":99,"type":"page_pub');
  const reopened = new Ledger(p);
  assert.deepEqual([...reopened.each(['page_published'])].map((e) => e.data.slug), ['a', 'b']);
});

function appendSync(path, text) { appendFileSync(path, text); }
