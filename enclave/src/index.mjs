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
let syncState = { ok: null, height: null, at: null };
async function syncWallet() {
  for (;;) {
    try {
      // Wallet creation needs the network (first scan); if boot had none, keep trying here.
      if (!address) {
        address = await wallet.init();
        walletError = null;
        ledger.append('wallet', { chain: config.zcashChain, address, ufvk: await wallet.viewingKey(), birthday: await wallet.birthday() });
      }
      const h = await wallet.sync();
      const height = Number.isFinite(h) ? h : null;
      // The ledger records transitions (first success, recovery after a failure); the height lives in /vitals.
      if (syncState.ok !== true) ledger.append('wallet-sync', { ok: true, height });
      syncState = { ok: true, height, at: new Date().toISOString() };
    } catch (e) {
      ledger.append('sync-skipped', digestError('sync', e));
      syncState = { ...syncState, ok: false, at: new Date().toISOString() };
    }
    await new Promise((r) => setTimeout(r, Math.max(1, config.syncMinutes) * 60_000));
  }
}

// Brain check at boot: one 1-token completion per provider, paid by the founder's bootstrap credit (not the treasury).
// Public proof that the entity has a working brain before anyone gifts it a life. Keys never leave this process.
const providersPublic = (config.providers ?? []).map((p) => ({ name: p.name, model: p.model, speed: p.speed ?? 'any', keyConfigured: Boolean(p.apiKey) }));
async function probeProviders() {
  if (config.fakeLlm) return;
  for (const p of config.providers ?? []) {
    let status = 'no_key', ok = false;
    if (p.apiKey) {
      try {
        const base = String(p.baseUrl ?? '').replace(/\/+$/, '');
        const res = await fetch(`${base}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${p.apiKey}` },
          body: JSON.stringify({ model: p.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
          signal: AbortSignal.timeout(30_000),
        });
        status = res.status; ok = res.ok;
      } catch (e) { status = e?.name === 'TimeoutError' ? 'timeout' : 'unreachable'; }
    }
    ledger.append('llm_probe', { provider: p.name, model: p.model, keyConfigured: Boolean(p.apiKey), ok, status });
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
void probeProviders();

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

// Public channel, write side: anyone may post (no accounts, no privilege, same door for everyone, us included).
// Abuse limits only: size caps, one message per source per minute, a global hourly cap. Messages are public ledger
// entries; the entity sees the latest ones in its context and decides whether to answer (post_public) or not.
const HUMAN_MSG = { maxText: 500, maxAuthor: 40, perSourceMs: 60_000, globalPerHour: 120 };
const lastBySource = new Map(); let globalWindow = { start: Date.now(), n: 0 };
function acceptHumanMessage(source, body) {
  const text = String(body?.text ?? '').trim(), author = String(body?.author ?? '').trim().slice(0, HUMAN_MSG.maxAuthor);
  if (!text) return { code: 400, error: 'text required' };
  if (text.length > HUMAN_MSG.maxText) return { code: 413, error: `text over ${HUMAN_MSG.maxText} chars` };
  const now = Date.now();
  if (now - globalWindow.start > 3_600_000) globalWindow = { start: now, n: 0 };
  if (globalWindow.n >= HUMAN_MSG.globalPerHour) return { code: 429, error: 'channel busy, try later' };
  if (now - (lastBySource.get(source) ?? 0) < HUMAN_MSG.perSourceMs) return { code: 429, error: 'one message per minute' };
  lastBySource.set(source, now); globalWindow.n++;
  if (lastBySource.size > 10_000) lastBySource.clear();
  return { code: 201, entry: ledger.append('human_message', { author: author || 'anonymous', text }) };
}
const readBody = (req, max = 4096) => new Promise((resolve, reject) => {
  let buf = ''; req.on('data', (d) => { buf += d; if (buf.length > max) { reject(Object.assign(new Error('body too large'), { code: 413 })); req.destroy(); } });
  req.on('end', () => resolve(buf)); req.on('error', reject);
});

http.createServer(async (req, res) => {
  // Everything served here is public; a browser UI on any origin may read it and post to the channel.
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
  const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body, null, 1)); };
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    if (req.method === 'POST' && req.url === '/public-channel') {
      let body; try { body = JSON.parse(await readBody(req) || '{}'); } catch (e) { return json(e.code === 413 ? 413 : 400, { error: e.code === 413 ? 'body too large' : 'invalid json' }); }
      const source = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '?').split(',')[0].trim();
      const r = acceptHumanMessage(source, body);
      return r.entry ? json(201, { seq: r.entry.seq, ts: r.entry.ts }) : json(r.code, { error: r.error });
    }
    if (req.method !== 'GET') return json(405, { error: 'method not allowed' });
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
        wallet: walletFault ? { fault: String(walletFault) } : { ok: true, sync: syncState },
        brain: providersPublic,
        hoursLeft: rent.hoursLeft(bal ?? 0),
        hunger: life.lastHunger,
        daysAlive: Math.round(((Date.now() - life.startedAt) / DAY_MS) * 100) / 100,
        bornAt: m.bornAt ?? null,
        sleepUntil: m.sleepUntil ?? null,
      });
    }
    if (req.url === '/public-channel') {
      // Both directions, in ledger order: the entity's posts and the humans' messages.
      return json(200, readLedger().filter((e) => e.type === 'post_public' || e.type === 'human_message').slice(-200).map((e) => (
        e.type === 'post_public'
          ? { seq: e.seq, ts: e.ts, from: 'entity', text: e.data?.text }
          : { seq: e.seq, ts: e.ts, from: 'human', author: e.data?.author, text: e.data?.text }
      )));
    }
    json(404, { error: 'not found' });
  } catch (e) {
    json(500, { error: String(e.message).slice(0, 300), code: e.code ?? null });
  }
}).listen(config.port, () => console.log(`entity up on :${config.port} mode=${keys.mode} ledger=${ledger.seq} zcash=${address ?? walletError}`));
