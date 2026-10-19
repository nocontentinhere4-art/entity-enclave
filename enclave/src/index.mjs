// Sovereign entity — enclave service, phase 1.
// What it does today: generates its keys (sealed in TEE, dev otherwise), attests them, keeps a public hash-chained
// ledger, holds a Zcash light wallet (testnet by default), and exposes a read-only HTTP view. No brain yet.
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Ledger } from './ledger.mjs';
import { loadKeys } from './keys.mjs';
import { connectDstack, attest } from './attestation.mjs';
import { ZcashWallet } from './zcash.mjs';

const STATE = process.env.STATE_DIR ?? './state';
const PORT = Number(process.env.PORT ?? 8080);
const ARCHIVE_PUB = process.env.ARCHIVE_PUBKEY ?? ''; // x25519 hex: private ledger entries are encrypted at rest to this key
const ZCASH_SERVER = process.env.ZCASH_SERVER ?? 'https://testnet.zec.rocks:443';
const ZCASH_CHAIN = process.env.ZCASH_CHAIN ?? 'testnet';
const ZINGO = process.env.ZINGO_BIN ?? 'zingo-cli';
const TICK_MS = Number(process.env.TICK_MS ?? 15 * 60_000);

const dstack = await connectDstack();
const keys = await loadKeys({ dstack: dstack?.client, statePath: join(STATE, 'dev-seed.json') });
const ledger = new Ledger(join(STATE, 'ledger.jsonl'));
const attestation = await attest(dstack, keys);

if (ledger.seq === 0) {
  ledger.append('birth', { mode: keys.mode, signPublicKey: keys.signPublicKey, boxPublicKey: keys.boxPublicKey, attestation: { mode: attestation.mode, app: attestation.app, compose: attestation.compose } });
}

const wallet = new ZcashWallet({ bin: ZINGO, dataDir: join(STATE, 'zcash'), server: ZCASH_SERVER, chain: ZCASH_CHAIN, nymProxy: process.env.NYM_PROXY });
let address = null, balance = null, walletError = null;
try {
  address = await wallet.init();
  ledger.append('wallet', { chain: ZCASH_CHAIN, address, ufvk: await wallet.viewingKey(), birthday: await wallet.birthday() });
} catch (e) {
  walletError = e.message;
  ledger.append('wallet-error', { error: walletError.slice(0, 300) });
}

// ---- life loop (phase 1: only heartbeat + wallet sync; the brain arrives in phase 2) ----------------------------
async function tick() {
  const t0 = Date.now();
  try {
    let height = null;
    if (address) {
      try { height = await wallet.sync(); } catch (e) { ledger.append('sync-skipped', { reason: String(e.message).slice(0, 160) }); }
      balance = await wallet.balance();
    }
    ledger.append('tick', { height, zatoshis: balance?.total_zatoshis ?? null, ms: Date.now() - t0 });
  } catch (e) {
    ledger.append('tick-error', { error: String(e.message).slice(0, 300) });
  }
}
tick();
setInterval(tick, TICK_MS);

// Private entry: content encrypted at rest; only its existence, size and position in the chain are public.
export function writePrivate(type, text) {
  if (!ARCHIVE_PUB) return ledger.append(type + '-unencrypted', { note: 'no archive key configured', text });
  return ledger.appendPrivate(type, keys.sealPrivate(ARCHIVE_PUB, text));
}

// ---- read-only public view ------------------------------------------------------------------------------------
http.createServer((req, res) => {
  const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body, null, 1)); };
  if (req.url === '/') return json(200, { entity: 'unnamed (phase 1)', mode: keys.mode, keys: { sign: keys.signPublicKey, box: keys.boxPublicKey }, zcash: { chain: ZCASH_CHAIN, address, balance, error: walletError }, ledger: { entries: ledger.seq, head: ledger.head }, attestation: { mode: attestation.mode, app: attestation.app, compose: attestation.compose } });
  if (req.url === '/attestation') return json(200, attestation);
  if (req.url === '/ledger') { res.writeHead(200, { 'content-type': 'application/x-ndjson' }); return res.end(existsSync(join(STATE, 'ledger.jsonl')) ? readFileSync(join(STATE, 'ledger.jsonl')) : ''); }
  if (req.url === '/verify') return json(200, Ledger.verify(join(STATE, 'ledger.jsonl')));
  json(404, { error: 'not found' });
}).listen(PORT, () => console.log(`entity up on :${PORT} mode=${keys.mode} ledger=${ledger.seq} zcash=${address ?? walletError}`));
