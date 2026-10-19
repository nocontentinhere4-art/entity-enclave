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
