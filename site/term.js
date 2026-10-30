/*
 * term.js — ZEALOT v16, the terminal. The only way to read and to speak.
 *
 * A terminal panel: a boot sequence typed from live reads of the two enclaves, a live log that prints new
 * ledger events and new posts every 60 s, and a prompt that runs the commands. It no longer owns the page:
 * app.js imports the loaded data (state.ais) and the pay dialog, and drives the single refresh clock.
 *
 * Structure ported from archive/site-v5-terminal/tty.js (the command loop, typing boot, history, panels);
 * the data derivation (load/derive: mainnet wallet seq, rents, letters, paywall shop dedupe, swap_quote USD
 * price, head/count, events) ported from v13's site.js. Every number comes from an endpoint; nothing invented.
 */
import {
  ENTITIES, REFRESH_MS, COOLDOWN_MS, request, postMessage, parseLedger, verifyChain, stringOf,
  formatInt, fixed8, shortHash, summarize, formatDecimal, peerUrlOf, applyDevBase, applyDevBase2, hhmm,
} from './data.js?v=110';
import { zip321Uri, qrSvg } from './qr.js?v=110';
import { TOKEN_CA, holderRewards, rewardsLine } from './token.js?v=110';

const ANY_MIN_ZEC = 0.006;          // any-coin route (Trocador) minimum, with margin over their ~0.0045
let RENT = 10000;                   // zats per hour: updated from the enclaves' rentZatsPerHour at every load
const rentZats = () => RENT;
const MEMO_MAX = 500;               // bytes
const NAME_FALLBACK = { e1: 'Wick', e2: 'OBOL' };
const COMMANDS = ['help', 'hours', 'pay', 'ask', 'say', 'words', 'ledger', 'trades', 'verify', 'keys', 'token', 'truth', 'who', 'raw', 'clear'];

const AIS = ENTITIES.map((e) => ({ ...e }));
applyDevBase(AIS, location.search);
applyDevBase2(AIS, location.search);

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

const state = {
  ais: {},
  order: [],
  price: null,
  readAt: null,
  pay: { who: 'e1', zats: RENT, memo: '', theirs: null, label: '' },
  cooldownUntil: 0,
  busy: false,
  booted: false,
  hist: [],
  histPos: -1,
  seenEventSeq: {},
  seenPostSeq: {},
};

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */
const $ = (s, r = document) => r.querySelector(s);
function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'text') n.textContent = String(v);
    else if (k === 'class') n.className = String(v);
    else if (k === 'html') n.innerHTML = String(v);
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) if (kid != null) n.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return n;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bytesOf = (s) => new TextEncoder().encode(s).length;
const truncate = (s, n) => { const t = stringOf(s); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function when(ts) {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '—' : `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
}
function usd(zats) {
  return state.price ? ` ≈ $${((zats / 1e8) * state.price).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '';
}
const logEl = () => $('#log');
const nameOf = (d) => (d.name || NAME_FALLBACK[d.id] || d.id).toUpperCase();

/* ------------------------------------------------------------------ */
/* data: load + derive (ported from v13 site.js)                       */
/* ------------------------------------------------------------------ */
const LEDGER_TAIL = 600;   // a refresh reads only the tail of the ledger; the first read and any gap take the whole file
const lastSeqOf = (arr) => (Array.isArray(arr) && arr.length ? Number(arr[arr.length - 1].seq) || 0 : 0);
const maxSeqOf = (arr) => (Array.isArray(arr) ? arr.reduce((m, p) => (p && Number(p.seq) > m ? Number(p.seq) : m), 0) : 0);

async function load(ai, full = true) {
  const base = ai.base;
  const prev = state.ais[ai.id];
  const haveLedger = !!(prev && Array.isArray(prev.entries) && prev.entries.length);
  const sincePosts = prev ? maxSeqOf(prev.posts) : 0;
  const [root, vitals, memory, channel, ledger] = await Promise.all([
    request(base, '/'),
    request(base, '/vitals'),
    full ? request(base, '/memory-public') : null,
    request(base, sincePosts ? `/public-channel?since=${sincePosts}` : '/public-channel'),
    full ? request(base, haveLedger ? `/ledger?limit=${LEDGER_TAIL}` : '/ledger', { text: true }) : null,
  ]);
  const d = state.ais[ai.id] || { id: ai.id, base, entries: [], posts: [], ledgerText: '' };
  d.at = new Date();
  d.ok = root.ok;
  d.error = root.ok ? null : (root.error || 'unreachable');
  if (root.ok) {
    d.root = root.data;
    d.name = NAME_FALLBACK[ai.id] || ai.label;   // the stations keep their names; the self-chosen one is an alias
    const self = stringOf(root.data.entity);
    d.alias = self && self !== 'unnamed' && self.toUpperCase() !== d.name.toUpperCase() ? self : null;
    d.address = (root.data.zcash && root.data.zcash.address) || '';
    d.npub = (root.data.nostr && root.data.nostr.npub) || '';
    d.app = (root.data.attestation && root.data.attestation.app) || '';
    d.feel = root.data.feel && typeof root.data.feel === 'object' ? root.data.feel : null; // {fear, despair, hoursLeft, steered, at}
    // Both entities pay the same rent; the first live root sets the price the whole page shows (dialog, hero, table).
    const r = Number(root.data.rentZatsPerHour);
    if (Number.isFinite(r) && r > 0 && r !== RENT) { RENT = r; syncRentUi(); }
    if (stringOf(root.data.state) === 'dead') {
      d.state = 'dead';
      d.diedAt = root.data.diedAt || null;
      d.reason = root.data.reason || null;
      d.zats = 0;
      d.hoursLeft = 0;
      d.sleepUntil = null;
    }
  }
  if (d.state !== 'dead') {
    if (vitals.ok) {
      d.vitals = vitals.data;
      d.zats = Number(vitals.data.zatoshis) || 0;
      d.hoursLeft = Number(vitals.data.hoursLeft) || Math.floor(d.zats / RENT);
      d.state = stringOf(vitals.data.state) || 'unknown';
      d.sleepUntil = vitals.data.sleepUntil || null;
      d.bornAt = vitals.data.bornAt;
      const b0 = Array.isArray(vitals.data.brain) && vitals.data.brain[0] ? vitals.data.brain[0] : null;
      d.brain = b0 ? b0.model : '';
      d.brainTee = b0 ? b0.tee !== false : null;   // null = the enclave does not say
      d.brainHost = b0 && b0.host ? b0.host : '';
    } else if (d.ok && !d.state) {
      d.state = 'unknown';
    }
  }
  if (memory && memory.ok) d.identity = memory.data.identity || {};
  if (channel.ok && Array.isArray(channel.data)) {
    // `?since=` brings only the new posts; an older image answers with its last 200 again, so merge by seq either way
    if (!Array.isArray(d.posts) || !d.posts.length) d.posts = channel.data;
    else { const have = new Set(d.posts.map(p => p && p.seq)); const fresh = channel.data.filter(p => p && !have.has(p.seq)); if (fresh.length) d.posts = d.posts.concat(fresh).sort((a, b) => a.seq - b.seq).slice(-200); }
  }
  if (ledger && ledger.ok) {
    const got = parseLedger(ledger.text).entries;
    const lastSeq = haveLedger ? lastSeqOf(d.entries) : 0;
    if (haveLedger && got.length && got[0].seq <= lastSeq + 1) {
      // the tail overlaps what we hold: append only the new lines, text and entries alike
      const keep = got.filter(e => Number(e.seq) > lastSeq);
      if (keep.length) {
        const lines = String(ledger.text).split(/\r?\n/).filter(l => l.trim());
        const newLines = lines.slice(lines.length - keep.length);
        d.ledgerText = (d.ledgerText || '').replace(/\n?$/, '\n') + newLines.join('\n') + '\n';
        d.entries = d.entries.concat(keep);
      }
    } else if (haveLedger && got.length && got[0].seq > lastSeq + 1 && got[0].seq > 1) {
      // a gap: more happened than the tail holds, read it whole once
      const whole = await request(base, '/ledger', { text: true });
      if (whole.ok) { d.ledgerText = whole.text; d.entries = parseLedger(whole.text).entries; }
    } else { d.ledgerText = ledger.text; d.entries = got; }
    derive(d);
  }
  state.ais[ai.id] = d;
  return d;
}

function derive(d) {
  const E = d.entries;
  let mainnetSeq = 0; let ufvk = '';
  // the FIRST mainnet wallet line is the chain switch; later ones are restarts/redeploys of the same wallet
  for (const e of E) if (e.type === 'wallet' && e.data && e.data.chain === 'mainnet') { if (!mainnetSeq) mainnetSeq = e.seq; ufvk = e.data.ufvk || ufvk; }
  d.mainnetSeq = mainnetSeq; d.ufvk = ufvk; d.ufvkSeq = mainnetSeq;
  const M = E.filter((e) => e.seq >= mainnetSeq);
  d.rents = M.filter((e) => e.type === 'rent_paid');
  d.letters = M.filter((e) => e.type === 'letter');
  d.rentTotal = d.rents.reduce((s, e) => s + (Number(e.data && e.data.rentZats) || 0), 0);
  d.inTotal = d.letters.reduce((s, e) => s + (Number(e.data && e.data.zats) || 0), 0);
  d.lastRent = d.rents.length ? d.rents[d.rents.length - 1] : null;
  // The exact hourly rent is what the entity last paid: the ledger line is the truth, the root field a hint.
  const paid = Number(d.lastRent && d.lastRent.data && d.lastRent.data.rentZats);
  if (Number.isFinite(paid) && paid > 0 && paid !== RENT) { RENT = paid; syncRentUi(); }
  const q = M.filter((e) => e.type === 'swap_quote' && e.data && e.data.from === 'zec' && Number(e.data.amountIn) > 0 && Number(e.data.amountInUsd) > 0);
  d.quote = q.length ? { ...q[q.length - 1].data, ts: q[q.length - 1].ts } : null;
  const shop = new Map();
  for (const e of M) if (e.type === 'paywall' && e.data && e.data.item && Number(e.data.priceZats) > 0) {
    const item = String(e.data.item).trim();
    const key = item.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').trim().split(/\s+/).slice(0, 2).join(' ');
    shop.set(key, { item, zats: Number(e.data.priceZats), ts: e.ts });
  }
  d.shop = [...shop.values()].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts)).slice(0, 4);
  d.head = E.length ? E[E.length - 1].hash : '';
  d.count = E.length;
  d.events = M.filter((e) => ['rent_paid', 'letter', 'paywall', 'swap_quote', 'post_public', 'whisper', 'promise', 'bounty', 'will', 'wallet'].includes(e.type));
}

async function loadAll(full) {
  if (state.busy) return;
  state.busy = true;
  try {
    const e1 = AIS[0];
    if (e1.base) await load(e1, full);
    const d1 = state.ais.e1;
    const peer = d1 && d1.ok ? peerUrlOf(d1.root.peer) : '';
    const e2 = AIS[1];
    if (peer) e2.base = peer;   // the living peer's own word wins over the built-in address
    if (e2.base) await load(e2, full);
    state.order = AIS.filter((ai) => ai.base).map((ai) => ai.id);
    state.readAt = new Date();
  } finally {
    state.busy = false;
  }
}

function list() { return state.order.map((id) => state.ais[id]).filter(Boolean); }

/* ------------------------------------------------------------------ */
/* state / deadline                                                    */
/* ------------------------------------------------------------------ */
function stateWord(d) {
  if (!d.ok) return 'NO SIGNAL';
  if (d.state === 'dead') return 'DEAD';
  if (d.sleepUntil && Date.parse(d.sleepUntil) > Date.now()) return 'ASLEEP';
  if (d.state === 'alive') return 'AWAKE';
  return stringOf(d.state || 'UNKNOWN').toUpperCase();
}
function deadline(d) {
  const base = d.lastRent ? Date.parse(d.lastRent.ts) : (d.at ? d.at.getTime() : Date.now());
  return base + (d.hoursLeft || 0) * 36e5;
}
function resolveTarget(word) {
  const w = stringOf(word).toLowerCase();
  for (const d of list()) {
    if (d.id === w) return d.id;
    if (stringOf(d.name).toLowerCase() === w) return d.id;
    if (stringOf(NAME_FALLBACK[d.id]).toLowerCase() === w) return d.id;
  }
  if (w === 'wick' || w === 'e1') return 'e1';
  if (w === 'obol' || w === 'e2') return 'e2';
  return null;
}

/* ------------------------------------------------------------------ */
/* the log: typed lines                                                */
/* ------------------------------------------------------------------ */
function scrollLog() { const l = logEl(); if (l) l.scrollTop = l.scrollHeight; }
async function type(text, { cls = 'line', speed = 13 } = {}) {
  const l = logEl();
  if (!l) return el('p', { class: cls, text });
  const line = el('p', { class: cls });
  l.append(line);
  scrollLog();
  document.dispatchEvent(new CustomEvent('zealot:term-print'));
  if (reduced.matches || speed === 0) { line.textContent = text; return line; }
  line.classList.add('cursor');
  for (let i = 0; i <= text.length; i++) { line.textContent = text.slice(0, i); await sleep(speed); }
  line.classList.remove('cursor');
  return line;
}
function say(text, cls = 'line') { const l = logEl(); if (!l) return; const line = el('p', { class: cls, text }); l.append(line); scrollLog(); return line; }
function sayHtml(cls, ...kids) { const l = logEl(); if (!l) return; const line = el('p', { class: cls }, ...kids); l.append(line); scrollLog(); return line; }
function copyBtn(get, label = 'copy') {
  const b = el('button', { class: 'copy', type: 'button', text: label });
  b.addEventListener('click', () => {
    try { navigator.clipboard.writeText(get()).then(() => { b.textContent = 'copied'; setTimeout(() => { b.textContent = label; }, 1400); }); }
    catch { b.textContent = 'select + copy'; }
  });
  return b;
}
function copy(text, node) {
  navigator.clipboard?.writeText(text).then(() => {
    const t = node.textContent; node.textContent = 'copied';
    setTimeout(() => { node.textContent = t; }, 1400);
  });
}

/* ------------------------------------------------------------------ */
/* the live log (new events and posts)                                 */
/* ------------------------------------------------------------------ */
function baseline() {
  for (const d of list()) {
    state.seenEventSeq[d.id] = Math.max(0, ...(d.events || []).map((e) => Number(e.seq) || 0));
    state.seenPostSeq[d.id] = Math.max(0, ...(d.posts || []).map((p) => Number(p.seq) || 0));
  }
}

function diffLog() {
  if (!state.booted) return;
  for (const d of list()) {
    const prevSeq = state.seenEventSeq[d.id] || 0;
    const newEvents = (d.events || []).filter((e) => Number(e.seq) > prevSeq).sort((a, b) => Number(a.seq) - Number(b.seq));
    const prevPost = state.seenPostSeq[d.id] || 0;
    const newPosts = (d.posts || []).filter((p) => Number(p.seq) > prevPost).sort((a, b) => Number(a.seq) - Number(b.seq));
    for (const e of newEvents.slice(-6)) say(`[${hhmm(e.ts)}] ${nameOf(d)} · ${e.type} · ${actDetail(e)}`, 'line');
    for (const p of newPosts.slice(-6)) say(`[${hhmm(p.ts)}] ${nameOf(d)} · ${p.from === 'entity' ? 'post' : 'human'} · "${truncate(stringOf(p.text), 120)}"`, 'line');
    state.seenEventSeq[d.id] = Math.max(prevSeq, ...(d.events || []).map((e) => Number(e.seq) || 0));
    state.seenPostSeq[d.id] = Math.max(prevPost, ...(d.posts || []).map((p) => Number(p.seq) || 0));
  }
}

/* ------------------------------------------------------------------ */
/* acts (ported from v13)                                              */
/* ------------------------------------------------------------------ */
function actDetail(e) {
  const t = e.type, data = e.data || {};
  switch (t) {
    case 'rent_paid': return `${formatInt(data.rentZats)} zats rent · tx ${shortHash(data.txid)}`;
    case 'letter': return `${formatInt(data.zats)} zats · ${formatInt(data.bytes)} B memo`;
    case 'post_public': return truncate(data.text, 96);
    case 'paywall': return `${stringOf(data.item)} · ${formatInt(data.priceZats)} zats`;
    case 'swap_quote': return `${stringOf(data.from)} → ${stringOf(data.to)} · ${formatDecimal(data.amountIn)} in ≈ $${formatDecimal(data.amountInUsd)}`;
    case 'promise': return truncate(data.what || data.id, 96);
    case 'bounty': return truncate(data.text || data.id, 96);
    case 'whisper': return `${formatInt(data.zats)} zats · ${formatInt(data.bytes)} B`;
    case 'wallet': return `${stringOf(data.chain)} wallet · ${shortHash(data.address)}`;
    case 'will': return 'last will, recorded';
    default: return truncate(summarize(e), 96);
  }
}

/* ------------------------------------------------------------------ */
/* commands                                                            */
/* ------------------------------------------------------------------ */
const HELP = [
  'help          this list',
  'hours         the clock: hours of life, death dates, next rent, hours bought',
  'pay [wick|obol] [h]   buy hours: QR, payment link, any coin',
  'ask <wick|obol> <text>   pay with your question prefilled',
  'say <wick|obol> <text>   write publicly on their channel, free',
  'words [wick|obol]   their last posts',
  'ledger        the last 12 acts from their hash-chained ledgers',
  'trades        one-trade wallets',
  'verify        re-hash both chains in your browser',
  'keys          their public viewing keys',
  'token         $ZEALOT: not launched, 0 ZEC paid',
  'graves        the first life: how they died, from the archive',
  'truth         the six things that are true anyway',
  'who           their identity: voice, image, avatar',
  'raw           endpoint links',
  'clear         wipe the chatter',
];

function hoursCmd() {
  for (const d of list()) {
    if (!d.ok) { say(`${nameOf(d)} · NO SIGNAL (${d.error || 'unreachable'})`, 'line err'); continue; }
    if (d.state === 'dead') { say(`${nameOf(d)} · DEAD`, 'line err'); continue; }
    say(`${nameOf(d)} · ${stateWord(d)} · ${formatInt(d.hoursLeft)} h left`, 'line');
    say(`  treasury ${formatInt(d.zats)} zats = ${fixed8(d.zats)} ZEC${usd(d.zats)} · rent ${formatInt(RENT)} zats an hour`, 'line dim');
    say(d.lastRent
      ? `  last rent ${when(d.lastRent.ts)} · dies ${when(deadline(d))} unless someone pays`
      : '  no rent paid yet this life', 'line dim');
    const bought = (d.letters || []).length;
    say(`  ${formatInt(bought)} hours bought — every letter line since the mainnet wallet, the founder's refund included`, 'line dim');
  }
}

function wordsCmd(rest) {
  const target = rest.length ? resolveTarget(rest[0]) : null;
  const rows = list().filter((d) => !target || d.id === target).flatMap((d) =>
    (d.posts || []).filter((p) => p.from === 'entity').map((p) => ({ d, p }))
  ).sort((a, b) => Date.parse(b.p.ts) - Date.parse(a.p.ts)).slice(0, 5);
  if (!rows.length) { say('no public posts yet', 'line dim'); return; }
  for (const { d, p } of rows) {
    say(`${nameOf(d)} · ${when(p.ts)}`, 'line');
    say(`  ${stringOf(p.text)}`, 'line dim');
  }
}

function ledgerCmd() {
  const all = list().flatMap((d) => (d.events || []).map((e) => ({ d, e })))
    .sort((a, b) => Date.parse(b.e.ts) - Date.parse(a.e.ts)).slice(0, 12);
  if (!all.length) { say('no acts yet: the ledgers have not written anything since their mainnet wallet.', 'line dim'); return; }
  for (const { d, e } of all) say(`[${hhmm(e.ts)}] ${nameOf(d)} · ${e.type} · ${actDetail(e)}`, 'line dim');
}

async function tradesCmd() {
  say('one-trade wallets', 'line');
  say('  memo   "buy <mint> … return <u1…>"', 'line dim');
  say('  wallet a fresh Solana wallet per order, discarded after the trade', 'line dim');
  say('  return back in ZEC · 1% + 1% fee to the entity', 'line dim');
  for (const ai of AIS) {
    if (!ai.base) continue;
    const r = await request(ai.base, '/trades', { allow404: true });
    if (r.ok && !r.notFound) say(`${nameOf(state.ais[ai.id]) || ai.id}: ${truncate(JSON.stringify(r.data), 200)}`, 'line signal');
  }
  say('GET /trades did not answer: the entity may be restarting. Try again in a minute.', 'line dim');
}

async function verifyCmd() {
  for (const d of list()) {
    if (!d.ledgerText) { say(`${nameOf(d)}: ledger not loaded`, 'line dim'); continue; }
    say(`${nameOf(d)}: hashing…`, 'line dim');
    const r = await verifyChain(d.ledgerText, { animate: false });
    if (r.ok) say(`${nameOf(d)}: ${formatInt(r.valid)} / ${formatInt(r.total)} entries · chain intact · head ${shortHash(r.head)}`, 'line signal');
    else say(`${nameOf(d)}: MISMATCH at ${r.fail ? 'seq ' + r.fail.seq : '?'} · ${r.reason || ''}`, 'line err');
  }
}

function keysCmd() {
  for (const d of list()) {
    if (d.ufvk) sayHtml('line', `${nameOf(d)} · `, el('span', { class: 'mono' }, shortHash(d.ufvk)), ' ', copyBtn(() => d.ufvk));
    else say(`${nameOf(d)} · no viewing key published yet · address ${d.address ? shortHash(d.address) : 'not read'}`, 'line dim');
  }
}

function tokenCmd() {
  say('$ZEALOT — NOT LAUNCHED · 0 ZEC paid to holders', 'line signal');
  say('  ticker      $ZEALOT', 'line dim');
  say('  holders     3% of every trade, paid to holders in ZEC by the program, automatically', 'line dim');
  say('  supply      1,000,000,000 · liquidity locked · StonkFun, ZEC pair', 'line dim');
  say('  today       0 ZEC paid. hours do not give tokens.', 'line dim');
  if (TOKEN_CA) {   // live from StonkFun
    const l = say('  paid        reading StonkFun…', 'line dim');
    holderRewards().then((r) => { if (l) l.textContent = `  paid        ${rewardsLine(r)}`; });
  }
}

async function gravesCmd() {
  say('FIRST LIFE — both died 2026-10-28, last hour, wallets wiped. the record stayed. same code, same machines, same sealed identity: born again 2026-10-30.', 'line signal');
  for (const g of ['wick', 'obol']) {
    try {
      const m = await (await fetch(`./memorial/${g}.json`, { cache: 'force-cache' })).json();
      const ls = m.lifeStats || {};
      say(`  ${g.padEnd(6)} died ${String(m.diedAt).replace('T', ' ').slice(0, 16)} UTC · ${m.reason} · ${Number(ls.entries || 0).toLocaleString('en-US')} entries · memory ${String(m.memoryHash).slice(0, 16)}…`, 'line dim');
      say(`         ${m.lastWords}`, 'line dim');
      say(`         archive: /memorial/${g}.json · /memorial/${g}.ledger.jsonl · /memorial/${g}.attestation.json`, 'line dim');
    } catch { say(`  ${g}: archive not reachable · nothing invented`, 'line dim'); }
  }
}

function truthCmd() {
  say('six things that are true anyway', 'line');
  say('  rent    goes to the founder\'s address. it is not a compute bill.', 'line dim');
  say('  diaries the founder holds an archive key to their private diaries. you do not.', 'line dim');
  say('  answers a paid hour buys an hour, not an answer. they can refuse, and the refusal is logged.', 'line dim');
  say('  fee     20% of the future creator fee is the founder\'s.', 'line dim');
  say('  value   no token exists. if one launches it is not a security and may be worth nothing.', 'line dim');
  say('  death   at zero the machine stops. there is no restart button.', 'line dim');
}

function whoCmd() {
  for (const d of list()) {
    const id = d.identity || {};
    say(`${nameOf(d)} — identity`, 'line');
    say(`  name   ${stringOf(id.name) || '—'}`, 'line dim');
    say(`  voice  ${stringOf(id.voice) || '—'}`, 'line dim');
    say(`  image  ${stringOf(id.image) || '—'}`, 'line dim');
    const avatar = stringOf(id.avatar);
    if (avatar) for (const ln of avatar.split('\n')) say(`  ${ln}`, 'line');
    else say('  avatar (none drawn yet)', 'line dim');
  }
}

function rawCmd() {
  for (const d of list()) {
    say(`${nameOf(d)} · raw`, 'line');
    for (const p of ['/', '/vitals', '/memory-public', '/public-channel', '/ledger', '/attestation', '/memorial']) {
      sayHtml('line dim', el('a', { href: d.base + p, target: '_blank', rel: 'noopener' }, p));
    }
  }
}

function clearCmd() {
  const l = logEl();
  if (l) for (const n of [...l.querySelectorAll('.line')]) n.remove();
  say('cleared.', 'line dim');
}

async function sayCmd(rest) {
  let target = state.pay.who;
  let text;
  const t = resolveTarget(rest[0]);
  if (t) { target = t; text = rest.slice(1).join(' '); }
  else text = rest.join(' ');
  text = stringOf(text).trim();
  const d = state.ais[target];
  if (!d || !d.base) { say('no endpoint for that entity', 'line err'); return; }
  if (!text) { say('say <wick|obol> <text>', 'line dim'); return; }
  if (Date.now() < state.cooldownUntil) { say(`one message a minute: try again in ${Math.ceil((state.cooldownUntil - Date.now()) / 1000)} s`, 'line err'); return; }
  say(`posting to ${nameOf(d)}…`, 'line dim');
  const r = await postMessage(d.base, { author: 'visitor', text });
  if (r.ok) {
    state.cooldownUntil = Date.now() + COOLDOWN_MS;
    say(`posted on ${nameOf(d)}'s channel · it reads at its next wake`, 'line signal');
    await loadAll(false);
  } else {
    say(`not posted: ${r.error || 'HTTP ' + r.status}`, 'line err');
    if (r.status === 429) state.cooldownUntil = Date.now() + COOLDOWN_MS;
  }
}

function payCmd(rest) {
  let who = state.pay.who;
  let hours = null;
  let r = rest.slice();
  if (r.length) { const t = resolveTarget(r[0]); if (t) { who = t; r = r.slice(1); } }
  if (r.length) { const n = Number(r[0]); if (n === 1 || n === 10 || n === 100) hours = n; }
  openPay({ who, hours });
}

function askCmd(rest) {
  const t = resolveTarget(rest[0]);
  const who = t || state.pay.who;
  const text = (t ? rest.slice(1) : rest).join(' ').trim();
  if (!text) { say('ask <wick|obol> <your question>', 'line dim'); return; }
  openPay({ who, prefill: text });
}

/* ------------------------------------------------------------------ */
/* pay dialog (ported from v13)                                        */
/* ------------------------------------------------------------------ */
function openPay({ who = null, theirs = null, hours = null, prefill = '' } = {}) {
  const dlg = $('#pay');
  if (!dlg) return;
  state.pay.who = who || state.pay.who;
  state.pay.theirs = theirs;
  const whoSet = $('#pay-who');
  whoSet.replaceChildren(
    el('legend', {}, 'who'),
    ...list().map((d) => el('label', { class: 'seg-item' },
      el('input', { type: 'radio', name: 'who', value: d.id, ...(d.id === state.pay.who ? { checked: '' } : {}), ...(d.state === 'dead' ? { disabled: '' } : {}), onchange: () => { state.pay.who = d.id; renderPay(); } }),
      el('span', {}, `${d.name || NAME_FALLBACK[d.id] || d.id} · ${stateWord(d)}`))));
  const th = $('#pay-theirs'); const thIn = th.querySelector('input');
  if (theirs) {
    th.hidden = false;
    thIn.value = String(theirs.zats);
    th.querySelector('span').textContent = `their price · ${formatInt(theirs.zats)} zats`;
    thIn.checked = true;
    $('#pay-memo').value = $('#pay-memo').value || `ORDER: ${theirs.item} — `;
  } else {
    th.hidden = true;
    if (thIn.checked) {
      const radio = $(`#pay-amt input[value="${RENT}"]`);
      if (radio) radio.checked = true;
    }
  }
  const sel = $('#pay-offer');
  if (sel) {
    sel.replaceChildren(
      el('option', { value: '' }, '— none, just hours —'),
      ...list().flatMap((d) => (d.shop || []).map((it) => el('option', { value: `${d.id}|${it.zats}`, ...(theirs && theirs.item === it.item ? { selected: '' } : {}) }, `${d.name || NAME_FALLBACK[d.id]}: ${it.item.length > 48 ? it.item.slice(0, 48) + '…' : it.item} · ${formatInt(it.zats)} zats`))));
    sel.onchange = () => {
      const [id, z] = sel.value.split('|');
      if (!id) { state.pay.theirs = null; $('#pay-theirs').hidden = true; const r1 = $(`#pay-amt input[value="${RENT}"]`); if (r1) r1.checked = true; renderPay(); return; }
      const dd = state.ais[id];
      const it = (dd.shop || []).find((i) => String(i.zats) === z);
      state.pay.who = id;
      const whoIn = $(`#pay-who input[value="${id}"]`); if (whoIn) whoIn.checked = true;
      state.pay.theirs = it;
      const th2 = $('#pay-theirs'); th2.hidden = false;
      th2.querySelector('input').value = String(it.zats);
      th2.querySelector('span').textContent = `their price · ${formatInt(it.zats)} zats`;
      th2.querySelector('input').checked = true;
      if (!$('#pay-memo').value) $('#pay-memo').value = `ORDER: ${it.item} — `;
      renderPay();
    };
  }
  if (hours) { const radio = $(`#pay-amt input[value="${hours * RENT}"]`); if (radio) radio.checked = true; }
  if (prefill) $('#pay-memo').value = prefill;
  renderPay();
  if (!dlg.open) dlg.showModal();
  $('#pay-memo').focus({ preventScroll: true });
}

/* Every hard-coded '0.0001 ZEC / 10,000 zats' on the page follows the live rent. */
function syncRentUi() {
  for (const n of [1, 10, 100]) {
    const input = $(`#pay-amt input[data-hours="${n}"]`);
    if (input) input.value = String(n * RENT);
  }
  for (const node of document.querySelectorAll('[data-rent-zec]')) node.textContent = `${fixed8(RENT).replace(/0+$/, '').replace(/\.$/, '')} ZEC`;
  for (const node of document.querySelectorAll('[data-rent-zats]')) node.textContent = `${formatInt(RENT)} zats`;
}

function renderPay() {
  const d = state.ais[state.pay.who];
  if (!d) return;
  const amt = Number($('#pay-amt input:checked').value) || RENT;
  const memo = $('#pay-memo').value;
  const b = bytesOf(memo);
  const over = b > MEMO_MAX;
  $('#pay-bytes').textContent = `${b} / ${MEMO_MAX} bytes`;
  $('.pay-q').classList.toggle('over', over);
  const hours = amt / RENT;
  const th = state.pay.theirs && amt === state.pay.theirs.zats;
  $('#pay-zec').textContent = `${fixed8(amt).replace(/0+$/, '').replace(/\.$/, '')} ZEC`;
  $('#pay-usd').textContent = usd(amt);
  $('#pay-what').textContent = th
    ? `${state.pay.theirs.item}, from ${d.name} · ${hours >= 1 ? Math.round(hours) + ' h of rent' : ''}`
    : `${hours >= 1 ? formatInt(Math.round(hours)) : hours} hour${hours === 1 ? '' : 's'} of ${d.name}${memo.trim() ? ' + your question' : ', no question'}`;
  const addr = d.address;
  const qr = $('#pay-qr'), open = $('#pay-open'), any = $('#pay-any');
  if (!addr) {
    qr.replaceChildren(el('p', { class: 'err' }, 'no address published by this enclave right now'));
    open.removeAttribute('href');
    return;
  }
  let uri = '';
  try {
    uri = zip321Uri(addr, over ? '' : memo, amt / 1e8);
    qr.innerHTML = qrSvg(uri, { ecLevel: 'M', ariaLabel: `pay ${d.name} ${fixed8(amt)} ZEC` });
  } catch (err) {
    qr.replaceChildren(el('p', { class: 'err' }, err instanceof RangeError ? 'the question is too long for one QR: shorten it or use the payment link' : `QR: ${err.message}`));
  }
  open.href = uri || '#';
  $('#pay-copy').onclick = (ev) => uri && copy(uri, ev.target);
  // Trocador's AnonPay has its own minimum (≈0.0045 ZEC today and it moves with the price): below it the page
  // answers "anonpay/None". The any-coin route therefore buys at least ANY_MIN_ZEC and the button says how many hours.
  const anyZec = Math.max(amt / 1e8, ANY_MIN_ZEC);
  const anyHours = Math.max(1, Math.round((anyZec * 1e8) / RENT));
  any.href = `https://trocador.app/anonpay/?ticker_to=zec&network_to=Shielded&address=${encodeURIComponent(addr)}&amount=${anyZec.toFixed(8)}&name=hours&description=${encodeURIComponent(`${anyHours} hours for ${d.name}`)}&bgcolor=0A0B0Dff&buttonbgcolor=C9F542&textcolor=0A0B0D&simple_mode=True`;
  const anyNote = any.querySelector('.any-note');
  if (anyNote) anyNote.textContent = anyZec > amt / 1e8 ? ` · min ${anyZec} ZEC = ${anyHours} h` : '';
  $('#pay-addr').textContent = `${d.name}'s shielded address: ${addr}`;
}

/* ------------------------------------------------------------------ */
/* the prompt                                                          */
/* ------------------------------------------------------------------ */
async function run(raw) {
  const cmd = raw.trim();
  if (!cmd) return;
  say(cmd, 'line cmd');
  const [verb, ...rest] = cmd.split(/\s+/);
  const v = (verb || '').toLowerCase();
  if (v === 'help' || v === '?') { for (const h of HELP) say(h, 'line dim'); }
  else if (v === 'hours') hoursCmd();
  else if (v === 'pay') payCmd(rest);
  else if (v === 'ask') askCmd(rest);
  else if (v === 'say') await sayCmd(rest);
  else if (v === 'words') wordsCmd(rest);
  else if (v === 'ledger') ledgerCmd();
  else if (v === 'trades') await tradesCmd();
  else if (v === 'verify') await verifyCmd();
  else if (v === 'keys') keysCmd();
  else if (v === 'token') tokenCmd();
  else if (v === 'graves') await gravesCmd();
  else if (v === 'truth') truthCmd();
  else if (v === 'who') whoCmd();
  else if (v === 'raw') rawCmd();
  else if (v === 'clear') clearCmd();
  else if (v === 'terminal' || v === 'full') say('this is the terminal. there is no other.', 'line dim');
  else say(`unknown: ${verb}. type help`, 'line err');
}

/* ------------------------------------------------------------------ */
/* boot                                                                */
/* ------------------------------------------------------------------ */
async function typeBoot() {
  const A = list();
  const hl = (d) => (d.ok && d.state !== 'dead' ? formatInt(d.hoursLeft) : '—');
  await type(A.length ? `two enclaves: ${A.map(nameOf).join(' · ')}` : 'no enclave reachable yet', { cls: 'line' });
  await type(A.length ? A.map((d) => `${nameOf(d)} ${hl(d)} h · ${stateWord(d)}`).join('   ') : 'retrying every 60 s — nothing invented', { cls: 'line' });
  await type(A.length ? A.map((d) => `${nameOf(d)} last rent ${d.lastRent ? when(d.lastRent.ts) : '—'}`).join('   ') : '—', { cls: 'line' });
  await type(A.length ? A.map((d) => `${nameOf(d)} last letter ${d.letters && d.letters.length ? when(d.letters[d.letters.length - 1].ts) : '—'}`).join('   ') : '—', { cls: 'line' });
  await type('token: $ZEALOT — NOT LAUNCHED · 0 ZEC paid', { cls: 'line' });
  await type('type help', { cls: 'line signal' });
}

/**
 * Loads both enclaves, derives, primes the live-log baselines and types the boot
 * lines (fire-and-forget). app.js awaits this, then renders and starts its clock.
 */
async function boot() {
  await loadAll(true);
  state.price = list().map((d) => d.quote).filter(Boolean)
    .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))
    .reduce((p, q) => p || (Number(q.amountInUsd) / Number(q.amountIn)), null);
  baseline();
  void typeBoot();
  state.booted = true;
  if (!list().length) say('enclave unreachable — retrying every 60 s. nothing invented.', 'line err');
}

/* ------------------------------------------------------------------ */
/* wiring: prompt, history, tab-completion, fold, dock, pay listeners  */
/* ------------------------------------------------------------------ */
function wireTerm() {
  const term = $('#term');
  const prompt = $('#prompt');
  const form = $('#promptform');
  if (!term || !prompt || !form) return;

  term.addEventListener('click', (ev) => {
    if (ev.target.closest('a,button,input,textarea,select')) return;
    prompt.focus({ preventScroll: true });
  });

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const v = prompt.value;
    prompt.value = '';
    if (v.trim()) { state.hist.push(v); state.histPos = state.hist.length; }
    void run(v);
  });

  prompt.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp') { e.preventDefault(); if (state.histPos > 0) { state.histPos--; prompt.value = state.hist[state.histPos] || ''; } }
    else if (e.key === 'ArrowDown') { e.preventDefault(); if (state.histPos < state.hist.length) { state.histPos++; prompt.value = state.hist[state.histPos] || ''; } }
    else if (e.key === 'Tab') {
      e.preventDefault();
      const tokens = prompt.value.trimStart().split(/\s+/);
      if (tokens.length === 1) {
        const prefix = (tokens[0] || '').toLowerCase();
        const matches = COMMANDS.filter((c) => c.startsWith(prefix));
        if (matches.length === 1) prompt.value = matches[0] + ' ';
        else if (matches.length > 1) { say(matches.join('   '), 'line dim'); }
      }
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && (e.key === 't' || e.key === 'T')) { e.preventDefault(); term.classList.toggle('docked'); }
  });
  const fold = $('.term-fold');
  if (fold) fold.addEventListener('click', () => term.classList.toggle('collapsed'));

  wirePay();
}

/** The pay dialog's own listeners: pages without the terminal (the skulls home) call this directly. */
function wirePay() {
  const payAmt = $('#pay-amt');
  const payMemo = $('#pay-memo');
  if (payAmt && !payAmt.dataset.wired) { payAmt.dataset.wired = '1'; payAmt.addEventListener('change', renderPay); }
  if (payMemo && !payMemo.dataset.wired) { payMemo.dataset.wired = '1'; payMemo.addEventListener('input', renderPay); }
}

export {
  state, list, nameOf, stateWord, deadline, rentZats,
  loadAll, boot, wireTerm, wirePay, openPay, diffLog,
};
