import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { paused } from '../src/safety/pause.mjs';

const dir = mkdtempSync(join(tmpdir(), 'pause-'));
const file = join(dir, 'pause.json');

test('a readable pause file is honoured as-is', async () => {
  writeFileSync(file, JSON.stringify({ paused: false, since: '2026-01-01T00:00:00Z' }));
  assert.deepEqual(await paused({ pauseFile: file }), { paused: false });
  writeFileSync(file, JSON.stringify({ paused: true, since: '2026-01-01T00:00:00Z' }));
  assert.deepEqual(await paused({ pauseFile: file }), { paused: true });
});

test('unreadable/missing/corrupt pause file fails safe: paused', async () => {
  await rmSync(file, { force: true });
  assert.deepEqual(await paused({ pauseFile: file }), { paused: true, reason: 'fail-safe' });
  writeFileSync(file, '{ not json'); // corrupt: unparseable
  assert.deepEqual(await paused({ pauseFile: file }), { paused: true, reason: 'fail-safe' });
  await rmSync(dir, { recursive: true, force: true }); // whole dir gone (must be last: the dir holds the file)
  assert.deepEqual(await paused({ pauseFile: file }), { paused: true, reason: 'fail-safe' });
});

test('no pause source configured fails safe: paused with a reason', async () => {
  assert.deepEqual(await paused({}), { paused: true, reason: 'no pause source configured' });
  assert.deepEqual(await paused(undefined), { paused: true, reason: 'no pause source configured' });
});
