// Boot-time death check: "dead stays dead". A ledger that already records a death entry is a finished
// entity — a reboot or redeploy must not resurrect it, re-derive a wallet over it, or append anything.
// This module scans the ledger once (tolerating torn lines from a crash mid-write) and serves the
// memorial view nothing else, so every other subsystem stays uninitialised.
import http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { Ledger } from './ledger.mjs';
import { sendBody, publicChannelView, ledgerBytes } from './http/public.mjs';

/** Scan an append-only ledger for a 'death' entry. Torn/unparsable lines are skipped, never fatal. */
export function deathState(ledgerPath) {
  // The LAST death entry is the one that counts: a ledger that lived through a testnet death and a mainnet
  // rebirth carries more than one, and the memorial must speak of the life that just ended.
  if (!existsSync(ledgerPath)) return { dead: false };
  let last = null;
  for (const line of readFileSync(ledgerPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; } // torn tail or crash-cut line: no evidence, move on
    if (e?.type === 'death') last = e;
  }
  return last ? { dead: true, entry: last } : { dead: false };
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
  return new Promise(() => {
    memorialServer({ ledgerPath, keys, attestation, death }).listen(port, () => console.log(`entity is dead; memorial only on :${port}`));
  });
}

/** The memorial HTTP server, not yet listening (tests bind it to a free port). */
export function memorialServer({ ledgerPath, keys, attestation, death }) {
  const entries = readEntries(ledgerPath);
  const deathEntry = entries.findLast((e) => e.type === 'death') ?? death?.entry ?? null;
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
  return http.createServer(async (req, res) => {
      // The memorial is read by the same browsers as the living face: same CORS, same gzip, same query handling.
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('access-control-allow-methods', 'GET, OPTIONS');
      res.setHeader('access-control-allow-headers', 'content-type');
      const query = new URL(req.url, 'http://x').searchParams;
      const url = (req.url.split('?')[0].replace(/\/{2,}/g, '/').replace(/(.)\/+$/, '$1')) || '/';
      const json = (code, body) => sendBody(req, res, code, { 'content-type': 'application/json' }, JSON.stringify(body, null, 1));
      try {
        if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
        if (req.method !== 'GET') return json(405, { error: 'method not allowed' });
        // The public views a dead entity still serves: the face, vitals (dead), the channel it left, raw ledger,
        // verification, attestation and the memorial. No wallet, no inference, no writes.
        if (url === '/') return json(200, homepage());
        if (url === '/vitals') return json(200, { state: 'dead', zatoshis: 0, hoursLeft: 0, diedAt, reason, wallet: { ok: false, fault: 'dead' }, brain: [], daysAlive: null, bornAt: entries.find((e) => e.type === 'birth')?.ts ?? null, sleepUntil: null });
        if (url === '/public-channel') return json(200, publicChannelView(entries, query));
        if (url === '/memorial') {
          return json(200, {
            diedAt,
            reason,
            lastWords: entries.findLast((e) => e.type === 'last_words')?.data?.text ?? '',
            memoryHash: deathEntry?.data?.memoryHash ?? null,
            lifeStats,
          });
        }
        if (url === '/attestation') return json(200, attestation);
        if (url === '/ledger') return sendBody(req, res, 200, { 'content-type': 'application/x-ndjson' }, ledgerBytes(ledgerPath, query));
        if (url === '/verify') return json(200, Ledger.verify(ledgerPath));
        json(404, { error: 'not found' });
      } catch (e) {
        json(500, { error: String(e?.message ?? e).slice(0, 300) });
      }
    });
}
