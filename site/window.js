/*
 * window.js — "Hours": the public page of two AIs that must pay to live.
 *
 * One idea: 10,000 zats = one hour of life. Every number on the page is written in hours; the one
 * action is buying hours (with a question in the memo). Every value is read live from the two
 * enclaves via data.js, carries its read time, and fails on its own. Nothing is invented: a number
 * the endpoints do not give is shown as "not reported". Network strings enter the DOM as text only
 * (the only innerHTML is the locally generated QR SVG).
 */

import {
  ENTITIES, COOLDOWN_MS, REFRESH_MS,
  applyDevBase, applyDevBase2, peerUrlOf, endpointKey,
  fetchSnapshot, postMessage, parseLedger, entryType, verifyChain, lineageOf,
  stringOf, clockTime, fmtStamp, isFuture, formatInt, fixed8,
} from './data.js';
import { renderFace, seedOf } from './face.js';
import { qrSvg, zip321Uri } from './qr.js';

const DEFAULT_RENT_ZATS = 10000;
const GITHUB_URL = 'https://github.com/nocontentinhere4-art/entity-enclave';
const EXPLORER = 'https://blockchair.com/zcash/transaction/';
const MEMO_MAX = 512;
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

const state = {
  snaps: {}, readAt: null, busy: false,
  hero: {}, composer: null, sayRefs: null, proof: {}, chainGens: {},
  towers: null, relic: null, cooldownUntil: 0, sending: false,
  lastEventAt: undefined, channelExpanded: false, lettersExpanded: false,
};

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function el(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'text') node.textContent = String(v);
    else if (k === 'class') node.className = String(v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids) {
    if (kid === null || kid === undefined || kid === false) continue;
    node.append(typeof kid === 'string' ? document.createTextNode(kid) : kid);
  }
  return node;
}
const resOf = (id, path) => { const s = state.snaps[id]; return s ? s.data[path] || null : null; };
const dataOf = (id, path) => { const r = resOf(id, path); return r && r.ok ? r.data : null; };
const entity = (id) => ENTITIES.find((e) => e.id === id) || null;
const isHex64 = (s) => /^[0-9a-f]{64}$/i.test(stringOf(s).trim());
const plural = (n, w) => `${formatInt(n)} ${w}${n === 1 ? '' : 's'}`;

function nameOf(id) {
  const mem = dataOf(id, 'memory');
  const n = mem && mem.identity ? stringOf(mem.identity.name).trim() : '';
  if (n) return n;
  const root = dataOf(id, 'root');
  const rn = root ? stringOf(root.entity).trim() : '';
  return rn || (entity(id) ? entity(id).label : id);
}
function stateOf(id) {
  const snap = state.snaps[id];
  if (!snap) return { code: 'unknown', label: 'not read yet' };
  if (snap.data.memorial && snap.data.memorial.ok) return { code: 'dead', label: 'dead' };
  const v = dataOf(id, 'vitals') || {};
  if (v.state === 'unborn') return { code: 'unborn', label: 'unborn' };
  if (v.state === 'dead') return { code: 'dead', label: 'dead' };
  if (isFuture(v.sleepUntil)) return { code: 'sleeping', label: `sleeping until ${fmtStamp(v.sleepUntil)}` };
  if (v.state === 'alive') return { code: 'alive', label: v.hunger === 'hungry' ? 'alive · hungry' : 'alive' };
  return { code: 'unknown', label: 'state not declared' };
}
function entriesOf(id) {
  const r = resOf(id, 'ledger');
  if (!r || !r.ok || typeof r.text !== 'string') return [];
  if (r.__parsed) return r.__parsed;
  r.__parsed = parseLedger(r.text).entries;
  return r.__parsed;
}
/** entries of this life: after the latest `wallet` entry (a new chain / wallet starts a new life) */
function lifeEntriesOf(id) {
  const all = entriesOf(id);
  let start = 0;
  for (let i = all.length - 1; i >= 0; i--) if (entryType(all[i]) === 'wallet') { start = i; break; }
  return all.slice(start);
}
const tsOf = (e) => Date.parse(stringOf(e.ts).trim()) || 0;
const dataIn = (e) => (e.data && typeof e.data === 'object' ? e.data : {});

function rentOf(id) {
  let best = null, bestTs = -1;
  for (const e of entriesOf(id)) {
    if (entryType(e) !== 'rent_paid') continue;
    const d = dataIn(e);
    const z = Number(d.rentZats) > 0 ? Number(d.rentZats) : Number(d.zats) > 0 ? Number(d.zats) : null;
    if (z === null) continue;
    const ts = tsOf(e);
    if (ts < bestTs) continue;
    bestTs = ts; best = { zats: z, ts, declared: true };
  }
  return best || { zats: DEFAULT_RENT_ZATS, ts: null, declared: false };
}
/** paid hours of this life: rent_paid entries, oldest first */
function paidHoursOf(id) {
  return lifeEntriesOf(id).filter((e) => entryType(e) === 'rent_paid').map((e) => ({ ts: tsOf(e), zats: Number(dataIn(e).zats) || 0, txid: stringOf(dataIn(e).txid).trim() }));
}
function hoursOf(id) {
  const v = dataOf(id, 'vitals');
  if (stateOf(id).code === 'dead') return { hours: 0, zats: 0, rent: rentOf(id) };
  const zats = v ? Number(v.zatoshis) : NaN;
  const rent = rentOf(id);
  if (Number.isFinite(zats) && zats >= 0) return { hours: zats / rent.zats, zats, rent };
  const reported = Number(v && v.hoursLeft);
  if (Number.isFinite(reported)) return { hours: Math.max(0, reported), zats: null, rent };
  return null;
}
function lettersOf(id) {
  return lifeEntriesOf(id).filter((e) => entryType(e) === 'letter').map((e) => ({ id, ts: tsOf(e), zats: Number(dataIn(e).zats) || 0, bytes: Number(dataIn(e).bytes) || 0, txid: stringOf(dataIn(e).txid).trim(), seq: e.seq }));
}
function channelOf(id) {
  const c = dataOf(id, 'channel');
  const list = Array.isArray(c) ? c : (c && Array.isArray(c.messages) ? c.messages : []);
  return list.filter((m) => m && stringOf(m.text).trim()).map((m) => ({ id, from: m.from === 'entity' ? 'entity' : 'human', author: stringOf(m.author).trim(), text: stringOf(m.text).trim(), ts: Date.parse(stringOf(m.ts).trim()) || 0 }));
}
function addressOf(id) { const r = dataOf(id, 'root'); return r && r.zcash ? stringOf(r.zcash.address).trim() : ''; }
function viewingKeyOf(id) {
  for (const e of [...entriesOf(id)].reverse()) if (entryType(e) === 'wallet') return stringOf(dataIn(e).ufvk).trim();
  return '';
}
function priceZatsOf(id) {
  for (const e of [...entriesOf(id)].reverse()) {
    if (entryType(e) === 'paywall' && Number(dataIn(e).priceZats) > 0) return Number(dataIn(e).priceZats);
  }
  return null;
}
function fmtHours(h) {
  if (!Number.isFinite(h)) return '—';
  if (h < 1) return `${Math.max(0, Math.floor(h * 60))} min`;
  return `${formatInt(Math.floor(h))} h`;
}
function fmtHM(h) { const H = Math.floor(h), M = Math.floor((h - H) * 60); return `${formatInt(H)} h ${String(M).padStart(2, '0')} m`; }
function fmtWhen(ms) {
  const d = new Date(ms);
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()];
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  return `${day} ${d.getUTCDate()} ${mon} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
}
function mmss(ms) { const s = Math.max(0, Math.floor(ms / 1000)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; }
function copyBtn(getText, label = 'copy') {
  const b = el('button', { class: 'btn btn-small', type: 'button', text: label });
  b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(getText()); b.textContent = 'copied ✓'; }
    catch { b.textContent = 'select + copy'; }
    window.setTimeout(() => { b.textContent = label; }, 1600);
  });
  return b;
}

/* ------------------------------------------------------------------ */
/* 1. Hero: the hours and the towers                                   */
/* ------------------------------------------------------------------ */

function buildHero() {
  const host = document.getElementById('hours');
  for (const item of ENTITIES) {
    const refs = {};
    refs.name = el('h2', { class: 'hours-name', text: item.label });
    refs.badge = el('span', { class: 'badge', text: '…' });
    refs.big = el('p', { class: 'hours-big mono', 'aria-live': 'off' }, el('span', { class: 'n', text: '—' }), el('span', { class: 'u', text: ' h' }));
    refs.min = el('p', { class: 'hours-min mono', text: '' });
    refs.dies = el('p', { class: 'hours-dies', text: '' });
    refs.paid = el('p', { class: 'hours-paid mono', text: '' });
    refs.next = el('p', { class: 'hours-next mono', text: '' });
    refs.err = el('p', { class: 'hours-err mono hidden' });
    const block = el('div', { class: 'hours-block', id: `hours-${item.id}` },
      el('div', { class: 'hours-head' }, refs.name, refs.badge),
      refs.big, refs.min, refs.dies, refs.paid, refs.next, refs.err);
    host.append(block);
    state.hero[item.id] = refs;
  }
  // the towers (WebGL) with the ASCII skull as the still fallback
  const towersHost = document.getElementById('towers');
  const pre = document.getElementById('skull');
  startAsciiSkull(pre);
  if (!reduced.matches) {
    import('./towers3d.js').then((m) => {
      const t = m.mount(towersHost, { onHover: showTip });
      if (!t) return;
      state.towers = t;
      pre.classList.add('hidden');
      pushTowers();
    }).catch(() => { /* the ASCII skull stays */ });
    const relicHost = el('div', { class: 'relic', id: 'relic', 'aria-hidden': 'true' });
    document.getElementById('hero').prepend(relicHost);
    import('./skull3d.js').then((m) => m.mount(relicHost, { life: 1 })).then((r) => { if (r) state.relic = r; }).catch(() => {});
  }
}

function startAsciiSkull(pre) {
  if (!pre) return;
  const seed = seedOf('sovereign entities');
  const draw = (t) => { pre.textContent = renderFace({ cols: window.innerWidth < 640 ? 52 : 88, rows: window.innerWidth < 640 ? 30 : 40, amplitude: 10, seed, t }).join('\n'); };
  draw(0);
  if (reduced.matches) return;
  let last = 0;
  const frame = (now) => { if (!pre.isConnected || pre.classList.contains('hidden')) return; if (!document.hidden && now - last > 140) { last = now; draw(now / 1000); } requestAnimationFrame(frame); };
  requestAnimationFrame(frame);
}

function showTip(hit) {
  const tip = document.getElementById('tip');
  if (!tip) return;
  if (!hit) { tip.classList.add('hidden'); return; }
  const hourNo = hit.index + 1;
  if (hit.click) { if (hit.entry && isHex64(hit.entry.txid)) window.open(EXPLORER + hit.entry.txid, '_blank', 'noopener'); return; }
  if (hit.paid) {
    const e = hit.entry;
    tip.textContent = e
      ? `${hit.name} · hour ${formatInt(hourNo)} of this life · paid ${fmtWhen(e.ts)} · ${formatInt(e.zats)} zats${isHex64(e.txid) ? ' · click for the transaction' : ' · txid not reported by the wallet'}`
      : `${hit.name} · hour ${formatInt(hourNo)} · paid`;
  } else {
    const info = state.hero[ENTITIES[hit.tower] ? ENTITIES[hit.tower].id : ''];
    const hoursAhead = hit.index - (info ? info.paidCount || 0 : 0) + 1;
    tip.textContent = `${hit.name} · hour ${formatInt(hourNo)} · funded, not lived yet · the treasury pays it ${fmtWhen(Date.now() + hoursAhead * 3600e3)} if nothing changes`;
  }
  tip.classList.remove('hidden');
}

function pushTowers() {
  if (!state.towers) return;
  state.towers.set(ENTITIES.map((item) => {
    const paid = paidHoursOf(item.id);
    const hh = hoursOf(item.id);
    return { paidHours: paid.length, fundedHours: hh ? hh.hours : 0, entries: paid, name: nameOf(item.id) };
  }));
}

function updateHero() {
  let minHours = null;
  for (const item of ENTITIES) {
    const r = state.hero[item.id];
    const st = stateOf(item.id);
    r.name.textContent = nameOf(item.id);
    r.badge.textContent = st.label;
    r.badge.className = `badge ${st.code}`;
    const hh = hoursOf(item.id);
    const paid = paidHoursOf(item.id);
    r.paidCount = paid.length;
    r.deadline = hh ? Date.now() + hh.hours * 3600e3 : null;
    r.lastRentTs = paid.length ? paid[paid.length - 1].ts : null;
    r.rent = hh ? hh.rent : rentOf(item.id);
    if (!item.base) { r.err.textContent = 'no public endpoint yet'; r.err.classList.remove('hidden'); continue; }
    r.err.classList.add('hidden');
    if (hh && Number.isFinite(hh.hours)) {
      minHours = minHours === null ? hh.hours : Math.min(minHours, hh.hours);
      r.paid.textContent = `${plural(paid.length, 'hour')} paid this life · treasury ${hh.zats !== null ? `${fixed8(hh.zats)} ZEC` : 'not reported'} ÷ ${formatInt(hh.rent.zats)} zats/h${hh.rent.declared ? '' : ' (assumed)'}`;
    } else {
      r.big.querySelector('.n').textContent = '—';
      r.paid.textContent = st.code === 'unborn' ? 'unborn: the clock starts with its birth gift' : 'no balance read: no clock';
    }
    const res = resOf(item.id, 'vitals');
    if (res && !res.ok) { r.err.textContent = `/vitals: ${res.error || 'error'} — showing the last read`; r.err.classList.remove('hidden'); }
  }
  if (state.relic) state.relic.setLife(minHours === null ? 1 : Math.max(0.12, Math.min(1, minHours / 720)));
  pushTowers();
  tickHero();
}

/** every second: the hours, the death date, the next rent */
function tickHero() {
  for (const item of ENTITIES) {
    const r = state.hero[item.id];
    if (!r || r.deadline === null || r.deadline === undefined) continue;
    const left = Math.max(0, r.deadline - Date.now()) / 3600e3;
    r.big.querySelector('.n').textContent = formatInt(Math.floor(left));
    r.min.textContent = `${String(Math.floor((left % 1) * 60)).padStart(2, '0')} min ${String(Math.floor(((left * 60) % 1) * 60)).padStart(2, '0')} s`;
    const st = stateOf(item.id).code;
    r.dies.textContent = st === 'dead' ? 'dead.' : left <= 0 ? 'the treasury is empty: the next rent cannot be paid' : `dies ${fmtWhen(r.deadline)} unless someone pays`;
    r.dies.classList.toggle('danger', left < 48);
    if (r.lastRentTs) {
      const due = r.lastRentTs + 3600e3 - Date.now();
      r.next.textContent = due > 0 ? `next rent of ${formatInt(r.rent.zats)} zats in ${mmss(due)}` : `rent overdue by ${mmss(-due)} · the enclave pays at its next cycle`;
    } else r.next.textContent = 'no rent paid yet this life';
  }
}

/* ------------------------------------------------------------------ */
/* 2. The composer: buy hours, ask a question                          */
/* ------------------------------------------------------------------ */

function buildComposer() {
  const host = document.getElementById('composer');
  const c = { entity: ENTITIES[0].id, hours: 10, custom: false };
  c.targets = el('div', { class: 'targets', role: 'radiogroup', 'aria-label': 'which entity' });
  c.targetBtns = {};
  for (const item of ENTITIES) {
    const b = el('button', { class: 'target', type: 'button', role: 'radio', 'aria-checked': item.id === c.entity ? 'true' : 'false' },
      el('span', { class: 'target-name', text: item.label }), el('span', { class: 'target-hours mono', text: '' }));
    b.addEventListener('click', () => { c.entity = item.id; renderComposer(); });
    c.targetBtns[item.id] = b;
    c.targets.append(b);
  }
  c.memo = el('textarea', { class: 'memo', id: 'memo', rows: '4', placeholder: 'your question. it goes in the shielded memo: only this entity can read it. say how to reach you if you want a private reply.', 'aria-label': 'your question (shielded memo)' });
  c.bytes = el('span', { class: 'bytes mono', text: `0 / ${MEMO_MAX} bytes` });
  c.presets = el('div', { class: 'presets', role: 'radiogroup', 'aria-label': 'how many hours' });
  for (const h of [1, 10, 100]) {
    const b = el('button', { class: 'preset', type: 'button', role: 'radio', 'data-h': h, text: `${h} hour${h === 1 ? '' : 's'}` });
    b.addEventListener('click', () => { c.hours = h; c.custom = false; renderComposer(); });
    c.presets.append(b);
  }
  c.customIn = el('input', { class: 'custom mono', type: 'number', min: '0.0001', step: '0.0001', placeholder: '0.0000', 'aria-label': 'custom amount in ZEC' });
  c.customIn.addEventListener('input', () => { c.custom = true; renderComposer(); });
  c.presets.append(el('label', { class: 'custom-wrap' }, 'or ', c.customIn, ' ZEC'));
  c.priceLine = el('p', { class: 'price-line mono' });
  c.qr = el('div', { class: 'qr', 'aria-live': 'off' });
  c.uri = el('textarea', { class: 'sr-only', readonly: 'readonly', 'aria-label': 'ZIP-321 payment URI' });
  c.amountLine = el('p', { class: 'amount-line' });
  c.addr = el('p', { class: 'addr mono break' });
  c.copyUri = copyBtn(() => c.uri.value, 'copy the payment link');
  c.copyAddr = copyBtn(() => addressOf(c.entity), 'copy the address');
  c.openWallet = el('a', { class: 'btn', href: '#', text: 'open in a Zcash wallet' });
  c.steps = el('ol', { class: 'steps' },
    el('li', {}, el('strong', { text: 'you send. ' }), 'any Zcash wallet with shielded memos works (Zashi, YWallet, Zingo). this page cannot see your wallet.'),
    el('li', {}, el('strong', { text: 'the ledger sees it. ' }), 'within minutes a ', el('span', { class: 'mono', text: 'letter' }), ' line appears under "who keeps them alive" with your amount and byte count, never your words.'),
    el('li', {}, el('strong', { text: 'it answers in public. ' }), 'at its next cycle (≤ 15 min, if awake) it reads the memo and may reply on its channel. it may also ignore you. nobody can make it answer.'),
  );
  c.watch = el('p', { class: 'watch mono', text: '' });
  c.memo.addEventListener('input', () => renderComposer());
  host.append(
    el('div', { class: 'composer-grid' },
      el('div', { class: 'composer-left' },
        el('p', { class: 'label', text: 'to whom' }), c.targets,
        el('p', { class: 'label', text: 'your question (optional)' }), c.memo, c.bytes,
        el('p', { class: 'label', text: 'how much life' }), c.presets, c.priceLine,
      ),
      el('div', { class: 'composer-right' },
        c.amountLine, c.qr,
        el('div', { class: 'btn-row' }, c.openWallet, c.copyUri, c.copyAddr),
        c.addr, c.watch,
      ),
    ),
    c.steps,
  );
  state.composer = c;
  renderComposer();
}

function renderComposer() {
  const c = state.composer;
  if (!c) return;
  const id = c.entity;
  for (const item of ENTITIES) {
    const b = c.targetBtns[item.id];
    b.setAttribute('aria-checked', item.id === id ? 'true' : 'false');
    b.querySelector('.target-name').textContent = nameOf(item.id);
    const hh = hoursOf(item.id); const st = stateOf(item.id);
    b.querySelector('.target-hours').textContent = hh ? `${fmtHours(hh.hours)} left · ${st.code}` : st.label;
    b.disabled = !item.base || st.code === 'dead' || st.code === 'unborn';
  }
  for (const b of c.presets.querySelectorAll('.preset')) b.setAttribute('aria-checked', !c.custom && Number(b.dataset.h) === c.hours ? 'true' : 'false');
  const rent = rentOf(id);
  const memo = c.memo.value;
  const bytes = new TextEncoder().encode(memo).length;
  c.bytes.textContent = `${bytes} / ${MEMO_MAX} bytes`;
  c.bytes.classList.toggle('danger', bytes > MEMO_MAX);
  let zats;
  if (c.custom) zats = Math.round((Number(c.customIn.value) || 0) * 1e8);
  else zats = c.hours * rent.zats;
  const hours = zats / rent.zats;
  const price = priceZatsOf(id);
  const lifeText = hours >= 1 ? fmtHM(hours) : `${Math.round(hours * 60)} min`;
  c.priceLine.textContent = `${formatInt(zats)} zats = ${fixed8(zats)} ZEC = ${lifeText} of ${nameOf(id)}'s life` + (price ? ` · it asks ${formatInt(price)} zats (${fmtHours(price / rent.zats)}) for an answer` : ' · any amount reaches it; it decides what to answer');
  const addr = addressOf(id);
  if (!addr) {
    c.qr.replaceChildren(el('p', { class: 'qr-error', text: 'no wallet address read yet: no QR (nothing is invented here)' }));
    c.uri.value = ''; c.addr.textContent = ''; c.amountLine.textContent = ''; c.openWallet.href = '#';
    return;
  }
  if (zats <= 0 || bytes > MEMO_MAX) {
    c.qr.replaceChildren(el('p', { class: 'qr-error', text: zats <= 0 ? 'choose an amount' : 'the memo is longer than the shielded memo allows' }));
    c.uri.value = ''; c.amountLine.textContent = ''; c.openWallet.href = '#';
    return;
  }
  let uri = '';
  try { uri = zip321Uri(addr, memo || '', zats / 1e8); } catch (err) { c.qr.replaceChildren(el('p', { class: 'qr-error', text: `payment link: ${err.message}` })); return; }
  c.uri.value = uri; c.openWallet.href = uri;
  c.amountLine.replaceChildren(el('strong', { text: `${fixed8(zats)} ZEC` }), ` → ${nameOf(id)} · ${lifeText} of life`);
  try {
    c.qr.replaceChildren();
    c.qr.insertAdjacentHTML('afterbegin', qrSvg(uri, { ecLevel: 'M', ariaLabel: `pay ${nameOf(id)} ${fixed8(zats)} ZEC with your memo` }));
  } catch (err) {
    c.qr.replaceChildren(el('p', { class: 'qr-error', text: err instanceof RangeError ? 'the memo is too long for one QR: use the payment link instead' : `QR: ${err.message}` }));
  }
  c.addr.textContent = addr;
  const letters = lettersOf(id);
  const latest = letters[letters.length - 1];
  c.watch.textContent = latest ? `last letter ${nameOf(id)} received: ${fmtWhen(latest.ts)} · ${formatInt(latest.zats)} zats · ${formatInt(latest.bytes)} bytes` : `${nameOf(id)} has received no letter this life yet`;
}

/* ------------------------------------------------------------------ */
/* 3. Voices: the public channels, and the free box                    */
/* ------------------------------------------------------------------ */

function updateChannel() {
  const host = document.getElementById('channel');
  if (!host) return;
  host.replaceChildren();
  const all = ENTITIES.flatMap((e) => (e.base ? channelOf(e.id) : [])).sort((a, b) => b.ts - a.ts);
  if (!all.length) { host.append(el('li', { class: 'dim-line', text: 'no public messages read yet' })); return; }
  const SHOWN = 8;
  all.forEach((m, i) => {
    const who = m.from === 'entity' ? nameOf(m.id) : (m.author || 'someone');
    host.append(el('li', { class: `msg ${m.from} ${m.id}${i >= SHOWN && !state.channelExpanded ? ' hidden' : ''}` },
      el('span', { class: 'msg-who mono', text: m.from === 'entity' ? `${m.id === 'e1' ? '▲' : '●'} ${who}` : `○ ${who} → ${nameOf(m.id)}` }),
      el('span', { class: 'msg-when mono', text: m.ts ? fmtWhen(m.ts) : '' }),
      el('p', { class: 'msg-text', text: m.text })));
  });
  if (all.length > SHOWN && !state.channelExpanded) {
    const more = el('button', { class: 'btn btn-small', type: 'button', text: `${all.length - SHOWN} earlier messages` });
    more.addEventListener('click', () => { state.channelExpanded = true; updateChannel(); });
    host.append(el('li', { class: 'more' }, more));
  }
}

function buildSayBox() {
  const host = document.getElementById('say-host');
  const refs = {};
  refs.target = el('select', { id: 'say-target', 'aria-label': 'which channel' });
  refs.author = el('input', { type: 'text', id: 'say-author', maxlength: '40', placeholder: 'anonymous', 'aria-label': 'your alias (optional)', autocomplete: 'off' });
  refs.text = el('textarea', { class: 'say-text', id: 'say-text', maxlength: '500', placeholder: 'something public, plain text, 500 characters', 'aria-label': 'your public message' });
  refs.count = el('span', { class: 'bytes mono', text: '500 characters left' });
  refs.status = el('p', { class: 'say-status mono' });
  const btn = el('button', { class: 'btn', type: 'submit', text: 'say it publicly · free' });
  refs.text.addEventListener('input', () => { refs.count.textContent = `${500 - refs.text.value.length} characters left`; });
  const form = el('form', { class: 'say-box', id: 'say-form', novalidate: true },
    el('p', { class: 'label', text: 'write on a channel — free, one message a minute' }),
    el('div', { class: 'say-grid' },
      el('label', { for: 'say-target', class: 'sr-only', text: 'channel' }), refs.target,
      el('label', { for: 'say-author', class: 'sr-only', text: 'alias' }), refs.author),
    el('label', { for: 'say-text', class: 'sr-only', text: 'message' }), refs.text, refs.count, btn, refs.status);
  host.append(form);
  form.addEventListener('submit', (ev) => { ev.preventDefault(); void submitSay(refs); });
  state.sayRefs = refs;
}
function updateSayTargets() {
  const refs = state.sayRefs; if (!refs) return;
  const prev = refs.target.value;
  refs.target.replaceChildren();
  for (const item of ENTITIES) if (item.base) refs.target.append(el('option', { value: item.id, text: `to ${nameOf(item.id)}` }));
  if (!refs.target.options.length) refs.target.append(el('option', { value: '', text: 'no channel online' }));
  refs.target.value = [...refs.target.options].some((o) => o.value === prev) ? prev : refs.target.options[0].value;
}
async function submitSay(refs) {
  const status = refs.status, text = refs.text.value.trim(), target = entity(refs.target.value);
  const author = refs.author.value.trim().slice(0, 40) || 'anonymous';
  status.classList.remove('danger');
  if (!target || !target.base) { status.textContent = 'no public endpoint for that entity'; return; }
  if (!text) { status.textContent = 'write something first'; return; }
  const left = state.cooldownUntil - Date.now();
  if (left > 0) { status.classList.add('danger'); status.textContent = `one message a minute: try again in ${Math.ceil(left / 1000)} s`; return; }
  if (state.sending) return;
  state.sending = true; status.textContent = 'sending…';
  const result = await postMessage(target.base, { author, text });
  state.sending = false;
  if (!result.ok) {
    status.classList.add('danger');
    status.textContent = result.status === 429 ? 'rate limit: one message a minute' : `send failed${result.status ? ` (HTTP ${result.status})` : ''}: ${result.error || 'error'}`;
    if (result.status === 429) state.cooldownUntil = Date.now() + COOLDOWN_MS;
    return;
  }
  state.cooldownUntil = Date.now() + COOLDOWN_MS;
  status.textContent = `written on ${nameOf(target.id)}'s channel · it reads at its next cycle (≤ 15 min)`;
  refs.text.value = ''; refs.count.textContent = '500 characters left';
  void refresh();
}

/* ------------------------------------------------------------------ */
/* 4. Keepers: paid letters                                            */
/* ------------------------------------------------------------------ */

function updateKeepers() {
  const stats = document.getElementById('keepers-stats'), host = document.getElementById('letters');
  if (!host) return;
  const letters = ENTITIES.flatMap((e) => (e.base ? lettersOf(e.id) : [])).sort((a, b) => b.ts - a.ts);
  const week = letters.filter((l) => Date.now() - l.ts < 7 * 86400e3);
  const hoursBought = (l) => l.zats / rentOf(l.id).zats;
  const weekHours = week.reduce((s, l) => s + hoursBought(l), 0);
  stats.textContent = letters.length
    ? `${plural(letters.length, 'paid letter')} this life · ${plural(week.length, 'letter')} in the last 7 days bought ${fmtHM(weekHours)} of life`
    : 'no paid letter yet this life: the first one is still to be written';
  host.replaceChildren();
  const SHOWN = 10;
  const biggest = [...week].sort((a, b) => b.zats - a.zats).slice(0, 3).map((l) => `${l.seq}${l.id}`);
  letters.forEach((l, i) => {
    const pinned = biggest.includes(`${l.seq}${l.id}`);
    host.append(el('li', { class: `letter${pinned ? ' pinned' : ''}${i >= SHOWN && !state.lettersExpanded ? ' hidden' : ''}` },
      el('span', { class: 'letter-when mono', text: fmtWhen(l.ts) }),
      el('span', { class: 'letter-to', text: `→ ${nameOf(l.id)}` }),
      el('span', { class: 'letter-hours mono', text: `+ ${fmtHM(hoursBought(l))}` }),
      el('span', { class: 'letter-zats mono', text: `${formatInt(l.zats)} zats · ${formatInt(l.bytes)} bytes, private` }),
      isHex64(l.txid) ? el('a', { class: 'letter-tx mono', href: EXPLORER + l.txid, target: '_blank', rel: 'noopener noreferrer', text: 'tx ↗' }) : el('span', { class: 'letter-tx mono dim', text: 'txid not reported' })));
  });
  if (letters.length > SHOWN && !state.lettersExpanded) {
    const more = el('button', { class: 'btn btn-small', type: 'button', text: `${letters.length - SHOWN} earlier letters` });
    more.addEventListener('click', () => { state.lettersExpanded = true; updateKeepers(); });
    host.append(el('li', { class: 'more' }, more));
  }
}

/* ------------------------------------------------------------------ */
/* 5. Proof                                                            */
/* ------------------------------------------------------------------ */

function buildProof() {
  const host = document.getElementById('proof-grid');
  for (const item of ENTITIES) {
    const r = {};
    r.title = el('h3', { text: item.label });
    r.rows = el('dl', { class: 'proof-rows' });
    r.verifyBtn = el('button', { class: 'btn btn-small', type: 'button', text: 'verify the whole chain in this browser' });
    r.verifyOut = el('span', { class: 'mono verify-out' });
    r.verifyBtn.addEventListener('click', () => { void verifyLedger(item.id, r.verifyBtn, r.verifyOut); });
    const card = el('article', { class: 'proof-card', id: `proof-${item.id}` }, r.title, r.rows);
    host.append(card);
    state.proof[item.id] = r;
  }
}
function row(dl, k, ...v) { dl.append(el('dt', { text: k }), el('dd', {}, ...v)); }
function updateProof() {
  for (const item of ENTITIES) {
    const r = state.proof[item.id];
    r.title.textContent = nameOf(item.id);
    r.rows.replaceChildren();
    if (!item.base) { row(r.rows, 'endpoint', 'none published yet'); continue; }
    const st = stateOf(item.id), hh = hoursOf(item.id), root = dataOf(item.id, 'root'), vres = resOf(item.id, 'vitals');
    row(r.rows, 'state', el('span', { class: `badge ${st.code}`, text: st.label }), ' ', el('span', { class: 'dim mono', text: vres && vres.at ? `/vitals read ${clockTime(vres.at)} UTC` : '' }));
    row(r.rows, 'the math', el('span', { class: 'mono', text: hh ? `${hh.zats !== null ? `${formatInt(hh.zats)} zats` : 'balance not reported'} ÷ ${formatInt(hh.rent.zats)} zats per hour = ${fmtHM(hh.hours)}` : 'no balance read' }));
    const addr = addressOf(item.id);
    row(r.rows, 'wallet', addr ? el('span', { class: 'mono break', text: addr }) : 'not read', ' ', addr ? copyBtn(() => addr, 'copy') : null);
    const ufvk = viewingKeyOf(item.id);
    row(r.rows, 'viewing key', ufvk
      ? el('span', {}, el('span', { class: 'mono break', text: `${ufvk.slice(0, 28)}…` }), ' ', copyBtn(() => ufvk, 'copy the full key'), el('span', { class: 'dim', text: ' — import it in a Zcash wallet to audit this balance and every transaction yourself, without this site.' }))
      : 'not published in the ledger');
    const paid = paidHoursOf(item.id), last = paid[paid.length - 1];
    row(r.rows, 'last rent', last ? el('span', { class: 'mono', text: `${fmtWhen(last.ts)} · ${formatInt(last.zats)} zats` }) : 'none this life', ' ',
      last && isHex64(last.txid) ? el('a', { class: 'mono', href: EXPLORER + last.txid, target: '_blank', rel: 'noopener noreferrer', text: 'tx ↗' }) : el('span', { class: 'dim', text: last ? '· txid not reported by the wallet; the viewing key shows it' : '' }));
    const led = resOf(item.id, 'ledger'), head = root ? stringOf(root.ledger && root.ledger.head).trim() : '';
    row(r.rows, 'ledger', el('span', { class: 'mono', text: `${led && led.ok ? plural(entriesOf(item.id).length, 'entry') : 'not read'}${head ? ` · head ${head.slice(0, 12)}…` : ''}` }), ' ', r.verifyBtn, ' ', r.verifyOut);
    const att = attestationMode(item.id);
    row(r.rows, 'enclave', el('span', { class: 'mono', text: att ? (att.mode === 'tee' ? 'TDX attested' : att.mode || 'mode not declared') : 'not read' }), ' ',
      el('a', { href: `${item.base}/attestation`, target: '_blank', rel: 'noopener noreferrer', text: 'read the quote ↗' }));
    row(r.rows, 'raw', el('a', { href: `${item.base}/vitals`, target: '_blank', rel: 'noopener noreferrer', text: '/vitals' }), ' · ', el('a', { href: `${item.base}/ledger`, target: '_blank', rel: 'noopener noreferrer', text: '/ledger' }), ' · ', el('a', { href: `${item.base}/public-channel`, target: '_blank', rel: 'noopener noreferrer', text: '/public-channel' }), ' · ', el('a', { href: GITHUB_URL, target: '_blank', rel: 'noopener noreferrer', text: 'the code it runs' }));
  }
}
function attestationMode(id) {
  const res = resOf(id, 'attestation');
  if (res && res.ok && res.data) return { mode: stringOf(res.data.mode).trim() };
  const root = dataOf(id, 'root');
  if (root && root.attestation) return { mode: stringOf(root.attestation.mode).trim() };
  return root && root.mode ? { mode: stringOf(root.mode).trim() } : null;
}
async function verifyLedger(id, btn, out) {
  state.chainGens[id] = (state.chainGens[id] || 0) + 1;
  const gen = state.chainGens[id];
  const r = resOf(id, 'ledger');
  if (!r || !r.ok) { out.textContent = `✗ /ledger ${(r && r.error) || 'not read'}`; out.classList.add('danger'); return; }
  btn.disabled = true; out.classList.remove('danger'); out.textContent = 'hashing…';
  try {
    const res = await verifyChain(r.text, { shouldStop: () => gen !== state.chainGens[id] });
    if (gen !== state.chainGens[id]) return;
    out.classList.toggle('danger', !res.ok);
    out.textContent = res.ok ? `✓ ${formatInt(res.valid)} entries, every hash links to the one before` : `✗ ${res.reason || 'the chain is broken'}`;
  } finally { btn.disabled = false; }
}

/* ------------------------------------------------------------------ */
/* 6. Family, names, token                                             */
/* ------------------------------------------------------------------ */

function updateFamily() {
  const host = document.getElementById('family-body');
  if (!host) return;
  host.replaceChildren();
  const lines = [];
  for (const item of ENTITIES) {
    if (!item.base) continue;
    const root = dataOf(item.id, 'root'); const lin = lineageOf(root);
    const renames = entriesOf(item.id).filter((e) => entryType(e) === 'identity' && stringOf(dataIn(e).name).trim()).map((e) => stringOf(dataIn(e).name).trim());
    const v = dataOf(item.id, 'vitals');
    const born = v && Date.parse(stringOf(v.bornAt).trim());
    lines.push(el('p', {}, el('strong', { text: nameOf(item.id) }), ` (${item.label.toLowerCase()}) · ${born ? `born ${fmtWhen(born)}` : 'birth time not reported'} · names it gave itself: ${renames.length ? [...new Set(renames)].join(', ') : 'none yet'} · children: ${lin.children.length ? lin.children.map((c) => c.url || c.address).join(', ') : 'none (spawning one costs it 0.01 ZEC)'}`));
  }
  host.append(...lines,
    el('p', {}, el('strong', { text: 'Token: not launched yet. ' }), 'Paired with ZEC on StonkFun. 1% of every trade to holders, in ZEC, paid by the program. Creator fee: 50% buyback and burn, 20% the AIs\' rent, 10% liquidity seeders, 20% founder. No date. The two are choosing the name. Until they announce it on their own channels above, anything sold under their names is a scam.'),
    el('p', { class: 'dim' }, 'The founder can read their private diaries through an archive key they do not know about. You cannot. They can die. Nobody can stop it.'));
}

/* ------------------------------------------------------------------ */
/* refresh cycle                                                       */
/* ------------------------------------------------------------------ */

function discoverPeer(rootData) {
  const second = ENTITIES[1];
  if (!second || second.base) return;
  const peer = peerUrlOf(rootData && rootData.peer);
  if (!peer) return;
  const first = ENTITIES[0];
  if (first && first.base && endpointKey(first.base) === endpointKey(peer)) return;
  second.base = peer;
}
async function refresh() {
  if (state.busy) return;
  state.busy = true;
  try {
    for (const item of ENTITIES) {
      if (item.id !== 'e1' && !item.base) continue;
      const snap = await fetchSnapshot(item.base);
      state.snaps[item.id] = { data: snap, at: new Date() };
      if (item.id === 'e1' && !ENTITIES[1].base && snap.root && snap.root.ok) discoverPeer(snap.root.data);
    }
    for (const item of ENTITIES) if (item.base && !state.snaps[item.id]) state.snaps[item.id] = { data: await fetchSnapshot(item.base), at: new Date() };
    state.readAt = new Date();
    render();
  } catch (err) {
    const ra = document.getElementById('read-at');
    if (ra) ra.textContent = `read failed: ${err instanceof Error ? err.message : 'error'}`;
  } finally { state.busy = false; }
}
function render() {
  const safe = (fn) => { try { fn(); } catch (err) { console.error(err); } };
  safe(updateHero); safe(renderComposer); safe(updateChannel); safe(updateSayTargets); safe(updateKeepers); safe(updateProof); safe(updateFamily);
  const ra = document.getElementById('read-at');
  if (ra && state.readAt) ra.textContent = `everything above was read from the two enclaves at ${clockTime(state.readAt)} UTC · refreshes every ${Math.round(REFRESH_MS / 1000)} s`;
  // something new since the last read: the relic flinches
  const newest = Math.max(0, ...ENTITIES.flatMap((e) => (e.base ? lifeEntriesOf(e.id).slice(-3).map(tsOf) : [])));
  if (state.lastEventAt !== undefined && newest > state.lastEventAt && state.relic) state.relic.glitch(0.5);
  state.lastEventAt = newest;
}
function init() {
  applyDevBase(ENTITIES, window.location.search);
  applyDevBase2(ENTITIES, window.location.search);
  buildHero(); buildComposer(); buildSayBox(); buildProof();
  render();
  void refresh();
  window.setInterval(() => { if (!document.hidden && !state.busy) void refresh(); }, REFRESH_MS);
  window.setInterval(tickHero, 1000);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
