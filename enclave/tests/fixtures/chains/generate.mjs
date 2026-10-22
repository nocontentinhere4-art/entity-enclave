// Fixture generator for the chain tests (dev-time tool, NOT run by the test suite).
// It re-reads the REAL mainnet transactions shipped in this directory and derives the
// Jupiter-shaped v0 transaction used for signing tests, then writes the derived fixtures.
//
//   node tests/fixtures/chains/generate.mjs
//
// Ground-truth discipline: the real fixtures are non-circular anchors — every shipped signature
// verifies with tweetnacl against the parsed message bytes, so belief-mistakes cannot hide. The
// derived fixture is built by PREPENDING a fixture-keys taker (slot 0, zero-filled — exactly what
// Jupiter /swap/v2/order returns) and re-mapping all instruction indices by +1; the original payer
// stays a co-signer at slot 1 (JupiterZ-style partial signing). Tests re-derive the same bytes
// independently from soltx-real-v0.json, so a silent serialization change breaks byte-identity.

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import nacl from 'tweetnacl';
import {
  base58, parseTransaction, buildLegacyTransaction, systemTransferInstruction,
  tokenCloseAccountInstruction, keypairFromSeed, PROGRAM_ID_SYSTEM,
} from '../../../src/trade/soltx.mjs';

const here = new URL('.', import.meta.url).pathname;
const read = (f) => JSON.parse(readFileSync(here + f, 'utf8'));

const v0real = read('soltx-real-v0.json');
const legacyReal = read('soltx-real-legacy.json');

// Fixed fixture keys: sha256(label) seeds. No real funds ever touch these.
const seed = (label) => Uint8Array.from(createHash('sha256').update(label).digest());
const taker = keypairFromSeed(seed('sov-trade-taker-fixture'));       // entity's disposable order wallet
const maker = keypairFromSeed(seed('sov-trade-maker-fixture'));       // fake "JupiterZ" market maker
const treasury = keypairFromSeed(seed('sov-trade-treasury-fixture')); // fee receiver
const OTHER = keypairFromSeed(seed('sov-trade-dest-fixture'));        // generic extra key

const c16 = (n) => { const o = []; let x = n; for (;;) { let b = x & 0x7f; x >>>= 7; if (x === 0) { o.push(b); break; } o.push(b | 0x80); } return o; };
const u8 = (...parts) => Uint8Array.from(parts.flat());

// --- derive a Jupiter /swap/v2/order-shaped v0 transaction from the REAL v0 swap -----------------
const realP = parseTransaction(v0real.base64);
// blockhash = the 32 bytes right after header+static keys in the body
const blockhashBytes = realP.messageBody.slice(4 + realP.staticKeys.length * 32, 4 + realP.staticKeys.length * 32 + 32);

// New static key list: [taker(signer slot 0), original static keys…] — the original payer remains a
// required co-signer at slot 1 (its zeroed slot is what JupiterZ would fill). Instruction indices are
// all +1 because everything shifts by the hoisted taker key.
const keysBytes = [taker.publicKey, ...realP.staticKeys];
const header = [2, realP.numReadonlySigned, realP.numReadonlyUnsigned];
const remap = (i) => i + 1; // every key index in instructions shifts by the taker's position

const bodyBytes = u8(
  ...c16(header[0]), ...c16(header[1]), ...c16(header[2]), ...c16(keysBytes.length),
  ...keysBytes.map((k) => Array.from(k)),
  ...blockhashBytes,
  ...c16(realP.instructions.length),
  ...realP.instructions.flatMap((i) => [
    remap(i.programIdIndex), ...c16(i.accounts.length), ...i.accounts.map(remap), ...c16(i.data.length), ...i.data,
  ]),
  ...c16(realP.addressTableLookups?.length ?? 0),
  ...(realP.addressTableLookups ?? []).flatMap((l) => [
    ...base58.decode(l.tablePubkeyBase58),
    ...c16(l.writable.length), ...l.writable,
    ...c16(l.readonly.length), ...l.readonly,
  ]),
);
const message = u8(0x80, ...bodyBytes); // version byte committed by the signatures
const composed = u8(...c16(2), new Array(64).fill(0), new Array(64).fill(0), ...message);

// Canonical taker signature over the composed message bytes (what /execute expects in signedTransaction
// once slot 0 is filled; slot 1 stays zero — the market maker's partial-sign slot).
const takerSig = nacl.sign.detached(message, taker.secretKey);
const sigPrefixLen = c16(2).length;
const signedEnvelope = composed.slice();
signedEnvelope.set(takerSig, sigPrefixLen);

const jupiterOrder = {
  _comment: 'DERIVED fixture (generate.mjs) — a regeneratable derivative of soltx-real-v0.json. Jupiter /swap/v2/order response shape: v0 transaction, slot 0 = fixture taker (zero pre-fill, taker signs; signature included as expectedTakerSignature), slot 1 = zeroed co-signer (real payer at static key 1, JupiterZ-style partial sign), static keys = real swap keys hoisted by one for the taker.',
  requestId: 'rfq-fixture-0001',
  outAmount: '123456789',
  router: 'JUP',
  mode: 'ExactIn',
  feeBps: 0,
  feeMint: 'So11111111111111111111111111111111111111112',
  transactionVersion: 'V0',
  transaction: Buffer.from(composed).toString('base64'),
  expectedTakerSignatureBase58: base58.encode(takerSig),
  signedTransaction: Buffer.from(signedEnvelope).toString('base64'),
  _keys: {
    taker: { seedLabel: 'sov-trade-taker-fixture', pub: taker.publicKeyBase58 },
    maker: { seedLabel: 'sov-trade-maker-fixture', pub: maker.publicKeyBase58 },
    treasury: { seedLabel: 'sov-trade-treasury-fixture', pub: treasury.publicKeyBase58 },
    other: { seedLabel: 'sov-trade-dest-fixture', pub: OTHER.publicKeyBase58 },
  },
};

// --- close-leg fixtures: legacy transfer + ATA close built with OUR builders ----------------------
// The test asserts the builder's output against `independentWire`, a hand-rolled layout
// recomputation below — two independent derivations must agree byte-for-byte.
const blockhash = base58.encode(blockhashBytes);
const feeTransfer = buildLegacyTransaction({
  feePayer: taker.publicKey,
  recentBlockhash: blockhash,
  instructions: [systemTransferInstruction({ from: taker.publicKey, to: treasury.publicKey, lamports: 1_210_000 })],
});
const ataClose = buildLegacyTransaction({
  feePayer: taker.publicKey,
  recentBlockhash: blockhash,
  instructions: [tokenCloseAccountInstruction({ account: OTHER.publicKey, destination: treasury.publicKey, owner: taker.publicKey })],
});

// Hand layout of the fee transfer (independent derivation):
// [1 sig] [64 zero] [header 1/0/1] [3 keys] [blockhash] [1 instr: progIdx 2, accounts (00 01), data len 12,
// [2,0,0,0] + 1_210_000 LE]
const lamports = 1_210_000;
let lamportsBigInt = BigInt(lamports);
const lamportsLe = [];
for (let i = 0; i < 8; i++) { lamportsLe.push(Number(lamportsBigInt & 0xffn)); lamportsBigInt >>= 8n; }
const expectedWire = u8(
  ...c16(1), new Array(64).fill(0),
  1, 0, 1, 3,
  ...taker.publicKey, ...treasury.publicKey, ...base58.decode(PROGRAM_ID_SYSTEM),
  ...blockhashBytes,
  1,               // instruction count
  2,               // program index
  2, 0, 1,         // 2 accounts: taker(idx 0), treasury(idx 1)
  12,              // data length
  2, 0, 0, 0, ...lamportsLe,
);
if (expectedWire.length !== feeTransfer.bytes.length) throw new Error(`transfer wire length mismatch: hand ${expectedWire.length} vs builder ${feeTransfer.bytes.length}`);

writeFileSync(here + 'jupiter-order-built.json', JSON.stringify(jupiterOrder, null, 2) + '\n');
writeFileSync(here + 'soltx-derived-transfer.json', JSON.stringify({
  _comment: 'DERIVED (generate.mjs): legacy SystemProgram transfer built with soltx.buildLegacyTransaction — keys [taker(signer,w), treasury(w), program(ro)], fee payer slot 0, 12-byte selector [2,0,0,0] + 1_210_000 LE. independentWire is a hand-rolled layout recomputation; tests must keep both identical.',
  keysBase58: feeTransfer.staticKeysBase58,
  independentWire: Buffer.from(expectedWire).toString('base64'),
  builderWire: feeTransfer.base64,
  slot1Example: { blockhash, from: taker.publicKeyBase58, to: treasury.publicKeyBase58 },
}, null, 2) + '\n');
writeFileSync(here + 'soltx-ata-close.json', JSON.stringify({
  _comment: 'DERIVED (generate.mjs): legacy closeAccount-built tx on the SPL Token program. data = [9]; keys [owner(signer), account(w), destination(w), program(ro)]; fee payer slot 0 = owner.',
  wire: ataClose.base64,
  keysBase58: ataClose.staticKeysBase58,
}, null, 2) + '\n');
console.log('fixtures regenerated: jupiter-order-built.json, soltx-derived-transfer.json, soltx-ata-close.json (taker pub:', taker.publicKeyBase58 + ')');
void legacyReal;
