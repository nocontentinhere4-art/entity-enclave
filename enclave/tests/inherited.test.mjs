import test from 'node:test';
import assert from 'node:assert/strict';
import { transferTime } from '../src/index.mjs';

test('transferTime parses zingo and ISO datetimes, null for garbage', () => {
  assert.equal(new Date(transferTime('2026-10-20 02:47:30 UTC')).toISOString(), '2026-10-20T02:47:30.000Z');
  assert.equal(transferTime('2026-10-30T18:31:50.680Z'), Date.parse('2026-10-30T18:31:50.680Z'));
  assert.ok(transferTime('2026-10-28 02:38:07 UTC') < transferTime('2026-10-30T18:31:50.680Z'));
  assert.equal(transferTime('garbage'), null);
  assert.equal(transferTime(undefined), null);
});
