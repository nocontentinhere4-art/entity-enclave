// soltx.test.mjs — byte-level tests for the hand-rolled Solana transaction crypto (src/trade/soltx.mjs).
// Ground truth is the fixtures under tests/fixtures/chains/: three REAL mainnet transactions (v0, legacy,
// and a v1 message that must be rejected) plus deterministic derivatives. Every shipped signature must
// verify against the parsed message bytes — the "non-circular anchor" discipline from generate.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  base58, parseTransaction, signTransaction, verifyTransactionSignature,
  buildLegacyTransaction, systemTransferInstruction, tokenCloseAccountInstruction,
  keypairFromSeed, readU64le, PROGRAM_ID_SYSTEM, PROGRAM_ID_TOKEN,
} from '../src/trade/soltx.mjs';

const here = new URL('./fixtures/chains/', import.meta.url);
const read = (f) => JSON.parse(readFileSync(new URL(f, here), 'utf8'));

// Fixed fixture keys (same labels as tests/fixtures/chains/generate.mjs). No real funds touch these.
const seed = (label) => Uint8Array.from(createHash('sha256').update(label).digest());
const taker = keypairFromSeed(seed('sov-trade-taker-fixture'));
const maker = keypairFromSeed(seed('sov-trade-maker-fixture'));
const treasury = keypairFromSeed(seed('sov-trade-treasury-fixture'));
const other = keypairFromSeed(seed('sov-trade-dest-fixture'));

const BLOCKHASH = '6ubV9kYQiNG1GJjkqvYkk3mSVJvSscgK7SE2aXLsMeuB';

// ---------------------------------------------------------------- base58 --------------------------------------
test('base58 round-trips and rejects characters outside the alphabet', () => {
  assert.equal(base58.encode(base58.decode('11111111111111111111111111111111')), '11111111111111111111111111111111');
  assert.equal(base58.decode('11111111111111111111111111111111').length, 32);
  const bytes = Uint8Array.from([0, 1, 2, 255, 0, 127]);
  assert.deepEqual(base58.decode(base58.encode(bytes)), bytes);
  assert.throws(() => base58.decode('0'), (e) => e.code === 'invalid_base58');
});

// ---------------------------------------------------------------- keypairs ------------------------------------
test('keypairFromSeed is deterministic, 64-byte secret, pubkey matches', () => {
  const a = keypairFromSeed(seed('sov-trade-taker-fixture'));
  const b = keypairFromSeed(seed('sov-trade-taker-fixture'));
  assert.equal(a.publicKeyBase58, b.publicKeyBase58);
  assert.equal(a.publicKeyBase58, taker.publicKeyBase58);
  assert.equal(a.secretKey.length, 64);
  assert.equal(base58.encode(a.publicKey), a.publicKeyBase58);
  assert.notEqual(keypairFromSeed(seed('sov-trade-maker-fixture')).publicKeyBase58, a.publicKeyBase58);
});

// ---------------------------------------------------------------- real mainnet anchors -----------------------
test('parses the real mainnet v0 transaction and its embedded signature verifies', () => {
  const v0 = read('soltx-real-v0.json');
  const p = parseTransaction(v0.base64);
  assert.equal(p.version, 'v0');
  assert.equal(p.signatureCount, 1);
  assert.equal(p.staticKeys.length, 10);
  assert.equal(p.instructions.length, 5);
  assert.ok(p.recentBlockhashBase58.length >= 32);
  assert.ok(verifyTransactionSignature(p, 0), 'embedded v0 signature must verify against the parsed message bytes');
});

test('parses the real mainnet legacy transaction and its signature verifies', () => {
  const leg = read('soltx-real-legacy.json');
  const p = parseTransaction(leg.base64);
  assert.equal(p.version, 'legacy');
  assert.equal(p.signatureCount, 1);
  assert.ok(verifyTransactionSignature(p, 0), 'embedded legacy signature must verify');
});

test('rejects a v1 message (0x81) with unsupported_version', () => {
  const v1 = read('soltx-real-v1.json');
  assert.throws(() => parseTransaction(v1.base64), (e) => e.code === 'unsupported_version');
});

// ---------------------------------------------------------------- signing ------------------------------------
test('signs slot 0 of the Jupiter-shaped v0 transaction; signature matches the fixture byte-for-byte', () => {
  const jo = read('jupiter-order-built.json');
  const parsed = parseTransaction(jo.transaction);
  assert.equal(parsed.version, 'v0');
  assert.equal(parsed.signatureCount, 2); // slot 0 = taker, slot 1 = JupiterZ co-signer

  const signed = signTransaction(jo.transaction, taker.secretKey);
  assert.equal(signed.signerIndex, 0);
  assert.equal(signed.signatureBase58, jo.expectedTakerSignatureBase58);
  assert.equal(signed.signedBase64, jo.signedTransaction);

  const reparsed = parseTransaction(signed.signedBase64);
  assert.ok(verifyTransactionSignature(reparsed, 0));
  assert.ok(reparsed.signatures[1].every((b) => b === 0), 'the co-signer slot must remain zero (partial sign)');
});

test('signTransaction accepts raw bytes as well as base64', () => {
  const jo = read('jupiter-order-built.json');
  const raw = Uint8Array.from(Buffer.from(jo.transaction, 'base64'));
  assert.deepEqual(signTransaction(raw, taker.secretKey).signed, signTransaction(jo.transaction, taker.secretKey).signed);
});

test('finds the signer at a non-zero index and leaves the other slot zero (JupiterZ shape)', () => {
  // fee payer = maker (slot 0); the transfer's `from` is the taker (slot 1).
  const tx = buildLegacyTransaction({
    feePayer: maker.publicKey,
    recentBlockhash: BLOCKHASH,
    instructions: [systemTransferInstruction({ from: taker.publicKey, to: other.publicKey, lamports: 5000 })],
  });
  const before = parseTransaction(tx.base64);
  assert.equal(before.numRequiredSignatures, 2);

  const signed = signTransaction(tx.base64, taker.secretKey);
  assert.equal(signed.signerIndex, 1);
  const p = parseTransaction(signed.signed);
  assert.ok(p.signatures[0].every((b) => b === 0), 'fee-payer slot untouched');
  assert.ok(verifyTransactionSignature(p, 1), 'our slot verifies');
  assert.equal(signed.signatureBase58, base58.encode(p.signatures[1]));
});

test('rejects a transaction whose message does not contain our public key', () => {
  const jo = read('jupiter-order-built.json');
  assert.throws(() => signTransaction(jo.transaction, other.secretKey), (e) => e.code === 'signer_not_found');
});

test('refuses to overwrite an already-filled signature slot', () => {
  const jo = read('jupiter-order-built.json');
  assert.throws(() => signTransaction(jo.signedTransaction, taker.secretKey), (e) => e.code === 'signature_slot_filled');
});

test('rejects an empty transaction and a wrong-length secret', () => {
  const jo = read('jupiter-order-built.json');
  assert.throws(() => parseTransaction(''), (e) => e.code === 'bad_tx');
  assert.throws(() => signTransaction(jo.transaction, new Uint8Array(32)), (e) => e.code === 'bad_secret');
});

// ---------------------------------------------------------------- instruction builders ------------------------
test('systemTransferInstruction encodes the 4-byte selector and u64 lamports', () => {
  const i = systemTransferInstruction({ from: taker.publicKey, to: treasury.publicKey, lamports: 1_210_000 });
  assert.equal(i.programId, PROGRAM_ID_SYSTEM);
  assert.deepEqual(i.keys.map((k) => base58.encode(k.pubkey)), [taker.publicKeyBase58, treasury.publicKeyBase58]);
  assert.deepEqual(i.keys.map((k) => [k.isSigner, k.isWritable]), [[true, true], [false, true]]);
  assert.deepEqual([...i.data.slice(0, 4)], [2, 0, 0, 0]);
  assert.equal(readU64le(i.data, 4), 1_210_000n);
});

test('tokenCloseAccountInstruction targets Tokenkeg… with data [9]', () => {
  const i = tokenCloseAccountInstruction({ account: other.publicKey, destination: treasury.publicKey, owner: taker.publicKey });
  assert.equal(i.programId, PROGRAM_ID_TOKEN);
  assert.deepEqual([...i.data], [9]);
  assert.deepEqual(i.keys.map((k) => base58.encode(k.pubkey)), [other.publicKeyBase58, treasury.publicKeyBase58, taker.publicKeyBase58]);
  assert.deepEqual(i.keys.map((k) => [k.isSigner, k.isWritable]), [[false, true], [false, true], [true, false]]);
});

// ---------------------------------------------------------------- legacy transaction build --------------------
test('buildLegacyTransaction transfer matches the hand-derived fixture byte-for-byte', () => {
  const dt = read('soltx-derived-transfer.json');
  const built = buildLegacyTransaction({
    feePayer: dt.slot1Example.from,
    recentBlockhash: dt.slot1Example.blockhash,
    instructions: [systemTransferInstruction({ from: dt.slot1Example.from, to: dt.slot1Example.to, lamports: 1_210_000 })],
  });
  assert.equal(built.base64, dt.builderWire);
  assert.equal(built.base64, dt.independentWire);
  assert.deepEqual(built.staticKeysBase58, dt.keysBase58);
  const p = parseTransaction(built.base64);
  assert.equal(base58.encode(p.staticKeys[p.instructions[0].programIdIndex]), PROGRAM_ID_SYSTEM);
  assert.equal(readU64le(p.instructions[0].data, 4), 1_210_000n);
});

test('closeAccount-built transaction parses to the Tokenkeg program with data [9]', () => {
  const ac = read('soltx-ata-close.json');
  const p = parseTransaction(ac.wire);
  assert.equal(base58.encode(p.staticKeys[p.instructions[0].programIdIndex]), PROGRAM_ID_TOKEN);
  assert.deepEqual([...p.instructions[0].data], [9]);
  assert.deepEqual(p.staticKeys.map(base58.encode), ac.keysBase58);
});

test('a built + signed legacy transfer verifies end to end', () => {
  const built = buildLegacyTransaction({
    feePayer: taker.publicKey,
    recentBlockhash: BLOCKHASH,
    instructions: [systemTransferInstruction({ from: taker.publicKey, to: treasury.publicKey, lamports: 777 })],
  });
  const signed = signTransaction(built.base64, taker.secretKey);
  const p = parseTransaction(signed.signed);
  assert.equal(base58.encode(p.staticKeys[p.instructions[0].programIdIndex]), PROGRAM_ID_SYSTEM);
  assert.equal(readU64le(p.instructions[0].data, 4), 777n);
  assert.ok(verifyTransactionSignature(p, 0));
});
