// Sovereign entity — enclave service, phase 2.
// This file is wiring only: config in, modules composed, read-only view out. No policy lives here.
import http from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from './config.mjs';
import { Ledger } from './ledger.mjs';
import { loadKeys } from './keys.mjs';
import { connectDstack, attest } from './attestation.mjs';
import { ZcashWallet } from './zcash.mjs';
import { FakeWallet } from './fake-wallet.mjs';
import { MemoryStore } from './memory/store.mjs';
import { Pricing } from './economy/pricing.mjs';
import { Rent } from './economy/rent.mjs';
import { die } from './economy/death.mjs';
import { paused } from './safety/pause.mjs';
import { digestError } from './log.mjs';
import { Promises } from './life/promises.mjs';
import { Inference } from './llm/infer.mjs';
import { Tools } from './tools/registry.mjs';
import { Life } from './life/loop.mjs';
import { deathState, deadView } from './boot.mjs';

import { entropyToMnemonic } from './bip39.mjs';

const STATE = config.stateDir;
const LEDGER_PATH = join(STATE, 'ledger.jsonl');
const DAY_MS = 86_400_000;

// The pause switch fails closed: a missing file means "do not act". Create the default one on first boot so a
// fresh entity is alive; the operator stops it by writing {paused:true} (corruption still pauses it).
if (config.pauseFile) {
  try {
    if (!existsSync(config.pauseFile)) {
      mkdirSync(dirname(config.pauseFile), { recursive: true });
      writeFileSync(config.pauseFile, JSON.stringify({ paused: false, since: new Date().toISOString() }));
    }
  } catch (e) { console.error('cannot create pause file:', e.message); }
}

// The charter is read once and never written: it is immutable for the life of the process.
const charter = existsSync(config.charterPath) ? readFileSync(config.charterPath, 'utf8') : '';

const dstack = await connectDstack();
// Fail closed: outside a TEE the service runs only when explicitly asked to (local development).
if (!dstack && !config.allowDev) {
  console.error('no TEE (dstack socket unavailable) and ALLOW_DEV is not set: refusing to start unattested');
  process.exit(3);
}
const keys = await loadKeys({ dstack: dstack?.client, statePath: join(STATE, 'dev-seed.json') });
const ledger = new Ledger(LEDGER_PATH);
const attestation = await attest(dstack, keys);

// Dead stays dead: a ledger that already records a death reboots into the memorial view only — no wallet,
// no life loop, nothing further is appended. deadView never resolves, so nothing below ever runs.
const death = deathState(LEDGER_PATH);
if (death.dead) await deadView({ port: config.port, ledgerPath: LEDGER_PATH, keys, attestation, death });

if (ledger.seq === 0) {
  ledger.append('birth', { mode: keys.mode, signPublicKey: keys.signPublicKey, boxPublicKey: keys.boxPublicKey, attestation: { mode: attestation.mode, app: attestation.app, compose: attestation.compose } });
}

// Memory is encrypted at rest under a subkey of the entity seed: the same identity survives a redeploy.
const memory = new MemoryStore({ path: join(STATE, 'memory.bin'), key: keys.deriveSubkey('memory') });

// Wallet: real zingo-cli (offline locally, online through the mixnet to sync/send), or an in-memory fake.
const wallet = config.fakeWallet
  ? new FakeWallet({ zats: config.fakeBalanceZats, dataDir: join(STATE, 'zcash') })
  : new ZcashWallet({ bin: config.zingoBin, dataDir: join(STATE, 'zcash'), server: config.zcashServer, chain: config.zcashChain, nymProxy: config.nymProxy, seedMnemonic: entropyToMnemonic(keys.deriveSubkey('zcash')), birthday: config.zcashBirthday });

// Directories to shred on death. The in-memory fake wallet leaves no files behind, so it passes none.
if (!config.fakeWallet) config.walletPaths = [join(STATE, 'zcash')];

let address = null, walletError = null;
try {
  address = await wallet.init(); // creates the wallet on first run, offline
  ledger.append('wallet', { chain: config.zcashChain, address, ufvk: await wallet.viewingKey(), birthday: await wallet.birthday() });
} catch (e) {
  walletError = e.message;
  ledger.append('wallet-error', digestError('wallet', e));
}

// Online sync can take a long time over the mixnet, so it runs in the background and never delays the service.
// It repeats forever: incoming ZEC (the birth gift, every later payment) is only visible after a sync. A sync that
// hits its timeout keeps the progress zingo saved, so the next round continues from there.
// The ledger records failures and height changes, not every quiet round.
async function syncWallet() {
  if (!address) return;
  let lastHeight = null;
  for (;;) {
    try {
      const h = await wallet.sync();
      const height = Number.isFinite(h) ? h : null;
      if (height !== lastHeight) { ledger.append('wallet-sync', { ok: true, height }); lastHeight = height; }
    } catch (e) { ledger.append('sync-skipped', digestError('sync', e)); }
    await new Promise((r) => setTimeout(r, Math.max(1, config.syncMinutes) * 60_000));
  }
}

const pricing = new Pricing({ ledger });
const rent = new Rent({ ledger, wallet, config });
const promises = new Promises({ ledger, memory });
const inference = new Inference({ config, ledger, pricing });
const tools = new Tools({ ledger, wallet, memory, pricing, keys, config, channels: { public: 'public' }, promises });

const life = new Life({ config, ledger, wallet, memory, pricing, rent, inference, tools, promises, charter, keys, die, paused });
life.start();
void syncWallet();

// ---- read-only public view ------------------------------------------------------------------------------------
const readLedger = () => {
  if (!existsSync(LEDGER_PATH)) return [];
  const out = [];
  for (const line of readFileSync(LEDGER_PATH, 'utf8').split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* torn tail: ignore, same policy as the Ledger */ }
  }
  return out;
};

http.createServer(async (req, res) => {
  const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body, null, 1)); };
  try {
    if (req.url === '/') {
      const m = await memory.load();
      return json(200, {
        entity: m.identity?.name || 'unnamed',
        mode: keys.mode,
        keys: { sign: keys.signPublicKey, box: keys.boxPublicKey },
        zcash: { chain: config.zcashChain, address, balance: life.lastBalance, error: walletError },
        ledger: { entries: ledger.seq, head: ledger.head },
        attestation: { mode: attestation.mode, app: attestation.app, compose: attestation.compose },
      });
    }
    if (req.url === '/attestation') return json(200, attestation);
    if (req.url === '/ledger') { res.writeHead(200, { 'content-type': 'application/x-ndjson' }); return res.end(existsSync(LEDGER_PATH) ? readFileSync(LEDGER_PATH) : ''); }
    if (req.url === '/verify') return json(200, Ledger.verify(LEDGER_PATH));
    // Who the entity is and what it plans, plus the last public events — never the private diary.
    if (req.url === '/memory-public') {
      const m = await memory.load();
      return json(200, {
        identity: m.identity,
        plan: m.plan,
        promises: promises.open(),
        events: readLedger().filter((e) => !e.private).slice(-10).map((e) => ({ seq: e.seq, ts: e.ts, type: e.type })),
      });
    }
    if (req.url === '/vitals') {
      // A wallet that cannot be read must not hide the rest of the vitals: report the failure kind instead of a 500.
      let bal = life.lastBalance ?? null, walletFault = walletError ? 'init' : null;
      if (bal === null && !walletFault) {
        try { bal = Number((await wallet.balance())?.total_zatoshis ?? 0); } catch (e) { walletFault = e.code ?? 'balance'; }
      }
      const m = await memory.load();
      return json(200, {
        state: m.bornAt ? 'alive' : 'unborn',
        zatoshis: bal,
        wallet: walletFault ? { fault: String(walletFault) } : { ok: true },
        hoursLeft: rent.hoursLeft(bal ?? 0),
        hunger: life.lastHunger,
        daysAlive: Math.round(((Date.now() - life.startedAt) / DAY_MS) * 100) / 100,
        bornAt: m.bornAt ?? null,
        sleepUntil: m.sleepUntil ?? null,
      });
    }
    if (req.url === '/public-channel') {
      return json(200, readLedger().filter((e) => e.type === 'post_public').map((e) => ({ seq: e.seq, ts: e.ts, channel: e.data?.channel, text: e.data?.text })));
    }
    json(404, { error: 'not found' });
  } catch (e) {
    json(500, { error: String(e.message).slice(0, 300), code: e.code ?? null });
  }
}).listen(config.port, () => console.log(`entity up on :${config.port} mode=${keys.mode} ledger=${ledger.seq} zcash=${address ?? walletError}`));
