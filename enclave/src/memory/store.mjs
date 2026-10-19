// Persistent memory, encrypted at rest with AES-256-GCM (WebCrypto). Writes are atomic (tmp + rename) and the
// previous valid version is kept as `.bak`, so a crash mid-write or a torn file never costs the entity its past.
import { webcrypto } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const AAD = new TextEncoder().encode('sov-memory-v1');
const FILE_VERSION = 1;
const MAX_EVENTS = 50;

export function emptyMemory() {
  return {
    identity: { name: '', voice: '', image: '' },
    plan: '',
    personalRules: [],
    promises: [],
    will: { text: '', transfers: [] },
    relationships: {},
    events: [],
    daily: [],
  };
}

/** Fill missing fields, cap the event log, and keep unknown keys (e.g. `sleepUntil` set by tools). */
function normalize(m = {}) {
  const d = emptyMemory();
  return {
    ...m,
    identity: { ...d.identity, ...(m.identity ?? {}) },
    plan: typeof m.plan === 'string' ? m.plan : '',
    personalRules: Array.isArray(m.personalRules) ? m.personalRules : [],
    promises: Array.isArray(m.promises) ? m.promises : [],
    will: { text: m.will?.text ?? '', transfers: Array.isArray(m.will?.transfers) ? m.will.transfers : [] },
    relationships: m.relationships && typeof m.relationships === 'object' ? m.relationships : {},
    events: Array.isArray(m.events) ? m.events.slice(-MAX_EVENTS) : [],
    daily: Array.isArray(m.daily) ? m.daily : [],
  };
}

export class MemoryStore {
  constructor({ path, key }) {
    if (!(key instanceof Uint8Array) || key.length !== 32) throw new Error('MemoryStore key must be a 32-byte Uint8Array');
    this.path = path;
    this.bakPath = `${path}.bak`;
    // Copy the key: the caller must not be able to mutate the material we imported.
    this.cryptoKey = webcrypto.subtle.importKey('raw', new Uint8Array(key), 'AES-GCM', false, ['encrypt', 'decrypt']);
  }

  async load() {
    const primary = await this.#tryRead(this.path);
    if (primary) return primary;
    const backup = await this.#tryRead(this.bakPath);
    if (backup) return backup;
    // No file at all is a fresh entity; an unreadable one is corruption and must not be silently replaced.
    if (existsSync(this.path) || existsSync(this.bakPath)) {
      const e = new Error('memory file and backup are unreadable');
      e.code = 'memory_corrupt';
      throw e;
    }
    return emptyMemory();
  }

  async save(memory) {
    const plain = JSON.stringify(normalize(memory));
    const sealed = await this.#seal(plain);
    // Only promote the current file to backup when it actually decrypts: never overwrite a good backup with a bad file.
    if (existsSync(this.path) && (await this.#tryRead(this.path))) {
      await this.#writeAtomic(this.bakPath, await readFile(this.path));
    }
    await this.#writeAtomic(this.path, sealed);
  }

  async appendEvent(e) {
    const m = await this.load();
    m.events.push({ ts: e.ts ?? new Date().toISOString(), type: String(e.type ?? 'event'), summary: String(e.summary ?? '') });
    m.events = m.events.slice(-MAX_EVENTS);
    await this.save(m);
    return m.events.at(-1);
  }

  /** Overwrite with random bytes before unlinking: deletion alone leaves old blocks recoverable. */
  async wipe() {
    for (const f of [this.path, this.bakPath, `${this.path}.tmp`, `${this.bakPath}.tmp`]) await this.#shred(f);
  }

  async #seal(plaintext) {
    const iv = webcrypto.getRandomValues(new Uint8Array(12));
    const ct = await webcrypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: AAD },
      await this.cryptoKey,
      new TextEncoder().encode(plaintext),
    );
    return JSON.stringify({
      v: FILE_VERSION,
      alg: 'AES-256-GCM',
      iv: Buffer.from(iv).toString('base64'),
      data: Buffer.from(ct).toString('base64'), // WebCrypto appends the 16-byte tag to the ciphertext
    });
  }

  async #tryRead(file) {
    if (!existsSync(file)) return null;
    try {
      const box = JSON.parse(await readFile(file, 'utf8'));
      if (box.v !== FILE_VERSION || !box.iv || !box.data) return null;
      const plain = await webcrypto.subtle.decrypt(
        { name: 'AES-GCM', iv: Buffer.from(box.iv, 'base64'), additionalData: AAD },
        await this.cryptoKey,
        Buffer.from(box.data, 'base64'),
      );
      return normalize(JSON.parse(new TextDecoder().decode(plain)));
    } catch {
      return null; // wrong key, torn file, tampered tag: all mean "not usable"
    }
  }

  async #writeAtomic(file, content) {
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, content, { mode: 0o600 });
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
