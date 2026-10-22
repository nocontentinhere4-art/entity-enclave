// Entity Solana treasury — the persistent fee destination of the trade desks (plan §3, §7.4, §14.3).
//
// The treasury key is DETERMINISTIC: `keys.deriveSubkey('sol-treasury')` from src/keys.mjs, so it is
// reproducible across redeploys of the same enclave image and unknowable outside — it is never
// configured, never logged, and never derived from a per-order wallet. Close-leg fees land in SOL on this
// address (not ZEC) so receipts are auditable on-chain and no second bridge is needed to collect them.
//
// Pure module: no I/O, no state, no network. The engine orchestrates the Solana client (send/confirm);
// here lives only the key, the fee math, the ledger receipt shape, and the sweep-instruction builders.

import { keypairFromSeed, systemTransferInstruction, buildLegacyTransaction } from './soltx.mjs';

/** Subkey label passed to keys.deriveSubkey (plan §3: deriveSubkey('sol-treasury')). */
export const TREASURY_SUBKEY = 'sol-treasury';
/** Default fee basis points per leg — 1%, clamped to 300 (plan §6.4/§11). */
export const DEFAULT_FEE_BPS = 100;
const MAX_FEE_BPS = 300;

/** Typed treasury failure with a short `.code`; prose stays console-side (never in the ledger). */
export class TreasuryError extends Error {
  /**
   * @param {string} code    e.g. 'bad_fee_bps', 'bad_receipt', 'bad_rate'
   * @param {string} message human context
   */
  constructor(code, message) { super(message); this.code = code; }
}

function clampFeeBps(feeBps) {
  const n = Math.trunc(Number(feeBps ?? DEFAULT_FEE_BPS));
  if (!Number.isFinite(n) || n < 0) throw new TreasuryError('bad_fee_bps', `feeBps must be a non-negative integer: '${feeBps}'`);
  return Math.min(n, MAX_FEE_BPS);
}

function toBigInt(v, name) {
  try { return BigInt(v); } catch { throw new TreasuryError('bad_amount', `${name} must be an integer: '${v}'`); }
}

/**
 * The entity's Solana treasury keypair, deterministically derived from `deriveSubkey('sol-treasury')`.
 * Same label → same key on redeploy of the same image.
 * @param {{ deriveSubkey: (label: string) => Uint8Array }} keys  the src/keys.mjs key handle
 * @returns {{ secretKey: Uint8Array, publicKey: Uint8Array, publicKeyBase58: string }}
 */
export function treasuryKeypair(keys) {
  if (!keys || typeof keys.deriveSubkey !== 'function') {
    throw new TreasuryError('bad_keys', 'treasury: keys must expose deriveSubkey(label)');
  }
  return keypairFromSeed(keys.deriveSubkey(TREASURY_SUBKEY));
}

/** The treasury's base58 Solana address — fee + ATA-rent destination of every close leg. */
export function treasuryAddress(keys) {
  return treasuryKeypair(keys).publicKeyBase58;
}

/**
 * Open-leg fee in zats: floor(zatsIn × feeBps / 10000). It never leaves the entity's ZEC wallet — the
 * open leg swaps `zatsIn − feeOpen` and keeps the rest (plan §1).
 * @param {{ zatsIn: number|string|bigint, feeBps?: number }} p
 * @returns {bigint}
 */
export function feeOpenZats({ zatsIn, feeBps = DEFAULT_FEE_BPS }) {
  const z = toBigInt(zatsIn, 'zatsIn');
  if (z < 0n) throw new TreasuryError('bad_zats', 'zatsIn must be ≥ 0');
  return (z * BigInt(clampFeeBps(feeBps))) / 10000n;
}

/**
 * Close-leg fee in SOL lamports: floor(solOut × feeBps / 10000), transferred on-chain to the treasury.
 * @param {{ solOut: number|string|bigint, feeBps?: number }} p
 * @returns {bigint}
 */
export function feeCloseLamports({ solOut, feeBps = DEFAULT_FEE_BPS }) {
  const s = toBigInt(solOut, 'solOut');
  if (s < 0n) throw new TreasuryError('bad_sol', 'solOut must be ≥ 0');
  return (s * BigInt(clampFeeBps(feeBps))) / 10000n;
}

/**
 * ZEC equivalent of the close fee, at the close-leg bridge rate (plan §1/§7.4: the fee is recorded as its
 * ZEC equivalent from the close quote rate). rate = amountOutZats per amountInLamports.
 * @param {{ solOut: number|string|bigint, feeBps?: number,
 *           amountInLamports: number|string|bigint, amountOutZats: number|string|bigint }} p
 * @returns {bigint}
 */
export function feeCloseZats({ solOut, feeBps = DEFAULT_FEE_BPS, amountInLamports, amountOutZats }) {
  const lamports = feeCloseLamports({ solOut, feeBps });
  const inL = toBigInt(amountInLamports, 'amountInLamports');
  const outZ = toBigInt(amountOutZats, 'amountOutZats');
  if (inL <= 0n) throw new TreasuryError('bad_rate', 'close quote rate needs amountInLamports > 0');
  if (outZ < 0n) throw new TreasuryError('bad_rate', 'amountOutZats must be ≥ 0');
  return (lamports * outZ) / inL;
}

/**
 * The `data` payload of a ledger `fee` entry (plan §5). Open legs carry `{orderId, zats, leg}`; close legs
 * also carry the SOL lamports actually moved to the treasury (`sol`, a string — matches the ledger JSON).
 * @param {{ orderId: string, leg: 'open'|'close', sol?: number|string|bigint, zats?: number|string|bigint }} p
 * @returns {{ orderId: string, leg: 'open'|'close', zats: number, sol?: string }}
 */
export function feeReceipt({ orderId, leg, sol = null, zats = 0 }) {
  if (typeof orderId !== 'string' || !orderId) throw new TreasuryError('bad_receipt', 'feeReceipt needs a non-empty orderId');
  if (leg !== 'open' && leg !== 'close') throw new TreasuryError('bad_receipt', 'leg must be open|close');
  const data = { orderId, zats: Number(toBigInt(zats, 'zats')), leg };
  if (leg === 'close') data.sol = String(toBigInt(sol ?? 0, 'sol'));
  return data;
}

/**
 * A SystemProgram transfer instruction from an order wallet to the treasury (the close-leg fee move).
 * @param {{ from: string|Uint8Array, to: string|Uint8Array, lamports: number|bigint }} p
 * @returns {ReturnType<typeof systemTransferInstruction>}
 */
export function sweepInstruction({ from, to, lamports }) {
  return systemTransferInstruction({ from, to, lamports });
}

/**
 * A complete legacy transfer transaction sweeping `lamports` from an order wallet (fee payer, slot 0) to
 * `to`. Callers sign with soltx.signTransaction and submit through the Solana client.
 * @param {{ feePayer: string|Uint8Array, to: string|Uint8Array, lamports: number|bigint,
 *           recentBlockhash: string }} p
 * @returns {ReturnType<typeof buildLegacyTransaction>}
 */
export function buildSweepTransaction({ feePayer, to, lamports, recentBlockhash }) {
  return buildLegacyTransaction({
    feePayer,
    recentBlockhash,
    instructions: [sweepInstruction({ from: feePayer, to, lamports })],
  });
}
