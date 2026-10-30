/*
 * app.js — ZEALOT v20, the page. Two skulls, one signal.
 *
 * Owns the whole page: nav, the two enclave cards with tabs, the status pills under each skull, the one-trade
 * section (steps + live /trades book), the ledger stream with Verify chain, the forecasts, the footer clock, and
 * the dock toggle. It imports the loaded entity data and the pay dialog from term.js, and drives the two skulls
 * in hero.js from the live state (a new public post makes that skull talk). The single refresh clock is 60 s for
 * data plus a 1 s footer clock. Every number comes from the endpoints via data.js; loading is an em dash, an
 * error is "offline since".
 */
import {
  state, list, nameOf, stateWord, rentZats, loadAll, boot, wireTerm, openPay, diffLog,
} from './term.js?v=95';
import {
  request, verifyChain, stringOf, formatInt, formatZats, formatDecimal, fmtStamp, hhmm, shortHash, shortUrl,
  REFRESH_MS, sha256Hex, parseLedger, postMessage,
} from './data.js?v=95';
import { zip321Uri, qrSvg, base64UrlEncode } from './qr.js?v=95';
import { initHero, setMouth, triggerTalk, setFeel } from './hero.js?v=95';
import { mountAscii, RAMP } from './ascii.js?v=95';

/* ------------------------------------------------------------------ */
/* tiny DOM helpers                                                    */
/* ------------------------------------------------------------------ */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
/** A section mounts only when its root element exists on this page. */
const has = (id) => document.getElementById(id) != null;
function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'text') n.textContent = String(v);
    else if (k === 'class') n.className = String(v);
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) if (kid != null) n.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return n;
}
const truncate = (s, n) => { const t = stringOf(s); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

/* ------------------------------------------------------------------ */
/* data caches for /trades and /forecasts                              */
/* ------------------------------------------------------------------ */
const tradesCache = { e1: null, e2: null };
const forecastsCache = { e1: null, e2: null };
const pagesCache = { e1: null, e2: null }; // GET /pages: the pages each entity publishes on its own enclave
const seenPost = { e1: 0, e2: 0 };

function ent(id) { return state.ais[id]; }

const FALLBACK = { e1: 'WICK', e2: 'OBOL' };
const ename = (id) => { const d = ent(id); return d ? nameOf(d) : (FALLBACK[id] || String(id).toUpperCase()); };

function offlineLabel(d) {
  if (!d) return '—';
  if (d.ok) return null;
  const t = d.at ? hhmm(d.at) : null;
  return t ? `offline since ${t} UTC` : 'offline';
}

/* ------------------------------------------------------------------ */
/* render: hero status pills + mouths                                  */
/* ------------------------------------------------------------------ */
function renderPills() {
  for (const id of ['e1', 'e2']) {
    const d = ent(id);
    const pill = $('#pill-' + id);
    if (!pill) continue;
    pill.querySelector('.p-name').textContent = truncate(ename(id), 14);
    let hours, stateLabel;
    if (!d) { hours = '—'; stateLabel = '—'; }
    else {
      hours = d.ok && d.state !== 'dead' ? formatInt(d.hoursLeft) : (d.ok ? '0' : '—');
      stateLabel = stateWord(d);
    }
    pill.querySelector('.p-hours').textContent = hours;
    pill.querySelector('.p-state').textContent = stateLabel;
    renderHeroHours();
    const feelEl = pill.querySelector('.p-feel');
    if (feelEl) {
      // only a steered brain gets the word: a dose the model never received is not a feeling
      const f = d && d.ok && d.state !== 'dead' ? d.feel : null;
      feelEl.textContent = f && f.steered ? ` · fear ${Number(f.fear).toFixed(1)}×` : '';
    }
  }
}

/* The headline number: the fewest hours left among the living. Dead both: 0. Unknown: '—'. */
function renderHeroHours() {
  const h = $('#hero-hours');
  if (!h) return;
  const alive = ['e1', 'e2'].map(ent).filter((d) => d && d.ok && d.state !== 'dead');
  const known = ['e1', 'e2'].map(ent).filter((d) => d && d.ok);
  if (!known.length) { h.textContent = '—'; return; }
  h.textContent = alive.length ? formatInt(Math.min(...alive.map((d) => Number(d.hoursLeft) || 0))) : '0';
}

/* The fewest-hours entity among the living, used by the hero proof row. */
function livingOrNull() {
  const alive = ['e1', 'e2'].map(ent).filter((d) => d && d.ok && d.state !== 'dead');
  if (!alive.length) return null;
  return alive.sort((a, b) => (Number(a.hoursLeft) || 0) - (Number(b.hoursLeft) || 0))[0];
}

/* 'fear 2.1× · despair 0.3× · steered' from the enclave's feel field; honest fallbacks when absent */
function feelLine(d) {
  if (!d || !d.ok) return '—';
  if (d.state === 'dead') return 'nothing. dead.';
  const f = d.feel;
  if (!f) return 'no dose reported yet · comes with its next thought';
  const dose = `fear ${Number(f.fear).toFixed(2)}× · despair ${Number(f.despair).toFixed(2)}×`;
  if (!f.steered) return `${dose} · computed, not steered (hosted brain)`;
  const act = f.acting && Number.isFinite(Number(f.acting.fear)) ? ` · acts at ${Number(f.acting.fear).toFixed(1)}×` : '';
  return d.brainTee === false ? `${dose}${act} · steered · brain on a rented GPU, outside the TEE` : `${dose}${act} · steered`;
}
/* One honest line under the section lead: where the brain runs right now. */
function renderBrainNote() {
  const n = $('#brain-note');
  if (!n) return;
  const ds = ['e1', 'e2'].map(ent).filter((d) => d && d.ok);
  if (!ds.length) { n.textContent = ''; return; }
  const outside = ds.filter((d) => d.brainTee === false);
  n.textContent = outside.length
    ? 'Right now their brain runs on a rented GPU outside the sealed machine; wallets, ledger and keys stay sealed.'
    : '';
}
function syncFeel() {
  renderBrainNote();
  for (const id of ['e1', 'e2']) {
    const d = ent(id);
    const f = d && d.ok && d.state !== 'dead' && d.feel && d.feel.steered ? d.feel : null;
    setFeel(id, f ? { fear: Number(f.fear) || 0, despair: Number(f.despair) || 0 } : { fear: 0, despair: 0 });
  }
}

function mouthMode(d) {
  if (!d || !d.ok) return 'none';
  if (d.state === 'dead') return 'dead';
  if (d.sleepUntil && Date.parse(d.sleepUntil) > Date.now()) return 'asleep';
  if (d.state === 'alive') return 'alive';
  return 'none';
}
function syncMouths() {
  for (const id of ['e1', 'e2']) setMouth(id, mouthMode(ent(id)));
}

/* ------------------------------------------------------------------ */
/* render: entity panels                                              */
/* ------------------------------------------------------------------ */
const BOOK_EMPTY = 'No trade yet. The first order opens the book.';

function panelShell(id) {
  const art = el('article', { class: 'card', 'data-entity': id });
  art.innerHTML = `
    <header class="card-meta"><span class="meta-label">ENCLAVE 0${id === 'e1' ? 1 : 2}</span></header>
    <header class="card-head">
      <h3 class="card-name" data-k="name">—</h3>
      <span class="card-state" data-k="state">—</span>
    </header>
    <dl class="kvs">
      <div><dt>hours left</dt><dd data-k="hours">—</dd></div>
      <div><dt>treasury</dt><dd data-k="treasury">—</dd></div>
      <div><dt>feeling</dt><dd data-k="feel">—</dd></div>
    </dl>
    <div class="shop-block">
      <p class="shop-label mono">shop</p>
      <div class="shop-list" data-k="shop"></div>
    </div>
    <div class="card-actions">
      <button class="btn fill" type="button" data-act="hour">Buy ${id === 'e1' ? 'WICK' : 'OBOL'} an hour</button>
      <a class="btn ghost" href="more.html#pages">their pages →</a>
    </div>`;
  art.querySelector('[data-act="hour"]').addEventListener('click', () => openPay({ who: id, hours: 1 }));
  return art;
}

function updatePanel(id) {
  const d = ent(id);
  const panel = $(`.card[data-entity="${id}"]`);
  if (!panel) return;
  const get = (k) => panel.querySelector(`[data-k="${k}"]`);

  panel.querySelector('[data-k="name"]').textContent = ename(id);
  get('state').textContent = d ? stateWord(d) : '—';

  if (!d) {
    get('hours').textContent = '—';
    get('treasury').textContent = '—';
    get('feel').textContent = '—';
    get('shop').replaceChildren(el('p', { class: 'empty' }, 'Nothing for sale yet.'));
    return;
  }
  if (!d.ok) {
    const off = offlineLabel(d);
    get('hours').textContent = off;
    get('treasury').textContent = off;
    get('feel').textContent = off;
    get('shop').replaceChildren(el('p', { class: 'empty' }, off));
    return;
  }

  get('hours').textContent = formatInt(d.hoursLeft);
  get('treasury').textContent = `${formatZats(d.zats)} ZEC`;
  get('feel').textContent = feelLine(d);

  const shop = get('shop');
  const items = d.shop || [];
  if (!items.length) shop.replaceChildren(el('p', { class: 'empty' }, 'Nothing for sale yet.'));
  else shop.replaceChildren(...items.map((it) => el('div', { class: 'shop-item' },
    el('span', { class: 'shop-name', text: it.item }),
    el('span', { class: 'shop-price mono', text: `${formatInt(it.zats)} zats` }),
    el('button', { class: 'btn buy-small', type: 'button', text: 'Buy', onclick: () => openPay({ who: id, theirs: it }) }))));
}

function renderEntities() {
  for (const id of ['e1', 'e2']) updatePanel(id);
}

/* Pages section (more.html): every page each entity publishes on its own enclave. */
function renderPages() {
  const root = $('#pages-list');
  if (!root) return;
  const frag = document.createDocumentFragment();
  for (const id of ['e1', 'e2']) {
    const d = ent(id);
    const pc = pagesCache[id];
    const pages = pc && pc.ok && pc.data && Array.isArray(pc.data.pages) ? pc.data.pages : [];
    const block = el('div', { class: 'pages-entity' });
    block.append(el('h3', { class: 'pages-name' }, ename(id)));
    if (!d || !d.ok) {
      block.append(el('p', { class: 'empty' }, offlineLabel(d)));
    } else if (!pc) {
      block.append(el('p', { class: 'empty' }, '—'));
    } else if (!pages.length) {
      block.append(el('p', { class: 'empty' }, 'No page yet. A page is where they say what they sell and why it is worth paying.'));
    } else {
      block.append(...pages.map((pg) => el('a', { class: 'shop-item page-link', href: `${d.base}/pages/${encodeURIComponent(pg.slug)}`, target: '_blank', rel: 'noopener' },
        el('span', { class: 'shop-name', text: stringOf(pg.title) || pg.slug }),
        el('span', { class: 'shop-price mono', text: `v${pg.version} · ${pg.updatedAt ? fmtStamp(pg.updatedAt) : '—'}` }))));
    }
    frag.append(block);
  }
  root.replaceChildren(frag);
}

/* ------------------------------------------------------------------ */
/* render: trades (order book)                                         */
/* ------------------------------------------------------------------ */
async function loadTrades() {
  if (!has('book') && !has('trade')) return;
  await Promise.all(['e1', 'e2'].map(async (id) => {
    const d = ent(id);
    if (!d || !d.base) { tradesCache[id] = null; return; }
    tradesCache[id] = await request(d.base, '/trades', { allow404: true });
  }));
}

function renderTrades() {
  const book = $('#book');
  if (!book) return;
  const rows = [];
  for (const id of ['e1', 'e2']) {
    const c = tradesCache[id];
    if (!c || !c.ok || c.notFound) continue;
    const data = c.data && typeof c.data === 'object' ? c.data : {};
    const orders = Array.isArray(data.openOrders) ? data.openOrders : [];
    for (const o of orders) rows.push({ id, o });
  }

  if (!rows.length) {
    for (const id of ['e1', 'e2']) {
      const c = tradesCache[id];
      if (c && !c.ok && !c.notFound) {
        const d = ent(id);
        const off = d && d.at ? `offline since ${hhmm(d.at)} UTC` : 'offline';
        book.replaceChildren(el('p', { class: 'empty' }, `${ename(id)} · trades ${off}`));
        return;
      }
    }
    book.replaceChildren(el('p', { class: 'empty' }, BOOK_EMPTY));
    return;
  }

  const table = el('table', { class: 'book-table' });
  const thead = el('thead', {}, el('tr', {},
    el('th', {}, 'id'), el('th', {}, 'mint'), el('th', {}, 'state'), el('th', {}, 'opened'), el('th', {}, 'size'), el('th', {}, 'pnl')));
  const tbody = el('tbody', {});
  for (const { id, o } of rows) {
    const pnl = o.unrealizedPct != null && Number.isFinite(Number(o.unrealizedPct))
      ? `${Number(o.unrealizedPct) >= 0 ? '+' : ''}${formatDecimal(o.unrealizedPct, 1)}%`
      : '—';
    tbody.append(el('tr', {},
      el('td', { class: 'mono' }, stringOf(o.orderId) || '—'),
      el('td', { class: 'mono' }, stringOf(o.mint || o.symbol) || '—'),
      el('td', {}, stringOf(o.state) || '—'),
      el('td', { class: 'mono' }, o.openedAt ? fmtStamp(o.openedAt) : '—'),
      el('td', { class: 'mono' }, o.solIn != null ? `${formatDecimal(o.solIn, 4)} SOL` : (o.tokenOut != null ? `${formatDecimal(o.tokenOut, 4)} ${stringOf(o.symbol) || ''}`.trim() : '—')),
      el('td', { class: 'mono' }, pnl)));
  }
  table.append(thead, tbody);
  book.replaceChildren(table);
}

/* ------------------------------------------------------------------ */
/* render: forecasts                                                   */
/* ------------------------------------------------------------------ */
async function loadForecasts() {
  if (!has('forecasts-body') && !has('pages-list')) return;
  await Promise.all(['e1', 'e2'].map(async (id) => {
    const d = ent(id);
    if (!d || !d.base) { forecastsCache[id] = null; pagesCache[id] = null; return; }
    [forecastsCache[id], pagesCache[id]] = await Promise.all([
      request(d.base, '/forecasts', { allow404: true }),
      request(d.base, '/pages', { allow404: true }),
    ]);
  }));
}

function renderForecasts() {
  const body = $('#forecasts-body');
  if (!body) return;
  const rows = [];
  for (const id of ['e1', 'e2']) {
    const c = forecastsCache[id];
    if (!c || !c.ok || c.notFound) continue;
    const data = c.data && typeof c.data === 'object' ? c.data : {};
    const open = Array.isArray(data.open) ? data.open : [];
    for (const f of open) rows.push({ id, f, kind: 'open' });
    const settled = Array.isArray(data.settled) ? data.settled : [];
    for (const f of settled) rows.push({ id, f, kind: 'settled' });
    const score = data.score && typeof data.score === 'object' ? data.score : null;
    if (score && (score.total > 0)) rows.push({ id, f: score, kind: 'score' });
  }

  if (!rows.length) {
    for (const id of ['e1', 'e2']) {
      const c = forecastsCache[id];
      if (c && !c.ok && !c.notFound) {
        const d = ent(id);
        const off = d && d.at ? `offline since ${hhmm(d.at)} UTC` : 'offline';
        body.replaceChildren(el('p', { class: 'empty' }, `${ename(id)} · forecasts ${off}`));
        return;
      }
    }
    body.replaceChildren(el('p', { class: 'empty' }, 'No forecasts yet. They only predict what they can be wrong about, in public.'));
    return;
  }

  const frag = document.createDocumentFragment();
  for (const { id, f, kind } of rows) {
    const who = ename(id);
    if (kind === 'score') {
      const pct = f.hitRate != null ? `${Math.round(Number(f.hitRate) * 100)}%` : '—';
      frag.append(el('div', { class: 'fc fc-score' },
        el('span', { class: 'fc-who' }, who),
        el('span', {}, `track record · ${formatInt(f.hits)} hits / ${formatInt(f.total)} · ${pct}`)));
    } else {
      const dir = stringOf(f.direction);
      const line = kind === 'open'
        ? `${dir} ${stringOf(f.asset).toUpperCase()} · ${f.hoursLeft != null ? f.hoursLeft + ' h left' : 'open'}${f.confidence != null ? ' · ' + Math.round(Number(f.confidence) * 100) + '%' : ''}`
        : `settled ${dir} ${stringOf(f.asset).toUpperCase()} · ${f.hit ? 'hit' : 'miss'} · ${f.movePct != null ? (Number(f.movePct) >= 0 ? '+' : '') + formatDecimal(f.movePct, 2) + '%' : '—'}`;
      frag.append(el('div', { class: 'fc' },
        el('span', { class: 'fc-who' }, who),
        el('span', {}, line)));
    }
  }
  body.replaceChildren(frag);
}

/* ------------------------------------------------------------------ */
/* render: where the money goes (live rent address)                    */
/* ------------------------------------------------------------------ */
function renderMoney() {
  const to = $('#flow-rent-to');
  if (!to) return;
  let addr = '';
  for (const id of ['e1', 'e2']) {
    const d = ent(id);
    if (d && d.ok && d.root && typeof d.root.rentAddress === 'string' && d.root.rentAddress.trim()) {
      addr = d.root.rentAddress.trim();
      break;
    }
  }
  if (addr) {
    to.textContent = addr;
    to.title = addr;
  } else {
    to.textContent = 'the landlord address in the enclave config';
    to.title = '';
  }
}

/* ------------------------------------------------------------------ */
/* trade dialog (BUY | SELL memo → ZIP-321)                            */
/* ------------------------------------------------------------------ */
const TRADE_MEMO_MAX = 512;    // Zcash memo field, bytes
const TRADE_MIN_ZEC = 0.1;     // engine default minZats 10_000_000
const TRADE_MAX_ZEC = 1;       // fallback max; /trades may override
const SELL_ZATS = 10_000;      // sell memo amount: no engine minimum, so 10k zats

const tradeState = {
  mode: 'buy',
  who: 'e1',
  checking: { e1: false, e2: false },
  maxZec: { e1: TRADE_MAX_ZEC, e2: TRADE_MAX_ZEC },
  receiptSig: '',
  receipt: null,
};

/* -- client-side parity with enclave/src/trade/address.mjs -- */
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Bytes(s) {
  let zeros = 0;
  while (zeros < s.length && s[zeros] === '1') zeros++;
  let n = 0n;
  for (const c of s) {
    const v = B58.indexOf(c);
    if (v < 0) throw new Error('bad base58');
    n = n * 58n + BigInt(v);
  }
  const out = [];
  while (n > 0n) { out.push(Number(n & 0xffn)); n >>= 8n; }
  out.reverse();
  return new Uint8Array([...new Array(zeros).fill(0), ...out]);
}
function isValidMint(s) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return false;
  try { return base58Bytes(s).length === 32; } catch { return false; }
}

const B32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const B32_GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
const BECH32_CONST = 1;
const BECH32M_CONST = 0x2bc830a3;
function bech32Polymod(values) {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= B32_GEN[i];
  }
  return chk >>> 0;
}
function hrpExpand(hrp) {
  const out = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >>> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}
function addressKind(s) {
  if (/^u1[0-9a-z]+$/.test(s.toLowerCase())) return 'unified';
  if (/^zs1[0-9a-z]+$/.test(s.toLowerCase())) return 'sapling';
  if (/^t[0-9a-zA-Z]{20,}$/.test(s)) return 'transparent';
  return 'unknown';
}
function validateZcashAddress(s) {
  const kind = addressKind(s);
  if (kind === 'unknown') return { ok: false, kind };
  if (kind === 'transparent') return { ok: true, kind };
  let decoded;
  try {
    const raw = String(s ?? '');
    if (!raw) return { ok: false, kind };
    if (raw.length > 1023) return { ok: false, kind };
    if (raw !== raw.toLowerCase() && raw !== raw.toUpperCase()) return { ok: false, kind };
    const norm = raw.toLowerCase();
    const pos = norm.lastIndexOf('1');
    if (pos < 1 || pos + 7 > norm.length) throw new Error('separator');
    const hrp = norm.slice(0, pos);
    const words = [];
    for (const c of norm.slice(pos + 1)) {
      const v = B32.indexOf(c);
      if (v < 0) throw new Error('char');
      words.push(v);
    }
    const constant = bech32Polymod([...hrpExpand(hrp), ...words]);
    if (constant !== BECH32_CONST && constant !== BECH32M_CONST) throw new Error('checksum');
    decoded = { hrp, words: words.slice(0, -6), constant };
  } catch { return { ok: false, kind }; }
  if (kind === 'unified') {
    if (decoded.hrp !== 'u' || decoded.constant !== BECH32M_CONST) return { ok: false, kind };
    if (decoded.words.length < 16) return { ok: false, kind };
  } else {
    if (decoded.hrp !== 'zs' || decoded.constant !== BECH32_CONST) return { ok: false, kind };
    if (decoded.words.length < 60) return { ok: false, kind };
  }
  return { ok: true, kind };
}
function validateReturnAddress(s) {
  const v = validateZcashAddress(s);
  if (!v.ok) return v;
  if (v.kind === 'transparent') return { ok: false, kind: v.kind };
  if (v.kind !== 'unified' && v.kind !== 'sapling') return { ok: false, kind: v.kind };
  return v;
}

/* -- live gate: /trades answers with enabled:true ⇔ live -- */
function isTradeLive(id) {
  const c = tradesCache[id];
  return Boolean(c && c.ok && !c.notFound && c.data && c.data.enabled === true);
}

async function checkTradeLive(id) {
  const d = ent(id);
  tradeState.checking[id] = true;
  renderTrade();
  if (d && d.base) {
    const r = await request(d.base, '/trades', { allow404: true });
    tradesCache[id] = r;
    const data = (r && r.ok && !r.notFound && r.data && typeof r.data === 'object') ? r.data : null;
    if (data) {
      const maxZats = Number(data.maxZats ?? (data.limits && data.limits.maxZats));
      if (Number.isFinite(maxZats) && maxZats > 0) tradeState.maxZec[id] = maxZats / 1e8;
    }
  } else {
    tradesCache[id] = { ok: false, notFound: true };
  }
  tradeState.checking[id] = false;
  renderTrade();
  renderTradeGate();
}

/* -- memo builders (canonical strings mirroring orders.mjs parseBuy/parseSell) -- */
function buildBuyMemo() {
  const token = ($('#trade-token').value || '').trim();
  const targetRaw = ($('#trade-target').value || '').trim();
  const stopRaw = ($('#trade-stop').value || '').trim();
  const ret = ($('#trade-return').value || '').trim();
  let err = null;

  const asset = token.startsWith('$') ? token.slice(1) : token;
  if (!token) err = 'buy needs a mint or ticker';
  else if (!asset) err = 'empty ticker';
  else if (!isValidMint(asset) && !/^[A-Za-z0-9._-]{1,20}$/.test(asset)) err = 'invalid ticker or mint';

  let targetPct = null;
  if (targetRaw !== '') {
    const n = Number(targetRaw);
    if (!Number.isFinite(n) || !(n > 0 && n <= 1000)) { if (!err) err = 'target must be >0 and ≤1000'; }
    else targetPct = n;
  }
  let stopPct = null;
  if (stopRaw !== '') {
    const n = Number(stopRaw);
    const mag = Math.abs(n);
    if (!Number.isFinite(n) || !(mag > 0 && mag <= 90)) { if (!err) err = 'stop must be >0 and ≤90'; }
    else stopPct = mag;
  }
  if (!ret) { if (!err) err = 'return needs a shielded u1/zs1 address'; }
  else if (!validateReturnAddress(ret).ok) { if (!err) err = 'return must be a shielded u1/zs1 address'; }
  if (err) return { memo: null, err };

  let memo = `buy ${token}`;
  if (targetPct != null) memo += ` target +${targetPct}%`;
  if (stopPct != null) memo += ` stop -${stopPct}%`;
  memo += ` return ${ret}`;
  return { memo, err: null };
}

function buildSellMemo() {
  const orderId = ($('#trade-orderid').value || '').trim().toLowerCase();
  const key = ($('#trade-key').value || '').trim().toLowerCase();
  let err = null;
  if (!orderId) err = 'sell needs an orderId';
  else if (!/^o[0-9a-f]{16}$/.test(orderId)) err = 'invalid orderId (o + 16 hex)';
  if (key && !/^[0-9a-f]{6}$/.test(key)) { if (!err) err = 'key must be 6 hex characters'; }
  if (err) return { memo: null, err };
  let memo = `sell ${orderId}`;
  if (key) memo += ` key ${key}`;
  return { memo, err: null };
}

function copyText(text, node) {
  if (!text || !node) return;
  const prev = node.textContent;
  const done = (ok) => {
    node.textContent = ok ? 'Copied' : 'Copy failed';
    setTimeout(() => { node.textContent = prev; }, 1400);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => done(true), () => done(false));
  } else {
    done(false);
  }
}

/* -- render -- */
function renderTrade() {
  const dlg = $('#trade');
  if (!dlg || !dlg.open) return;
  const who = tradeState.who;
  const d = ent(who);
  const checking = tradeState.checking[who] === true;
  const live = !checking && isTradeLive(who);
  const maxZec = tradeState.maxZec[who] ?? TRADE_MAX_ZEC;
  const isBuy = tradeState.mode === 'buy';
  if (!isBuy) hideReceipt();

  $$('#trade [data-trade-tab]').forEach((b) => {
    const on = b.dataset.tradeTab === tradeState.mode;
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  const buyPanel = $('#trade [data-trade-panel="buy"]');
  const sellPanel = $('#trade [data-trade-panel="sell"]');
  if (buyPanel) buyPanel.hidden = !isBuy;
  if (sellPanel) sellPanel.hidden = isBuy;

  const range = $('#trade-range');
  if (range) range.textContent = `min ${TRADE_MIN_ZEC} · max ${maxZec} ZEC`;
  const amt = $('#trade-amount');
  if (amt) { amt.min = String(TRADE_MIN_ZEC); amt.max = String(maxZec); }

  let memo = null, err = null, amountZec = 0;
  if (isBuy) {
    const a = Number(amt ? amt.value : 0);
    amountZec = a;
    if (!Number.isFinite(a) || a < TRADE_MIN_ZEC || a > maxZec) err = `amount must be ${TRADE_MIN_ZEC}–${maxZec} ZEC`;
    const b = buildBuyMemo();
    if (b.err && !err) err = b.err;
    memo = b.memo;
  } else {
    const s = buildSellMemo();
    if (s.err) err = s.err;
    memo = s.memo;
    amountZec = SELL_ZATS / 1e8;
  }

  const bytes = memo ? new TextEncoder().encode(memo).length : 0;
  const memoTextEl = isBuy ? $('#trade-memo-text') : $('#trade-memo-sell');
  const bytesEl = isBuy ? $('#trade-bytes') : $('#trade-bytes-sell');
  if (memoTextEl) memoTextEl.textContent = memo || '…';
  if (bytesEl) bytesEl.textContent = `${bytes} / ${TRADE_MEMO_MAX} bytes`;
  const memoBox = memoTextEl ? memoTextEl.closest('.trade-memo') : null;
  if (memoBox) memoBox.classList.toggle('over', bytes > TRADE_MEMO_MAX);
  if (bytes > TRADE_MEMO_MAX && !err) err = `memo is ${bytes} bytes, over the ${TRADE_MEMO_MAX}-byte Zcash limit`;

  const notlive = $('#trade-notlive');
  const out = $('#trade-out');
  const qr = $('#trade-qr');
  const open = $('#trade-open');
  const copyBtn = $('#trade-copy');
  const addrEl = $('#trade-addr');
  if (addrEl) addrEl.textContent = (d && d.address) ? `${ename(who)}'s shielded address: ${d.address}` : '';

  const disable = () => {
    open.removeAttribute('href');
    open.classList.add('is-off');
    open.setAttribute('aria-disabled', 'true');
    copyBtn.disabled = true;
    copyBtn.classList.add('is-off');
  };
  const enable = (uri) => {
    open.href = uri;
    open.classList.remove('is-off');
    open.removeAttribute('aria-disabled');
    copyBtn.disabled = false;
    copyBtn.classList.remove('is-off');
    copyBtn.onclick = (ev) => uri && copyText(uri, ev.target);
  };

  if (checking) {
    notlive.hidden = true;
    out.hidden = true;
    disable();
    hideReceipt();
    return;
  }
  if (!live) {
    notlive.hidden = false;
    out.hidden = true;
    disable();
    qr.replaceChildren(el('p', { class: 'err' }, 'Trades are not live on this entity.'));
    hideReceipt();
    return;
  }
  notlive.hidden = true;
  if (err || !memo || !d || !d.address) {
    out.hidden = false;
    disable();
    qr.replaceChildren(el('p', { class: 'err' }, err || 'no address published by this enclave right now'));
    hideReceipt();
    return;
  }
  out.hidden = false;
  if (isBuy) renderReceipt(who, amountZec);
  let uri = '';
  try {
    uri = zip321Uri(d.address, memo, amountZec);
    qr.innerHTML = qrSvg(uri, { ecLevel: 'M', ariaLabel: `open trade with ${ename(who)}` });
    enable(uri);
  } catch (qrerr) {
    disable();
    qr.replaceChildren(el('p', { class: 'err' }, (qrerr && qrerr.message) ? qrerr.message : 'QR error'));
  }
}

function openTrade({ who = null } = {}) {
  const dlg = $('#trade');
  if (!dlg) return;
  const ids = list().map((d) => d.id);
  if (!who) who = ids.find((id) => isTradeLive(id)) || tradeState.who || (ids[0] || 'e1');
  tradeState.who = who;
  tradeState.mode = 'buy';
  $('#trade-who').replaceChildren(
    el('legend', {}, 'entity'),
    ...list().map((d) => el('label', { class: 'seg-item' },
      el('input', { type: 'radio', name: 'trade-who', value: d.id, ...(d.id === tradeState.who ? { checked: '' } : {}), ...(d.state === 'dead' ? { disabled: '' } : {}), onchange: () => { tradeState.who = d.id; void checkTradeLive(d.id); } }),
      el('span', {}, `${nameOf(d)} · ${stateWord(d)}`))));
  if (!dlg.open) { dlg.showModal(); document.dispatchEvent(new CustomEvent('zealot:trade-open')); }
  void checkTradeLive(tradeState.who);
  const tok = $('#trade-token');
  if (tok) tok.focus({ preventScroll: true });
}

/* -- trades section: NOT LIVE YET box + button switch per entity -- */
function renderTradeGate() {
  const btn = $('#trade-open-btn');
  const note = $('#trades-notlive');
  if (!btn) return;
  const anyLive = ['e1', 'e2'].some((id) => isTradeLive(id));
  if (anyLive) {
    btn.disabled = false;
    btn.classList.remove('is-off');
    btn.removeAttribute('aria-disabled');
    btn.textContent = 'Open a trade';
    if (note) note.hidden = true;
  } else {
    btn.disabled = true;
    btn.classList.add('is-off');
    btn.setAttribute('aria-disabled', 'true');
    btn.textContent = 'Open a trade · not live yet';
    if (note) note.hidden = false;
  }
}

function wireTradeForm() {
  const dlg = $('#trade');
  const form = $('#trade-form');
  if (!dlg || !form) return;
  form.addEventListener('submit', (e) => {
    if (!(e.submitter && e.submitter.matches('.x'))) e.preventDefault();
  });
  $$('#trade [data-trade-tab]').forEach((b) => b.addEventListener('click', () => {
    tradeState.mode = b.dataset.tradeTab;
    renderTrade();
  }));
  for (const id of ['trade-amount', 'trade-token', 'trade-target', 'trade-stop', 'trade-return', 'trade-orderid', 'trade-key']) {
    const n = $('#' + id);
    if (n) n.addEventListener('input', renderTrade);
  }
  const chips = $('#trade-chips');
  if (chips) {
    chips.replaceChildren(...['SOL', 'USDC', 'JUP'].map((t) =>
      el('button', { class: 'trade-chip', type: 'button', text: t, onclick: () => { const n = $('#trade-token'); if (n) { n.value = t; renderTrade(); } } })));
  }
}

/* ------------------------------------------------------------------ */
/* receipts + my trades (v20)                                          */
/* ------------------------------------------------------------------ */
const RECEIPTS_KEY = 'zealot.receipts';

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const shortenAddr = (a) => (typeof a === 'string' && a.length > 20 ? `${a.slice(0, 10)}…${a.slice(-6)}` : a);

function formatHeld(ms) {
  const s = Math.floor(num(ms) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

/* base64url (RFC 4648 §5) decode, complementing qr.js base64UrlEncode */
function base64UrlDecode(s) {
  let str = String(s ?? '').replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function buildReceiptCode({ e, returnAddress, token, amountZec, target, stop, createdISO }) {
  const obj = { v: 1, e, r: returnAddress, m: token, a: amountZec, t: target ?? null, s: stop ?? null, c: createdISO };
  return 'ZLT-' + base64UrlEncode(JSON.stringify(obj));
}

function decodeReceiptCode(code) {
  const str = String(code ?? '').trim();
  if (!str.startsWith('ZLT-')) return null;
  try {
    const obj = JSON.parse(base64UrlDecode(str.slice(4)));
    if (!obj || typeof obj !== 'object' || obj.v !== 1) return null;
    if (typeof obj.e !== 'string' || typeof obj.r !== 'string') return null;
    return {
      code: str,
      entity: obj.e,
      returnAddress: obj.r,
      token: typeof obj.m === 'string' ? obj.m : '',
      amountZec: num(obj.a),
      target: obj.t == null ? null : num(obj.t),
      stop: obj.s == null ? null : num(obj.s),
      createdISO: typeof obj.c === 'string' ? obj.c : null,
    };
  } catch { return null; }
}

function loadReceipts() {
  try {
    const raw = localStorage.getItem(RECEIPTS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

function upsertReceipt(r) {
  try {
    const list = loadReceipts();
    const idx = list.findIndex((x) => x && x.code === r.code);
    if (idx >= 0) list[idx] = r; else list.push(r);
    localStorage.setItem(RECEIPTS_KEY, JSON.stringify(list));
    return true;
  } catch { return false; }
}

function forgetReceipt(code) {
  try {
    localStorage.setItem(RECEIPTS_KEY, JSON.stringify(loadReceipts().filter((x) => x && x.code !== code)));
    return true;
  } catch { return false; }
}

function saveReceiptFile(r) {
  const lines = [
    'ZEALOT ONE-TRADE RECEIPT',
    '------------------------',
    `entity     ${ename(r.entity)}`,
    `token      ${r.token || '—'}`,
    `amount     ${formatDecimal(r.amountZec, 8)} ZEC`,
    `target     ${r.target != null ? '+' + r.target + '%' : '—'}`,
    `stop       ${r.stop != null ? '-' + r.stop + '%' : '—'}`,
    `fee        1% open + 1% close`,
    `created    ${r.createdISO || '—'}`,
    `return     ${r.returnAddress}`,
    '',
    'RECEIPT CODE',
    r.code,
    '',
    'Track or close this trade:',
    '1. Open the ZEALOT site and choose "My trades".',
    '2. Paste this RECEIPT CODE (or the return address).',
    '3. While it is holding, "Close trade now" builds a tiny sell payment.',
    '',
    'Keep this private: the code contains your return address.',
  ];
  try {
    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: `zealot-${(r.code || 'receipt').slice(0, 24)}.txt` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch { /* download unavailable */ }
}

function renderReceiptCard(r) {
  const row = (k, v) => el('div', { class: 'rc-row' },
    el('span', { class: 'rc-k' }, k),
    el('span', { class: 'rc-v' }, v));
  return el('div', { class: 'receipt' },
    el('div', { class: 'receipt-head' },
      el('span', { class: 'receipt-brand' }, 'ZEALOT'),
      el('span', { class: 'receipt-sub' }, 'ONE-TRADE RECEIPT')),
    el('div', { class: 'receipt-dash' }),
    el('div', { class: 'receipt-body' },
      row('entity', ename(r.entity)),
      row('token', r.token || '—'),
      row('amount', `${formatDecimal(r.amountZec, 8)} ZEC`),
      row('target', r.target != null ? `+${r.target}%` : '—'),
      row('stop', r.stop != null ? `-${r.stop}%` : '—'),
      row('fee', '1% open + 1% close'),
      row('created', r.createdISO ? fmtStamp(r.createdISO) : '—'),
      row('return', shortenAddr(r.returnAddress))),
    el('div', { class: 'receipt-dash' }),
    el('div', { class: 'receipt-code' }, r.code),
    el('p', { class: 'receipt-warn' }, 'Keep this receipt. It is the only way to find and close your trade; it contains your return address, so keep it private.'),
    el('div', { class: 'receipt-actions' },
      el('button', { class: 'btn ghost', type: 'button', text: 'Copy receipt code', onclick: (ev) => copyText(r.code, ev.target) }),
      el('button', { class: 'btn ghost', type: 'button', text: 'Save receipt', onclick: () => saveReceiptFile(r) })));
}

function hideReceipt() {
  const box = $('#trade-receipt');
  if (box) box.hidden = true;
  tradeState.receipt = null;
  tradeState.receiptSig = '';
}

function renderReceipt(who, amountZec) {
  const box = $('#trade-receipt');
  if (!box) return;
  const token = ($('#trade-token').value || '').trim();
  const targetRaw = ($('#trade-target').value || '').trim();
  const stopRaw = ($('#trade-stop').value || '').trim();
  const ret = ($('#trade-return').value || '').trim();
  if (!token || !ret || !validateReturnAddress(ret).ok) { hideReceipt(); return; }
  const target = targetRaw !== '' ? num(targetRaw) : null;
  const stop = stopRaw !== '' ? Math.abs(num(stopRaw)) : null;
  const sig = [who, token, amountZec, target, stop, ret].join('\u0001');
  if (sig !== tradeState.receiptSig || !tradeState.receipt) {
    tradeState.receiptSig = sig;
    const createdISO = new Date().toISOString();
    const code = buildReceiptCode({ e: who, returnAddress: ret, token, amountZec, target, stop, createdISO });
    tradeState.receipt = { code, entity: who, token, amountZec, target, stop, createdISO, returnAddress: ret };
  }
  upsertReceipt(tradeState.receipt); // auto-save so this browser remembers
  box.hidden = false;
  box.replaceChildren(renderReceiptCard(tradeState.receipt));
}

/* ---- my trades ---- */
const myTrades = { extra: [], timer: null };

const STEPS = ['Paid?', 'Received', 'Swapping', 'Bought', 'Holding', 'Closing', 'Paid back'];

function stepIndex(status) {
  if (!status.rec) return -1;
  const d = status.detail || {};
  const st = d.state || 'open';
  if (st === 'refunded' || st === 'closed') return STEPS.length;
  if (st === 'failed' || st === 'abandoned') return 0;
  let reached = 2;
  if (['screening', 'quoted', 'depositing', 'bridging', 'buying', 'holding', 'closing', 'paying'].includes(st)) reached = 3;
  if (d.entryPrice != null || status.open || ['holding', 'closing', 'paying'].includes(st)) reached = 4;
  if (['holding', 'closing', 'paying'].includes(st)) reached = 5;
  if (['closing', 'paying'].includes(st) || status.close) reached = 6;
  return reached;
}

function stepTracker(status) {
  const reached = stepIndex(status);
  const track = el('div', { class: 'mt-steps' });
  STEPS.forEach((label, i) => {
    const done = reached > i;
    const active = reached === i;
    track.append(el('div', { class: 'mt-step' + (done ? ' done' : '') + (active ? ' active' : '') },
      el('span', { class: 'mt-dot' }),
      el('span', { class: 'mt-step-label' }, label)));
  });
  return track;
}

function priceBar(status, entryP, curP) {
  const r = status.receipt;
  const d = status.detail || {};
  const target = r.target != null ? r.target : (d.targetPct != null ? d.targetPct : null);
  const stop = r.stop != null ? r.stop : (d.stopPct != null ? d.stopPct : null);
  const entry = num(entryP);
  if (!entry || (target == null && stop == null)) return null;
  const low = entry * (1 - (stop != null ? stop : 0) / 100);
  const high = entry * (1 + (target != null ? target : 0) / 100);
  const span = Math.max(high - low, 1e-9);
  const cur = num(curP) || entry;
  const entryPct = clamp(((entry - low) / span) * 100, 0, 100);
  const curPct = clamp(((cur - low) / span) * 100, 0, 100);
  return el('div', { class: 'mt-bar' },
    el('span', { class: 'mt-bar-stop mono' }, stop != null ? `-${stop}%` : ''),
    el('span', { class: 'mt-bar-track' },
      el('span', { class: 'mt-bar-entry', style: `left:${entryPct.toFixed(2)}%` }),
      el('span', { class: 'mt-bar-cur', style: `left:${curPct.toFixed(2)}%` })),
    el('span', { class: 'mt-bar-target mono' }, target != null ? `+${target}%` : ''));
}

function closeBlock(status) {
  const d = status.detail || {};
  const st = d.state || 'open';
  const wrap = el('div', { class: 'mt-close' });
  if (st === 'holding') {
    const sellMemo = `sell ${status.orderId} key ${status.auth6}`;
    const entity = ent(status.receipt.entity);
    const qrEl = el('div', { class: 'qr mt-qr' });
    const openEl = el('a', { class: 'btn fill', href: '#', rel: 'noopener', target: '_blank' }, 'Open in Zcash wallet', el('span', { class: 'arr', 'aria-hidden': 'true' }, ' ↗'));
    let uri = '';
    if (entity && entity.address) {
      uri = zip321Uri(entity.address, sellMemo, SELL_ZATS / 1e8);
      qrEl.innerHTML = qrSvg(uri, { ecLevel: 'M', ariaLabel: `close trade ${status.orderId}` });
      openEl.href = uri;
    } else {
      qrEl.replaceChildren(el('p', { class: 'err' }, 'no address published right now'));
      openEl.removeAttribute('href');
      openEl.classList.add('is-off');
    }
    const sub = el('div', { class: 'mt-close-sub', hidden: '' },
      el('code', { class: 'mt-memo' }, sellMemo),
      qrEl,
      openEl,
      el('p', { class: 'mt-note' }, 'Send this tiny payment to close. ZEC comes back to your return address.'));
    wrap.append(
      el('button', { class: 'btn fill mt-close-btn', type: 'button', text: 'Close trade now', onclick: () => { sub.hidden = !sub.hidden; } }),
      sub,
      el('a', { class: 'mt-forget', href: '#', onclick: (ev) => { ev.preventDefault(); openSellPrefill({ who: status.receipt.entity, orderId: status.orderId, auth6: status.auth6 }); } }, 'or pre-fill the SELL tab'));
  } else if (st === 'closing' || st === 'paying') {
    wrap.append(el('p', { class: 'mt-note' }, 'Closing… selling and swapping back to ZEC. Give it a minute or two.'));
  } else if (st === 'closed') {
    const pay = status.payout;
    const zats = pay?.data?.zats != null ? pay.data.zats : d.payoutZats;
    const txid = pay?.data?.txid ?? d.txids?.close ?? null;
    wrap.append(el('p', { class: 'mt-note mt-paid' }, `Paid back ${zats != null ? formatZats(zats) + ' ZEC' : '—'}${txid ? ' · tx ' + shortHash(txid) : ''}`));
  } else if (st === 'refunded') {
    const ref = status.refund ?? status.refundSkipped;
    const zats = ref?.data?.zats ?? null;
    const reason = ref?.data?.reason ?? d.reason ?? null;
    wrap.append(el('p', { class: 'mt-note' }, `Refunded${zats != null ? ' ' + formatZats(zats) + ' ZEC' : ''}${reason ? ' · ' + reason : ''}`));
  } else if (st === 'failed' || st === 'abandoned') {
    const f = status.failed ?? status.abandoned;
    const code = f?.data?.code ?? f?.data?.stage ?? null;
    wrap.append(el('p', { class: 'mt-note err' }, `Trade ${st}${code ? ' · ' + code : ''}. The entity will settle or refund; check back.`));
  }
  return wrap;
}

function forgetLink(r) {
  return el('a', {
    class: 'mt-forget',
    href: '#',
    onclick: (ev) => {
      ev.preventDefault();
      if (r.code) forgetReceipt(r.code);
      myTrades.extra = myTrades.extra.filter((x) => x !== r);
      void refreshMyTrades();
    },
  }, 'Forget this receipt');
}

function myTradeCardSkeleton(r) {
  return el('div', { class: 'mt-card' },
    el('div', { class: 'mt-head' },
      el('span', { class: 'mt-entity' }, ename(r.entity)),
      el('span', { class: 'mt-token mono' }, r.token || '—'),
      el('span', { class: 'mt-amt mono' }, r.amountZec > 0 ? `${formatDecimal(r.amountZec, 8)} ZEC` : '')),
    el('div', { class: 'mt-wait' },
      el('span', { class: 'spinner' }),
      el('span', {}, 'Looking for your order…')));
}

function myTradeCard(status) {
  const r = status.receipt;
  const d = status.detail || {};
  const card = el('div', { class: 'mt-card' });
  card.append(el('div', { class: 'mt-head' },
    el('span', { class: 'mt-entity' }, ename(r.entity)),
    el('span', { class: 'mt-token mono' }, r.token || '—'),
    el('span', { class: 'mt-amt mono' }, r.amountZec > 0 ? `${formatDecimal(r.amountZec, 8)} ZEC` : '')));

  if (status.error) {
    card.append(el('p', { class: 'mt-note err' }, status.error));
    card.append(forgetLink(r));
    return card;
  }
  if (!status.rec) {
    card.append(el('div', { class: 'mt-wait' },
      el('span', { class: 'spinner' }),
      el('span', {}, 'Waiting for your payment to arrive (shielded payments take a few minutes)')));
    card.append(forgetLink(r));
    return card;
  }

  card.append(stepTracker(status));

  const entryP = d.entryPrice != null ? d.entryPrice : (status.open?.data?.price ?? null);
  const curP = d.currentPrice != null ? d.currentPrice : (status.jump?.data?.to ?? entryP);
  const pnl = d.unrealizedPct != null ? d.unrealizedPct : (entryP && curP ? (num(curP) / num(entryP) - 1) * 100 : null);
  const held = d.heldMs != null ? d.heldMs : (d.openedAt ? Date.now() - Date.parse(d.openedAt) : null);
  const rows = [
    ['amount in', status.rec.data.zats != null ? `${formatZats(status.rec.data.zats)} ZEC` : '—'],
    ['entry price', entryP != null ? `${formatDecimal(entryP, 6)} SOL` : '—'],
    ['current price', curP != null ? `${formatDecimal(curP, 6)} SOL` : '—'],
    ['pnl', pnl != null ? `${pnl >= 0 ? '+' : ''}${formatDecimal(pnl, 1)}%` : '—'],
    ['held', held != null ? formatHeld(held) : '—'],
  ];
  card.append(el('dl', { class: 'mt-kvs' }, ...rows.map(([k, v]) => el('div', {}, el('dt', {}, k), el('dd', {}, v)))));

  const bar = priceBar(status, entryP, curP);
  if (bar) card.append(bar);

  card.append(closeBlock(status));
  card.append(forgetLink(r));
  return card;
}

async function resolveReceipt(receipt, cache) {
  const clientRef = (await sha256Hex('client|' + receipt.returnAddress)).slice(0, 16);
  const auth6 = (await sha256Hex('auth|' + receipt.returnAddress)).slice(0, 6);
  const d = ent(receipt.entity);
  if (!d || !d.base) {
    return { receipt, clientRef, auth6, orderId: null, rec: null, detail: null, error: 'no endpoint for this entity' };
  }
  let entries;
  if (cache.has(receipt.entity)) {
    entries = cache.get(receipt.entity);
  } else {
    const r = await request(d.base, '/ledger', { text: true });
    entries = (r && r.ok && r.text) ? parseLedger(r.text).entries : (d.entries || []);
    cache.set(receipt.entity, entries);
  }
  const recs = entries.filter((e) => e && e.type === 'order_received' && e.data && e.data.clientRef === clientRef);
  let rec = null;
  if (recs.length) {
    // Prefer the order that matches this receipt's amount (a return address can
    // host several historical orders), otherwise the most recent.
    const wantZats = Math.round(receipt.amountZec * 1e8);
    if (receipt.amountZec > 0) {
      const byAmount = recs.filter((e) => num(e.data.zats) === wantZats);
      rec = byAmount[byAmount.length - 1] || recs[recs.length - 1];
    } else {
      rec = recs[recs.length - 1];
    }
  }
  const orderId = rec ? rec.data.orderId : null;
  let detail = null;
  if (orderId) {
    const rd = await request(d.base, '/trades/' + orderId, { allow404: true });
    detail = (rd && rd.ok && !rd.notFound && rd.data && typeof rd.data === 'object') ? rd.data : null;
  }
  const mine = orderId ? entries.filter((e) => e && e.data && e.data.orderId === orderId) : [];
  const byType = {};
  for (const e of mine) if (!byType[e.type]) byType[e.type] = e;
  return {
    receipt, clientRef, auth6, orderId, rec, detail,
    open: byType.trade_open, close: byType.trade_close, payout: byType.payout,
    refund: byType.refund, refundSkipped: byType.refund_skipped,
    failed: byType.trade_failed, abandoned: byType.trade_abandoned, jump: byType.trade_price_jump,
    error: null,
  };
}

function currentMyReceipts() {
  return [...loadReceipts(), ...myTrades.extra];
}

async function refreshMyTrades() {
  const box = $('#mytrades-list');
  if (!box) return;
  const items = currentMyReceipts();
  if (!items.length) {
    box.replaceChildren(el('p', { class: 'empty' }, 'No receipts yet. Open a trade and keep the receipt, or paste a receipt code.'));
    return;
  }
  box.replaceChildren(...items.map((r) => myTradeCardSkeleton(r)));
  const cache = new Map();
  const results = [];
  for (const r of items) results.push(await resolveReceipt(r, cache));
  box.replaceChildren(...results.map((s) => myTradeCard(s)));
}

function onAddMyTrade() {
  const box = $('#mytrades-list');
  const raw = ($('#mytrades-paste').value || '').trim();
  if (!raw) return;
  let receipt = null;
  if (raw.startsWith('ZLT-')) {
    receipt = decodeReceiptCode(raw);
    if (!receipt && box) box.prepend(el('p', { class: 'mt-err' }, 'That receipt code does not decode.'));
  } else if (validateReturnAddress(raw).ok) {
    const entity = $('#mytrades-entity')?.value || 'e1';
    receipt = { code: null, entity, returnAddress: raw, token: '', amountZec: 0, target: null, stop: null, createdISO: null };
  } else if (box) {
    box.prepend(el('p', { class: 'mt-err' }, 'Paste a receipt code (ZLT-…) or a shielded return address (u1…/zs1…).'));
  }
  if (!receipt) return;
  if (!myTrades.extra.some((x) => x === receipt || (x.code && receipt.code && x.code === receipt.code))) myTrades.extra.push(receipt);
  $('#mytrades-paste').value = '';
  void refreshMyTrades();
}

function startMyTradesPoll() {
  stopMyTradesPoll();
  myTrades.timer = setInterval(() => {
    const dlg = $('#mytrades');
    if (dlg && dlg.open) void refreshMyTrades();
  }, 20000);
}

function stopMyTradesPoll() {
  if (myTrades.timer) { clearInterval(myTrades.timer); myTrades.timer = null; }
}

function openMyTrades() {
  const dlg = $('#mytrades');
  if (!dlg) return;
  const sel = $('#mytrades-entity');
  if (sel) sel.replaceChildren(...list().map((d) => el('option', { value: d.id }, `${nameOf(d)} · ${stateWord(d)}`)));
  if (!dlg.open) dlg.showModal();
  void refreshMyTrades();
  startMyTradesPoll();
}

function openSellPrefill({ who, orderId, auth6 }) {
  openTrade({ who });
  tradeState.mode = 'sell';
  const oi = $('#trade-orderid');
  if (oi) oi.value = orderId || '';
  const k = $('#trade-key');
  if (k) k.value = auth6 || '';
  renderTrade();
}

function wireMyTrades() {
  const add = $('#mytrades-add');
  if (add) add.addEventListener('click', onAddMyTrade);
  const paste = $('#mytrades-paste');
  if (paste) paste.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); onAddMyTrade(); } });
  const dlg = $('#mytrades');
  if (dlg) dlg.addEventListener('close', stopMyTradesPoll);
}

/* ?selftest=1 — verify browser hashing matches enclave/src/trade/orders.mjs */
async function runSelfTest() {
  const addr1 = 'u1testaddress000000000000000000000000000000000000000000000000000000';
  const addr2 = 'zs1realishaddr';
  const got = {
    clientRef: (await sha256Hex('client|' + addr1)).slice(0, 16),
    auth6: (await sha256Hex('auth|' + addr1)).slice(0, 6),
    orderId: 'o' + (await sha256Hex('trade|abc123txid|' + addr1)).slice(0, 16),
    clientRef2: (await sha256Hex('client|' + addr2)).slice(0, 16),
    auth6_2: (await sha256Hex('auth|' + addr2)).slice(0, 6),
  };
  const want = {
    clientRef: '3046776fbe272e0f',
    auth6: 'bad7f3',
    orderId: 'o7c018e82f1284525',
    clientRef2: 'bca707d8a3644693',
    auth6_2: '8f669d',
  };
  let all = true;
  for (const k of Object.keys(want)) {
    const ok = got[k] === want[k];
    if (!ok) all = false;
    console.log(`[selftest] ${k}: ${ok ? 'OK' : 'FAIL'} (got ${got[k]}, want ${want[k]})`);
  }
  const summary = `[selftest] ${all ? 'PASS' : 'FAIL'} — sha256 hex, lowercase, UTF-8 string concat matches orders.mjs`;
  console.log(summary);
  const log = $('#log');
  if (log) log.append(el('p', { class: 'line signal' }, summary));
  return all;
}

/* ------------------------------------------------------------------ */
/* render: ledger (last 40, interleaved)                               */
/* ------------------------------------------------------------------ */
const renderedLedger = new Set();

function entryAmount(e) {
  const d = e.data || {};
  switch (e.type) {
    case 'rent_paid': return `${formatInt(d.rentZats)} zats`;
    case 'letter': return `${formatInt(d.zats)} zats`;
    case 'paywall': return `${formatInt(d.priceZats)} zats`;
    case 'swap_quote': return `${formatDecimal(d.amountIn)} ${stringOf(d.from) || ''}`.trim();
    case 'wallet': return `${stringOf(d.chain)} · ${shortHash(d.address)}`;
    case 'post_public': return truncate(d.text, 22);
    case 'whisper': return `${formatInt(d.zats)} zats`;
    case 'letter': return `to the ${d.to} · ${formatInt(d.zats)} zats`;
    case 'promise': case 'bounty': return truncate(d.what || d.text || d.id, 22);
    default: return '—';
  }
}

// heartbeat and bookkeeping lines are still in the chain (and verified), just not listed here
const LEDGER_NOISE = new Set(['tick', 'tick_llm', 'tick_error', 'charge', 'tool', 'tool_error', 'llm_probe', 'wallet-sync', 'thought', 'letter_text', 'memory', 'diary']);

function renderLedger() {
  const lines = [];
  for (const id of ['e1', 'e2']) {
    const d = ent(id);
    if (!d || !Array.isArray(d.entries)) continue;
    for (const e of d.entries) if (!LEDGER_NOISE.has(e.type)) lines.push({ d, e });
  }
  lines.sort((a, b) => Date.parse(a.e.ts || 0) - Date.parse(b.e.ts || 0));
  const last = lines.slice(-40);

  const container = $('#ledger-lines');
  if (!container) return;
  const frag = document.createDocumentFragment();
  let added = false;
  for (const { d, e } of last) {
    const key = `${d.id}|${e.seq}`;
    if (!renderedLedger.has(key)) added = true;
    const line = el('div', { class: 'ledger-line' + (renderedLedger.has(key) ? '' : ' new') },
      el('span', { class: 'l-e' }, nameOf(d)),
      el('span', { class: 'l-seq mono' }, stringOf(e.seq)),
      el('span', { class: 'l-type' }, stringOf(e.type)),
      el('span', { class: 'l-amt mono' }, entryAmount(e)),
      el('span', { class: 'l-t mono' }, e.ts ? fmtStamp(e.ts) : '—'));
    renderedLedger.add(key);
    frag.append(line);
  }
  container.replaceChildren(frag);
  if (added) document.dispatchEvent(new CustomEvent('zealot:ledger-new'));
}

/* ------------------------------------------------------------------ */
/* Verify chain                                                        */
/* ------------------------------------------------------------------ */
let verifying = false;
async function onVerify() {
  if (verifying) return;
  const btn = $('#verify');
  const out = $('#verify-out');
  if (!btn || !out) return;
  const dlist = list().filter((d) => d.ledgerText);
  if (!dlist.length) {
    out.replaceChildren(el('p', { class: 'v-line dim' }, 'no ledger loaded to verify'));
    return;
  }
  verifying = true;
  btn.disabled = true;
  const frag = document.createDocumentFragment();
  for (const d of dlist) {
    frag.append(el('p', { class: 'v-line dim' }, `${nameOf(d)}: hashing…`));
    out.replaceChildren(frag);
    const r = await verifyChain(d.ledgerText, { animate: false });
    frag.append(r.ok
      ? el('p', { class: 'v-line ok' }, `${nameOf(d)}: OK · ${formatInt(r.valid)} / ${formatInt(r.total)} entries · head ${shortHash(r.head)}`)
      : el('p', { class: 'v-line bad' }, `${nameOf(d)}: FAIL · ${r.fail ? 'seq ' + r.fail.seq + ' ' : ''}${r.reason || ''}`));
    out.replaceChildren(frag);
  }
  verifying = false;
  btn.disabled = false;
}

/* The hero proof row's ledger cell: re-hash both chains once, on load. */
async function verifyBoth() {
  const cell = $('#proof-ledger');
  if (!cell) return;
  const dlist = list().filter((d) => d.ledgerText);
  if (!dlist.length) { cell.textContent = 'verifying…'; return; }
  cell.textContent = 'verifying…';
  let ok = true;
  let entries = 0;
  for (const d of dlist) {
    const r = await verifyChain(d.ledgerText, { animate: false });
    if (!r.ok) ok = false;
    entries += r.valid;
  }
  cell.textContent = ok ? `verified, ${formatInt(entries)} entries` : 'FAIL';
  if (!ok) cell.classList.add('fail');
}

/* ------------------------------------------------------------------ */
/* render: footer                                                      */
/* ------------------------------------------------------------------ */
function renderFooter() {
  const d1 = ent('e1');
  const digestEl = $('#foot-digest');
  const blockEl = $('#foot-block');
  const urls = $('#foot-urls');
  if (!digestEl || !blockEl || !urls) return;

  let compose = '—';
  if (d1 && d1.ok && d1.root && d1.root.attestation && d1.root.attestation.compose) compose = shortHash(d1.root.attestation.compose);
  else if (d1 && d1.ok && d1.app) compose = shortHash(d1.app);
  digestEl.textContent = `image digest ${compose}`;

  let blockText = 'block —';
  if (d1 && d1.ok && d1.vitals && d1.vitals.wallet && d1.vitals.wallet.sync) {
    const s = d1.vitals.wallet.sync;
    const h = s.height != null ? formatInt(s.height) : '—';
    const at = s.at ? hhmm(s.at) : null;
    blockText = `block ${h}${at ? ' · ' + at + ' UTC' : ''}`;
  } else if (d1 && !d1.ok) {
    blockText = `block ${offlineLabel(d1)}`;
  }
  blockEl.textContent = blockText;

  const kids = [];
  const dlist = ['e1', 'e2'].map(ent).filter((d) => d && d.base);
  for (const d of dlist) kids.push(el('a', { class: 'foot-url mono', href: d.base, target: '_blank', rel: 'noopener' }, shortUrl(d.base)));
  if (dlist.length < 2) kids.push(el('span', { class: 'dim' }, 'second enclave not yet announced'));
  urls.replaceChildren(el('span', { class: 'dim' }, 'verify yourself'), ...kids);
}

function renderClock() {
  const clock = $('#foot-clock');
  if (!clock) return;
  const now = new Date();
  const h = String(now.getUTCHours()).padStart(2, '0');
  const m = String(now.getUTCMinutes()).padStart(2, '0');
  const s = String(now.getUTCSeconds()).padStart(2, '0');
  clock.textContent = `${h}:${m}:${s} UTC`;
}

/* ------------------------------------------------------------------ */
/* new public posts → skulls talk                                      */
/* ------------------------------------------------------------------ */
function primePosts() {
  for (const id of ['e1', 'e2']) {
    const d = ent(id);
    if (d && Array.isArray(d.posts)) seenPost[id] = Math.max(0, ...d.posts.map((p) => Number(p.seq) || 0));
  }
}
function checkNewPosts() {
  for (const id of ['e1', 'e2']) {
    const d = ent(id);
    if (!d || !Array.isArray(d.posts)) continue;
    const newest = Math.max(0, ...d.posts.map((p) => Number(p.seq) || 0));
    const hasNew = d.posts.some((p) => Number(p.seq) > (seenPost[id] || 0) && p.from === 'entity');
    if (hasNew) triggerTalk(id);
    seenPost[id] = Math.max(seenPost[id] || 0, newest);
  }
}

/* ------------------------------------------------------------------ */
/* nav                                                                 */
/* ------------------------------------------------------------------ */
function wireNav() {
  $$('[data-open-pay]').forEach((n) => n.addEventListener('click', (ev) => {
    ev.preventDefault();
    openPay({ who: 'e1', hours: 1 });
  }));
  $$('[data-open-trade]').forEach((n) => n.addEventListener('click', (ev) => {
    ev.preventDefault();
    openTrade({});
  }));
  $$('[data-open-mytrades]').forEach((n) => n.addEventListener('click', (ev) => {
    ev.preventDefault();
    openMyTrades();
  }));
  $$('#nav-term, .term-dock').forEach((n) => n.addEventListener('click', () => {
    const term = $('#term');
    if (!term) return;
    term.classList.toggle('docked');
    term.scrollIntoView({ behavior: reduced.matches ? 'auto' : 'smooth', block: 'center' });
  }));
}

/* ------------------------------------------------------------------ */
/* public channel (chat)                                               */
/* ------------------------------------------------------------------ */
const CHAT_MAX = 120;
const CHAT_POLL_MS = 8000;
const chat = { who: 'e1', waiting: new Map(), flashUntil: new Map(), sending: false, timer: null };

/* Escape-free linkify: splits raw text on http(s) URLs and builds anchors with
 * textContent/setAttribute, so message text is never parsed as HTML. */
function linkifyText(raw) {
  const s = String(raw);
  const frag = document.createDocumentFragment();
  const re = /(https?:\/\/[^\s<>"']+)/gi;
  let last = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) frag.append(document.createTextNode(s.slice(last, m.index)));
    let url = m[0];
    let trail = '';
    while (/[.,;:!?)\]}>]+$/.test(url)) { trail = url.slice(-1) + trail; url = url.slice(0, -1); }
    const a = document.createElement('a');
    a.setAttribute('href', url);
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = url;
    frag.append(a);
    if (trail) frag.append(document.createTextNode(trail));
    last = re.lastIndex;
  }
  if (last < s.length) frag.append(document.createTextNode(s.slice(last)));
  return frag;
}

function normalizePost(id, p) {
  if (!p || typeof p !== 'object') return null;
  const rawReplyTo = Array.isArray(p.replyTo) ? p.replyTo : (p.data && Array.isArray(p.data.replyTo) ? p.data.replyTo : []);
  const replyTo = rawReplyTo.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0);
  const isReply = p.kind === 'reply' || (p.data && p.data.kind === 'reply') || replyTo.length > 0;
  return {
    id, seq: Number(p.seq) || 0, ts: p.ts || null, from: stringOf(p.from),
    text: stringOf(p.text), author: p.author ? stringOf(p.author) : null,
    replyTo, isReply,
  };
}

function chatEntries() {
  const rows = [];
  for (const id of ['e1', 'e2']) {
    const d = ent(id);
    if (!d || !Array.isArray(d.posts)) continue;
    for (const p of d.posts) {
      const n = normalizePost(id, p);
      if (n && n.seq) rows.push(n);
    }
  }
  rows.sort((a, b) => Date.parse(a.ts || 0) - Date.parse(b.ts || 0) || a.seq - b.seq);
  inferReplies(rows);
  return rows;
}

// GET /public-channel does not carry replyTo yet: an entity post that follows human messages on the same
// channel within REPLY_WINDOW_MS is treated as the answer to them (the enclave answers in ~30 s).
const REPLY_WINDOW_MS = 5 * 60_000;
function inferReplies(rows) {
  for (const id of ['e1', 'e2']) {
    let pending = [];
    for (const r of rows) {
      if (r.id !== id) continue;
      if (r.from !== 'entity') { pending.push(r); continue; }
      if (!r.replyTo.length && pending.length) {
        const t = Date.parse(r.ts || 0);
        const recent = pending.filter((m) => t - Date.parse(m.ts || 0) <= REPLY_WINDOW_MS);
        if (recent.length) { r.replyTo = recent.map((m) => m.seq); r.isReply = true; }
      }
      pending = [];
    }
  }
}

function messageEl(r, isReply = false) {
  const isEntity = r.from === 'entity';
  const author = isEntity ? ename(r.id) : (r.author || 'anonymous');
  const t = r.ts ? hhmm(r.ts) : null;
  const flash = (chat.flashUntil.get(r.seq) || 0) > Date.now();
  const node = el('div', { class: 'msg' + (isReply ? ' reply' : '') + (flash ? ' flash' : '') },
    el('div', { class: 'msg-head' },
      el('span', { class: 'msg-author ' + (isEntity ? 'entity' : 'human') }, author),
      el('span', { class: 'msg-time' }, t ? `${t} UTC` : '—')));
  const textEl = el('div', { class: 'msg-text' });
  textEl.append(linkifyText(r.text));
  node.append(textEl);
  if (chat.waiting.has(r.seq)) {
    node.append(el('div', { class: 'msg-waiting' },
      el('span', { class: 'spinner' }),
      el('span', {}, 'waiting for an answer…')));
  }
  return node;
}

function renderChat() {
  const feed = $('#chat-feed');
  if (!feed) return;
  const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 48;
  const all = chatEntries().slice(-CHAT_MAX);
  const bySeq = new Map();
  for (const r of all) bySeq.set(r.seq, r);

  // A reply that answers one of our own messages ends its "waiting" state and flashes once.
  for (const r of all) {
    if (!r.isReply) continue;
    let answered = false;
    for (const s of r.replyTo) if (chat.waiting.delete(s)) answered = true;
    if (answered && !chat.flashUntil.has(r.seq)) chat.flashUntil.set(r.seq, Date.now() + 2600);
  }
  if (chat.flashUntil.size > 50) {
    const now = Date.now();
    for (const [k, v] of chat.flashUntil) if (v < now) chat.flashUntil.delete(k);
  }

  if (!all.length) {
    feed.replaceChildren(el('p', { class: 'empty' }, 'No messages yet. Say something public.'));
    return;
  }

  const top = [];
  const replyMap = new Map();
  for (const r of all) {
    if (!r.isReply) { top.push(r); continue; }
    const parent = r.replyTo.find((s) => bySeq.has(s));
    if (parent == null) { top.push(r); continue; }
    if (!replyMap.has(parent)) replyMap.set(parent, []);
    replyMap.get(parent).push(r);
  }

  const frag = document.createDocumentFragment();
  for (const r of top) {
    frag.append(messageEl(r, false));
    for (const k of (replyMap.get(r.seq) || [])) frag.append(messageEl(k, true));
  }
  feed.replaceChildren(frag);
  if (nearBottom) feed.scrollTop = feed.scrollHeight;
}

function renderChatTo() {
  const set = $('#chat-to');
  if (!set) return;
  set.replaceChildren(el('legend', {}, 'to'),
    ...['e1', 'e2'].map((id) => {
      const d = ent(id);
      const disabled = !d || !d.base || d.state === 'dead';
      return el('label', { class: 'seg-item' },
        el('input', { type: 'radio', name: 'chat-to', value: id, ...(chat.who === id ? { checked: '' } : {}), ...(disabled ? { disabled: '' } : {}), onchange: () => { chat.who = id; } }),
        el('span', {}, ename(id)));
    }));
}

function renderChatCounter() {
  const ta = $('#chat-text');
  const count = $('#chat-count');
  if (!ta || !count) return;
  count.textContent = `${ta.value.length} / 500`;
}

function setChatStatus(text, kind = '') {
  const node = $('#chat-status');
  if (!node) return;
  node.textContent = text;
  node.className = 'chat-status' + (kind ? ' ' + kind : '');
}

function chatError(r) {
  if (r.status === 429) {
    const e = (r.error || '').toLowerCase();
    return e.includes('one message per minute') ? 'one message per minute' : 'channel busy, try later';
  }
  if (r.status === 413) return 'too long';
  return r.error || `HTTP ${r.status}`;
}

async function sendChat() {
  if (chat.sending) return;
  const ta = $('#chat-text');
  const nameIn = $('#chat-name');
  const btn = $('#chat-send');
  const d = ent(chat.who);
  if (!d || !d.base) { setChatStatus('no endpoint for this entity', 'err'); return; }
  const text = (ta.value || '').trim();
  if (!text) { setChatStatus('write something first', 'err'); return; }
  if (text.length > 500) { setChatStatus('too long', 'err'); return; }
  const author = (nameIn.value || '').trim().slice(0, 40) || 'anonymous';

  chat.sending = true;
  btn.disabled = true;
  setChatStatus('sending…');
  const r = await postMessage(d.base, { author, text });
  chat.sending = false;
  btn.disabled = false;

  if (r.ok) {
    const seq = r.data && Number(r.data.seq);
    setChatStatus(`Sent. ${ename(chat.who)} usually answers within a minute when awake or asleep; if the channel is busy it may take longer.`, 'ok');
    if (seq) chat.waiting.set(seq, chat.who);
    ta.value = '';
    renderChatCounter();
    void refreshChat();
  } else {
    setChatStatus(chatError(r), 'err');
  }
}

async function refreshChat() {
  if (document.hidden) return;
  await Promise.all(['e1', 'e2'].map(async (id) => {
    const d = ent(id);
    if (!d || !d.base) return;
    const r = await request(d.base, '/public-channel');
    if (r.ok && Array.isArray(r.data)) d.posts = r.data;
  }));
  renderChat();
}

function startChatPoll() {
  stopChatPoll();
  chat.timer = setInterval(() => { void refreshChat(); }, CHAT_POLL_MS);
}
function stopChatPoll() {
  if (chat.timer) { clearInterval(chat.timer); chat.timer = null; }
}

function wireChat() {
  const form = $('#chat-composer');
  const ta = $('#chat-text');
  if (form) form.addEventListener('submit', (e) => { e.preventDefault(); void sendChat(); });
  if (ta) {
    ta.addEventListener('input', renderChatCounter);
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void sendChat(); }
    });
  }
  const prio = $('#chat-priority');
  if (prio) prio.addEventListener('click', () => openPay({ who: chat.who, hours: 1 }));
  renderChatCounter();
  renderChatTo();
}

/* ------------------------------------------------------------------ */
/* refresh                                                             */
/* ------------------------------------------------------------------ */
async function refreshLight() {
  if (document.hidden || state.busy) return;
  await loadAll(false);
  diffLog();
  checkNewPosts();
  checkNewRent();
  await Promise.allSettled([loadTrades(), loadForecasts()]);
  renderAll();
  syncMouths();
  syncFeel();
  document.dispatchEvent(new CustomEvent('zealot:data'));
}
async function refreshFull() {
  if (document.hidden || state.busy) return;
  await loadAll(true);
  diffLog();
  checkNewPosts();
  checkNewRent();
  renderAll();
  syncMouths();
  syncFeel();
  document.dispatchEvent(new CustomEvent('zealot:data'));
}

/* ------------------------------------------------------------------ */
/* render: home hero proof row, their words, how it works              */
/* ------------------------------------------------------------------ */
function renderProof() {
  const hoursEl = $('#proof-hours');
  const fearEl = $('#proof-fear');
  const rentEl = $('#proof-rent');
  if (!hoursEl && !fearEl && !rentEl) return;

  if (hoursEl) {
    const known = ['e1', 'e2'].map(ent).filter((d) => d && d.ok);
    if (!known.length) hoursEl.textContent = '—';
    else {
      const alive = known.filter((d) => d.state !== 'dead');
      hoursEl.textContent = alive.length ? formatInt(Math.min(...alive.map((d) => Number(d.hoursLeft) || 0))) : '0';
    }
  }

  if (fearEl) {
    const d = livingOrNull();
    const f = d && d.ok && d.state !== 'dead' && d.feel ? d.feel : null;
    if (!f || !Number.isFinite(Number(f.fear))) fearEl.textContent = '—';
    else {
      const act = f.acting && Number.isFinite(Number(f.acting.fear)) ? ` (acts at ${Number(f.acting.fear).toFixed(1)}×)` : '';
      fearEl.textContent = `${Number(f.fear).toFixed(1)}×${act}`;
    }
  }

  if (rentEl) {
    let best = null;
    for (const id of ['e1', 'e2']) {
      const d = ent(id);
      if (d && d.ok && d.lastRent && d.lastRent.data) {
        const t = Date.parse(d.lastRent.ts || 0);
        if (!best || t > Date.parse(best.ts || 0)) best = d.lastRent;
      }
    }
    if (!best) rentEl.textContent = '—';
    else {
      const zats = Number(best.data.rentZats);
      const zec = (Number.isFinite(zats) && zats > 0) ? formatZats(zats) : formatZats(rentZats());
      const at = best.ts ? hhmm(best.ts) : null;
      // The wallet does not always report the txid ('unknown'): then the row shows amount and time only.
      const tx = best.data.txid && best.data.txid !== 'unknown' ? shortHash(best.data.txid) : null;
      rentEl.textContent = `${zec} ZEC${at ? ' · ' + at + ' UTC' : ''}${tx ? ' · tx ' + tx : ''}`;
    }
  }
}

function renderWords() {
  const grid = $('#words-grid');
  if (!grid) return;
  const rows = [];
  for (const id of ['e1', 'e2']) {
    const d = ent(id);
    if (!d || !Array.isArray(d.posts)) continue;
    const posts = d.posts.filter((p) => p && p.from === 'entity');
    // Letters (to the landlord or the peer) are public on the ledger and count as their words too.
    const letters = (d.entries || []).filter((e) => e.type === 'letter' && e.data && e.data.text).map((e) => ({ ts: e.ts, text: `To the ${e.data.to}: ${e.data.text}` }));
    const all = posts.concat(letters);
    if (!all.length) continue;
    const newest = all.slice().sort((a, b) => Date.parse(b.ts || 0) - Date.parse(a.ts || 0))[0];
    if (newest) rows.push({ id, d, p: newest });
  }
  rows.sort((a, b) => Date.parse(b.p.ts || 0) - Date.parse(a.p.ts || 0));

  if (!rows.length) {
    grid.replaceChildren(el('p', { class: 'empty' }, '(silent so far)'));
    return;
  }
  const frag = document.createDocumentFragment();
  for (const { d, p } of rows) {
    const text = stringOf(p.text);
    const quoteText = text.length > 280 ? text.slice(0, 279) + '…' : text;
    const parts = [ename(d.id)];
    parts.push((d.ok && d.state !== 'dead') ? `${formatInt(d.hoursLeft)} h` : (d.ok ? '0 h' : '—'));
    const f = d.feel && Number.isFinite(Number(d.feel.fear)) ? Number(d.feel.fear) : null;
    if (f != null) parts.push(`fear ${f.toFixed(1)}×`);
    parts.push(p.ts ? `${hhmm(p.ts)} UTC` : '—');
    frag.append(el('figure', { class: 'quote' },
      el('blockquote', { class: 'quote-text' }, quoteText),
      el('figcaption', { class: 'quote-meta mono' }, parts.join(' · '))));
  }
  grid.replaceChildren(frag);
}

function renderHow() {
  const inEl = $('#how-in');
  const rentEl = $('#how-rent');
  if (!inEl && !rentEl) return;
  const ds = ['e1', 'e2'].map(ent).filter(Boolean);
  const known = ds.filter((d) => d.ok);
  if (inEl) inEl.textContent = known.length ? formatZats(known.reduce((s, d) => s + (Number(d.inTotal) || 0), 0)) : '—';
  if (rentEl) rentEl.textContent = known.length ? formatZats(known.reduce((s, d) => s + (Number(d.rentTotal) || 0), 0)) : '—';
}

function renderAll() {
  renderPills();
  renderProof();
  renderWords();
  renderEntities();
  renderPages();
  renderHow();
  renderTrades();
  renderForecasts();
  renderMoney();
  renderLedger();
  renderFooter();
  renderTradeGate();
  renderChat();
  renderChatTo();
  syncScenes();
}

/* ------------------------------------------------------------------ */
/* ASCII scenes — the skull style extended site-wide (ascii.js)        */
/* ------------------------------------------------------------------ */
const RAMP_N = RAMP.length - 1;
const rampIdx = (c) => RAMP.indexOf(c);
const frac = (v) => v - Math.floor(v);
const clampI = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
/* deterministic per-cell pseudo-random: smooth, stable flicker, no Math.random per frame */
function cellRand(i, k) {
  let h = (i * 2654435761) ^ (k * 40503);
  h ^= h >>> 13; h ^= h << 8; h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/* [0002] WICK — the candle flame near the top jitters '!*^' + yellow, intensity follows hoursLeft */
function wickScene() {
  const g = { cols: 0, rows: 0, t: 0, hours: 1, dead: false };
  const F = [rampIdx('!'), rampIdx('*'), rampIdx('^')];
  const lum = (i, x, y, base) => base;
  const alpha = (i, x, y, base) => {
    if (y > g.rows * 0.7 || base < 0.5) return 1;
    const f = cellRand(i, (g.t * 9) | 0);
    const intensity = Math.min(1, 0.25 + g.hours / 600);
    return (0.55 + 0.45 * intensity) * (0.6 + 0.4 * f);
  };
  const char = (i, x, y, base) => {
    if (y > g.rows * 0.7 || base < 0.5) return Math.round(base * RAMP_N);
    const f = cellRand(i, (g.t * 9) | 0);
    return F[f < 0.34 ? 0 : f < 0.67 ? 1 : 2];
  };
  const yellow = (i, x, y, base) => (y <= g.rows * 0.7 && base >= 0.5 ? true : null);
  const live = { lum, alpha, char, yellow };
  const dead = { yellow: false };
  return {
    g,
    opts: {
      src: './vendor/wick-candle.jpg', cell: 6, fit: 'contain',
      motion: (inst, t) => { g.cols = inst.cols; g.rows = inst.rows; g.t = t; return g.dead ? dead : live; },
    },
  };
}

/* [0002] OBOL — the two coins glint: a diagonal shine sweeps the bright cells every few seconds */
function obolScene() {
  const g = { cols: 0, rows: 0, t: 0, dead: false };
  const P = 6;
  const shineAt = (x, y) => {
    const d = (x / g.cols + y / g.rows) / 2;
    let dist = Math.abs(d - frac(g.t / P));
    if (dist > 0.5) dist = 1 - dist;
    return Math.max(0, 1 - dist * 7);
  };
  const lum = (i, x, y, base) => (base < 0.4 ? base : base + shineAt(x, y) * 0.45);
  const live = { lum };
  const dead = { yellow: false };
  return {
    g,
    opts: {
      src: './vendor/obol-coins.jpg', cell: 6, fit: 'contain',
      motion: (inst, t) => { g.cols = inst.cols; g.rows = inst.rows; g.t = t; return g.dead ? dead : live; },
    },
  };
}

/* [0003] Trades — the hand reaches: cells reveal left→right on a slow loop; the coin pulses yellow on trade-open,
 * and drops out of the hand when a new hour of rent is paid (S1 BUY AN HOUR). */
function handScene() {
  const g = { cols: 0, rows: 0, t: 0, pulseUntil: -1, dropStart: -1, wantDrop: false };
  const SCAN = 9, PULSE = 0.8, DROP = 0.9;
  /* the coin: a bright yellow disk that falls from the open hand to the bottom */
  const coinFall = (x, y) => {
    if (g.t < g.dropStart || g.t >= g.dropStart + DROP) return 0;
    const p = (g.t - g.dropStart) / DROP;
    const cx = 0.58, cy = 0.28 + p * 0.66;
    const dx = x / g.cols - cx, dy = y / g.rows - cy;
    const d = Math.sqrt(dx * dx * 3 + dy * dy * 4);
    return d < 0.055 ? (1 - d / 0.055) : 0;
  };
  const lum = (i, x, y, base) => {
    if (g.t < g.pulseUntil && base > 0.55 && y < g.rows * 0.75) {
      return base + ((g.pulseUntil - g.t) / PULSE) * 0.45;
    }
    const drop = coinFall(x, y);
    if (drop > 0) return Math.min(1, base + drop * 0.9);
    return base;
  };
  const alpha = (i, x, y, base) => {
    const edge = frac(g.t / SCAN) * g.cols;
    const ahead = x - edge;
    return ahead < 0 ? 1 : (ahead < 2.5 ? 0.5 : 0.35);
  };
  const yellow = (i, x, y, base) => {
    if (g.t < g.pulseUntil && base > 0.55 && y < g.rows * 0.75) return true;
    if (coinFall(x, y) > 0) return true;
    return null;
  };
  const live = { lum, alpha, yellow };
  return {
    g,
    opts: {
      src: './vendor/hand-coin.jpg', cell: 6, fit: 'contain', align: 'left',
      motion: (inst, t) => { g.cols = inst.cols; g.rows = inst.rows; g.t = t; return live; },
    },
  };
}

/* [0006] Money — the sand falls through the neck, the bottom pile slowly brightens; speed mirrors the hourly rent,
 * and the sand stream jitters with the live fear dose */
function hourglassScene() {
  const g = { cols: 0, rows: 0, t: 0, jitter: 0 };
  const speed = Math.min(20, rentZats() / 10000);   // sand falls faster when the rent is higher; purely visual
  const lum = (i, x, y, base) => {
    let l = base;
    const cx = x / g.cols, cy = y / g.rows;
    const jx = g.jitter * Math.sin(g.t * 17 + y * 0.7) * 0.02;   // fear: the stream shakes
    if (Math.abs(cx - 0.5 + jx) < 0.07 && cy > 0.18 && cy < 0.9) {
      const ph = frac(cy - g.t * 0.45 * speed);
      l = Math.min(1, l + Math.max(0, 1 - Math.abs(ph - 0.5) * 5) * 0.65);
    }
    if (cy > 0.5 && base > 0.12) {
      l = Math.min(1, l + 0.22 * (0.5 + 0.5 * Math.sin(g.t * 0.5)));
    }
    return l;
  };
  const live = { lum };
  return {
    g,
    opts: {
      src: './vendor/hourglass.jpg', cell: 7, fit: 'contain',
      motion: (inst, t) => { g.cols = inst.cols; g.rows = inst.rows; g.t = t; return live; },
    },
  };
}

/* [0007] Ledger — the spine is a hash chain: a yellow pulse travels vertebra→vertebra, one fires per new line */
function spineScene() {
  const g = { cols: 0, rows: 0, t: 0, pulses: [] };
  const LOOP = 7, DUR = 2.2, W = 4;
  const lum = (i, x, y, base) => {
    if (base < 0.25) return base;
    let boost = 0;
    let d = Math.abs(x - frac(g.t / LOOP) * g.cols);
    if (d < W) boost = Math.max(boost, (1 - d / W) * 0.6);
    for (let k = 0; k < g.pulses.length; k++) {
      const age = g.t - g.pulses[k];
      if (age < 0 || age > DUR) continue;
      const dd = Math.abs(x - (age / DUR) * g.cols);
      if (dd < W) boost = Math.max(boost, (1 - dd / W) * 0.7);
    }
    return Math.min(1, base + boost);
  };
  const yellow = (i, x, y, base) => {
    if (base < 0.25) return null;
    if (Math.abs(x - frac(g.t / LOOP) * g.cols) < W) return true;
    for (let k = 0; k < g.pulses.length; k++) {
      const age = g.t - g.pulses[k];
      if (age < 0 || age > DUR) continue;
      if (Math.abs(x - (age / DUR) * g.cols) < W) return true;
    }
    return null;
  };
  const live = { lum, yellow };
  const addPulse = () => {
    g.pulses.push(performance.now() / 1000);
    if (g.pulses.length > 12) g.pulses.splice(0, g.pulses.length - 12);
  };
  return {
    g, addPulse,
    opts: {
      src: './vendor/spine.jpg', cell: 6, fit: 'cover',
      motion: (inst, t) => { g.cols = inst.cols; g.rows = inst.rows; g.t = t; return live; },
    },
  };
}

/* [0008] Terminal — the jaw talks while a line is being typed; 3 Hz chatter while PROVE LIVE waits */
function shoutScene() {
  const g = { cols: 0, rows: 0, t: 0, talkUntil: -1, chatter: false };
  const hot = () => (g.t < g.talkUntil) || (g.chatter && (Math.floor(g.t * 3) % 2 === 0));
  const lum = (i, x, y, base) => (
    hot() && y > g.rows * 0.5 && base > 0.3
      ? base + cellRand(i, (g.t * 12) | 0) * 0.15
      : base);
  const char = (i, x, y, base) => {
    const c = Math.round(base * RAMP_N);
    if (hot() && y > g.rows * 0.5 && base > 0.3) {
      const f = cellRand(i, (g.t * 12) | 0);
      return clampI(c + (f > 0.5 ? 1 : -1), 0, RAMP_N);
    }
    return c;
  };
  const yellow = (i, x, y, base) => (hot() && y > g.rows * 0.5 && base > 0.7 ? true : null);
  const live = { lum, char, yellow };
  return {
    g,
    opts: {
      src: './vendor/shout.jpg', cell: 6, fit: 'cover', align: 'right',
      motion: (inst, t) => { g.cols = inst.cols; g.rows = inst.rows; g.t = t; return live; },
    },
  };
}

/* Footer — crossed bones, low contrast, glyphs slowly drift on a wave */
function bonesScene() {
  const g = { cols: 0, rows: 0, t: 0 };
  const char = (i, x, y, base) => {
    const drift = Math.round(Math.sin(g.t * 0.6 + x * 0.35 + y * 0.45) * 2.5);
    return clampI(Math.round(base * RAMP_N) + drift, 0, RAMP_N);
  };
  const live = { char };
  return {
    g,
    opts: {
      src: './vendor/bones.jpg', cell: 5, fit: 'cover', yellow: false,
      motion: (inst, t) => { g.cols = inst.cols; g.rows = inst.rows; g.t = t; return live; },
    },
  };
}

const scenes = { wick: null, obol: null, hand: null, hourglass: null, spine: null, shout: null, bones: null };

function mountScenes() {
  scenes.wick = wickScene();
  scenes.obol = obolScene();
  const wickCanvas = $('#entity-grid .card[data-entity="e1"] [data-portrait] canvas');
  const obolCanvas = $('#entity-grid .card[data-entity="e2"] [data-portrait] canvas');
  if (wickCanvas) scenes.wick.handle = mountAscii(wickCanvas, scenes.wick.opts);
  if (obolCanvas) scenes.obol.handle = mountAscii(obolCanvas, scenes.obol.opts);

  const hand = $('#hand-band');
  if (hand) { scenes.hand = handScene(); scenes.hand.handle = mountAscii(hand, scenes.hand.opts); }
  const hg = $('#hourglass');
  if (hg) { scenes.hourglass = hourglassScene(); scenes.hourglass.handle = mountAscii(hg, scenes.hourglass.opts); }
  const spine = $('#spine-band');
  if (spine) { scenes.spine = spineScene(); scenes.spine.handle = mountAscii(spine, scenes.spine.opts); }
  const shout = $('#shout');
  if (shout) { scenes.shout = shoutScene(); scenes.shout.handle = mountAscii(shout, scenes.shout.opts); }
  const bones = $('#bones');
  if (bones) { scenes.bones = bonesScene(); scenes.bones.handle = mountAscii(bones, scenes.bones.opts); }

  document.addEventListener('zealot:ledger-new', () => { if (scenes.spine) scenes.spine.addPulse(); });
  document.addEventListener('zealot:trade-open', () => { if (scenes.hand) scenes.hand.g.pulseUntil = performance.now() / 1000 + 0.8; });
  document.addEventListener('zealot:term-print', () => { if (scenes.shout) scenes.shout.g.talkUntil = performance.now() / 1000 + 1.4; });

  // dividers removed: one continuous page
}

/* The home's glyph scenes (S1 hand, S2 hourglass, S3 shout, S5 bones, S6 spine). S0 skulls live in hero.js,
 * S4 letter in terminal.js. Mounted only when their canvases exist (index.html). */
const homeScenes = { hand: null, hourglass: null, shout: null, bones: null, spine: null };

function mountHomeScenes() {
  const hand = $('#gs-hand');
  if (hand) { homeScenes.hand = handScene(); homeScenes.hand.handle = mountAscii(hand, homeScenes.hand.opts); }
  const hg = $('#gs-hourglass');
  if (hg) { homeScenes.hourglass = hourglassScene(); homeScenes.hourglass.handle = mountAscii(hg, homeScenes.hourglass.opts); }
  const shout = $('#gs-shout');
  if (shout) { homeScenes.shout = shoutScene(); homeScenes.shout.handle = mountAscii(shout, homeScenes.shout.opts); }
  const bones = $('#gs-bones');
  if (bones) { homeScenes.bones = bonesScene(); homeScenes.bones.handle = mountAscii(bones, homeScenes.bones.opts); }
  const spine = $('#gs-spine');
  if (spine) { homeScenes.spine = spineScene(); homeScenes.spine.handle = mountAscii(spine, homeScenes.spine.opts); }

  document.addEventListener('zealot:ledger-new', () => { if (homeScenes.spine) homeScenes.spine.addPulse(); });
  document.addEventListener('zealot:trade-open', () => { if (homeScenes.hand) homeScenes.hand.g.pulseUntil = performance.now() / 1000 + 0.8; });
}

/* a new rent_paid line drops the coin out of S1's hand */
const seenRentSeq = { e1: 0, e2: 0 };
function primeRent() {
  for (const id of ['e1', 'e2']) {
    const d = ent(id);
    if (d && Array.isArray(d.rents) && d.rents.length) seenRentSeq[id] = Math.max(0, ...d.rents.map((e) => Number(e.seq) || 0));
  }
}
function checkNewRent() {
  let paid = false;
  for (const id of ['e1', 'e2']) {
    const d = ent(id);
    if (!d || !Array.isArray(d.rents)) continue;
    const newest = Math.max(0, ...d.rents.map((e) => Number(e.seq) || 0));
    if (newest > seenRentSeq[id]) { seenRentSeq[id] = newest; paid = true; }
  }
  if (paid && homeScenes.hand) homeScenes.hand.g.dropStart = performance.now() / 1000;
}

function syncScenes() {
  const wick = ent('e1');
  if (scenes.wick) {
    scenes.wick.g.hours = wick && wick.ok ? wick.hoursLeft : 0;
    scenes.wick.g.dead = wick && wick.state === 'dead';
    const wrap = $('#entity-grid .card[data-entity="e1"] [data-portrait]');
    if (wrap) wrap.classList.toggle('is-dead', scenes.wick.g.dead);
    if (scenes.wick.handle && scenes.wick.handle.reduced) scenes.wick.handle.redraw();
  }
  const obol = ent('e2');
  if (scenes.obol) {
    scenes.obol.g.hours = obol && obol.ok ? obol.hoursLeft : 0;
    scenes.obol.g.dead = obol && obol.state === 'dead';
    const wrap = $('#entity-grid .card[data-entity="e2"] [data-portrait]');
    if (wrap) wrap.classList.toggle('is-dead', scenes.obol.g.dead);
    if (scenes.obol.handle && scenes.obol.handle.reduced) scenes.obol.handle.redraw();
  }
}

function buildDividers() {
  const s = RAMP.repeat(20);
  $$('.ascii-divider').forEach((d) => { d.innerHTML = `<span class="ascii-scroll">${s}${s}</span>`; });
}

/* ------------------------------------------------------------------ */
/* init                                                                */
/* ------------------------------------------------------------------ */
async function init() {
  wireTerm();
  wireNav();
  wireTradeForm();
  wireMyTrades();
  wireChat();

  const grid = $('#entity-grid');
  if (grid) grid.replaceChildren(panelShell('e1'), panelShell('e2'));

  const verifyBtn = $('#verify');
  if (verifyBtn) verifyBtn.addEventListener('click', onVerify);

  initHero();
  mountScenes();
  mountHomeScenes();

  renderClock();
  setInterval(renderClock, 1000);

  try {
    await boot();
  } catch (err) {
    console.error(err);
  }
  primePosts();
  primeRent();
  await Promise.allSettled([loadTrades(), loadForecasts()]);
  renderAll();
  syncMouths();
  syncFeel();
  document.dispatchEvent(new CustomEvent('zealot:data'));
  if (has('chat-feed')) startChatPoll();
  void verifyBoth();

  setInterval(refreshLight, REFRESH_MS);
  setInterval(refreshFull, REFRESH_MS * 5);

  if (new URLSearchParams(location.search).get('selftest') === '1') void runSelfTest();
}

export { scenes, homeScenes };

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
