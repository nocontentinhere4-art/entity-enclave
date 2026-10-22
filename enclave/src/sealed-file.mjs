// AES-256-GCM sealed file primitive shared by MemoryStore and TradeStore.
//
// Behaviour (identical to the original MemoryStore implementation, now in one place):
//   - value → JSON → AES-256-GCM with a random 12-byte IV and a caller-supplied AAD;
//   - envelope: {"v":1,"alg":"AES-256-GCM","iv":"…","data":"…"} (WebCrypto appends the 16-byte tag);
//   - writes are atomic: write a 0600 temp file, fsync, rename in the same directory;
//   - `save` promotes the previous *readable* primary to `.bak` before replacing it, so a bad write never
//     destroys the last good version;
//   - `saveBoth` writes the same plaintext to primary and backup (used by TradeStore.forget, where the old
//     ciphertext in `.bak` still contains a secret and must be replaced, not merely superseded);
//   - `wipe` overwrites with random bytes and unlinks primary, backup and both temp files.
//
// A missing file is "fresh". A file that exists but cannot be decrypted (wrong key, torn write, tampered tag)
// reads as `null`; the caller decides whether that means corruption (MemoryStore throws `memory_corrupt`).
import { webcrypto } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

const FILE_VERSION = 1;

/** @param {Uint8Array|Buffer} value */
const asBytes = (value) => (value instanceof Uint8Array ? value : new Uint8Array(value));

export class SealedFile {
  /**
   * @param {object} opts
   * @param {string} opts.path            primary file
   * @param {Uint8Array} opts.key         32 raw bytes
   * @param {string|Uint8Array} opts.aad  domain separation string (e.g. 'sov-memory-v1')
   */
  constructor({ path, key, aad }) {
    if (typeof path !== 'string' || !path) throw new Error('SealedFile path is required');
    if (!(key instanceof Uint8Array) || key.length !== 32) throw new Error('SealedFile key must be a 32-byte Uint8Array');
    this.path = path;
    this.bakPath = `${path}.bak`;
    this.aad = typeof aad === 'string' ? new TextEncoder().encode(aad) : asBytes(aad);
    // Copy the key: the caller must not be able to mutate the material we imported.
    this.cryptoKey = webcrypto.subtle.importKey('raw', asBytes(key), 'AES-GCM', false, ['encrypt', 'decrypt']);
  }

  /** True when a primary or backup file exists (even if it is unreadable). */
  exists() {
    return existsSync(this.path) || existsSync(this.bakPath);
  }

  /**
   * Decrypt and parse one file. Returns `null` for missing, torn, wrong-key or tampered files.
   * @param {string} [file]
   * @returns {Promise<any|null>}
   */
  async read(file = this.path) {
    if (!existsSync(file)) return null;
    try {
      const box = JSON.parse(await readFile(file, 'utf8'));
      if (box.v !== FILE_VERSION || !box.iv || !box.data) return null;
      const plain = await webcrypto.subtle.decrypt(
        { name: 'AES-GCM', iv: Buffer.from(box.iv, 'base64'), additionalData: this.aad },
        await this.cryptoKey,
        Buffer.from(box.data, 'base64'),
      );
      return JSON.parse(new TextDecoder().decode(plain));
    } catch {
      return null; // wrong key, torn file, tampered tag: all mean "not usable"
    }
  }

  /**
   * Primary first, then backup. Never throws for unreadable content.
   * @returns {Promise<{value:any|null, source:'primary'|'backup'|null}>}
   */
  async load() {
    const primary = await this.read(this.path);
    if (primary !== null) return { value: primary, source: 'primary' };
    const backup = await this.read(this.bakPath);
    if (backup !== null) return { value: backup, source: 'backup' };
    return { value: null, source: null };
  }

  /**
   * Atomic save, keeping the previous readable version as `.bak`.
   * @param {any} value JSON-serialisable plaintext
   */
  async save(value) {
    const sealed = await this.#seal(value);
    // Only promote the current file to backup when it actually decrypts: never overwrite a good backup with a bad file.
    if (existsSync(this.path) && (await this.read(this.path)) !== null) {
      await this.#writeAtomic(this.bakPath, await readFile(this.path));
    }
    await this.#writeAtomic(this.path, sealed);
  }

  /**
   * Write the same plaintext to primary AND backup. Used when the old backup must stop containing a secret.
   * Both writes are atomic and fsynced; the backup is written first so a crash leaves the primary recoverable.
   * @param {any} value JSON-serialisable plaintext
   */
  async saveBoth(value) {
    const sealed = await this.#seal(value);
    await this.#writeAtomic(this.bakPath, sealed);
    await this.#writeAtomic(this.path, sealed);
  }

  /** Overwrite with random bytes before unlinking: deletion alone leaves old blocks recoverable. */
  async wipe() {
    for (const f of [this.path, this.bakPath, `${this.path}.tmp`, `${this.bakPath}.tmp`]) await this.#shred(f);
  }

  async #seal(value) {
    const iv = webcrypto.getRandomValues(new Uint8Array(12));
    const ct = await webcrypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: this.aad },
      await this.cryptoKey,
      new TextEncoder().encode(JSON.stringify(value)),
    );
    return JSON.stringify({
      v: FILE_VERSION,
      alg: 'AES-256-GCM',
      iv: Buffer.from(iv).toString('base64'),
      data: Buffer.from(ct).toString('base64'),
    });
  }

  async #writeAtomic(file, content) {
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
    const fh = await open(tmp, 'w', 0o600);
    try {
      await fh.write(bytes);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, file); // same directory, so the rename is atomic
  }

  async #shred(file) {
    try {
      const { size } = await stat(file);
      const fh = await open(file, 'r+');
      try {
        await fh.write(webcrypto.getRandomValues(new Uint8Array(Math.max(1, size))));
        await fh.sync();
      } finally {
        await fh.close();
      }
      await unlink(file);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
}
