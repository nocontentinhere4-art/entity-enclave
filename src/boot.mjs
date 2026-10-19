// Boot-time death check: "dead stays dead". A ledger that already records a death entry is a finished
// entity — a reboot or redeploy must not resurrect it, re-derive a wallet over it, or append anything.
// This module scans the ledger once (tolerating torn lines from a crash mid-write) and serves the
// memorial view nothing else, so every other subsystem stays uninitialised.
import http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { Ledger } from './ledger.mjs';

/** Scan an append-only ledger for a 'death' entry. Torn/unparsable lines are skipped, never fatal. */
export function deathState(ledgerPath) {
  if (!existsSync(ledgerPath)) return { dead: false };
  for (const line of readFileSync(ledgerPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; } // torn tail or crash-cut line: no evidence, move on
    if (e?.type === 'death') return { dead: true, entry: e };
  }
  return { dead: false };
}

/** Ledger content through the same tolerant lens: entries only (torn lines skipped), in file order. */
function readEntries(ledgerPath) {
  if (!existsSync(ledgerPath)) return [];
  const out = [];
  for (const line of readFileSync(ledgerPath, 'utf8').split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* torn tail: ignore, same policy as the Ledger */ }
  }
  return out;
}

/**
 * Read-only memorial: the only page a dead entity serves. No wallet, no life loop, no ledger writes.
 * Never resolves: the process lives purely as this HTTP view.
 */
export function deadView({ port, ledgerPath, keys, attestation, death }) {
  const entries = readEntries(ledgerPath);
  const deathEntry = death?.entry ?? entries.findLast((e) => e.type === 'death');
  const ticks = entries.filter((e) => e.type === 'tick');
  // Charges are what the ticks paid to live: costZats on 'tick' entries (tick_llm repeats a subset).
  const lifeStats = {
    entries: entries.length,
    firstTs: entries[0]?.ts ?? null,
    lastTs: entries.at(-1)?.ts ?? null,
    ticks: ticks.length,
    charges: ticks.reduce((s, e) => s + (e.data?.costZats ?? 0), 0),
  };
  const name = entries.findLast((e) => e.type === 'identity')?.data?.name ?? null;
  const diedAt = deathEntry?.ts ?? null;
  const reason = deathEntry?.data?.reason ?? null;
  const homepage = () => ({
    state: 'dead',
    entity: name,
    mode: keys.mode,
    keys: { sign: keys.signPublicKey, box: keys.boxPublicKey },
    diedAt,
    reason,
    ledger: { entries: entries.length },
    attestation: { mode: attestation.mode, app: attestation.app, compose: attestation.compose },
  });
  return new Promise(() => {
    http.createServer(async (req, res) => {
      const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body, null, 1)); };
      try {
        // Only the five public views: the read-only face, raw ledger, verification, attestation and the memorial.
        if (req.method === 'GET' && req.url === '/') return json(200, homepage());
        if (req.method === 'GET' && req.url === '/memorial') {
          return json(200, {
            diedAt,
            reason,
            lastWords: entries.findLast((e) => e.type === 'last_words')?.data?.text ?? '',
            memoryHash: deathEntry?.data?.memoryHash ?? null,
            lifeStats,
          });
        }
        if (req.method === 'GET' && req.url === '/attestation') return json(200, attestation);
        if (req.method === 'GET' && req.url === '/ledger') { res.writeHead(200, { 'content-type': 'application/x-ndjson' }); return res.end(existsSync(ledgerPath) ? readFileSync(ledgerPath) : ''); }
        if (req.method === 'GET' && req.url === '/verify') return json(200, Ledger.verify(ledgerPath));
        json(404, { error: 'not found' });
      } catch (e) {
        json(500, { error: String(e?.message ?? e).slice(0, 300) });
      }
    }).listen(port, () => console.log(`entity is dead (died ${diedAt}); memorial only on :${port}`));
  });
}
