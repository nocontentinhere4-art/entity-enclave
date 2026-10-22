// Persistent memory, encrypted at rest with AES-256-GCM (see src/sealed-file.mjs for the file primitive).
// Writes are atomic (tmp + rename) and the previous valid version is kept as `.bak`, so a crash mid-write or a
// torn file never costs the entity its past.
import { existsSync } from 'node:fs';
import { SealedFile } from '../sealed-file.mjs';

const AAD = 'sov-memory-v1';
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
    this.path = path;
    this.bakPath = `${path}.bak`;
    this.file = new SealedFile({ path, key, aad: AAD });
  }

  async load() {
    const primary = await this.file.read(this.path);
    if (primary !== null) return normalize(primary);
    const backup = await this.file.read(this.bakPath);
    if (backup !== null) return normalize(backup);
    // No file at all is a fresh entity; an unreadable one is corruption and must not be silently replaced.
    if (existsSync(this.path) || existsSync(this.bakPath)) {
      const e = new Error('memory file and backup are unreadable');
      e.code = 'memory_corrupt';
      throw e;
    }
    return emptyMemory();
  }

  async save(memory) {
    await this.file.save(normalize(memory));
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
    await this.file.wipe();
  }
}
