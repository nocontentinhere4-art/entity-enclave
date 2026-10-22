// Pure Solana transaction crypto — no I/O, no state, fully unit-testable. Everything the trade modules need
// to sign what Jupiter's v2 API hands back without wallet libraries:
//
//   - base58 encode/decode (Solana pubkeys, signatures)
//   - ed25519 keypairs from a 32-byte seed (tweetnacl), matching Solana keypairs exactly
//   - parse → sign → serialize of versioned (v0/v1) AND legacy transaction wire bytes
//   - SystemProgram transfer + SPL Token closeAccount instruction builders (legacy transactions)
//
// Wire format (verified against real mainnet fixtures in tests/fixtures/chains/):
//
//   transaction  = compact-u16 sigCount | 64 bytes × sigCount | message
//   message      = [0x80|0x81 version] + body      (v0/v1; legacy has no version byte)
//   body         = compact-u16 numRequiredSignatures, compact-u16 numReadonlySigned,
//                  compact-u16 numReadonlyUnsigned, compact-u16 numStaticKeys, 32 bytes × keys,
//                  recentBlockhash (32 bytes), compact-u16 numInstructions, instructions…,
//                  [v0 only] compact-u16 numAddressTableLookups, lookups…
//   instruction  = programIdIndex (u8), compact-u16 numAccounts, account indexes…,
//                  compact-u16 dataLength, data bytes
//   v0 lookup    = table pubkey (32 bytes inline), compact-u16 writable…, compact-u16 readonly…
//
// The signature covers ONLY the message bytes (the 0x80 version byte included for v0 — verified against
// real mainnet bytes). Signature slot i corresponds to static account key i for i < numRequiredSignatures;
// v0 transactions can also declare lookup-table signers, whose slots live beyond the static range — we
// never sign those. Jupiter's /swap/v2 puts the taker statically, which is the only sign path we allow.
// v1 messages (0x81) are REJECTED: the format has churned across SDK releases, Jupiter cannot emit it, and
// fail-closed beats guesswork around funds.

import nacl from 'tweetnacl';

/** SPL Token program (classic). Token-2022 is `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`. */
export const PROGRAM_ID_TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
/** System program. */
export const PROGRAM_ID_SYSTEM = '11111111111111111111111111111111';

// ---------------------------------------------------------------- base58 ----------------------------------------
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_INDEX = new Map([...B58].map((c, i) => [c, i]));

export const base58 = {
  /**
   * Encode bytes as base58 (Bitcoin alphabet). Leading 0x00 bytes become leading '1's.
   * @param {Uint8Array} bytes
   * @returns {string}
   */
  encode(bytes) {
    if (bytes.length === 0) return '';
    let zeros = 0;
    while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
    let n = 0n;
    for (const b of bytes) n = (n << 8n) | BigInt(b);
    let s = '';
    while (n > 0n) {
      s = B58[Number(n % 58n)] + s;
      n /= 58n;
    }
    return '1'.repeat(zeros) + s;
  },
  /**
   * Decode base58 to bytes. Throws `invalid_base58` on any character outside the alphabet.
   * @param {string} text
   * @returns {Uint8Array}
   */
  decode(text) {
    if (typeof text !== 'string') throw new SoltxError('invalid_base58', 'base58: not a string');
    if (text.length === 0) return new Uint8Array(0);
    let zeros = 0;
    while (zeros < text.length && text[zeros] === B58[0]) zeros++;
    let n = 0n;
    for (const c of text) {
      const i = B58_INDEX.get(c);
      if (i === undefined) throw new SoltxError('invalid_base58', `base58: bad character '${c}'`);
      n = n * 58n + BigInt(i);
    }
    const body = [];
    while (n > 0n) {
      body.push(Number(n & 0xffn));
      n >>= 8n;
    }
    body.reverse();
    const out = new Uint8Array(zeros + body.length);
    out.set(body, zeros);
    return out;
  },
};

/** Typed serialization/parse errors with a short `.code` for the ledger (see src/log.mjs digestError). */
export class SoltxError extends Error {
  /**
   * @param {string} code  short machine code, e.g. 'signer_not_found'
   * @param {string} message  human explanation (console only — never goes to the ledger)
   */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// ---------------------------------------------------------------- compact-u16 -----------------------------------
// Solana's "compact u16": 7-bit big groups little-endian, high bit = continuation, capped at 3 bytes.
// Every u16 value round-trips; values ≥ 2^14 use a third byte carrying (value >> 14) ≤ 3.

/**
 * Decode a compact-u16 at `pos` inside `bytes`. Advances `pos`. Throws `bad_compact_u16` if malformed.
 * @param {Uint8Array} bytes
 * @param {{ pos: number }} cursor
 * @returns {number}
 */
export function readCompactU16(bytes, cursor) {
  let value = 0;
  const startPos = cursor.pos;
  for (let shift = 0; shift <= 14; shift += 7) {
    if (cursor.pos >= bytes.length) throw new SoltxError('bad_compact_u16', 'compact-u16 truncated');
    const byte = bytes[cursor.pos++];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      if (shift > 0 && value >> 15 !== 0) break; // length > 15 bits impossible; fall through to check
      if (value > 0xffff) throw new SoltxError('bad_compact_u16', 'compact-u16 overflows u16');
      return value;
    }
  }
  throw new SoltxError('bad_compact_u16', `compact-u16 longer than 3 bytes at offset ${startPos}`);
}

/**
 * Encode a u16 as Solana compact-u16.
 * @param {number} value  0…65535
 * @returns {Uint8Array}
 */
export function writeCompactU16(value) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) throw new SoltxError('bad_compact_u16', `out of u16 range: ${value}`);
  const out = [];
  let next = value;
  for (;;) {
    let byte = next & 0x7f;
    next >>>= 7;
    if (next === 0) { out.push(byte); break; }
    byte |= 0x80;
    out.push(byte);
  }
  return Uint8Array.from(out);
}

// ---------------------------------------------------------------- integers --------------------------------------

/**
 * Append a u64 (BigInt) little-endian to `out`.
 * @param {BigInt} value
 * @param {Uint8Array[]} out
 */
export function u64le(value, out) {
  let v = BigInt(value);
  if (v < 0n || v >= 1n << 64n) throw new SoltxError('bad_u64', `out of u64 range: ${value}`);
  const bytes = [];
  for (let i = 0; i < 8; i++) { bytes.push(Number(v & 0xffn)); v >>= 8n; }
  out.push(Uint8Array.from(bytes));
}

/**
 * Read a little-endian u64 from `bytes` at offset `start`.
 * @param {Uint8Array} bytes
 * @param {number} start
 * @returns {BigInt}
 */
export function readU64le(bytes, start) {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(bytes[start + i] ?? 0);
  return v;
}

// ---------------------------------------------------------------- keypairs --------------------------------------

/**
 * Solana ed25519 keypair deterministically from a 32-byte seed. The 64-byte `secretKey` is the tweetnacl
 * layout (seed ‖ publicKey) — exactly what `nacl.sign.detached` wants.
 * @param {Uint8Array} seed  32 bytes (e.g. keys.deriveSubkey('sol-treasury'))
 * @returns {{ secretKey: Uint8Array, publicKey: Uint8Array, publicKeyBase58: string }}
 */
export function keypairFromSeed(seed) {
  if (!(seed instanceof Uint8Array) || seed.length !== 32) throw new SoltxError('bad_seed', 'seed must be 32 bytes');
  const kp = nacl.sign.keyPair.fromSeed(seed);
  return {
    secretKey: kp.secretKey,
    publicKey: kp.publicKey,
    publicKeyBase58: base58.encode(kp.publicKey),
  };
}

/** Fresh random keypair (for disposable trade wallets). Same shape as {@link keypairFromSeed}. */
export function generateKeypair() {
  return keypairFromSeed(nacl.randomBytes(32));
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ---------------------------------------------------------------- parse -----------------------------------------

/**
 * Parse transaction wire bytes (base64 string or raw) into fields + the exact signable message.
 * Parsing is strict — any trailing byte, truncation or oversized element throws.
 *
 * @param {string|Uint8Array} tx  wire bytes, base64 encoded
 * @returns {{
 *   version: 'legacy'|'v0',
 *   signatureCount: number,
 *   signatures: Uint8Array[],          // 64-byte slots as they appear (Jupiter pre-fills zeros)
 *   message: Uint8Array,               // the exact signable bytes — version byte included for v0
 *   messageBody: Uint8Array,           // bytes after the version byte (equal to message for legacy)
 *   numRequiredSignatures: number,
 *   numReadonlySigned: number,
 *   numReadonlyUnsigned: number,
 *   staticKeys: Uint8Array[],          // static account keys; signature slot i ↔ static key i (i < numRequiredSignatures)
 *   recentBlockhashBase58: string,
 *   instructions: { programIdIndex: number, accounts: number[], data: Uint8Array }[],
 *   addressTableLookups: { tablePubkeyBase58: string, writable: number[], readonly: number[] }[] | null,
 * }}
 */
export function parseTransaction(tx) {
  const bytes = typeof tx === 'string' ? Uint8Array.from(Buffer.from(tx, 'base64')) : tx;
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) throw new SoltxError('bad_tx', 'transaction is empty');
  // A bare v1 MESSAGE (no envelope) starts with 0x81 where the envelope would start compact-u16(sigCount):
  // short-circuit it into the clean unsupported_version failure instead of an implausible-sig-count one.
  // 0x81 can never be a valid envelope prefix — a real sigCount compact-u16 is a single byte < 0x80 (the
  // code caps it at 12) — so a leading 0x81 is unambiguously a version byte, not a signature count.
  if (bytes[0] === 0x81) {
    throw new SoltxError('unsupported_version', 'v1 transactions are rejected outright; the format has churned across SDK releases — ask Jupiter for v0');
  }
  const cur = { pos: 0 };

  const signatureCount = readCompactU16(bytes, cur);
  if (signatureCount === 0 || signatureCount > 12) throw new SoltxError('bad_signature_count', `implausible signature count ${signatureCount}`);
  if (cur.pos + signatureCount * 64 > bytes.length) throw new SoltxError('truncated', 'signature slots run off the end');
  const signatures = [];
  for (let i = 0; i < signatureCount; i++) signatures.push(bytes.slice(cur.pos, cur.pos + 64)), (cur.pos += 64);

  const messageStart = cur.pos;
  const message = bytes.subarray(messageStart);
  // Message byte 0: 0x80 = v0, else legacy. v1 (0x81) exists but its wire format is still a moving target
  // (TransactionConfig fields are not stable across SDK releases — see svm conformance history) and nothing
  // in the 1Click/Jupiter contracts can emit it. Rejecting it here is the fail-closed choice.
  const first = message[0] ?? 0;
  if (first === 0x81) throw new SoltxError('unsupported_version', 'v1 transactions are rejected outright; ask Jupiter for v0 and re-examine if that ever changes');
  if (first > 0x81) throw new SoltxError('bad_version', `unsupported message version byte 0x${first.toString(16)}`);
  const version = first === 0x80 ? 'v0' : 'legacy';
  // Version byte must be committed by the signatures, so `message` (the signable bytes) keeps it;
  // `body` is the parsed remainder after the version byte.
  const body = version === 'v0' ? message.subarray(1) : message;

  // Header + static keys + blockhash + instructions (+ lookups for v0-style bodies).
  const bp = { pos: 0 };
  const numRequiredSignatures = readCompactU16(body, bp);
  const numReadonlySigned = readCompactU16(body, bp);
  const numReadonlyUnsigned = readCompactU16(body, bp);
  if (numRequiredSignatures === 0) throw new SoltxError('bad_header', 'message requires zero signatures');
  const keyCount = readCompactU16(body, bp);
  if (keyCount < numRequiredSignatures) throw new SoltxError('bad_header', `${keyCount} keys cannot satisfy ${numRequiredSignatures} signers`);
  if (numReadonlySigned > numRequiredSignatures) throw new SoltxError('bad_header', 'readonly signed count exceeds signer count');
  if (keyCount > 256) throw new SoltxError('bad_header', 'implausible static key count');
  const staticKeys = [];
  for (let i = 0; i < keyCount; i++) {
    if (bp.pos + 32 > body.length) throw new SoltxError('truncated', 'static keys run off the end');
    staticKeys.push(body.slice(bp.pos, bp.pos + 32));
    bp.pos += 32;
  }
  if (bp.pos + 32 > body.length) throw new SoltxError('truncated', 'recent blockhash runs off the end');
  const recentBlockhashBase58 = base58.encode(body.slice(bp.pos, bp.pos + 32));
  bp.pos += 32;

  const instructionCount = readCompactU16(body, bp);
  const instructions = [];
  for (let i = 0; i < instructionCount; i++) {
    if (bp.pos >= body.length) throw new SoltxError('truncated', 'instruction cut short');
    const programIdIndex = body[bp.pos++];
    if (programIdIndex >= keyCount) throw new SoltxError('bad_instruction', `program index ${programIdIndex} outside key list (${keyCount})`);
    const accounts = [];
    const nAccounts = readCompactU16(body, bp);
    for (let a = 0; a < nAccounts; a++) {
      if (bp.pos >= body.length) throw new SoltxError('truncated', 'instruction accounts cut short');
      accounts.push(body[bp.pos++]);
    }
    const dataLen = readCompactU16(body, bp);
    if (bp.pos + dataLen > body.length) throw new SoltxError('truncated', 'instruction data cut short');
    instructions.push({ programIdIndex, accounts, data: body.slice(bp.pos, bp.pos + dataLen) });
    bp.pos += dataLen;
  }

  let addressTableLookups = null;
  if (version === 'v0') {
    const lookupCount = readCompactU16(body, bp);
    addressTableLookups = [];
    for (let i = 0; i < lookupCount; i++) {
      if (bp.pos + 32 > body.length) throw new SoltxError('truncated', 'lookup table pubkey cut short');
      const tablePubkeyBase58 = base58.encode(body.slice(bp.pos, bp.pos + 32));
      bp.pos += 32;
      const writable = [], readonly = [];
      const nWritable = readCompactU16(body, bp);
      for (let a = 0; a < nWritable; a++) {
        if (bp.pos >= body.length) throw new SoltxError('truncated', 'lookup writable cut short');
        writable.push(body[bp.pos++]);
      }
      const nReadonly = readCompactU16(body, bp);
      for (let a = 0; a < nReadonly; a++) {
        if (bp.pos >= body.length) throw new SoltxError('truncated', 'lookup readonly cut short');
        readonly.push(body[bp.pos++]);
      }
      addressTableLookups.push({ tablePubkeyBase58, writable, readonly });
    }
  }

  if (bp.pos !== body.length) throw new SoltxError('trailing_bytes', `${body.length - bp.pos} unexpected message byte(s) after the last instruction`);

  return {
    version, signatureCount, signatures, message, messageBody: body,
    numRequiredSignatures, numReadonlySigned, numReadonlyUnsigned,
    staticKeys, recentBlockhashBase58, instructions, addressTableLookups,
  };
}

// ---------------------------------------------------------------- signing ---------------------------------------

/**
 * Sign OUR slot of a transaction, leaving every other signature slot byte-identical (Jupiter pre-fills its
 * market-maker slots with zeros / signs in parallel; only our own slot may be touched).
 *
 * Fails closed: our key must appear among the static account keys and within the signer range
 * (index < numRequiredSignatures). Lookup-only signers are unsupported.
 *
 * @param {string|Uint8Array} tx  wire bytes (base64 ok) as returned by Jupiter /order
 * @param {Uint8Array} secretKey  64-byte tweetnacl secret (seed ‖ publicKey)
 * @returns {{
 *   signed: Uint8Array,        // original bytes with only our signature slot replaced
 *   signedBase64: string,      // ready for Jupiter /execute and Solana sendTransaction
 *   signatureBase58: string,
 *   signerIndex: number,       // static key index (== signature slot)
 * }}
 */
export function signTransaction(tx, secretKey) {
  if (!(secretKey instanceof Uint8Array) || secretKey.length !== 64) throw new SoltxError('bad_secret', 'secretKey must be 64 bytes');
  const parsed = parseTransaction(tx);
  const ourPub = secretKey.subarray(32);

  let signerIndex = -1;
  for (let i = 0; i < parsed.staticKeys.length; i++) if (bytesEqual(parsed.staticKeys[i], ourPub)) { signerIndex = i; break; }
  if (signerIndex < 0) throw new SoltxError('signer_not_found', 'our public key is not among the static account keys');
  if (signerIndex >= parsed.numRequiredSignatures) throw new SoltxError('signer_not_required', 'our key is listed beyond the signer range of the message');
  if (signerIndex >= parsed.signatureCount) throw new SoltxError('bad_signature_count', 'fewer signature slots than required signers');

  const slotStart = sigSlotOffset(parsed, signerIndex);
  const current = parsed.signatures[signerIndex];
  for (const b of current) if (b !== 0) throw new SoltxError('signature_slot_filled', `signature slot ${signerIndex} already holds a signature`);

  const signature = nacl.sign.detached(parsed.message, secretKey);
  const raw = typeof tx === 'string' ? Uint8Array.from(Buffer.from(tx, 'base64')) : tx;
  const signed = raw.slice();
  signed.set(signature, slotStart);
  return {
    signed,
    signedBase64: Buffer.from(signed).toString('base64'),
    signatureBase58: base58.encode(signature),
    signerIndex,
  };
}

/** Absolute wire offset of 64-byte signature slot `index`: compact-u16(sigCount) prefix + 64 × index. */
function sigSlotOffset(parsed, index) {
  const prefixLen = writeCompactU16(parsed.signatureCount).length;
  return prefixLen + 64 * index;
}

/**
 * Verify signature slot `index` of a parsed transaction against static key `index` (tweetnacl). Used by the
 * tests to validate the parser/slice against REAL mainnet bytes; also a general-purpose audit helper.
 * @param {ReturnType<typeof parseTransaction>} parsed
 * @param {number} index
 * @returns {boolean}
 */
export function verifyTransactionSignature(parsed, index) {
  const key = parsed.staticKeys[index];
  const sig = parsed.signatures[index];
  if (!key || !sig) return false;
  return nacl.sign.detached.verify(parsed.message, sig, key);
}

// ---------------------------------------------------------------- instruction builders --------------------------

/**
 * SystemProgram transfer. Instruction selector is the 4-byte LE of `2`.
 * @param {{ from: string|Uint8Array, to: string|Uint8Array, lamports: number|BigInt }} p
 * @returns {{ programId: string, keys: { pubkey: Uint8Array, isSigner: boolean, isWritable: boolean }[], data: Uint8Array }}
 */
export function systemTransferInstruction({ from, to, lamports }) {
  const data = new Uint8Array(12);
  data.set([2, 0, 0, 0], 0);
  const raw = u64leBytes(lamports);
  data.set(raw, 4);
  return {
    programId: PROGRAM_ID_SYSTEM,
    keys: [
      { pubkey: as32(from), isSigner: true, isWritable: true },
      { pubkey: as32(to), isSigner: false, isWritable: true },
    ],
    data,
  };
}

/**
 * SPL Token closeAccount (instruction index 9) — reclaims the ATA rent to `destination`. Used by the close
 * pipeline to zero out the disposable wallet's token account before discard.
 * @param {{ account: string|Uint8Array, destination: string|Uint8Array, owner: string|Uint8Array }} p
 * @returns {{ programId: string, keys: {…}[], data: Uint8Array }}
 */
export function tokenCloseAccountInstruction({ account, destination, owner }) {
  return {
    programId: PROGRAM_ID_TOKEN,
    keys: [
      { pubkey: as32(account), isSigner: false, isWritable: true },
      { pubkey: as32(destination), isSigner: false, isWritable: true },
      { pubkey: as32(owner), isSigner: true, isWritable: false },
    ],
    data: Uint8Array.of(9),
  };
}

/**
 * Compile a LEGACY transaction wire from a fee payer + instructions. Static keys keep first-appearance
 * order with the fee payer hoisted to slot 0 (it must be a signer — slot 0 is its signature slot).
 * All signer slots are left zero; callers follow with {@link signTransaction}.
 *
 * @param {{
 *   feePayer: string|Uint8Array,
 *   recentBlockhash: string,                  // base58, from Solana RPC getLatestBlockhash
 *   instructions: ReturnType<typeof systemTransferInstruction>[],
 * }} p
 * @returns {{ bytes: Uint8Array, base64: string, staticKeysBase58: string[] }}
 */
export function buildLegacyTransaction({ feePayer, recentBlockhash, instructions }) {
  if (!Array.isArray(instructions) || instructions.length === 0) throw new SoltxError('bad_instructions', 'need at least one instruction');
  const fp = as32(feePayer);
  const keys = [];
  const seen = new Set();
  const push = (pub, isSigner, isWritable) => {
    const k = base58.encode(pub);
    const existing = seen.has(k);
    if (!existing) { seen.add(k); keys.push({ pubkey: pub, isSigner, isWritable }); return; }
    const entry = keys.find((e) => base58.encode(e.pubkey) === k);
    entry.isSigner = entry.isSigner || isSigner;
    entry.isWritable = entry.isWritable || isWritable;
  };
  push(fp, true, true);
  for (const instr of instructions) {
    for (const k of instr.keys) push(k.pubkey, k.isSigner, k.isWritable);
    push(as32(instr.programId), false, false);
  }
  // Signers must occupy the first numRequiredSignatures slots; hoist every signer before non-signers
  // while preserving relative order (fee payer stays slot 0).
  const signers = keys.filter((k) => k.isSigner);
  const others = keys.filter((k) => !k.isSigner);
  const ordered = [...signers, ...others];
  const numRequiredSignatures = signers.length;
  const numReadonlySigned = signers.filter((k) => !k.isWritable).length;
  const numReadonlyUnsigned = others.filter((k) => !k.isWritable).length;

  const msg = [writeCompactU16(numRequiredSignatures), writeCompactU16(numReadonlySigned), writeCompactU16(numReadonlyUnsigned), writeCompactU16(ordered.length)];
  for (const k of ordered) msg.push(k.pubkey);
  msg.push(as32(recentBlockhash)); // base58 here round-trips the 32-byte hash
  msg.push(writeCompactU16(instructions.length));
  for (const instr of instructions) {
    const programIdx = ordered.findIndex((k) => bytesEqual(k.pubkey, as32(instr.programId)));
    if (programIdx < 0) throw new SoltxError('bad_instructions', 'program id missing from key list');
    const parts = [Uint8Array.of(programIdx), ...instr.keys.map((k) => ordered.findIndex((o) => bytesEqual(o.pubkey, k.pubkey)))];
    if (parts.slice(1).some((i) => i < 0)) throw new SoltxError('bad_instructions', 'instruction key missing from key list');
    msg.push(Uint8Array.of(programIdx), writeCompactU16(instr.keys.length), Uint8Array.from(parts.slice(1)), writeCompactU16(instr.data.length), instr.data);
  }
  const message = Array.prototype.concat(...msg.map((p) => Array.from(p)));
  const messageBytes = Uint8Array.from(message);
  const wire = [writeCompactU16(numRequiredSignatures)];
  for (let i = 0; i < numRequiredSignatures; i++) wire.push(new Uint8Array(64));
  wire.push(messageBytes);
  const bytes = Uint8Array.from(wireFlat(wire));
  return { bytes, base64: Buffer.from(bytes).toString('base64'), staticKeysBase58: ordered.map((k) => base58.encode(k.pubkey)) };
}

function wireFlat(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) { out.set(p, pos); pos += p.length; }
  return out;
}

function u64leBytes(value) {
  const parts = [];
  u64le(value, parts);
  return parts[0];
}

function as32(v) {
  if (v instanceof Uint8Array) {
    if (v.length !== 32) throw new SoltxError('bad_pubkey', `expected a 32-byte pubkey, got ${v.length}`);
    return v;
  }
  const bytes = base58.decode(String(v));
  if (bytes.length !== 32) throw new SoltxError('bad_pubkey', `'${v}' is not a 32-byte base58 pubkey`);
  return bytes;
}
