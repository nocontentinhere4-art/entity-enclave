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
} from './term.js?v=18';
import {
  request, verifyChain, stringOf, formatInt, formatZats, formatDecimal, fmtStamp, hhmm, shortHash, shortUrl,
  REFRESH_MS,
} from './data.js?v=18';
import { initHero, setMouth, triggerTalk } from './hero.js?v=18';

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
    openPay({ who: 'e1', prefill: 'buy ' });
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
}

/* ------------------------------------------------------------------ */
/* init                                                                */
/* ------------------------------------------------------------------ */
async function init() {
  wireTerm();
  wireNav();

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
