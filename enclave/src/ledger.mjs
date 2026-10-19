// Append-only public ledger: every event is a JSON line chained by SHA-256 to the previous one.
// Anyone can recompute the chain; the entity cannot rewrite its past. Private entries are stored encrypted
// at rest but still chained, so their existence and order are public even when their content is not.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class Ledger {
  constructor(path) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
    this.head = this.#lastHash();
    this.seq = this.#count();
  }

  /** Public event. `data` must be JSON-serialisable and is stored in clear. */
  append(type, data) {
    return this.#write({ type, data });
  }

  /** Private event: `ciphertext` (base64) only; the public sees type, time, size and the chain. */
  appendPrivate(type, ciphertext) {
    return this.#write({ type, private: true, size: ciphertext.length, ciphertext });
  }

  #write(entry) {
    const e = { seq: ++this.seq, ts: new Date().toISOString(), prev: this.head, ...entry };
    const body = JSON.stringify(e);
    e.hash = createHash('sha256').update(body).digest('hex');
    appendFileSync(this.path, JSON.stringify(e) + '\n');
    this.head = e.hash;
    return e;
  }

  #lastHash() {
    if (!existsSync(this.path)) return '0'.repeat(64);
    const lines = readFileSync(this.path, 'utf8').trim().split('\n').filter(Boolean);
    return lines.length ? JSON.parse(lines.at(-1)).hash : '0'.repeat(64);
  }

  #count() {
    return existsSync(this.path) ? readFileSync(this.path, 'utf8').trim().split('\n').filter(Boolean).length : 0;
  }

  /** Verify the whole chain from disk. Returns { ok, entries, brokenAt }. */
  static verify(path) {
    if (!existsSync(path)) return { ok: true, entries: 0 };
    let prev = '0'.repeat(64);
    const lines = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      const e = JSON.parse(lines[i]);
      const { hash, ...rest } = e;
      const recomputed = createHash('sha256').update(JSON.stringify(rest)).digest('hex');
      if (hash !== recomputed || e.prev !== prev) return { ok: false, entries: lines.length, brokenAt: i + 1 };
      prev = hash;
    }
    return { ok: true, entries: lines.length, head: prev };
  }
}
