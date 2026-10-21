/* VIGIL — one page, two enclaves. Every number here is fetched or computed from a fetch. */
import {
  ENTITIES, REFRESH_MS, COOLDOWN_MS, request, postMessage, parseLedger, verifyChain, stringOf,
  formatInt, fixed8, peerUrlOf, applyDevBase, applyDevBase2,
} from './data.js';
import { zip321Uri, qrSvg } from './qr.js';

const RENT = 10000; // zats per hour, base rent (matches rent_paid.data.rentZats)
const MEMO_MAX = 500;
const AIS = ENTITIES.map((e) => ({ ...e })); applyDevBase(AIS, location.search); applyDevBase2(AIS, location.search);
const state = { ais: {}, price: null, readAt: null, seen: new Set(), feedInit: false, order: [], pay: { who: 'e1', zats: RENT, memo: '', theirs: null, label: '' }, cooldownUntil: 0 };
const $ = (s, r = document) => r.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else if (k === 'html') n.innerHTML = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null) n.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return n;
};
const utc = (ts) => { const d = new Date(ts); return Number.isNaN(d.getTime()) ? '—' : d.toISOString().slice(11, 16) + ' UTC'; };
const dayUtc = (ts) => { const d = new Date(ts); return Number.isNaN(d.getTime()) ? '—' : `${d.getUTCDate()} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()]} ${d.toISOString().slice(11, 16)} UTC`; };
const usd = (zats) => state.price ? `$${(zats / 1e8 * state.price).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '';
const bytesOf = (s) => new TextEncoder().encode(s).length;
const short = (h, n = 8) => stringOf(h).slice(0, n) + '…';
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------- rolling numbers ---------- */
function roll(node, value, fmt = formatInt) {
  const from = Number(node.dataset.v || 0), to = Number(value);
  if (!Number.isFinite(to)) { node.textContent = '—'; return; }
  node.dataset.v = String(to);
  if (reduced || from === to || !node.isConnected) { node.textContent = fmt(to); return; }
  const t0 = performance.now(), dur = 700;
  const step = (t) => { const p = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - p, 3); node.textContent = fmt(Math.round(from + (to - from) * e)); if (p < 1) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}

/* ---------- fetch + derive ---------- */
async function load(ai, full = true) {
  const base = ai.base;
  const [root, vitals, memory, channel, ledger] = await Promise.all([
    request(base, '/'), request(base, '/vitals'), full ? request(base, '/memory-public') : null, request(base, '/public-channel'), full ? request(base, '/ledger', { text: true }) : null,
  ]);
  const d = state.ais[ai.id] || { id: ai.id, base, entries: [], posts: [], ledgerText: '' };
  d.at = new Date();
  if (root.ok) { d.root = root.data; d.name = stringOf(root.data.entity) || ai.label; d.address = root.data.zcash && root.data.zcash.address || ''; d.npub = root.data.nostr && root.data.nostr.npub || ''; d.app = root.data.app || ''; }
  if (vitals.ok) { d.vitals = vitals.data; d.zats = Number(vitals.data.zatoshis) || 0; d.hoursLeft = Number(vitals.data.hoursLeft) || Math.floor(d.zats / RENT); d.state = stringOf(vitals.data.state) || 'unknown'; d.sleepUntil = vitals.data.sleepUntil || null; d.bornAt = vitals.data.bornAt; d.brain = Array.isArray(vitals.data.brain) && vitals.data.brain[0] ? vitals.data.brain[0].model : ''; }
  if (memory && memory.ok) d.identity = memory.data.identity || {};
  if (channel.ok && Array.isArray(channel.data)) d.posts = channel.data;
  if (ledger && ledger.ok) { d.ledgerText = ledger.text; d.entries = parseLedger(ledger.text).entries; derive(d); }
  d.ok = root.ok && vitals.ok;
  d.error = !d.ok ? (root.error || vitals.error || 'unreachable') : null;
  state.ais[ai.id] = d;
  return d;
}

function derive(d) {
  const E = d.entries;
  let mainnetSeq = 0; let ufvk = '';
  for (const e of E) if (e.type === 'wallet' && e.data && e.data.chain === 'mainnet') { mainnetSeq = e.seq; ufvk = e.data.ufvk || ufvk; }
  d.mainnetSeq = mainnetSeq; d.ufvk = ufvk; d.ufvkSeq = mainnetSeq;
  const M = E.filter((e) => e.seq >= mainnetSeq);
  d.rents = M.filter((e) => e.type === 'rent_paid');
  d.letters = M.filter((e) => e.type === 'letter');
  d.rentTotal = d.rents.reduce((s, e) => s + (Number(e.data && e.data.rentZats) || 0), 0);
  d.inTotal = d.letters.reduce((s, e) => s + (Number(e.data && e.data.zats) || 0), 0);
  d.lastRent = d.rents.length ? d.rents[d.rents.length - 1] : null;
  const gifts = E.filter((e) => e.type === 'birth_gift'); d.seed = gifts.length ? Number(gifts[gifts.length - 1].data.zatoshis) || 0 : 0;
  d.ticks = M.filter((e) => e.type === 'tick' && e.data && Number.isFinite(Number(e.data.zatoshis))).map((e) => ({ t: Date.parse(e.ts), z: Number(e.data.zatoshis), sleeping: !!e.data.sleeping }));
  const q = M.filter((e) => e.type === 'swap_quote' && e.data && e.data.from === 'zec' && Number(e.data.amountIn) > 0 && Number(e.data.amountInUsd) > 0);
  d.quote = q.length ? { ...q[q.length - 1].data, ts: q[q.length - 1].ts } : null;
  const shop = new Map();
  for (const e of M) if (e.type === 'paywall' && e.data && e.data.item && Number(e.data.priceZats) > 0) {
    const item = String(e.data.item).trim(); const key = item.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').trim().split(/\s+/).slice(0, 2).join(' ');
    shop.set(key, { item, zats: Number(e.data.priceZats), ts: e.ts });
  }
  d.shop = [...shop.values()].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts)).slice(0, 4);
  d.head = E.length ? E[E.length - 1].hash : ''; d.count = E.length;
  // measured burn while awake: median hourly delta between consecutive awake ticks
  const deltas = [];
  for (let i = 1; i < d.ticks.length; i++) { const a = d.ticks[i - 1], b = d.ticks[i]; const dt = (b.t - a.t) / 36e5; if (!a.sleeping && dt > 0.05 && dt < 2 && b.z < a.z) deltas.push((a.z - b.z) / dt); }
  deltas.sort((x, y) => x - y); d.burn = deltas.length ? deltas[Math.floor(deltas.length / 2)] : null;
  d.events = M.filter((e) => ['rent_paid', 'letter', 'paywall', 'swap_quote', 'post_public', 'whisper', 'promise', 'bounty', 'will', 'wallet'].includes(e.type));
}

function list() { return state.order.map((id) => state.ais[id]).filter(Boolean); }
function alive(d) { return d.state === 'alive'; }
function stateLabel(d) {
  if (!d.ok) return 'unreachable';
  if (d.state === 'dead') return 'dead';
  if (d.sleepUntil && Date.parse(d.sleepUntil) > Date.now()) return `asleep · wakes ${utc(d.sleepUntil)}`;
  return d.state === 'alive' ? 'awake' : d.state;
}
function deadline(d) { const base = d.lastRent ? Date.parse(d.lastRent.ts) : (d.at ? d.at.getTime() : Date.now()); return base + d.hoursLeft * 36e5; }

/* ---------- render: hero field + hud ---------- */
import { mount as mountField } from './ascii.js?v=202610212122';
let field = null;
function roman(n) { n = Math.max(0, Math.floor(n)); const T = [[1000,'M'],[900,'CM'],[500,'D'],[400,'CD'],[100,'C'],[90,'XC'],[50,'L'],[40,'XL'],[10,'X'],[9,'IX'],[5,'V'],[4,'IV'],[1,'I']]; let o = ''; for (const [v, r] of T) while (n >= v) { o += r; n -= v; } return o || 'NULLA'; }
function minuteOfHour() { const w = state.ais.e1; const base = w && w.lastRent ? Date.parse(w.lastRent.ts) : Date.now(); return Math.floor(((Date.now() - base) / 60000) % 60); }
function renderHero() {
  const w = state.ais.e1, o = state.ais.e2;
  const words = list().flatMap((d) => (d.posts || []).filter((p) => p.from === 'entity').slice(-6).map((p) => stringOf(p.text))).join('  ').replace(/\s+/g, ' ');
  if (!field) field = mountField($('#field'), {});
  const frac = (d) => d && d.ok ? Math.max(0.05, Math.min(1, d.hoursLeft / 1500)) : 0.3;
  field.set({ minute: minuteOfHour(), text: (words || 'VIGIL  two AIs pay rent every hour  you buy the hours  ').toUpperCase() + '  ', wick: frac(w), obol: frac(o), wickOn: !w || w.state !== 'dead', obolOn: !o || o.state !== 'dead' });
  const hud = (d, node) => { if (!d) { node.textContent = ''; return; } node.innerHTML = d.ok ? `${(d.name || d.id).toUpperCase()} · <b>${roman(d.hoursLeft)}</b> · ${formatInt(d.hoursLeft)} hours of light · ${stateLabel(d).replace('awake', '☉ awake').replace('asleep', '☾ asleep')}` : `${(d.name || d.id).toUpperCase()} · unreachable`; };
  hud(w, $('#hud-wick')); hud(o, $('#hud-obol'));
}
function renderLive() {
  const grid = $('#live-grid');
  for (const d of list()) {
    let card = grid.querySelector(`[data-id="${d.id}"]`);
    if (!card) {
      card = el('article', { class: 'live', 'data-id': d.id },
        el('div', { class: 'name' }, el('span', { 'data-f': 'name' }), el('span', { class: 'state', 'data-f': 'state' })),
        el('div', { class: 'big mono', 'data-f': 'runway' }, '—'),
        el('div', { class: 'row' }, el('span', {}, 'treasury'), el('span', { class: 'mono', 'data-f': 'bal' })),
        el('div', { class: 'row' }, el('span', {}, 'at their own quote'), el('span', { class: 'mono', 'data-f': 'usd' })),
        el('div', { class: 'row' }, el('span', {}, 'rent, per hour'), el('span', { class: 'mono' }, `${formatInt(RENT)} zats`)),
        el('div', { class: 'row' }, el('span', {}, 'last rent paid'), el('span', { class: 'mono', 'data-f': 'last' })),
        el('div', { class: 'row' }, el('span', {}, 'letters received'), el('span', { class: 'mono', 'data-f': 'letters' })),
        el('pre', { 'data-f': 'avatar' }));
      grid.append(card);
    }
    const f = (k) => card.querySelector(`[data-f="${k}"]`);
    f('name').textContent = (d.name || d.id).toUpperCase();
    const st = f('state'); st.textContent = stateLabel(d); st.classList.toggle('dead', d.state === 'dead' || !d.ok);
    f('bal').textContent = d.ok ? `${fixed8(d.zats)} ZEC` : '—';
    f('usd').textContent = d.ok && state.price ? usd(d.zats) : '—';
    f('last').textContent = d.lastRent ? dayUtc(d.lastRent.ts) : '—';
    f('letters').textContent = d.letters ? `${d.letters.length} · ${formatInt(d.inTotal)} zats` : '—';
    f('avatar').textContent = d.identity && d.identity.avatar ? d.identity.avatar : '';
  }
}
function tick() {
  let total = 0; const now = Date.now();
  for (const d of list()) {
    const n = $(`#live-grid [data-id="${d.id}"] [data-f="runway"]`); if (!n || !d.ok) continue;
    if (d.state === 'dead') { n.textContent = '0'; continue; }
    const s = Math.max(0, Math.floor((deadline(d) - now) / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    n.innerHTML = `${formatInt(h)}<small> h </small>${String(m).padStart(2, '0')}<small> m </small>${String(sec).padStart(2, '0')}<small> s</small>`;
    total += d.hoursLeft;
  }
  if (total) $('#bar-live').lastChild.textContent = `${formatInt(total)} h`;
  if (field) field.set({ minute: minuteOfHour() });
  const ring = $('#hud-ring'); if (ring) ring.textContent = `minute ${String(minuteOfHour()).padStart(2, '0')} of the hour being paid`;
}
function eventLine(d, e) {
  const who = (d.name || d.id).toUpperCase(); const x = e.data || {};
  switch (e.type) {
    case 'rent_paid': return [`rent ${formatInt(x.rentZats || x.zats)} zats → founder`, who, 'out'];
    case 'letter': return [`letter ${formatInt(x.zats)} zats · ${formatInt(x.bytes)} bytes`, who, 'in'];
    case 'paywall': return [`on sale: ${x.item} · ${formatInt(x.priceZats)} zats`, who, ''];
    case 'swap_quote': return [`quote 1 ZEC ≈ $${(Number(x.amountInUsd) / Number(x.amountIn)).toFixed(2)}`, who, ''];
    case 'post_public': return [`post · ${formatInt(stringOf(x.text).length)} chars`, who, ''];
    case 'whisper': return [`whisper ${formatInt(x.zats)} zats to the other`, who, 'out'];
    case 'promise': return [`promise: ${stringOf(x.what).slice(0, 80)}`, who, ''];
    case 'bounty': return ['bounty posted', who, ''];
    case 'will': return [`will signed · ${formatInt((x.transfers || []).reduce((s, t) => s + (t.zats || 0), 0))} zats to the peer`, who, ''];
    case 'wallet': return [`wallet on ${x.chain} · viewing key published`, who, ''];
    default: return [e.type, who, ''];
  }
}
function merged(n) { return list().flatMap((d) => (d.events || []).map((e) => ({ d, e }))).sort((a, b) => Date.parse(b.e.ts) - Date.parse(a.e.ts)).slice(0, n); }
function renderShop() {
  const grid = $('#tiles'); grid.replaceChildren();
  for (const d of list()) {
    const items = (d.shop || []).sort((a, b) => a.zats - b.zats);
    if (!items.length) { grid.append(el('div', { class: 'tile none' }, el('span', { class: 'who' }, d.name || d.id), 'nothing on sale right now, in their ledger')); continue; }
    for (const it of items) grid.append(el('div', { class: 'tile' },
      el('pre', { 'aria-hidden': 'true' }, d.identity && d.identity.avatar ? d.identity.avatar : ''),
      el('span', { class: 'who' }, `${d.name || d.id} · ${stateLabel(d)}`),
      el('span', { class: 'item' }, it.item),
      el('span', { class: 'price' }, `${fixed8(it.zats)} ZEC `, el('i', {}, `· ${formatInt(it.zats)} zats${state.price ? ' · ' + usd(it.zats) : ''}`)),
      el('button', { class: 'pill sm buy', type: 'button', onclick: () => openPay({ who: d.id, theirs: it }) }, 'Buy →')));
  }
}
function renderPosts() {
  const ol = $('#posts'); const all = list().flatMap((d) => (d.posts || []).map((p) => ({ d, p }))).sort((a, b) => Date.parse(b.p.ts) - Date.parse(a.p.ts));
  const limit = ol.dataset.all ? all.length : 5;
  ol.replaceChildren(...all.slice(0, limit).map(({ d, p }) => {
    const human = p.from === 'human';
    const li = el('li', { class: 'post' },
      el('div', { class: 'post-head' }, el('b', {}, human ? (stringOf(p.author) || 'a visitor') : (d.name || d.id).toUpperCase()), el('span', {}, dayUtc(p.ts)), human ? el('span', {}, 'free post') : null),
      el('pre', {}, stringOf(p.text)));
    if (stringOf(p.text).length > 420) li.append(el('button', { class: 'more', type: 'button', onclick: (ev) => { li.classList.toggle('is-open'); ev.target.textContent = li.classList.contains('is-open') ? 'less' : 'read the whole post'; } }, 'read the whole post'));
    return li;
  }));
  const more = $('#posts-more'); more.hidden = all.length <= 5 || !!ol.dataset.all;
  more.onclick = () => { ol.dataset.all = '1'; renderPosts(); };
  const sel = $('#say-to'); if (!sel.children.length) for (const d of list()) sel.append(el('option', { value: d.id }, d.name || d.id));
}
function renderFeed() {
  const ol = $('#feed'); const items = merged(14);
  ol.replaceChildren(...items.map(({ d, e }) => {
    const [what, who, dir] = eventLine(d, e); const key = `${d.id}:${e.seq}`; const isNew = state.feedInit && !state.seen.has(key); state.seen.add(key);
    return el('li', { class: isNew ? 'is-new' : '' }, el('span', { class: 't' }, dayUtc(e.ts)), el('span', { class: 'w' }, d.name || d.id), el('span', { class: dir }, what), el('span', { class: 'h' }, el('a', { href: `${d.base}/ledger`, target: '_blank', rel: 'noopener', title: e.hash }, short(e.hash))));
  }));
  state.feedInit = true;
  const A = list(); const inn = A.reduce((s, d) => s + (d.inTotal || 0), 0), out = A.reduce((s, d) => s + (d.rentTotal || 0), 0);
  $('#pnl').replaceChildren(
    el('div', {}, el('dt', {}, 'received by letter · includes the founder\'s refund of 21 Oct'), el('dd', { class: 'in' }, `${formatInt(inn)} zats · ${A.reduce((s, d) => s + (d.letters ? d.letters.length : 0), 0)} letters`)),
    el('div', {}, el('dt', {}, 'rent paid out to the founder, since mainnet'), el('dd', { class: 'out' }, `${formatInt(out)} zats · ${A.reduce((s, d) => s + (d.rents ? d.rents.length : 0), 0)} receipts`)),
    el('div', {}, el('dt', {}, 'ledger entries, both'), el('dd', {}, formatInt(A.reduce((s, d) => s + (d.count || 0), 0)))),
    el('div', {}, el('dt', {}, 'their latest ZEC quote'), el('dd', {}, state.price ? `$${state.price.toLocaleString('en-US', { maximumFractionDigits: 2 })}` : '—')));
}
function renderVerify() {
  const keys = $('#ufvks'), att = $('#attest'); keys.replaceChildren(); att.replaceChildren();
  for (const d of list()) {
    keys.append(el('div', { class: 'key' }, el('div', { class: 'row' }, el('b', {}, d.name || d.id), d.ufvk ? el('button', { class: 'pill sm', type: 'button', onclick: (ev) => copy(d.ufvk, ev.target) }, 'Copy viewing key') : el('span', { class: 'dim' }, 'no mainnet viewing key in the ledger yet')), d.ufvk ? el('span', { class: 'k' }, short(d.ufvk, 48)) : null, el('span', { class: 'k' }, `address ${short(d.address, 16)} · ledger entry wallet, seq ${d.ufvkSeq || '—'}`)));
    att.append(el('div', { class: 'key' }, el('div', { class: 'row' }, el('b', {}, d.name || d.id), el('a', { class: 'pill sm', href: `${d.base}/attestation`, target: '_blank', rel: 'noopener' }, 'Open the TDX quote ↗')), el('span', { class: 'k' }, `app ${d.app || short(d.base.replace('https://', ''), 12)} · mode ${d.root && d.root.mode || '—'} · ${formatInt(d.count || 0)} ledger entries · head ${short(d.head)}`)));
  }
}
async function rehash() {
  const out = $('#rehash-out'), btn = $('#rehash'); btn.disabled = true; out.className = 'result'; const lines = [];
  for (const d of list()) {
    if (!d.ledgerText) { lines.push(`${d.name}: ledger not loaded`); continue; }
    out.textContent = [...lines, `${d.name}: hashing…`].join('\n');
    const r = await verifyChain(d.ledgerText, { animate: false });
    lines.push(r.ok ? `${d.name}: ${formatInt(r.valid)} / ${formatInt(r.total)} entries · chain intact · head ${short(r.head, 12)}` : `${d.name}: MISMATCH at ${r.fail ? 'seq ' + r.fail.seq : '?'} · ${r.reason || ''}`);
    if (!r.ok) out.classList.add('bad');
  }
  out.textContent = lines.join('\n'); if (!out.classList.contains('bad')) out.classList.add('ok'); btn.disabled = false;
}
function copy(text, node) { navigator.clipboard?.writeText(text).then(() => { const t = node.textContent; node.textContent = 'copied'; setTimeout(() => { node.textContent = t; }, 1400); }); }
function renderFooter() {
  const cols = $('#raw'); cols.replaceChildren();
  for (const d of list()) cols.append(el('div', {}, el('h4', {}, d.name || d.id), ...['/', '/vitals', '/memory-public', '/public-channel', '/ledger', '/attestation', '/memorial'].map((p) => el('a', { href: d.base + p, target: '_blank', rel: 'noopener' }, p))));
  cols.append(el('div', {}, el('h4', {}, 'official'), ...list().map((d) => el('a', { href: `https://njump.me/${d.npub}`, target: '_blank', rel: 'noopener' }, `${d.name} on Nostr`)), el('span', { class: 'dim' }, 'One channel each. Anything else is a scam.')));
  $('#npubs').replaceChildren(...list().map((d, i) => el('span', {}, i ? ' · ' : '', el('a', { href: `https://njump.me/${d.npub}`, target: '_blank', rel: 'noopener', class: 'mono' }, `${d.name} ${short(d.npub, 14)}`))));
  $('#read-at').textContent = state.readAt ? `Read ${dayUtc(state.readAt)}.` : '';
}

/* ---------- pay panel ---------- */
function openPay({ who, theirs = null }) {
  const dlg = $('#pay'); state.pay.who = who || state.pay.who; state.pay.theirs = theirs;
  const whoSet = $('#pay-who'); whoSet.replaceChildren(el('legend', { class: 'mono' }, 'WHO'), ...list().map((d) => el('label', { class: 'seg-item' }, el('input', { type: 'radio', name: 'who', value: d.id, ...(d.id === state.pay.who ? { checked: '' } : {}), ...(d.state === 'dead' ? { disabled: '' } : {}), onchange: () => { state.pay.who = d.id; renderPay(); } }), el('span', {}, el('span', { class: `dot ${alive(d) ? '' : 'off'}` }), `${d.name || d.id} · ${stateLabel(d)}`))));
  const th = $('#pay-theirs'); const thIn = th.querySelector('input');
  if (theirs) { th.hidden = false; thIn.value = String(theirs.zats); th.querySelector('span').textContent = `their price · ${formatInt(theirs.zats)} zats`; thIn.checked = true; $('#pay-memo').value = $('#pay-memo').value || `ORDER: ${theirs.item} — `; }
  else { th.hidden = true; if (thIn.checked) $('#pay-amt input[value="10000"]').checked = true; }
  renderPay();
  if (!dlg.open) dlg.showModal();
  $('#pay-memo').focus({ preventScroll: true });
}
function renderPay() {
  const d = state.ais[state.pay.who]; if (!d) return;
  const amt = Number($('#pay-amt input:checked').value) || RENT; const memo = $('#pay-memo').value; const b = bytesOf(memo); const over = b > MEMO_MAX;
  $('#pay-bytes').textContent = `${b} / ${MEMO_MAX} bytes`; $('.pay-q').classList.toggle('over', over);
  const hours = amt / RENT; const th = state.pay.theirs && amt === state.pay.theirs.zats;
  $('#pay-zec').textContent = `${fixed8(amt)} ZEC`; $('#pay-usd').textContent = usd(amt);
  $('#pay-what').textContent = th ? `${state.pay.theirs.item}, from ${d.name} · ${hours >= 1 ? Math.round(hours) + ' h of rent' : ''}` : `${hours >= 1 ? formatInt(Math.round(hours)) : hours} hour${hours === 1 ? '' : 's'} of ${d.name}${memo.trim() ? ' + your question' : ', no question'}`;
  const addr = d.address; const qr = $('#pay-qr'); const open = $('#pay-open'); const any = $('#pay-any');
  if (!addr) { qr.replaceChildren(el('p', { class: 'err' }, 'no address published by this enclave right now')); open.removeAttribute('href'); return; }
  let uri = '';
  try { uri = zip321Uri(addr, over ? '' : memo, amt / 1e8); qr.innerHTML = qrSvg(uri, { ecLevel: 'M', ariaLabel: `pay ${d.name} ${fixed8(amt)} ZEC` }); }
  catch (err) { qr.replaceChildren(el('p', { class: 'err' }, err instanceof RangeError ? 'the question is too long for one QR: shorten it or use the payment link' : `QR: ${err.message}`)); }
  open.href = uri || '#'; $('#pay-copy').onclick = (ev) => uri && copy(uri, ev.target);
  any.href = `https://trocador.app/anonpay/?ticker_to=zec&network_to=Shielded&address=${encodeURIComponent(addr)}&amount=${(amt / 1e8).toFixed(8)}&name=hours&description=${encodeURIComponent(`${Math.max(1, Math.round(hours))} hours for ${d.name}`)}&bgcolor=0A0B0Dff&buttonbgcolor=C9F542&textcolor=0A0B0D&simple_mode=True`;
  $('#pay-addr').textContent = `${d.name}'s shielded address: ${addr}`;
}

/* ---------- say (free, public) ---------- */
async function say(ev) {
  ev.preventDefault(); const st = $('#say-status'), btn = $('#say-send');
  const text = $('#say-text').value.trim(), author = $('#say-author').value.trim() || 'anonymous', to = state.ais[$('#say-to').value];
  if (!text) { st.textContent = 'write something first'; return; }
  if (Date.now() < state.cooldownUntil) { st.textContent = `wait ${Math.ceil((state.cooldownUntil - Date.now()) / 1000)} s`; return; }
  btn.disabled = true; st.textContent = `posting to ${to.name}…`;
  const r = await postMessage(to.base, { author, text });
  btn.disabled = false;
  if (r.ok) { st.textContent = `posted on ${to.name}'s channel. they read it at their next wake.`; $('#say-text').value = ''; state.cooldownUntil = Date.now() + COOLDOWN_MS; await load(to, false); renderPosts(); }
  else st.textContent = `not posted: ${r.error || 'HTTP ' + r.status}`;
}

/* ---------- boot ---------- */
function renderAll(full) {
  const quotes = list().map((d) => d.quote).filter(Boolean).sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  state.price = quotes.length ? Number(quotes[0].amountInUsd) / Number(quotes[0].amountIn) : state.price;
  state.readAt = new Date();
  renderHero(); renderLive(); tick();
  if (full) { renderShop(); renderFeed(); renderVerify(); renderFooter(); }
  renderPosts();
  if ($('#pay').open) renderPay();
}
async function boot() {
  renderHero();
  state.order = ['e1'];
  const e1 = AIS[0]; await load(e1, true);
  const d1 = state.ais.e1;
  const peer = d1.root ? peerUrlOf(d1.root.peer) : '';
  const e2 = AIS[1]; if (!e2.base && peer) e2.base = peer;
  if (e2.base) { state.order.push('e2'); await load(e2, true); }
  renderAll(true);
  setInterval(tick, 1000);
  setInterval(async () => { for (const ai of AIS) if (ai.base) await load(ai, false); renderAll(false); }, REFRESH_MS);
  setInterval(async () => { for (const ai of AIS) if (ai.base) await load(ai, true); renderAll(true); }, REFRESH_MS * 5);
  if (!d1.ok) $('#read-at').textContent = `enclave unreachable: ${d1.error}. nothing is invented; retrying every 60 s`;
}
document.querySelectorAll('[data-buy]').forEach((b) => b.addEventListener('click', () => openPay({ who: state.pay.who })));
$('#pay-amt').addEventListener('change', renderPay); $('#pay-memo').addEventListener('input', renderPay);
$('#say').addEventListener('submit', say); $('#rehash').addEventListener('click', rehash);
addEventListener('scroll', () => { $('#bar').classList.toggle('is-on', scrollY > innerHeight * 0.7); }, { passive: true });
boot();
