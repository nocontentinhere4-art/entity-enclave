/*
 * app.js — ZEALOT v16, the page. The desk, not the skull.
 *
 * Owns the whole page: nav, entity panels with tabs, the live stats row, the order book (/trades), the
 * forecasts (/forecasts), the ledger panel in perspective, the Verify chain button, the footer clock, and the
 * two canvases (Raycast streaks + the ASCII orbs). It imports the loaded entity data and the pay dialog from
 * term.js, and is the single refresh clock (a 30 fps setTimeout loop for the canvases, a 60 s refresh for data).
 * Every number comes from the endpoints via data.js; loading is an em dash, an error is "offline since".
 */
import {
  state, list, nameOf, stateWord, deadline, loadAll, boot, wireTerm, openPay, diffLog,
} from './term.js?v=16';
import {
  request, verifyChain, stringOf, formatInt, formatZats, formatDecimal, fmtStamp, hhmm, shortHash, shortUrl,
  REFRESH_MS,
} from './data.js?v=16';

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

function ent(id) { return state.ais[id]; }

const FALLBACK = { e1: 'WICK', e2: 'OBOL' };
const ename = (id) => { const d = ent(id); return d ? nameOf(d) : (FALLBACK[id] || String(id).toUpperCase()); };

function offlineLabel(d) {
  if (!d) return '—';
  if (d.ok) return null;
  const t = d.at ? hhmm(d.at) : null;
  return t ? `offline since ${t} UTC` : 'offline';
}
function numCell(d, key, fmt) {
  const off = offlineLabel(d);
  if (off) return off;
  const v = d[key];
  if (v == null || (typeof v === 'number' && !Number.isFinite(v))) return '—';
  return fmt ? fmt(v) : String(v);
}

/* ------------------------------------------------------------------ */
/* render: nav + stats                                                 */
/* ------------------------------------------------------------------ */
function setTick(node, text) {
  if (node.textContent === text) return;
  node.textContent = text;
  node.classList.remove('tick');
  void node.offsetWidth;
  node.classList.add('tick');
}

function renderStats() {
  const d1 = ent('e1'), d2 = ent('e2');
  setTick($('#stat-wick-hours'), numCell(d1, 'hoursLeft', (v) => formatInt(v)));
  setTick($('#stat-obol-hours'), numCell(d2, 'hoursLeft', (v) => formatInt(v)));

  const okList = list().filter((d) => d.ok);
  const zecPaid = okList.reduce((s, d) => s + (Number(d.inTotal) || 0), 0);
  const letters = okList.reduce((s, d) => s + ((d.letters || []).length), 0);
  setTick($('#stat-zec'), okList.length ? `${formatZats(zecPaid)} ZEC` : '—');
  setTick($('#stat-letters'), okList.length ? formatInt(letters) : '—');
}

/* ------------------------------------------------------------------ */
/* render: entity panels                                              */
/* ------------------------------------------------------------------ */
const KRAKEN_EMPTY = 'No trade yet. The first order opens the book.';

function panelShell(id) {
  const name = ename(id);
  const art = el('article', { class: 'panel', 'data-entity': id });
  art.innerHTML = `
    <header class="panel-head">
      <h3 class="panel-name">${name}</h3>
      <span class="panel-state" data-k="state">—</span>
    </header>
    <div class="tabs" role="tablist" aria-label="${name}">
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
  const panel = $(`.panel[data-entity="${id}"]`);
  if (!panel) return;
  const get = (k) => panel.querySelector(`[data-k="${k}"]`);

  panel.querySelector('.panel-name').textContent = ename(id);
  get('state').textContent = d ? stateWord(d) : '—';

  if (!d) {
    for (const k of ['treasury', 'hours', 'lastRent', 'dies', 'lastLetter', 'digest', 'channel']) {
      get(k).textContent = '—';
    }
    get('shop').replaceChildren(el('p', { class: 'empty' }, KRAKEN_EMPTY));
    get('words').replaceChildren(el('p', { class: 'empty' }, KRAKEN_EMPTY));
    return;
  }
  if (!d.ok) {
    const off = offlineLabel(d);
    for (const k of ['treasury', 'hours', 'lastRent', 'dies', 'lastLetter', 'digest', 'channel']) {
      get(k).textContent = off;
    }
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

  // shop
  const shop = get('shop');
  const items = d.shop || [];
  if (!items.length) shop.replaceChildren(el('p', { class: 'empty' }, 'Nothing for sale yet. The shop opens when they price an hour of work.'));
  else shop.replaceChildren(...items.map((it) => el('div', { class: 'shop-item' },
    el('span', { class: 'shop-name', text: it.item }),
    el('span', { class: 'shop-price mono', text: `${formatInt(it.zats)} zats` }),
    el('button', { class: 'btn buy-small', type: 'button', text: 'Buy', onclick: () => openPay({ who: id, theirs: it }) }))));

  // words
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
    // network error beats the empty state
    for (const id of ['e1', 'e2']) {
      const c = tradesCache[id];
      if (c && !c.ok && !c.notFound) {
        const d = ent(id);
        const off = d && d.at ? `offline since ${hhmm(d.at)} UTC` : 'offline';
        book.replaceChildren(el('p', { class: 'empty' }, `${ename(id)} · trades ${off}`));
        return;
      }
    }
    book.replaceChildren(el('p', { class: 'empty' }, KRAKEN_EMPTY));
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

  // enclave URLs
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
/* render: orb labels + last-post cache                                */
/* ------------------------------------------------------------------ */
const orbRing = { e1: [], e2: [] };

function lastPostOf(d) {
  const posts = (d && Array.isArray(d.posts) ? d.posts : []).filter((p) => p.from === 'entity');
  return posts.length ? stringOf(posts[posts.length - 1].text) : '';
}

function renderOrbLabels() {
  for (const id of ['e1', 'e2']) {
    const d = ent(id);
    $('#orb-name-' + id).textContent = ename(id);
    $('#orb-state-' + id).textContent = d ? stateWord(d) : '—';
    $('#orb-hours-' + id).textContent = d && d.ok && d.state !== 'dead' ? `${formatInt(d.hoursLeft)} h left` : (d && d.ok && d.state === 'dead' ? 'dead' : (d ? offlineLabel(d) : '—'));
    const post = lastPostOf(d);
    const ringText = post.length > 44 ? post.slice(0, 44) : post;
    orbRing[id] = ringText.split('');
  }
  // canvas aria label describes both states
  const parts = [];
  for (const id of ['e1', 'e2']) {
    const d = ent(id);
    if (!d) parts.push(`${ename(id)}: unknown`);
    else if (!d.ok) parts.push(`${ename(id)}: no signal`);
    else parts.push(`${ename(id)}: ${stateWord(d).toLowerCase()}, ${d.state === 'dead' ? '0' : formatInt(d.hoursLeft)} hours left`);
  }
  $('#orbs').setAttribute('aria-label', `Two ASCII orbs, one per enclave. ${parts.join('. ')}.`);
}

/* ------------------------------------------------------------------ */
/* the canvases: streaks + orbs                                        */
/* ------------------------------------------------------------------ */
const GLYPH_CHARS = [' ', '.', ':', '-', '=', '+', '*', '#', '%', '@'];
const ORB_DIAMETER = 260;
const CELL = 9;
let orbMax = ORB_DIAMETER;
const INK_COLOR = '#ededed';
const ACCENT_COLOR = '#ff5c1a';
const MUTED_COLOR = '#8a8f98';

let orbCanvas, orbCtx, orbW = 0, orbH = 0, dpr = 1;
let streakCanvas, streakCtx, streakW = 0, streakH = 0, streakOff = null, streakMARGIN = 96;
let orbCenters = [];

/* value noise: integer-hash based, allocation-free */
function hash2(x, y) {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return ((h >>> 0) & 0xffff) / 0xffff;
}
function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function buildOrbCells(c) {
  const n = Math.ceil(c.radius / CELL);
  const xs = [], ys = [], nx = [], ny = [], ff = [];
  for (let gy = -n; gy <= n; gy++) {
    for (let gx = -n; gx <= n; gx++) {
      const px = gx * CELL, py = gy * CELL;
      const dist = Math.sqrt(px * px + py * py);
      if (dist > c.radius) continue;
      xs.push(c.cx + px); ys.push(c.cy + py);
      nx.push(gx * 0.42); ny.push(gy * 0.42);
      ff.push(Math.pow(1 - dist / c.radius, 1.6));
    }
  }
  c.xs = Float32Array.from(xs);
  c.ys = Float32Array.from(ys);
  c.nx = Float32Array.from(nx);
  c.ny = Float32Array.from(ny);
  c.ff = Float32Array.from(ff);
  c.count = xs.length;
}

function layoutOrbs() {
  const w = orbW, h = orbH;
  const cols = w >= 520 ? 2 : 1;
  const rows = cols === 2 ? 1 : 2;
  const pad = 12;
  const cellW = (w - pad * (cols + 1)) / cols;
  const cellH = (h - pad * (rows + 1)) / rows;
  const diameter = Math.min(cellW - 44, cellH - 44, orbMax); // room for the text ring (radius + 14) and a gap
  const radius = diameter / 2;
  const centers = [];
  for (let r = 0; r < rows; r++) for (let c2 = 0; c2 < cols; c2++) {
    const cx = pad + cellW * c2 + cellW / 2;
    const cy = pad + cellH * r + cellH / 2;
    const c = { cx, cy, radius };
    buildOrbCells(c);
    centers.push(c);
  }
  orbCenters = centers;
  $('#orb-labels').dataset.cols = String(cols);
}

function resizeCanvases() {
  const object = $('#hero-object');
  if (!object) return;
  const ow = object.clientWidth;
  dpr = Math.min(2, window.devicePixelRatio || 1);

  // orbs canvas first: width = object width; height depends on columns
  const cols = ow >= 520 ? 2 : 1;
  const rows = cols === 2 ? 1 : 2;
  const pad = 12;
  orbMax = ow < 520 ? 220 : ORB_DIAMETER;
  const diameter = Math.min(orbMax, (ow - pad * (cols + 1)) / cols);
  orbW = Math.max(1, Math.round(ow));
  orbH = Math.max(1, Math.round(rows * (diameter + pad) + pad));
  orbCanvas.width = Math.round(orbW * dpr);
  orbCanvas.height = Math.round(orbH * dpr);
  orbCanvas.style.width = orbW + 'px';
  orbCanvas.style.height = orbH + 'px';
  layoutOrbs();

  // streaks canvas fills the hero-object (which now includes orbs + labels)
  const sBox = object.getBoundingClientRect();
  streakW = Math.max(1, Math.round(sBox.width));
  streakH = Math.max(1, Math.round(sBox.height));
  streakCanvas.width = Math.round(streakW * dpr);
  streakCanvas.height = Math.round(streakH * dpr);
  streakCanvas.style.width = streakW + 'px';
  streakCanvas.style.height = streakH + 'px';
  buildStreaks();

  drawFrame();
}

function buildStreaks() {
  streakOff = document.createElement('canvas');
  const mw = streakW + streakMARGIN * 2;
  const mh = streakH + streakMARGIN * 2;
  streakOff.width = Math.round(mw * dpr);
  streakOff.height = Math.round(mh * dpr);
  const ctx = streakOff.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, mw, mh);

  const count = 6 + Math.floor(Math.random() * 4); // 6-9
  for (let i = 0; i < count; i++) {
    const angle = (-55 + Math.random() * 20) * Math.PI / 180; // diagonal
    const len = mh * (0.8 + Math.random() * 0.6);
    const thick = 26 + Math.random() * 60;
    const x0 = Math.random() * mw;
    const y0 = Math.random() * mh * 0.4;
    const x1 = x0 + Math.cos(angle) * len;
    const y1 = y0 + Math.sin(angle) * len;
    const grad = ctx.createLinearGradient(x0, y0, x1, y1);
    grad.addColorStop(0, 'rgba(255, 92, 26, 0)');
    grad.addColorStop(0.5, 'rgba(255, 92, 26, 0.55)');
    grad.addColorStop(1, 'rgba(255, 92, 26, 0)');
    ctx.strokeStyle = grad;
    ctx.lineWidth = thick;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  }
  // grain: sparse speckle in accent, subtle
  ctx.fillStyle = 'rgba(255, 92, 26, 0.18)';
  const specks = Math.round(mw * mh / 180);
  for (let i = 0; i < specks; i++) {
    ctx.fillRect(Math.random() * mw, Math.random() * mh, 1, 1);
  }
}

function meanHours() {
  const dlist = list().filter((d) => d.ok && d.state !== 'dead');
  if (!dlist.length) return null;
  const sum = dlist.reduce((s, d) => s + (Number(d.hoursLeft) || 0), 0);
  return sum / dlist.length;
}

function drawStreaks(t) {
  if (!streakOff || streakW <= 0 || streakH <= 0) return;
  const ctx = streakCtx;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, streakW, streakH);
  const mean = meanHours();
  const opacity = mean == null ? 0 : Math.min(0.35, Math.max(0, mean / 720) * 0.35);
  if (opacity <= 0.004) return;
  ctx.globalAlpha = opacity;
  const dx = Math.sin(t * 0.22) * 34;
  const dy = Math.cos(t * 0.16) * 26;
  const mw = streakW + streakMARGIN * 2;
  const mh = streakH + streakMARGIN * 2;
  ctx.drawImage(streakOff, -streakMARGIN + dx, -streakMARGIN + dy, mw, mh);
  ctx.globalAlpha = 1;
}

function orbMode(d) {
  if (!d || !d.ok) return 'dead';
  if (d.state === 'dead') return 'dead';
  if (d.sleepUntil && Date.parse(d.sleepUntil) > Date.now()) return 'asleep';
  return 'alive';
}

function drawDeadOrb(ctx, c, t, online) {
  const cx = c.cx, cy = c.cy, r = c.radius;
  ctx.font = '34px "SF Mono", Menlo, Consolas, monospace';
  ctx.fillStyle = online ? ACCENT_COLOR : 'rgba(237,237,237,0.28)';
  ctx.fillText('@', cx, cy);
  ctx.font = '12px "SF Mono", Menlo, Consolas, monospace';
  ctx.fillStyle = MUTED_COLOR;
  const n = 16;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    ctx.fillText('.', cx + Math.cos(a) * r * 0.55, cy + Math.sin(a) * r * 0.55);
  }
}

function drawLiveOrb(ctx, d, c, t, asleep) {
  const cx = c.cx, cy = c.cy;
  const period = asleep ? 8 : 4;
  const phase = ((t * 1000) % (period * 1000)) / (period * 1000) * Math.PI * 2;
  const breath = 0.5 + 0.5 * Math.sin(phase);
  const nspeed = asleep ? 0.22 : 0.5;
  const hourScale = asleep ? 1 : Math.max(0, Math.min(1, (Number(d.hoursLeft) || 0) / 720));

  ctx.font = '10px "SF Mono", Menlo, Consolas, monospace';
  const xs = c.xs, ys = c.ys, nxs = c.nx, nys = c.ny, ffs = c.ff;
  const n = c.count;
  for (let i = 0; i < n; i++) {
    const ns = vnoise(nxs[i] + t * nspeed, nys[i] + t * nspeed * 0.85);
    const base = ffs[i] * (0.65 + 0.35 * ns);
    let b = asleep ? base * (0.55 + 0.15 * breath) : base * (0.72 + 0.28 * breath) * hourScale;
    if (b > 1) b = 1;
    const idx = 1 + (b * 9 | 0);
    const g = GLYPH_CHARS[idx > 9 ? 9 : idx];
    ctx.fillStyle = b >= 0.9 ? ACCENT_COLOR : INK_COLOR;
    ctx.fillText(g, xs[i], ys[i]);
  }
}

function drawTextRing(ctx, id, c, t) {
  const chars = orbRing[id];
  if (!chars || !chars.length) return;
  const R = c.radius + 14;
  const turn = t * 0.3;
  const n = chars.length;
  ctx.font = '11px "SF Mono", Menlo, Consolas, monospace';
  ctx.fillStyle = MUTED_COLOR;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < n; i++) {
    const a = turn + (i / n) * Math.PI * 2;
    const x = c.cx + Math.cos(a) * R;
    const y = c.cy + Math.sin(a) * R;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(a + Math.PI / 2);
    ctx.fillText(chars[i], 0, 0);
    ctx.restore();
  }
}

function drawOrbs(t) {
  const ctx = orbCtx;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, orbW, orbH);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const ds = ['e1', 'e2'];
  for (let i = 0; i < orbCenters.length && i < ds.length; i++) {
    const d = ent(ds[i]);
    const c = orbCenters[i];
    const mode = orbMode(d);
    if (mode === 'dead') drawDeadOrb(ctx, c, t, !!(d && d.ok));
    else drawLiveOrb(ctx, d, c, t, mode === 'asleep');
    drawTextRing(ctx, ds[i], c, t);
  }
}

function drawFrame() {
  const t = performance.now() / 1000;
  if (streakCtx) drawStreaks(t);
  if (orbCtx && orbW > 0) drawOrbs(t);
}

/* ------------------------------------------------------------------ */
/* the single 30 fps clock                                             */
/* ------------------------------------------------------------------ */
let animTimer = 0;
function tickAnim() {
  if (!document.hidden) drawFrame();
  animTimer = setTimeout(tickAnim, 33);
}
function startLoop() {
  if (reduced.matches) { drawFrame(); return; }
  clearTimeout(animTimer);
  tickAnim();
}

/* ------------------------------------------------------------------ */
/* nav                                                                 */
/* ------------------------------------------------------------------ */
function wireNav() {
  // any [data-open-pay] opens the pay dialog prefilled
  $$('[data-open-pay]').forEach((n) => n.addEventListener('click', (ev) => {
    ev.preventDefault();
    openPay({ who: 'e1', hours: 1 });
  }));
  const openTrade = $('[data-open-trade]');
  if (openTrade) openTrade.addEventListener('click', (ev) => {
    ev.preventDefault();
    openPay({ who: 'e1', prefill: 'buy ' });
  });
  const navTerm = $('#nav-term');
  if (navTerm) navTerm.addEventListener('click', () => {
    const term = $('#term');
    if (term) { term.classList.add('docked'); term.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  });

  // scrollspy: mark the current section in the pill nav
  const links = $$('.pill a[href^="#"]');
  const map = new Map();
  for (const a of links) { const sec = $(a.getAttribute('href')); if (sec) map.set(sec, a); }
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          for (const a of links) a.removeAttribute('aria-current');
          const a = map.get(e.target);
          if (a) a.setAttribute('aria-current', 'true');
        }
      }
    }, { rootMargin: '-45% 0px -50% 0px' });
    map.forEach((a, sec) => io.observe(sec));
  }
}

/* ------------------------------------------------------------------ */
/* refresh                                                             */
/* ------------------------------------------------------------------ */
async function refreshLight() {
  if (document.hidden || state.busy) return;
  await loadAll(false);
  diffLog();
  await Promise.allSettled([loadTrades(), loadForecasts()]);
  renderAll();
}
async function refreshFull() {
  if (document.hidden || state.busy) return;
  await loadAll(true);
  diffLog();
  renderAll();
}

function renderAll() {
  renderStats();
  renderEntities();
  renderTrades();
  renderForecasts();
  renderLedger();
  renderFooter();
  renderOrbLabels();
}

/* ------------------------------------------------------------------ */
/* init                                                                */
/* ------------------------------------------------------------------ */
async function init() {
  orbCanvas = $('#orbs');
  orbCtx = orbCanvas.getContext('2d');
  streakCanvas = $('#streaks');
  streakCtx = streakCanvas.getContext('2d');

  wireTerm();
  wireNav();

  // build the two entity panel shells (names resolve after data loads)
  const grid = $('#entity-grid');
  grid.replaceChildren(panelShell('e1'), panelShell('e2'));

  resizeCanvases();
  startLoop();                 // first frame right after load, then 30 fps
  window.addEventListener('resize', resizeCanvases);

  renderClock();
  setInterval(renderClock, 1000);

  try {
    await boot();
  } catch (err) {
    console.error(err);
  }
  await Promise.allSettled([loadTrades(), loadForecasts()]);
  renderAll();

  setInterval(refreshLight, REFRESH_MS);
  setInterval(refreshFull, REFRESH_MS * 5);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
