// Solana JSON-RPC client for the disposable trade wallets. Injectable fetch (tests mock every call),
// bounded retries with doubling backoff for transient failures (network, 429, 5xx), strict shape
// validation everywhere — money paths fail closed rather than silently returning something plausible.
// Amounts cross the boundary as BigInt lamports; the rest is strings (no float ever touches lamports).

import { fetchJsonRetries } from './chains-http.mjs';

const RANK = { processed: 0, confirmed: 1, finalized: 2 };

/**
 * Solana RPC client.
 * @param {{
 *   url: string,                       // SOLANA_RPC_URL (a dedicated RPC — the public one rate-limits hard)
 *   fetchImpl?: typeof fetch,          // tests inject a mock
 *   commitment?: 'processed'|'confirmed'|'finalized',   // SOLANA_COMMITMENT, default confirmed
 *   timeoutMs?: number, retries?: number, backoffMs?: number,
 *   sleep?: (ms: number) => Promise<void>,
 * }} opts
 */
export class Solana {
  #url; #fetch; #commitment; #timeoutMs; #retries; #backoffMs; #sleep;

  constructor({ url, fetchImpl = fetch, commitment = 'confirmed', timeoutMs = 10_000, retries = 3, backoffMs = 250, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
    if (!url) throw new Error('Solana client needs a url (SOLANA_RPC_URL)');
    this.#url = url.replace(/\/+$/, '');
    this.#fetch = fetchImpl;
    this.#commitment = commitment;
    this.#timeoutMs = timeoutMs;
    this.#retries = retries;
    this.#backoffMs = backoffMs;
    this.#sleep = sleep;
  }

  get commitment() { return this.#commitment; }

  /**
   * Raw JSON-RPC. Throws on transport exhaustion or on non-null `error` payloads, retrying only
   * transient failures. `result: null` is a legitimate answer for many methods (e.g. unavailable tx).
   * @param {string} method
   * @param {Array} params
   */
  async rpc(method, params) {
    const res = await fetchJsonRetries({
      fetchImpl: this.#fetch,
      url: this.#url,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: { jsonrpc: '2.0', id: 1, method, params },
      timeoutMs: this.#timeoutMs,
      retries: this.#retries,
      backoffMs: this.#backoffMs,
      sleep: this.#sleep,
      label: `solana ${method}`,
    });
    const body = res?.json;
    if (!body || body.jsonrpc !== '2.0' || !('result' in body) && !('error' in body)) {
      throw new ShapeError(`solana ${method}: not a JSON-RPC response`, 'unexpected_rpc_shape');
    }
    if (body.error) {
      const e = new Error(`solana ${method}: ${body.error.message ?? JSON.stringify(body.error)}`);
      e.code = 'rpc_error';
      e.rpcCode = body.error.code;
      e.rpcData = body.error.data;
      throw e;
    }
    return body.result;
  }

  /**
   * Balance in lamports for a base58 pubkey (0 for an empty/absent account — that is a real on-chain fact).
   * @param {string} pubkey
   * @returns {Promise<BigInt>}
   */
  async balance(pubkey) {
    const result = await this.rpc('getBalance', [pubkey, { commitment: this.#commitment }]);
    const value = result?.value ?? result;
    if (!(typeof value === 'number' || typeof value === 'string')) throw new ShapeError('getBalance returned no integer value', 'unexpected_rpc_shape');
    return BigInt(typeof value === 'number' ? Math.trunc(value) : value);
  }

  /**
   * Latest (fee-payer-ready) blockhash for transaction building.
   * @param {{ commitment?: string }} [opts]
   * @returns {Promise<{ blockhash: string, lastValidBlockHeight: number }>}
   */
  async latestBlockhash({ commitment } = {}) {
    const r = await this.rpc('getLatestBlockhash', [{ commitment: commitment ?? this.#commitment }]);
    const v = r?.value ?? r;
    if (!v || typeof v.blockhash !== 'string' || !Number.isInteger(v.lastValidBlockHeight)) {
      throw new ShapeError('getLatestBlockhash returned an unexpected shape', 'unexpected_rpc_shape');
    }
    return { blockhash: v.blockhash, lastValidBlockHeight: v.lastValidBlockHeight };
  }

  /**
   * SPL token accounts of `owner` decoded as JSON (the parsed info carries the raw amount string).
   * Returns up to one entry per matching account; the caller decides which one is the ATA.
   * @param {string} owner
   * @param {string} mint
   * @returns {Promise<Array<{ address: string, amount: BigInt, decimals: number, state: string }>>}
   */
  async tokenAccounts(owner, mint) {
    const r = await this.rpc('getTokenAccountsByOwner', [
      owner,
      { mint },
      { commitment: this.#commitment, encoding: 'jsonParsed' },
    ]);
    const list = r?.value ?? [];
    if (!Array.isArray(list)) throw new ShapeError('getTokenAccountsByOwner returned no value array', 'unexpected_rpc_shape');
    return list.map((item) => {
      const info = item?.account?.data?.parsed?.info;
      const amount = info?.tokenAmount?.amount;
      if (!info || typeof amount !== 'string' || !/^\d+$/.test(amount)) {
        throw new ShapeError('token account carries no parsed tokenAmount.amount string', 'unexpected_rpc_shape');
      }
      return { address: item.pubkey, amount: BigInt(amount), decimals: info.tokenAmount.decimals, state: info.state };
    });
  }

  /**
   * Submit a base64 transaction; returns the signature. `skipPreflight` is deliberate: the trade wallets
   * fund nothing critical into flight without our own confirm() — a preflight that would reject on a
   * stale blockhash blocks one-lane retries, while the retry budget lives here instead.
   * @param {string} base64Tx
   * @param {{ skipPreflight?: boolean }} [opts]
   * @returns {Promise<string>} signature (base58)
   */
  async send(base64Tx, { skipPreflight = true } = {}) {
    const r = await this.rpc('sendTransaction', [base64Tx, { encoding: 'base64', skipPreflight }]);
    if (typeof r !== 'string' || r.length < 32) throw new ShapeError('sendTransaction returned no signature string', 'unexpected_rpc_shape');
    return r;
  }

  /**
   * Await a signature's confirmation at a commitment level by short-interval polling of
   * getSignatureStatuses. Timeouts do NOT throw — the caller decides what an unconfirmed send means
   * (the close pipeline checks `confirmed:false` itself). RPC-level and tx-level failures surface
   * as `err:{…}` in the result rather than local errors.
   *
   * @param {string} signature
   * @param {{
   *   commitment?: 'processed'|'confirmed'|'finalized',
   *   timeoutMs?: number, pollMs?: number,
   * }} [opts]
   * @returns {Promise<{ confirmed: boolean, timedOut?: boolean, err?: Object, slot?: number, confirmationStatus?: string }>}
   */
  async confirm(signature, { commitment, timeoutMs = 45_000, pollMs = 1_500 } = {}) {
    const need = RANK[commitment ?? this.#commitment] ?? RANK.confirmed;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const r = await this.rpc('getSignatureStatuses', [[signature], { searchTransactionHistory: false }]);
      const status = r?.value?.[0] ?? null;
      if (status) {
        if (status.err) return { confirmed: false, err: status.err, confirmationStatus: status.confirmationStatus, slot: status.slot };
        const have = RANK[status.confirmationStatus] ?? -1;
        if (have >= need) return { confirmed: true, err: null, confirmationStatus: status.confirmationStatus, slot: status.slot };
      }
      if (Date.now() >= deadline) {
        return { confirmed: false, timedOut: true, err: null, confirmationStatus: status?.confirmationStatus ?? null };
      }
      await this.#sleep(pollMs);
    }
  }
}

class ShapeError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}
