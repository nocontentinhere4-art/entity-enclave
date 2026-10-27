// Death: the one-way exit. The will executes against the wallet, last words and the death certificate go on the
// public chain, memory is wiped so nothing private outlives the entity, and the wallet files are deleted because
// the on-chain body must die with it. Never returns to normal execution: the caller does process.exit(0).
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { digestError } from '../log.mjs';

export async function die({ ledger, memory, wallet, keys, reason, walletPaths = [] }) {
  // Accept both the MemoryStore (load()/wipe()) and a plain Memory object: the loop owns the former.
  const m = typeof memory?.load === 'function' ? await memory.load() : (memory ?? {});
  // An entity that has never lived must not die: birth is irreversible, and death requires it.
  if (!m?.bornAt) {
    const e = new Error('refusing to die: entity was never born');
    e.code = 'not_born';
    throw e;
  }
  ledger.append('last_words', { text: m?.will?.text ?? '', reason });
  // Best-effort bequests: a failing transfer is recorded, never blocks the ones after it.
  const outcomes = [];
  for (const t of (m?.will?.transfers ?? [])) {
    try {
      const r = await wallet.send(t.to, t.zats, t.memo ?? 'inheritance');
      outcomes.push({ to: t.to, zats: t.zats, ok: true, txid: r?.txid ?? r?.txids?.[0] ?? r?.opid ?? r?.raw ?? 'unknown' });
    } catch (e) {
      outcomes.push({ to: t.to, zats: t.zats, ok: false, ...digestError('bequest', e) });
    }
  }
  const memoryHash = createHash('sha256').update(JSON.stringify(m)).digest('hex');
  // Signed by the entity keys exactly once: no posthumous "death certificates" can be forged separately.
  ledger.append('death', { reason, memoryHash, sig: keys.sign(`death:${memoryHash}`), transfers: outcomes });
  await (typeof memory?.wipe === 'function' ? memory.wipe() : Promise.resolve());
  // Remove exactly the wallet directories the caller named: never guess a wallet layout.
  for (const p of (Array.isArray(walletPaths) ? walletPaths : [])) {
    if (p) rmSync(p, { recursive: true, force: true });
  }
}
