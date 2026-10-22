// Address and codec primitives for the trade desk: base58 (Solana), mint validation, and Zcash shielded-address
// checks (Bech32/Bech32m). No dependency: the repo already hand-rolls bech32 for Nostr, and BigInt makes base58
// small enough to read.
//
// Zcash rules used here (plan §3.1 and §2.1):
//   - `u1…`  unified address   → Bech32m checksum (ZIP-316)
//   - `zs1…` Sapling address   → Bech32 checksum (BIP-173)
//   - `t…`   transparent       → valid Zcash, but NEVER accepted as an order return address: a memo can only
//                                travel with a shielded output, so a transparent return address would lose it.
import { createHash } from 'node:crypto';

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_MAP = new Map([...BASE58].map((c, i) => [c, i]));

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const CHARSET_MAP = new Map([...CHARSET].map((c, i) => [c, i]));
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

export const BECH32_CONST = 1;
export const BECH32M_CONST = 0x2bc830a3;

/** Encode bytes as base58 (Bitcoin/Solana alphabet). */
export function base58Encode(bytes) {
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (!input.length) return '';
  let zeros = 0;
  while (zeros < input.length && input[zeros] === 0) zeros++;
  let n = 0n;
  for (const b of input) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) {
    const rem = Number(n % 58n);
    n /= 58n;
    out = BASE58[rem] + out;
  }
  return '1'.repeat(zeros) + out;
}

/** Decode base58. Throws a coded error on an invalid character. */
export function base58Decode(text) {
  const s = String(text ?? '');
  if (!s) throw Object.assign(new Error('empty base58 string'), { code: 'base58_empty' });
  let zeros = 0;
  while (zeros < s.length && s[zeros] === '1') zeros++;
  let n = 0n;
  for (const c of s) {
    const v = BASE58_MAP.get(c);
    if (v === undefined) throw Object.assign(new Error('invalid base58 character'), { code: 'base58_invalid' });
    n = n * 58n + BigInt(v);
  }
  const out = [];
  while (n > 0n) {
    out.push(Number(n & 0xffn));
    n >>= 8n;
  }
  out.reverse();
  return Uint8Array.from([...new Array(zeros).fill(0), ...out]);
}

/** A Solana mint is a 32-byte public key encoded in base58 (32–44 chars). */
export function isValidMint(value) {
  const s = String(value ?? '');
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return false;
  try {
    return base58Decode(s).length === 32;
  } catch {
    return false;
  }
}

/** True when the string looks like a Solana public key (same 32-byte check as a mint). */
export function isValidSolanaAddress(value) {
  return isValidMint(value);
}

function polymod(values) {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i];
  }
  return chk >>> 0;
}

function hrpExpand(hrp) {
  const out = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >>> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}

function toWords(bytes) {
  const out = [];
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out.push((acc >>> bits) & 31);
    }
  }
  if (bits > 0) out.push((acc << (5 - bits)) & 31);
  return out;
}

/**
 * Encode bytes with a Bech32/Bech32m checksum.
 * @param {string} hrp
 * @param {Uint8Array|Buffer} bytes
 * @param {number} [constant=BECH32M_CONST]
 */
export function bech32Encode(hrp, bytes, constant = BECH32M_CONST) {
  const words = toWords(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  const pm = polymod([...hrpExpand(hrp), ...words, 0, 0, 0, 0, 0, 0]) ^ constant;
  const checksum = [];
  for (let i = 0; i < 6; i++) checksum.push((pm >>> (5 * (5 - i))) & 31);
  return `${hrp}1${[...words, ...checksum].map((w) => CHARSET[w]).join('')}`;
}

/**
 * Decode and verify a Bech32/Bech32m string.
 * @param {string} address
 * @returns {{hrp:string, words:number[], constant:number}}
 * @throws {Error & {code:string}}
 */
export function bech32Decode(address) {
  const raw = String(address ?? '');
  if (!raw) throw Object.assign(new Error('empty bech32 string'), { code: 'bech32_empty' });
  if (raw.length > 1023) throw Object.assign(new Error('bech32 string too long'), { code: 'bech32_length' });
  if (raw !== raw.toLowerCase() && raw !== raw.toUpperCase()) {
    throw Object.assign(new Error('mixed-case bech32 string'), { code: 'bech32_mixed_case' });
  }
  const s = raw.toLowerCase();
  const pos = s.lastIndexOf('1');
  if (pos < 1 || pos + 7 > s.length) throw Object.assign(new Error('bad bech32 separator'), { code: 'bech32_separator' });
  const hrp = s.slice(0, pos);
  const words = [];
  for (const c of s.slice(pos + 1)) {
    const v = CHARSET_MAP.get(c);
    if (v === undefined) throw Object.assign(new Error('invalid bech32 character'), { code: 'bech32_char' });
    words.push(v);
  }
  const constant = polymod([...hrpExpand(hrp), ...words]);
  if (constant !== BECH32_CONST && constant !== BECH32M_CONST) {
    throw Object.assign(new Error('bad bech32 checksum'), { code: 'bech32_checksum' });
  }
  return { hrp, words: words.slice(0, -6), constant };
}

/**
 * Classify a Zcash address string without trusting it.
 * @param {string} address
 * @returns {'unified'|'sapling'|'transparent'|'unknown'}
 */
export function addressKind(address) {
  const s = String(address ?? '');
  if (/^u1[0-9a-z]+$/.test(s.toLowerCase())) return 'unified';
  if (/^zs1[0-9a-z]+$/.test(s.toLowerCase())) return 'sapling';
  // Mainnet t1/t3, testnet tm/t2 and their long forms. A memo cannot ride with any of them.
  if (/^t[0-9a-zA-Z]{20,}$/.test(s)) return 'transparent';
  return 'unknown';
}

/**
 * Validate a Zcash address and, for shielded kinds, its checksum and variant.
 * @param {string} address
 * @returns {{ok:boolean, kind:'unified'|'sapling'|'transparent'|'unknown', code?:string}}
 */
export function validateZcashAddress(address) {
  const kind = addressKind(address);
  if (kind === 'unknown') return { ok: false, kind, code: 'address_unknown' };
  if (kind === 'transparent') return { ok: true, kind };

  let decoded;
  try {
    decoded = bech32Decode(address);
  } catch (e) {
    return { ok: false, kind, code: e.code ?? 'bech32_invalid' };
  }
  if (kind === 'unified') {
    if (decoded.hrp !== 'u') return { ok: false, kind, code: 'address_hrp' };
    if (decoded.constant !== BECH32M_CONST) return { ok: false, kind, code: 'address_not_bech32m' };
    // A unified address carries at least a typecode, a length and receiver data. Reject trivial payloads.
    if (decoded.words.length < 16) return { ok: false, kind, code: 'address_too_short' };
  } else {
    if (decoded.hrp !== 'zs') return { ok: false, kind, code: 'address_hrp' };
    if (decoded.constant !== BECH32_CONST) return { ok: false, kind, code: 'address_not_bech32' };
    // Sapling addresses encode 43 bytes → 69 data words.
    if (decoded.words.length < 60) return { ok: false, kind, code: 'address_too_short' };
  }
  return { ok: true, kind };
}

/** True only for a checksum-valid u1/zs1 address. */
export function isShieldedAddress(address) {
  const v = validateZcashAddress(address);
  return v.ok && (v.kind === 'unified' || v.kind === 'sapling');
}

/**
 * Return-address policy for buy memos: shielded, checksum-valid, not transparent.
 * @param {string} address
 * @returns {{ok:boolean, kind:string, code?:string}}
 */
export function validateReturnAddress(address) {
  const v = validateZcashAddress(address);
  if (!v.ok) return v;
  if (v.kind === 'transparent') return { ok: false, kind: v.kind, code: 'return_transparent' };
  if (v.kind !== 'unified' && v.kind !== 'sapling') return { ok: false, kind: v.kind, code: 'return_unknown' };
  return v;
}

/**
 * The preflight that prevents the most likely total loss (plan §2.1): a ZEC memo can only travel with a
 * shielded output, so a transparent 1Click deposit address plus a non-empty memo must abort before sending.
 *
 * @param {string} depositAddress
 * @param {string|null|undefined} memo
 * @returns {{ok:boolean, code?:string}}
 */
export function zcashDepositPreflight(depositAddress, memo) {
  const s = String(depositAddress ?? '');
  if (!s) return { ok: false, code: 'deposit_address_missing' };
  const hasMemo = String(memo ?? '').length > 0;
  const kind = addressKind(s);
  if (kind === 'transparent') {
    return hasMemo ? { ok: false, code: 'transparent_with_memo' } : { ok: true };
  }
  if (kind === 'unified' || kind === 'sapling') {
    const v = validateZcashAddress(s);
    if (!v.ok) return { ok: false, code: v.code ?? 'deposit_checksum' };
    return { ok: true };
  }
  return { ok: false, code: 'deposit_address_unknown' };
}

/** Short, non-reversible fingerprint for tests/logs. Never use it as an address. */
export function addressFingerprint(address) {
  return createHash('sha256').update(String(address ?? ''), 'utf8').digest('hex').slice(0, 12);
}
