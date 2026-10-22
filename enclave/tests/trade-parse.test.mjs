import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BECH32_CONST,
  BECH32M_CONST,
  base58Decode,
  base58Encode,
  bech32Encode,
  isValidMint,
  isShieldedAddress,
  validateReturnAddress,
  zcashDepositPreflight,
} from '../src/trade/address.mjs';
import {
  TradeMemoError,
  deriveAuth6,
  deriveClientRef,
  deriveOrderId,
  parseMemo,
  redactMemo,
  splitOpenFee,
} from '../src/trade/orders.mjs';
import { SOL_MINT } from '../src/trade/types.mjs';

const u1 = bech32Encode('u', Buffer.alloc(32, 7), BECH32M_CONST);
const u1b = bech32Encode('u', Buffer.alloc(32, 9), BECH32M_CONST);
const zs1 = bech32Encode('zs', Buffer.alloc(43, 3), BECH32_CONST);
const transparent = 't1SyntheticTransparentAddressForTestsOnly1111111';

test('parses the full buy grammar', () => {
  const memo = parseMemo(`buy ${SOL_MINT} target +25% stop -10% return ${u1}`);
  assert.equal(memo.kind, 'buy');
  assert.equal(memo.mint, SOL_MINT);
  assert.equal(memo.targetPct, 25);
  assert.equal(memo.stopPct, 10);
  assert.equal(memo.returnAddress, u1);
  const orderId = deriveOrderId('txid-1', memo.returnAddress);
  assert.equal(orderId.length, 17);
  assert.match(orderId, /^o[0-9a-f]{16}$/);
});

test('parses a ticker with $, missing target/stop, and only the first memo line', () => {
  const memo = parseMemo(`BuY $WIF return ${zs1}\nthis second line is a normal letter and must be ignored`);
  assert.equal(memo.kind, 'buy');
  assert.equal(memo.mintOrTicker, 'WIF');
  assert.equal(memo.mint, null);
  assert.equal(memo.targetPct, null);
  assert.equal(memo.stopPct, null);
});

test('target and stop accept bare numbers and stop accepts a negative sign', () => {
  const memo = parseMemo(`buy WIF target 25 stop -9 return ${u1}`);
  assert.equal(memo.targetPct, 25);
  assert.equal(memo.stopPct, 9);
});

test('orderId is deterministic for the same txid+address and differs for another address', () => {
  const a = deriveOrderId('tx-abc', u1);
  const b = deriveOrderId('tx-abc', u1);
  const c = deriveOrderId('tx-abc', u1b);
  const d = deriveOrderId('tx-other', u1);
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.notEqual(a, d);
});

test('auth6 and clientRef are stable and have the documented widths', () => {
  assert.match(deriveAuth6(u1), /^[0-9a-f]{6}$/);
  assert.match(deriveClientRef(u1), /^[0-9a-f]{16}$/);
  assert.equal(deriveAuth6(u1), deriveAuth6(u1));
});

test('rejects a transparent return address', () => {
  assert.throws(
    () => parseMemo(`buy WIF return ${transparent}`),
    (e) => e instanceof TradeMemoError && e.code === 'memo_return_transparent',
  );
  assert.equal(isShieldedAddress(transparent), false);
});

test('rejects a bad bech32 checksum', () => {
  const bad = u1.slice(0, -1) + (u1.endsWith('q') ? 'p' : 'q');
  assert.throws(() => parseMemo(`buy WIF return ${bad}`), (e) => e.code === 'memo_return_invalid');
  assert.equal(validateReturnAddress(bad).ok, false);
});

test('rejects a missing return address', () => {
  assert.throws(() => parseMemo('buy WIF target 10'), (e) => e.code === 'memo_return_required');
});

test('rejects an unknown keyword', () => {
  assert.throws(() => parseMemo(`buy WIF moon 100 return ${u1}`), (e) => e.code === 'memo_unknown_keyword');
});

test('rejects target above 1000 and stop above 90', () => {
  assert.throws(() => parseMemo(`buy WIF target 1001 return ${u1}`), (e) => e.code === 'memo_target_range');
  assert.throws(() => parseMemo(`buy WIF stop 91 return ${u1}`), (e) => e.code === 'memo_stop_range');
});

test('ordinary letters are not trade memos', () => {
  assert.equal(parseMemo('hello, please answer my question'), null);
  assert.equal(parseMemo(''), null);
});

test('sell memo parses orderId and optional key', () => {
  const id = deriveOrderId('txid-1', u1);
  assert.deepEqual(parseMemo(`sell ${id}`), { kind: 'sell', orderId: id, auth6: null });
  assert.deepEqual(parseMemo(`SELL ${id.toUpperCase()} KEY a1b2c3`), { kind: 'sell', orderId: id, auth6: 'a1b2c3' });
  assert.throws(() => parseMemo('sell not-an-order'), (e) => e.code === 'memo_order_id');
  assert.throws(() => parseMemo(`sell ${id} key xyz`), (e) => e.code === 'memo_auth');
  assert.throws(() => parseMemo(`sell ${id} other`), (e) => e.code === 'memo_unknown_keyword');
});

test('redactMemo removes the return address before the LLM sees it', () => {
  const out = redactMemo(`buy WIF target 10 return ${u1}`);
  assert.match(out, /return <redacted>/);
  assert.equal(out.includes(u1), false);
  assert.equal(out.includes('u1'), false);
});

test('base58 round-trips every 32-byte mint', () => {
  const bytes = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) bytes[i] = (i * 37 + 11) & 0xff;
  const encoded = base58Encode(bytes);
  assert.deepEqual(Buffer.from(base58Decode(encoded)), bytes);
  assert.equal(isValidMint(encoded), true);
  assert.equal(isValidMint('not-a-mint'), false);
  assert.equal(isValidMint(SOL_MINT), true);
});

test('deposit preflight refuses a transparent address carrying a memo', () => {
  assert.deepEqual(zcashDepositPreflight(transparent, 'memo'), { ok: false, code: 'transparent_with_memo' });
  assert.equal(zcashDepositPreflight(transparent, '').ok, true);
  assert.equal(zcashDepositPreflight(u1, 'memo').ok, true);
  assert.equal(zcashDepositPreflight(u1, '').ok, true);
});

test('open fee is 1% and stays in ZEC', () => {
  assert.deepEqual(splitOpenFee(2_500_000, 100), { feeOpenZats: 25_000, swapZats: 2_475_000 });
});
