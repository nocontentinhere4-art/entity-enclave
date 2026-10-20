import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBalance } from '../src/zcash.mjs';

test('parseBalance reads zingo balances with underscore thousands separators', () => {
  const out = `[
    confirmed_ironwood_balance: no view capability
    confirmed_orchard_balance: 100_000_000
    unconfirmed_orchard_balance: 0
    total_orchard_balance: 100_000_000
    total_sapling_balance: 1_234
    total_transparent_balance: 5
]`;
  const b = parseBalance(out);
  assert.equal(b.total_orchard_balance, 100_000_000);
  assert.equal(b.total_sapling_balance, 1234);
  assert.equal(b.confirmed_ironwood_balance, undefined);
  assert.equal(b.total_zatoshis, 100_000_000 + 1234 + 5);
});
