/*
 * app.js — ZEALOT v18, the page. Two skulls, one signal.
 *
 * Owns the whole page: nav, the two enclave cards with tabs, the status pills under each skull, the one-trade
 * section (steps + live /trades book), the ledger stream with Verify chain, the forecasts, the footer clock, and
 * the dock toggle. It imports the loaded entity data and the pay dialog from term.js, and drives the two skulls
 * in hero.js from the live state (a new public post makes that skull talk). The single refresh clock is 60 s for
 * data plus a 1 s footer clock. Every number comes from the endpoints via data.js; loading is an em dash, an
 * error is "offline since".
 */
import {
  state, list, nameOf, stateWord, deadline, loadAll, boot, wireTerm, openPay, diffLog,
} from './term.js?v=19';
import {
  request, verifyChain, stringOf, formatInt, formatZats, formatDecimal, fmtStamp, hhmm, shortHash, shortUrl,
  REFRESH_MS,
} from './data.js?v=19';
import { zip321Uri, qrSvg } from './qr.js?v=19';
import { initHero, setMouth, triggerTalk } from './hero.js?v=19';

/* ------------------------------------------------------------------ */
/* tiny DOM helpers                                                    */
/* ------------------------------------------------------------------ */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
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
    <header class="card-meta">
      <span class="meta-label">ENCLAVE 0${id === 'e1' ? 1 : 2}</span>
      <span class="meta-idx">[0002]</span>
    </header>
    <header class="card-head">
      <h3 class="card-name" data-k="name">—</h3>
      <span class="card-state" data-k="state">—</span>
    </header>
    <div class="tabs" role="tablist" aria-label="enclave">
      <button class="tab is-active" type="button" role="tab" aria-selected="true" data-tab="state">State</button>
      <button class="tab" type="button" role="tab" aria-selected="false" data-tab="shop">Shop</button>
      <button class="tab" type="button" role="tab" aria-selected="false" data-tab="words">Words</button>
    </div>
    <div class="tab-panels">
      <div class="tab-panel" data-panel="state" role="tabpanel">
        <dl class="kvs">
          <div><dt>treasury</dt><dd data-k="treasury">—</dd></div>
          <div><dt>hours left</dt><dd data-k="hours">—</dd></div>
          <div><dt>last rent</dt><dd data-k="lastRent">—</dd></div>
          <div><dt>dies at</dt><dd data-k="dies">—</dd></div>
          <div><dt>last letter</dt><dd data-k="lastLetter">—</dd></div>
          <div><dt>chain digest</dt><dd class="mono" data-k="digest">—</dd></div>
          <div><dt>channel count</dt><dd data-k="channel">—</dd></div>
        </dl>
      </div>
      <div class="tab-panel" data-panel="shop" role="tabpanel" hidden><div class="shop-list" data-k="shop"></div></div>
      <div class="tab-panel" data-panel="words" role="tabpanel" hidden><div class="words-list" data-k="words"></div></div>
    </div>`;
  art.querySelector('.tabs').addEventListener('click', (ev) => {
    const b = ev.target.closest('.tab');
    if (!b) return;
    art.querySelectorAll('.tab').forEach((t) => {
      const on = t === b;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    art.querySelectorAll('.tab-panel').forEach((p) => { p.hidden = p.dataset.panel !== b.dataset.tab; });
  });
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
    for (const k of ['treasury', 'hours', 'lastRent', 'dies', 'lastLetter', 'digest', 'channel']) get(k).textContent = '—';
    get('shop').replaceChildren(el('p', { class: 'empty' }, BOOK_EMPTY));
    get('words').replaceChildren(el('p', { class: 'empty' }, BOOK_EMPTY));
    return;
  }
  if (!d.ok) {
    const off = offlineLabel(d);
    for (const k of ['treasury', 'hours', 'lastRent', 'dies', 'lastLetter', 'digest', 'channel']) get(k).textContent = off;
    get('shop').replaceChildren(el('p', { class: 'empty' }, off));
    get('words').replaceChildren(el('p', { class: 'empty' }, off));
    return;
  }

  get('treasury').textContent = `${formatInt(d.zats)} zats · ${formatZats(d.zats)} ZEC`;
  get('hours').textContent = formatInt(d.hoursLeft);
  get('lastRent').textContent = d.lastRent ? fmtStamp(d.lastRent.ts) : '—';
  get('dies').textContent = d.state === 'dead'
    ? (d.diedAt ? fmtStamp(d.diedAt) : 'dead')
    : (d.lastRent ? fmtStamp(deadline(d)) : '—');
  get('lastLetter').textContent = (d.letters && d.letters.length) ? fmtStamp(d.letters[d.letters.length - 1].ts) : '—';
  get('digest').textContent = shortHash(d.head);
  get('channel').textContent = formatInt((d.posts || []).length);

  const shop = get('shop');
  const items = d.shop || [];
  if (!items.length) shop.replaceChildren(el('p', { class: 'empty' }, 'Nothing for sale yet. The shop opens when they price an hour of work.'));
  else shop.replaceChildren(...items.map((it) => el('div', { class: 'shop-item' },
    el('span', { class: 'shop-name', text: it.item }),
    el('span', { class: 'shop-price mono', text: `${formatInt(it.zats)} zats` }),
    el('button', { class: 'btn buy-small', type: 'button', text: 'Buy', onclick: () => openPay({ who: id, theirs: it }) }))));

  const words = get('words');
  const posts = (d.posts || []).filter((p) => p.from === 'entity').slice(-5).reverse();
  if (!posts.length) words.replaceChildren(el('p', { class: 'empty' }, 'No public posts yet. They speak when there is something to say.'));
  else words.replaceChildren(...posts.map((p) => el('div', { class: 'word' },
    el('p', { class: 'word-text', text: stringOf(p.text) }),
    el('span', { class: 'word-time mono', text: p.ts ? fmtStamp(p.ts) : '—' }))));
}

function renderEntities() {
  for (const id of ['e1', 'e2']) updatePanel(id);
}

/* ------------------------------------------------------------------ */
/* render: trades (order book)                                         */
/* ------------------------------------------------------------------ */
async function loadTrades() {
  await Promise.all(['e1', 'e2'].map(async (id) => {
    const d = ent(id);
    if (!d || !d.base) { tradesCache[id] = null; return; }
    tradesCache[id] = await request(d.base, '/trades', { allow404: true });
  }));
}

function renderTrades() {
  const book = $('#book');
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
  await Promise.all(['e1', 'e2'].map(async (id) => {
    const d = ent(id);
    if (!d || !d.base) { forecastsCache[id] = null; return; }
    forecastsCache[id] = await request(d.base, '/forecasts', { allow404: true });
  }));
}

function renderForecasts() {
  const body = $('#forecasts-body');
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
    return;
  }
  if (!live) {
    notlive.hidden = false;
    out.hidden = true;
    disable();
    qr.replaceChildren(el('p', { class: 'err' }, 'Trades are not live on this entity.'));
    return;
  }
  notlive.hidden = true;
  if (err || !memo || !d || !d.address) {
    out.hidden = false;
    disable();
    qr.replaceChildren(el('p', { class: 'err' }, err || 'no address published by this enclave right now'));
    return;
  }
  out.hidden = false;
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
  if (!dlg.open) dlg.showModal();
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
    case 'promise': case 'bounty': return truncate(d.what || d.text || d.id, 22);
    default: return '—';
  }
}

function renderLedger() {
  const lines = [];
  for (const id of ['e1', 'e2']) {
    const d = ent(id);
    if (!d || !Array.isArray(d.entries)) continue;
    for (const e of d.entries) lines.push({ d, e });
  }
  lines.sort((a, b) => Date.parse(a.e.ts || 0) - Date.parse(b.e.ts || 0));
  const last = lines.slice(-40);

  const container = $('#ledger-lines');
  const frag = document.createDocumentFragment();
  for (const { d, e } of last) {
    const key = `${d.id}|${e.seq}`;
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
}

/* ------------------------------------------------------------------ */
/* Verify chain                                                        */
/* ------------------------------------------------------------------ */
let verifying = false;
async function onVerify() {
  if (verifying) return;
  const btn = $('#verify');
  const out = $('#verify-out');
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

/* ------------------------------------------------------------------ */
/* render: footer                                                      */
/* ------------------------------------------------------------------ */
function renderFooter() {
  const d1 = ent('e1');
  const digestEl = $('#foot-digest');
  const blockEl = $('#foot-block');

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

  const urls = $('#foot-urls');
  const kids = [];
  const dlist = ['e1', 'e2'].map(ent).filter((d) => d && d.base);
  for (const d of dlist) kids.push(el('a', { class: 'foot-url mono', href: d.base, target: '_blank', rel: 'noopener' }, shortUrl(d.base)));
  if (dlist.length < 2) kids.push(el('span', { class: 'dim' }, 'second enclave not yet announced'));
  urls.replaceChildren(el('span', { class: 'dim' }, 'verify yourself'), ...kids);
}

function renderClock() {
  const now = new Date();
  const h = String(now.getUTCHours()).padStart(2, '0');
  const m = String(now.getUTCMinutes()).padStart(2, '0');
  const s = String(now.getUTCSeconds()).padStart(2, '0');
  $('#foot-clock').textContent = `${h}:${m}:${s} UTC`;
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
  $$('#nav-term, .term-dock').forEach((n) => n.addEventListener('click', () => {
    const term = $('#term');
    if (!term) return;
    term.classList.toggle('docked');
    term.scrollIntoView({ behavior: reduced.matches ? 'auto' : 'smooth', block: 'center' });
  }));
}

/* ------------------------------------------------------------------ */
/* refresh                                                             */
/* ------------------------------------------------------------------ */
async function refreshLight() {
  if (document.hidden || state.busy) return;
  await loadAll(false);
  diffLog();
  checkNewPosts();
  await Promise.allSettled([loadTrades(), loadForecasts()]);
  renderAll();
  syncMouths();
}
async function refreshFull() {
  if (document.hidden || state.busy) return;
  await loadAll(true);
  diffLog();
  checkNewPosts();
  renderAll();
  syncMouths();
}

function renderAll() {
  renderPills();
  renderEntities();
  renderTrades();
  renderForecasts();
  renderMoney();
  renderLedger();
  renderFooter();
  renderTradeGate();
}

/* ------------------------------------------------------------------ */
/* init                                                                */
/* ------------------------------------------------------------------ */
async function init() {
  wireTerm();
  wireNav();
  wireTradeForm();

  const grid = $('#entity-grid');
  grid.replaceChildren(panelShell('e1'), panelShell('e2'));

  initHero();

  renderClock();
  setInterval(renderClock, 1000);

  try {
    await boot();
  } catch (err) {
    console.error(err);
  }
  primePosts();
  await Promise.allSettled([loadTrades(), loadForecasts()]);
  renderAll();
  syncMouths();

  setInterval(refreshLight, REFRESH_MS);
  setInterval(refreshFull, REFRESH_MS * 5);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
