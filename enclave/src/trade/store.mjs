// The trade store: one AES-256-GCM sealed document, atomic writes, `.bak`, secret wipe, and a crash journal.
//
// Design notes that matter operationally:
//   - The key is `keys.deriveSubkey('trade-store')`; it is never configured or written anywhere.
//   - The whole document is rewritten on every save. A crash therefore either leaves the new version or the
//     previous one, never a half-merged order.
//   - `forget(orderId)` is stronger than "save without the secret": the previous ciphertext in `.bak` still
//     encrypts the old key material, so the secret-free plaintext is written to BOTH files (`saveBoth`).
//   - `journal` records an external-side-effect intent (e.g. "about to send ZEC") before the action. The engine
//     still treats the order state as the source of truth; the journal is the auditable bridge across a crash.
import { existsSync } from 'node:fs';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { SealedFile } from '../sealed-file.mjs';
import { TRADE_STORE_AAD } from './types.mjs';

const MAX_JOURNAL = 200;

/** Fresh store document. */
export function emptyTradeState() {
  return { v: 1, updatedAt: null, orders: {}, journal: [] };
}

/** Keep the document shape stable without touching order contents. */
function normalize(state) {
  const base = state && typeof state === 'object' ? state : {};
  return {
    ...base,
    v: 1,
    updatedAt: typeof base.updatedAt === 'string' ? base.updatedAt : null,
    orders: base.orders && typeof base.orders === 'object' && !Array.isArray(base.orders) ? base.orders : {},
    journal: Array.isArray(base.journal) ? base.journal.slice(-MAX_JOURNAL) : [],
  };
}

/** Convenience for wiring: the one true key derivation for this store. */
export function tradeStoreKey(keys) {
  return keys.deriveSubkey('trade-store');
}

export class TradeStore {
  /**
   * @param {object} opts
   * @param {string} opts.path   e.g. state/trades.bin
   * @param {Uint8Array} opts.key 32 bytes, `keys.deriveSubkey('trade-store')`
   * @param {() => number} [opts.now] epoch-ms clock, injectable for tests
   */
  constructor({ path, key, now } = {}) {
    this.path = path;
    this.bakPath = `${path}.bak`;
    this.lockPath = `${path}.lock`;
    this.file = new SealedFile({ path, key, aad: TRADE_STORE_AAD });
    this.now = now ?? (() => Date.now());
  }

  /** @returns {Promise<import('./types.mjs').TradeState>} */
  async load() {
    const { value } = await this.file.load();
    if (value !== null) return normalize(value);
    // No file at all is a fresh entity. An unreadable file is corruption: never silently replace it.
    if (this.file.exists()) {
      const e = new Error('trade store and backup are unreadable');
      e.code = 'trade_corrupt';
      throw e;
    }
    return emptyTradeState();
  }

  /** @param {import('./types.mjs').TradeState} state */
  async save(state) {
    await this.file.save({ ...normalize(state), updatedAt: new Date(this.now()).toISOString() });
  }

  /**
   * Remove an order's secret from primary AND backup. The order record itself (and its public history) stays.
   * @param {string} orderId
   * @returns {Promise<import('./types.mjs').Order|null>}
   */
  async forget(orderId) {
    const state = await this.load();
    const order = state.orders?.[orderId];
    if (!order) return null;
    order.secret = null;
    order.secretWipedAt = new Date(this.now()).toISOString();
    // Both writes are atomic; the plaintext written to `.bak` no longer contains the key material.
    await this.file.saveBoth({ ...normalize(state), updatedAt: new Date(this.now()).toISOString() });
    return order;
  }

  /**
   * Append a crash-journal entry. Callers persist the intent BEFORE the external action and record the result
   * afterwards. Entries are capped; the journal is inside the sealed document.
   * @param {{id?:string, op:string, orderId?:string, [k:string]:unknown}} entry
   */
  async journal(entry) {
    const state = await this.load();
    const e = { at: new Date(this.now()).toISOString(), ...entry };
    state.journal = [...state.journal, e].slice(-MAX_JOURNAL);
    await this.save(state);
    return e;
  }

  /** Drop a resolved journal intent by its `id`. */
  async clearJournal(id) {
    if (!id) return;
    const state = await this.load();
    const next = state.journal.filter((e) => e.id !== id);
    if (next.length === state.journal.length) return;
    state.journal = next;
    await this.save(state);
  }

  /**
   * A pid lock is defense in depth against two processes sharing one state volume; the engine is single-process.
   * Stale locks (dead pid) are replaced.
   */
  async acquireLock() {
    if (existsSync(this.lockPath)) {
      let pid = 0;
      try {
        pid = Number(JSON.parse(await readFile(this.lockPath, 'utf8')).pid) || 0;
      } catch {
        pid = 0;
      }
      if (pid && pid !== process.pid) {
        try {
          process.kill(pid, 0); // alive?
          const e = new Error(`trade store is locked by pid ${pid}`);
          e.code = 'trade_lock';
          throw e;
        } catch (e) {
          if (e.code === 'trade_lock') throw e;
          // ESRCH: the owner is gone, the lock is stale.
        }
      }
    }
    await writeFile(this.lockPath, JSON.stringify({ pid: process.pid, at: new Date(this.now()).toISOString() }), { mode: 0o600 });
  }

  async releaseLock() {
    try {
      const box = JSON.parse(await readFile(this.lockPath, 'utf8'));
      if (Number(box.pid) === process.pid) await unlink(this.lockPath);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }

  /** Shred primary, backup and temps. Used by death and by tests. */
  async wipe() {
    await this.file.wipe();
    try {
      await unlink(this.lockPath);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
}
