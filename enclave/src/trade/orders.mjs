// Memo grammar, deterministic order identifiers, redaction, and the pure safety gates (plan §3.1, §9).
//
// This module is pure: no I/O, no clock, no network. The engine calls it, and the tests drive it directly.
// It fails closed. An unknown keyword is an error, never a guess; a transparent return address is an error,
// never a warning.
import { createHash } from 'node:crypto';
import { isShieldedAddress, isValidMint, validateReturnAddress } from './address.mjs';
import { EXPOSED_STATES, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from './types.mjs';

const sha256hex = (s) => createHash('sha256').update(String(s), 'utf8').digest('hex');

/** Error with a stable code and, when it could be extracted, the client address for a refund. */
export class TradeMemoError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {string|null} [returnAddress]
   */
  constructor(code, message, returnAddress = null) {
    super(message);
    this.name = 'TradeMemoError';
    this.code = code;
    this.returnAddress = returnAddress;
  }
}

/** @param {unknown} text */
export function firstMemoLine(text) {
  return String(text ?? '').split(/\r?\n/, 1)[0].replace(/\s+/g, ' ').trim();
}

/** `+25%`, `25%` and `25` all mean 25. Returns null when the token is not a number. */
function parsePct(raw) {
  const m = String(raw ?? '').trim().match(/^([+-]?)(\d+(?:\.\d+)?)%?$/);
  if (!m) return null;
  const n = Number(`${m[1] === '-' ? '-' : ''}${m[2]}`);
  return Number.isFinite(n) ? n : null;
}

/**
 * Best-effort extraction of a usable return address, for refunding a memo that did not fully parse.
 * Only a checksum-valid shielded address is returned: sending to a typo would burn the money.
 * @param {string} text
 * @returns {string|null}
 */
export function extractReturnAddress(text) {
  const line = firstMemoLine(text);
  const m = line.match(/(?:^|\s)return\s+(\S+)/i);
  if (!m) return null;
  const candidate = m[1];
  return isShieldedAddress(candidate) ? candidate : null;
}

/**
 * Parse the first memo line.
 *
 * `buy <mint-or-$TICKER> [target +X%] [stop -Y%] return <u1…|zs1…>`
 * `sell <orderId> [key <auth6>]`
 *
 * @param {string} text raw memo (only the first line is considered)
 * @returns {import('./types.mjs').MemoBuy|import('./types.mjs').MemoSell|null} null when this is an ordinary letter
 * @throws {TradeMemoError}
 */
export function parseMemo(text) {
  const line = firstMemoLine(text);
  if (!line) return null;
  const words = line.split(' ');
  const head = words[0].toLowerCase();
  if (head !== 'buy' && head !== 'sell') return null;
  const returnAddress = extractReturnAddress(line);
  try {
    if (head === 'buy') return parseBuy(words, returnAddress);
    return parseSell(words);
  } catch (e) {
    if (e instanceof TradeMemoError && e.returnAddress === null && returnAddress) e.returnAddress = returnAddress;
    throw e;
  }
}

function parseBuy(words, returnAddress) {
  if (words.length < 2) throw new TradeMemoError('memo_syntax', 'buy needs a mint or ticker', returnAddress);
  const rawAsset = words[1];
  if (/^(target|stop|return|key)$/i.test(rawAsset)) {
    throw new TradeMemoError('memo_syntax', 'buy needs a mint or ticker first', returnAddress);
  }
  const asset = rawAsset.startsWith('$') ? rawAsset.slice(1) : rawAsset;
  if (!asset) throw new TradeMemoError('memo_syntax', 'empty ticker', returnAddress);
  const mint = isValidMint(asset) ? asset : null;
  if (!mint && !/^[A-Za-z0-9._-]{1,20}$/.test(asset)) {
    throw new TradeMemoError('memo_ticker', 'invalid ticker or mint', returnAddress);
  }

  let targetPct = null;
  let stopPct = null;
  let sawReturn = false;
  let sawTarget = false;
  let sawStop = false;

  for (let i = 2; i < words.length; i++) {
    const key = words[i].toLowerCase();
    if (key === 'target') {
      if (sawTarget) throw new TradeMemoError('memo_duplicate', 'target given twice', returnAddress);
      sawTarget = true;
      const value = parsePct(words[++i]);
      if (value === null) throw new TradeMemoError('memo_target_value', 'target needs a percentage', returnAddress);
      if (!(value > 0 && value <= 1000)) throw new TradeMemoError('memo_target_range', 'target must be >0 and ≤1000', returnAddress);
      targetPct = value;
    } else if (key === 'stop') {
      if (sawStop) throw new TradeMemoError('memo_duplicate', 'stop given twice', returnAddress);
      sawStop = true;
      const value = parsePct(words[++i]);
      if (value === null) throw new TradeMemoError('memo_stop_value', 'stop needs a percentage', returnAddress);
      const magnitude = Math.abs(value);
      if (!(magnitude > 0 && magnitude <= 90)) throw new TradeMemoError('memo_stop_range', 'stop must be >0 and ≤90', returnAddress);
      stopPct = magnitude;
    } else if (key === 'return') {
      if (sawReturn) throw new TradeMemoError('memo_duplicate', 'return given twice', returnAddress);
      sawReturn = true;
      const address = words[++i];
      if (!address) throw new TradeMemoError('memo_return_required', 'return needs an address', returnAddress);
      const check = validateReturnAddress(address);
      if (!check.ok) throw new TradeMemoError(check.code === 'return_transparent' ? 'memo_return_transparent' : 'memo_return_invalid', 'return must be a shielded u1/zs1 address', returnAddress);
    } else {
      throw new TradeMemoError('memo_unknown_keyword', 'unknown keyword in buy memo', returnAddress);
    }
  }

  if (!sawReturn) throw new TradeMemoError('memo_return_required', 'buy memo needs `return <u1…|zs1…>`', returnAddress);
  return {
    kind: 'buy',
    mintOrTicker: mint ?? asset,
    mint,
    targetPct,
    stopPct,
    returnAddress: firstMemoLine(returnAddressToken(words)),
  };
}

function returnAddressToken(words) {
  const i = words.findIndex((w) => w.toLowerCase() === 'return');
  return words[i + 1] ?? '';
}

function parseSell(words) {
  if (words.length < 2) throw new TradeMemoError('memo_syntax', 'sell needs an orderId');
  const orderId = words[1].toLowerCase();
  if (!/^o[0-9a-f]{16}$/.test(orderId)) throw new TradeMemoError('memo_order_id', 'invalid orderId');
  let auth6 = null;
  for (let i = 2; i < words.length; i++) {
    const key = words[i].toLowerCase();
    if (key !== 'key') throw new TradeMemoError('memo_unknown_keyword', 'unknown keyword in sell memo');
    if (auth6 !== null) throw new TradeMemoError('memo_duplicate', 'key given twice');
    const value = String(words[++i] ?? '').toLowerCase();
    if (!/^[0-9a-f]{6}$/.test(value)) throw new TradeMemoError('memo_auth', 'key must be 6 hex characters');
    auth6 = value;
  }
  return { kind: 'sell', orderId, auth6 };
}

// ---- identifiers (plan §3.1) ---------------------------------------------------------------------------------

/** @param {string} txid @param {string} returnAddress */
export function deriveOrderId(txid, returnAddress) {
  return `o${sha256hex(`trade|${txid}|${returnAddress}`).slice(0, 16)}`;
}

/** @param {string} returnAddress */
export function deriveAuth6(returnAddress) {
  return sha256hex(`auth|${returnAddress}`).slice(0, 6);
}

/** The only client-derived value that may appear in the public ledger. */
export function deriveClientRef(returnAddress) {
  return sha256hex(`client|${returnAddress}`).slice(0, 16);
}

/**
 * Remove the client address before the memo reaches the LLM context (plan §0, §3.1).
 * Everything from `return` to the end of the memo becomes `<redacted>`.
 * @param {string} text
 */
export function redactMemo(text) {
  return String(text ?? '').replace(/\breturn\b[\s\S]*$/i, 'return <redacted>');
}

// ---- pure limits (plan §7.3.2, §9) ---------------------------------------------------------------------------

/**
 * Funding and exposure checks, all in code.
 *
 * @param {object} input
 * @param {number} input.zats                 order size
 * @param {import('./types.mjs').TradeConfig} input.limits
 * @param {import('./types.mjs').Order[]} [input.orders]  every persisted order
 * @param {string} [input.clientRef]
 * @param {number} [input.balance]            current ZEC balance (zats)
 * @param {number} [input.reservedZats]       sum of in-flight/held swapZats; computed from orders when omitted
 * @param {number} [input.unsettledCharges=0] rent already owed but not yet paid
 * @param {number} [input.rentZatsPerHour=0]
 * @returns {{ok:true}|{ok:false, code:string, reason:string}}
 */
export function checkOrderLimits({
  zats,
  limits,
  orders = [],
  clientRef = '',
  balance = 0,
  reservedZats,
  unsettledCharges = 0,
  rentZatsPerHour = 0,
}) {
  const minZats = Number(limits.minZats ?? 10_000_000);
  const maxZats = Number(limits.maxZats ?? 1_000_000_000);
  const maxOpen = Number(limits.maxOpen ?? 5);
  const maxOpenZats = Number(limits.maxOpenZats ?? 2_000_000_000);
  const maxPerClient = Number(limits.maxPerClient ?? 1);
  const rentReserveHours = Number(limits.rentReserveHours ?? 24);

  if (!Number.isFinite(zats) || zats < minZats) return { ok: false, code: 'below_min', reason: `below ${minZats} zats` };
  if (zats > maxZats) return { ok: false, code: 'above_max', reason: `above ${maxZats} zats` };

  const exposed = (Array.isArray(orders) ? orders : []).filter((o) => o && EXPOSED_STATES.includes(o.state));
  if (exposed.length >= maxOpen) return { ok: false, code: 'max_open', reason: `${maxOpen} orders already open` };

  const reserved = Number.isFinite(reservedZats)
    ? Number(reservedZats)
    : exposed.reduce((sum, o) => sum + (Number(o.swapZats ?? o.zatsIn) || 0), 0);
  if (reserved + zats > maxOpenZats) {
    return { ok: false, code: 'max_exposure', reason: `exposure above ${maxOpenZats} zats` };
  }

  if (clientRef && maxPerClient > 0) {
    const mine = exposed.filter((o) => o.clientRef === clientRef).length;
    if (mine >= maxPerClient) return { ok: false, code: 'client_limit', reason: 'client already has an open order' };
  }

  const reserve = rentReserveHours * rentZatsPerHour;
  const left = Number(balance) - reserved - Number(unsettledCharges) - zats;
  if (left < reserve) {
    return { ok: false, code: 'rent_reserve', reason: `would leave ${left} zats, reserve is ${reserve}` };
  }
  return { ok: true };
}

/** Open-leg fee: kept in ZEC, never bridged. */
export function splitOpenFee(zats, feeBps) {
  const bps = clampFeeBps(feeBps);
  const feeOpenZats = Math.floor((Number(zats) * bps) / 10_000);
  return { feeOpenZats, swapZats: Number(zats) - feeOpenZats };
}

/** Close-leg fee: SOL lamports to the entity treasury. */
export function closeFeeLamports(solOut, feeBps) {
  return Math.floor((Number(solOut) * clampFeeBps(feeBps)) / 10_000);
}

export function clampFeeBps(feeBps) {
  const n = Number(feeBps);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 300) : 100;
}

/** Slippage is clamped, never trusted from config. */
export function clampSlippageBps(bps) {
  const n = Number(bps);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 300) : 100;
}

// ---- token screening (plan §2.2a, §9) ------------------------------------------------------------------------

/**
 * Enforce the token gate on a *resolved* token (W2's jupiter.resolveToken returns the raw API object).
 * All conditions are mandatory; anything missing fails closed.
 *
 * @param {import('./types.mjs').JupiterToken|null} token
 * @param {{minLiquidityUsd?:number, allowToken2022?:boolean}} [limits]
 * @returns {{ok:true}|{ok:false, code:string, reason:string}}
 */
export function screenToken(token, limits = {}) {
  const minLiquidityUsd = Number(limits.minLiquidityUsd ?? 50_000);
  if (!token) return { ok: false, code: 'token_not_found', reason: 'token not resolved' };
  if (!isValidMint(token.id)) return { ok: false, code: 'token_mint_invalid', reason: 'mint does not decode to 32 bytes' };
  if (token.isVerified !== true) return { ok: false, code: 'token_unverified', reason: 'token is not verified' };
  const liquidity = Number(token.liquidity);
  if (!Number.isFinite(liquidity) || liquidity < minLiquidityUsd) {
    return { ok: false, code: 'token_illiquid', reason: `liquidity below ${minLiquidityUsd} USD` };
  }
  const decimals = Number(token.decimals);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    return { ok: false, code: 'token_decimals', reason: 'invalid decimals' };
  }
  const audit = token.audit ?? {};
  if (audit.mintAuthorityDisabled !== true) return { ok: false, code: 'token_mint_authority', reason: 'mint authority is live' };
  if (audit.freezeAuthorityDisabled !== true) return { ok: false, code: 'token_freeze_authority', reason: 'freeze authority is live' };
  const top = Number(audit.topHoldersPercentage);
  if (!Number.isFinite(top) || top > 50) return { ok: false, code: 'token_concentrated', reason: 'top holders above 50%' };
  if (audit.isSus === true) return { ok: false, code: 'token_suspicious', reason: 'token flagged suspicious' };

  const program = token.tokenProgram ?? TOKEN_PROGRAM_ID;
  if (program === TOKEN_2022_PROGRAM_ID && !limits.allowToken2022) {
    return { ok: false, code: 'token_2022', reason: 'Token-2022 is disabled' };
  }
  if (program !== TOKEN_PROGRAM_ID && program !== TOKEN_2022_PROGRAM_ID) {
    return { ok: false, code: 'token_program', reason: 'unknown token program' };
  }
  return { ok: true };
}
