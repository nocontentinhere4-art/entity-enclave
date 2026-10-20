import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBalance, parseValueTransfers } from '../src/zcash.mjs';

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

test('parseValueTransfers reads zingo value_transfers blocks, multi-line memos included', () => {
  const out = `
{
    txid: 585d39b4d3c939fb349b19731a9978120a16cc354ec24842edd84b93babb92d3
    datetime: 2026-10-20 02:47:30 UTC
    status: confirmed
    blockheight: 4520685
    transaction fee: 15000
    zec price: not available
    kind: received
    value: 100000000
    recipient_address: not available
    pools_sent_from: 
    pools_received: Ironwood
    memos: 
	memo 1: fauzec/v1
01M5BK9JV1WVE5RRJH8ZFV66FK
https://fauzec.com/help
}
{
    txid: bf3d21211120f7e189a2a8668fbf26c24bb61bd351a29184b181288302e1845b
    datetime: 2026-10-20 02:50:42 UTC
    status: transmitted
    kind: sent
    value: 1500000
    recipient_address: utest1xc9
    memos: 
	memo 1: hello from wick: first memo test
}
`;
  const v = parseValueTransfers(out);
  assert.equal(v.length, 2);
  assert.equal(v[0].kind, 'received');
  assert.equal(v[0].value, 100_000_000);
  assert.equal(v[0].memos[0], 'fauzec/v1\n01M5BK9JV1WVE5RRJH8ZFV66FK\nhttps://fauzec.com/help');
  assert.equal(v[1].kind, 'sent');
  assert.equal(v[1].status, 'transmitted');
  assert.equal(v[1].recipient, 'utest1xc9');
  assert.deepEqual(v[1].memos, ['hello from wick: first memo test']);
});
