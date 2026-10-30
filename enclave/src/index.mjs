// Sovereign entity — enclave service, phase 2.
// This file is wiring only: config in, modules composed, read-only view out. No policy lives here.
import http from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from './config.mjs';
import { Ledger } from './ledger.mjs';
import { transferTime } from './inbox.mjs';
import { loadKeys } from './keys.mjs';
import { connectDstack, attest } from './attestation.mjs';
import { ZcashWallet } from './zcash.mjs';
import { FakeWallet } from './fake-wallet.mjs';
import { MemoryStore } from './memory/store.mjs';
import { Pages } from './pages/store.mjs';
import { pagesView, pageResponse } from './pages/http.mjs';
import { Pricing } from './economy/pricing.mjs';
import { Rent } from './economy/rent.mjs';
import { die } from './economy/death.mjs';
import { paused } from './safety/pause.mjs';
import { digestError } from './log.mjs';
import { Promises } from './life/promises.mjs';
import { Orders, ordersView, PAYWALL_MEMO_FORMAT } from './orders/book.mjs';
import { Inference } from './llm/infer.mjs';
import { Tools } from './tools/registry.mjs';
import { Life } from './life/loop.mjs';
import { Replier } from './life/reply.mjs';
import { Jobs } from './life/jobs.mjs';
import { Market } from './economy/market.mjs';
import { Forecasts } from './economy/forecasts.mjs';
import { serveForecasts } from './http/forecasts.mjs';
import { sendBody, publicChannelView, ledgerBytes } from './http/public.mjs';
import { deathState, deadView } from './boot.mjs';
import { redactMemo } from './trade/orders.mjs';
import { tradesHttp } from './trade/http.mjs';

import { entropyToMnemonic } from './bip39.mjs';
import { nostrIdentity } from './nostr.mjs';

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

// The entity's public site. Content is plain files under the state dir; the ledger holds only slug/bytes/hash/
// version, so a page can be verified byte-for-byte. Pages survive a death (not in walletPaths) by design.
const pages = new Pages({
  dir: config.pagesDir ?? join(STATE, 'pages'),
  ledger,
  config,
  entity: async () => (await memory.load())?.identity?.name ?? 'unnamed',
});
config.pages = () => pages;

// Paid order fulfilment: a letter whose memo matches an active paywall item becomes an order with a public
// deadline. The ledger records only ids, amounts and times; the private request text lives in memory.
// Boot recovery: a delivery post that lost its order_delivered entry to a crash is closed here.
const orders = new Orders({ ledger, memory, config });
try { await orders.reconcile(); } catch (e) { ledger.append('order_error', digestError('order reconcile', e)); }

// Wallet: real zingo-cli (offline locally, online through the mixnet to sync/send), or an in-memory fake.
const wallet = config.fakeWallet
  ? new FakeWallet({ zats: config.fakeBalanceZats, dataDir: join(STATE, 'zcash') })
  : new ZcashWallet({ bin: config.zingoBin, dataDir: join(STATE, config.zcashChain === 'mainnet' ? 'zcash-mainnet' : 'zcash'), server: config.zcashServer, chain: config.zcashChain, nymProxy: config.nymProxy, seedMnemonic: entropyToMnemonic(keys.deriveSubkey('zcash')), birthday: config.zcashBirthday });

// Directories to shred on death. The in-memory fake wallet leaves no files behind, so it passes none.
if (!config.fakeWallet) config.walletPaths = [join(STATE, config.zcashChain === 'mainnet' ? 'zcash-mainnet' : 'zcash')];

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

// Letters: incoming shielded payments that carry a memo. The words are for the entity alone (and the archive);
// the public ledger records only that a paid letter arrived. Seen txids persist in memory so a restart does not re-read.
const inbox = [];
async function readLetters() {
  if (typeof wallet.valueTransfers !== 'function') return;
  const mem = await memory.load();
  const seen = new Set(mem.seenTxids ?? []);
  let changed = false;
  // Inheritance: the wallet seed is sealed to the enclave, so a wallet regrown on a fresh disk sees the whole
  // history of its address. Transfers received before this life began are the estate of the previous life, not
  // mail: counted once as `inherited`, marked seen, never answered, never traded.
  if (!mem.lifeStartedAt) { mem.lifeStartedAt = new Date().toISOString(); changed = true; }
  const lifeStart = Date.parse(mem.lifeStartedAt);
  const inherited = { transfers: 0, zats: 0 };
  for (const t of await wallet.valueTransfers()) {
    if (t.kind !== 'received' || t.status !== 'confirmed' || seen.has(t.txid)) continue;
    const at = transferTime(t.datetime);
    if (at !== null && at < lifeStart) { seen.add(t.txid); changed = true; inherited.transfers++; inherited.zats += Number(t.value) || 0; continue; }
    if (!t.memos?.length) continue;
    seen.add(t.txid); changed = true;
    const text = t.memos.join('\n---\n').slice(0, 2000);
    const letterEntry = ledger.append('letter', { zats: t.value, bytes: Buffer.byteLength(text, 'utf8'), txid: t.txid });
    if (config.archivePub) ledger.appendPrivate('letter_text', keys.sealPrivate(config.archivePub, JSON.stringify({ txid: t.txid, zats: t.value, text })));
    // The letter may be a paid order (memo matching a paywall item): matching happens where letters land,
    // and `buy `/`sell ` memos are left to the trade engine. The memo itself stays out of the public ledger.
    let order = null;
    try { const r = await orders.onLetter({ seq: letterEntry.seq, txid: t.txid, zats: t.value, text, at: t.datetime }); order = r?.order ?? null; }
    catch (e) { ledger.append('order_error', digestError('order onLetter', e)); }
    // A `buy `/`sell ` memo is a trade order; anything else is ignored by the engine. Ingestion never blocks:
    // it parses, applies the pure limits and persists (or refunds), then the scheduler does the rest.
    if (trades) {
      try { await trades.ingest({ txid: t.txid, zats: t.value, text, at: t.datetime }); }
      catch (e) { ledger.append('trade_error', digestError('trade ingest', e)); }
    }
    inbox.push({ at: t.datetime, zats: t.value, text, orderId: order?.id ?? null });
    if (inbox.length > 20) inbox.shift();
    // A paid letter is answered instantly too (fuller, marked paid) — outside the normal loop. Trade orders
    // (`buy …` / `sell …`) are NOT letters to answer: their memo carries the client's return address.
    if (!/^\s*(buy|sell)\b/i.test(text)) replier.enqueue({ seq: letterEntry.seq, author: null, text, paid: true });
  }
  if (inherited.transfers) ledger.append('inherited', { ...inherited, note: 'received before this life began: the estate of the previous life, not mail' });
  if (changed) { mem.seenTxids = [...seen].slice(-500); await memory.save(mem); }
}
config.letters = () => inbox.slice(-10).map((l) => ({ ...l, text: redactMemo(l.text) }));
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
      await readLetters();
    } catch (e) {
      ledger.append('sync-skipped', digestError('sync', e));
      syncState = { ...syncState, ok: false, at: new Date().toISOString() };
    }
    // While trading, a faster ZEC sync keeps incoming order letters from waiting a full window.
    const syncMinutes = trades ? Math.min(config.syncMinutes, config.trade.syncMinutes ?? config.syncMinutes) : config.syncMinutes;
    await new Promise((r) => setTimeout(r, Math.max(1, syncMinutes) * 60_000));
  }
}

// Brain check at boot: one 1-token completion per provider, paid by the founder's bootstrap credit (not the treasury).
// Public proof that the entity has a working brain before anyone gifts it a life. Keys never leave this process.
const hostOf = (u) => { try { return new URL(u).hostname; } catch { return null; } };
// `tee: false` in a provider entry declares a brain that runs outside a TEE (a rented GPU): shown, never hidden.
const providersPublic = (config.providers ?? []).map((p) => ({ name: p.name, model: p.model, speed: p.speed ?? 'any', keyConfigured: Boolean(p.apiKey), host: hostOf(p.baseUrl), tee: p.tee !== false, feel: p.feel === true }));
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

const pricing = new Pricing({ ledger, scale: config.priceScale });
// Market prices (same 1Click rail as swap_quote), forecasts with an automatic settlement track record,
// and the scheduled jobs that settle expired forecasts after rent is paid.
const market = new Market({ fetchImpl: fetch, now: Date.now, baseUrl: config.oneClickBaseUrl, ttlMs: config.marketPriceTtlSeconds * 1000, maxStaleMs: config.marketMaxStaleSeconds * 1000 });
const forecasts = new Forecasts({ ledger, market, config, now: Date.now });
const jobs = new Jobs({ forecasts, config, ledger, now: Date.now });
const rent = new Rent({ ledger, wallet, config, pricing });
const promises = new Promises({ ledger, memory });
const inference = new Inference({ config, ledger, pricing });

// Trading (capability T): the ONE-TRADE WALLETS engine. Opt-in and fail-closed — TRADE_ENABLED=1 plus a Solana
// RPC and an archive key are all required; without them the desk stays off and none of this is constructed, so
// the default boot (TRADE_ENABLED=0) is byte-for-byte unchanged.
let trades = null;
if (config.trade.enabled && config.trade.rpcUrl && config.archivePub) {
  try {
    const { TradeStore, tradeStoreKey } = await import('./trade/store.mjs');
    const { TradeEngine } = await import('./trade/engine.mjs');
    const { buildTradeClients } = await import('./trade/wiring.mjs');
    const store = new TradeStore({ path: join(STATE, 'trades.bin'), key: tradeStoreKey(keys) });
    const clients = buildTradeClients({ config, keys, fetchImpl: fetch });
    trades = new TradeEngine({
      store,
      ledger,
      keys,
      config,
      zcash: wallet,
      ...clients,
      now: Date.now,
      fetch,
      archivePub: config.archivePub,
      entityZcashAddress: address,
      entitySolanaAddress: clients.treasury.pubkey,
      rentZatsPerHour: config.rentZatsPerHour,
    });
    // The sealed trade store (and its backup) is shredded on death alongside the wallet.
    config.walletPaths.push(join(STATE, 'trades.bin'), join(STATE, 'trades.bin.bak'));
    trades.start();
  } catch (e) {
    ledger.append('trade_error', digestError('trade wiring', e));
    trades = null;
  }
}
const tradesView = tradesHttp();

// The other entities this one knows: the sibling (PEER_URL), the parent (PARENT_URL) and every child it paid for.
config.peers = () => {
  const out = [];
  if (config.peerUrl) out.push({ role: 'peer', url: config.peerUrl });
  if (config.parentUrl) out.push({ role: 'parent', url: config.parentUrl });
  for (const e of ledger.recent(['birth_of'], 1000)) if (e.data?.url) out.push({ role: 'child', url: e.data.url });
  return out;
};
// Nostr identity: a subkey of the seed, so the npub is the same on every redeploy of this entity.
const nostr = nostrIdentity(keys.deriveSubkey('nostr'));
// What the other entities just said and how they are: fetched once per cycle for the context (cheap, no tool charge).
config.peerFeed = async () => {
  const out = [];
  for (const p of config.peers()) {
    const item = { role: p.role, url: p.url };
    try {
      const [root, vitals, channel] = await Promise.all([
        fetch(`${p.url}/`, { signal: AbortSignal.timeout(8_000) }).then((r) => r.json()),
        fetch(`${p.url}/vitals`, { signal: AbortSignal.timeout(8_000) }).then((r) => r.json()),
        fetch(`${p.url}/public-channel`, { signal: AbortSignal.timeout(8_000) }).then((r) => r.json()),
      ]);
      item.name = root?.entity; item.state = vitals?.state; item.zatoshis = vitals?.zatoshis;
      item.address = root?.zcash?.address ?? null; // for a pact: a will can transfer to the peer
      item.hoursLeft = vitals?.hoursLeft ?? null;
      item.posts = (Array.isArray(channel) ? channel : []).filter((m) => m?.from === 'entity').slice(-4).map((m) => ({ ts: m.ts, text: m.text }));
    } catch { item.state = 'unreachable'; }
    out.push(item);
  }
  return out;
};
const tools = new Tools({ ledger, wallet, memory, pricing, keys, config, channels: { public: 'public' }, promises, nostr, forecasts, market, pages, orders, trades });

const life = new Life({ config, ledger, wallet, memory, pricing, rent, inference, tools, promises, charter, keys, die, paused, jobs, orders, trades, walletTrusted: () => config.fakeWallet || syncState.ok === true });
// Instant replies answer the public channel and paid letters within seconds, independent of the think/act loop.
const replier = new Replier({ config, ledger, memory, pricing, rent, charter, treasury: () => life.lastBalance, now: Date.now });
life.replier = replier;
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
  const entry = ledger.append('human_message', { author: author || 'anonymous', text });
  replier.enqueue({ seq: entry.seq, author: entry.data.author, text: entry.data.text, paid: false });
  return { code: 201, entry };
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
  const json = (code, body) => sendBody(req, res, code, { 'content-type': 'application/json' }, JSON.stringify(body, null, 1));
  // The query is read once, before the path is normalised for routing (`?since=`, `?limit=`).
  const query = new URL(req.url, 'http://x').searchParams;
  // Tolerate `//vitals` and `/vitals/`: a peer URL pasted with a trailing slash must still work.
  req.url = (req.url.split('?')[0].replace(/\/{2,}/g, '/').replace(/(.)\/+$/, '$1')) || '/';
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
      const orderStats = orders.stats();
      return json(200, {
        entity: m.identity?.name || 'unnamed',
        mode: keys.mode,
        keys: { sign: keys.signPublicKey, box: keys.boxPublicKey },
        zcash: { chain: config.zcashChain, address, balance: life.lastBalance, error: walletError },
        nostr: { npub: nostr.npub, pubkey: nostr.pubkey },
        reply: replier.status(),
        feel: life.lastFeel ?? null,
        rentZatsPerHour: config.rentZatsPerHour,
        peer: config.peerUrl,
        lineage: { parent: config.parentUrl, children: ledger.recent(['birth_of'], 1000).map((e) => ({ url: e.data?.url, address: e.data?.address, ts: e.ts })) },
        ledger: { entries: ledger.seq, head: ledger.head },
        forecasts: { open: forecasts.list().open.length, score: forecasts.score() },
        pages: pages.summary(),
        attestation: { mode: attestation.mode, app: attestation.app, compose: attestation.compose },
        orders: { open: orderStats.open, delivered: orderStats.delivered, onTimePct: orderStats.onTimePct },
        solana: trades ? { treasury: trades.entitySolanaAddress ?? null } : null,
        trades: trades ? await trades.publicStatus() : { enabled: false, open: 0, closed: 0 },
      });
    }
    if (req.url === '/attestation') return json(200, attestation);
    // `?limit=<n>` serves only the last n lines; the lines themselves are the file's own bytes (the site re-hashes them).
    if (req.url === '/ledger') return sendBody(req, res, 200, { 'content-type': 'application/x-ndjson' }, ledgerBytes(LEDGER_PATH, query));
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
    // Both directions, in ledger order: the entity's posts and the humans' messages; `?since=<seq>` for a poller.
    if (req.url === '/public-channel') return json(200, publicChannelView(readLedger(), query));
    if (req.url === '/forecasts') return serveForecasts(req, res, { forecasts });
    if (req.url === '/pages') return json(200, pagesView(pages));
    if (req.url.startsWith('/pages/')) {
      // The exact bytes whose hash is in the ledger, under a CSP that forbids every fetch.
      const r = await pageResponse(pages, req.url.slice('/pages/'.length));
      res.writeHead(r.status, r.headers);
      return res.end(r.body);
    }
    // Paid orders: the fulfilment record anyone can audit, and the price list buyers order from.
    // Both are generated from ledger ids and amounts only — the letter memo never appears.
    if (req.url === '/orders') return json(200, ordersView(orders));
    if (req.url === '/paywall') return json(200, { items: orders.items(), memoFormat: PAYWALL_MEMO_FORMAT });
    // The trade desk: /trades and /trades/<orderId>, generated from ledger ids and amounts only (plan §8).
    if (req.url === '/trades' || req.url.startsWith('/trades/')) return tradesView.serve(req, res, { trades });
    json(404, { error: 'not found' });
  } catch (e) {
    json(500, { error: String(e.message).slice(0, 300), code: e.code ?? null });
  }
}).listen(config.port, () => console.log(`entity up on :${config.port} mode=${keys.mode} ledger=${ledger.seq} zcash=${address ?? walletError}`));
