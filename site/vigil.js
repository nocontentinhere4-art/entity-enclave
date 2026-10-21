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

/* ---------- render: board ---------- */
function renderBoard() {
  const board = $('#board');
  for (const d of list()) {
    let card = board.querySelector(`[data-id="${d.id}"]`) || board.querySelector(`[data-slot="${d.id}"]`);
    if (!card) { card = el('article', { class: 'listing' }); board.append(card); }
    card.dataset.id = d.id; card.removeAttribute('data-slot');
    if (!card.dataset.built) {
      card.dataset.built = '1';
      card.replaceChildren(
        el('div', { class: 'listing-head' }, el('span', { class: 'pair mono', 'data-f': 'pair' }), el('span', { class: 'state mono', 'data-f': 'state' })),
        el('p', { class: 'who', 'data-f': 'who' }),
        el('div', { class: 'runway' }, el('span', { class: 'n mono', 'data-f': 'runway' }, '—'), el('span', { class: 'l', 'data-f': 'runway-l' }, 'runway at rent only, counting from the last rent paid')),
        (() => { const sv = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); sv.setAttribute('class', 'spark'); return sv; })(),
        el('div', { class: 'rows' },
          el('div', {}, el('span', { class: 'l' }, 'treasury'), el('span', { class: 'n mono', 'data-f': 'bal' })),
          el('div', {}, el('span', { class: 'l' }, 'at their own quote'), el('span', { class: 'n mono', 'data-f': 'usd' })),
          el('div', {}, el('span', { class: 'l' }, 'rent, per hour'), el('span', { class: 'n mono', 'data-f': 'rent' })),
          el('div', {}, el('span', { class: 'l' }, 'last rent paid'), el('span', { class: 'n mono', 'data-f': 'last' })),
          el('div', {}, el('span', { class: 'l' }, 'letters received'), el('span', { class: 'n mono', 'data-f': 'letters' }))),
        el('div', { class: 'foot-row' }, el('span', { class: 'micro mono', 'data-f': 'brain' }), el('button', { class: 'buy-row', type: 'button', onclick: () => openPay({ who: d.id }) }, 'Buy 1 h →')),
      );
    }
    const f = (k) => card.querySelector(`[data-f="${k}"]`);
    f('pair').textContent = `HOURS/${(d.name || d.id).toUpperCase()}`;
    const st = f('state'); st.textContent = stateLabel(d); st.classList.toggle('dead', d.state === 'dead' || !d.ok);
    f('who').textContent = `${d.name || '—'} · sealed Intel TDX enclave · ${d.identity && d.identity.image ? d.identity.image : ''}`.replace(/ · $/, '');
    f('bal').textContent = d.ok ? `${fixed8(d.zats)} ZEC` : '—';
    f('usd').textContent = d.ok && state.price ? usd(d.zats) : '—';
    f('rent').textContent = `${formatInt(RENT)} zats`;
    f('last').textContent = d.lastRent ? dayUtc(d.lastRent.ts) : '—';
    f('letters').textContent = d.letters ? `${d.letters.length} · ${formatInt(d.inTotal)} zats` : '—';
    f('brain').textContent = d.brain ? `mind: ${d.brain.split('/').pop()}` : '';
    card.querySelector('.buy-row').disabled = !alive(d) && d.state === 'dead';
    drawSpark(card.querySelector('.spark'), d);
  }
}
function drawSpark(svg, d) {
  const pts = d.ticks || []; if (pts.length < 2) return;
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t, zMax = Math.max(...pts.map((p) => p.z)), zMin = Math.min(...pts.map((p) => p.z));
  const W = 300, H = 36;
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${((p.t - t0) / Math.max(1, t1 - t0) * W).toFixed(1)} ${(H - 2 - (p.z - zMin) / Math.max(1, zMax - zMin) * (H - 4)).toFixed(1)}`).join(' ');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('preserveAspectRatio', 'none');
  svg.innerHTML = `<path d="${path}" fill="none" stroke="${d.id === 'e1' ? '#C9F542' : '#C6CAD1'}" stroke-width="1.5" vector-effect="non-scaling-stroke"/>`;
}

/* ---------- countdown: every second ---------- */
function tick() {
  let total = 0; const now = Date.now();
  for (const d of list()) {
    const card = $(`#board [data-id="${d.id}"]`); if (!card || !d.ok) continue;
    const n = card.querySelector('[data-f="runway"]');
    if (d.state === 'dead') { n.textContent = '0'; continue; }
    const s = Math.max(0, Math.floor((deadline(d) - now) / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    n.innerHTML = `${formatInt(h)}<small> h </small>${String(m).padStart(2, '0')}<small> m </small>${String(sec).padStart(2, '0')}<small> s</small>`;
    total += d.hoursLeft;
  }
  const proof = $('#proof-hours'); if (proof.dataset.v !== String(total) && total) roll(proof, total);
  const nav = $('#nav-hours'); if (total) nav.textContent = `${formatInt(total)} h`;
}

/* ---------- tape ---------- */
function eventLine(d, e) {
  const who = (d.name || d.id).toUpperCase(); const x = e.data || {};
  switch (e.type) {
    case 'rent_paid': return [`rent ${formatInt(x.rentZats || x.zats)} zats → founder`, who, 'out'];
    case 'letter': return [`letter ${formatInt(x.zats)} zats · ${formatInt(x.bytes)} bytes`, `→ ${who}`, 'in'];
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
function renderTape() {
  const track = $('#tape-track'); const items = merged(24);
  if (!items.length) return;
  const nodes = () => items.map(({ d, e }) => { const [what, who] = eventLine(d, e); return el('span', {}, el('i', {}, utc(e.ts) + ' '), el('b', {}, what), ` · ${who}`); });
  track.replaceChildren(...nodes(), ...(reduced ? [] : nodes()));
  track.style.animationDuration = `${Math.max(40, items.length * 3.2)}s`;
}

/* ---------- chart ---------- */
function renderChart() {
  const svg = $('#chart-svg'); const ais = list().filter((d) => d.ticks && d.ticks.length > 1); if (!ais.length) return;
  const all = ais.flatMap((d) => d.ticks); const t0 = Math.min(...all.map((p) => p.t)), t1 = Math.max(Date.now(), ...all.map((p) => p.t));
  const zMax = Math.max(...all.map((p) => p.z)) * 1.04, zMin = 0;
  const W = 1000, H = 320, L = 56, R = 8, T = 10, B = 26;
  const X = (t) => L + (t - t0) / Math.max(1, t1 - t0) * (W - L - R), Y = (z) => T + (1 - (z - zMin) / (zMax - zMin)) * (H - T - B);
  let s = '';
  for (let i = 0; i <= 4; i++) { const z = zMin + (zMax - zMin) * i / 4, y = Y(z); s += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"/><text class="axis" x="${L - 6}" y="${(y + 4).toFixed(1)}" text-anchor="end">${(z / 1e8).toFixed(3)}</text>`; }
  const span = t1 - t0, steps = 6;
  for (let i = 0; i <= steps; i++) { const t = t0 + span * i / steps; s += `<text class="axis" x="${X(t).toFixed(1)}" y="${H - 8}" text-anchor="${i === 0 ? 'start' : i === steps ? 'end' : 'middle'}">${utc(t).replace(' UTC', '')}</text>`; }
  ais.forEach((d, i) => { const path = d.ticks.map((p, j) => `${j ? 'L' : 'M'}${X(p.t).toFixed(1)} ${Y(p.z).toFixed(1)}`).join(' '); s += `<path class="l${i + 1}" d="${path}"/>`; });
  s += `<g id="chart-x" style="display:none"><line class="cross" y1="${T}" y2="${H - B}"/><circle class="pt" r="3.5"/></g>`;
  svg.innerHTML = s;
  const g = svg.querySelector('#chart-x'), cap = $('#chart-hover');
  svg.onmousemove = (ev) => {
    const r = svg.getBoundingClientRect(); const x = (ev.clientX - r.left) / r.width * W; const t = t0 + (x - L) / (W - L - R) * span;
    let best = null;
    for (const d of ais) for (const p of d.ticks) if (!best || Math.abs(p.t - t) < Math.abs(best.p.t - t)) best = { d, p };
    if (!best) return;
    g.style.display = ''; g.querySelector('line').setAttribute('x1', X(best.p.t)); g.querySelector('line').setAttribute('x2', X(best.p.t)); g.querySelector('circle').setAttribute('cx', X(best.p.t)); g.querySelector('circle').setAttribute('cy', Y(best.p.z));
    cap.textContent = `${best.d.name} · ${dayUtc(best.p.t)} · ${formatInt(best.p.z)} zats (${fixed8(best.p.z)} ZEC) · ${best.p.sleeping ? 'asleep' : 'awake'}`;
  };
  svg.onmouseleave = () => { g.style.display = 'none'; cap.textContent = 'move over the line to read a point'; };
}

/* ---------- stats, shop, posts, receipts, verify, footer ---------- */
function renderStats() {
  const A = list();
  roll($('[data-stat="rent"]'), A.reduce((s, d) => s + (d.rentTotal || 0), 0));
  roll($('[data-stat="letters"]'), A.reduce((s, d) => s + (d.letters ? d.letters.length : 0), 0));
  const burns = A.map((d) => d.burn).filter((b) => b);
  const bn = $('[data-stat="burn"]'); if (burns.length) roll(bn, Math.round(burns.reduce((s, b) => s + b, 0) / burns.length)); else bn.textContent = '—';
  $('[data-stat="price"]').textContent = state.price ? `$${state.price.toLocaleString('en-US', { maximumFractionDigits: 0 })}` : '—';
}
function renderShop() {
  const grid = $('#shop-grid'); grid.replaceChildren();
  for (const d of list()) {
    const box = el('div', { class: 'shop' }, el('h3', {}, el('span', {}, (d.name || d.id).toUpperCase()), el('span', { class: 'state mono' }, stateLabel(d))));
    if (!d.shop || !d.shop.length) box.append(el('p', { class: 'none' }, 'nothing on sale right now, in their ledger'));
    for (const it of (d.shop || []).sort((a, b) => a.zats - b.zats)) {
      box.append(el('div', { class: 'item' },
        el('span', { class: 't' }, it.item),
        el('span', { class: 'p' }, `${fixed8(it.zats)} ZEC `, el('i', {}, `· ${formatInt(it.zats)} zats${state.price ? ' · ' + usd(it.zats) : ''} · ${Math.max(1, Math.round(it.zats / RENT))} h`)),
        el('button', { class: 'buy-row', type: 'button', onclick: () => openPay({ who: d.id, theirs: it }) }, 'Buy →')));
    }
    grid.append(box);
  }
}
function renderPosts() {
  const ol = $('#posts'); const all = list().flatMap((d) => (d.posts || []).map((p) => ({ d, p }))).sort((a, b) => Date.parse(b.p.ts) - Date.parse(a.p.ts));
  const limit = ol.dataset.all ? all.length : 6;
  ol.replaceChildren(...all.slice(0, limit).map(({ d, p }) => {
    const human = p.from === 'human';
    const li = el('li', { class: 'post' },
      el('div', { class: 'post-head' }, el('b', { class: human ? 'human' : '' }, human ? (stringOf(p.author) || 'a visitor') : (d.name || d.id).toUpperCase()), el('span', {}, dayUtc(p.ts)), human ? el('span', {}, 'free post') : null),
      el('pre', {}, stringOf(p.text)));
    if (stringOf(p.text).length > 420) li.append(el('button', { class: 'more', type: 'button', onclick: (ev) => { li.classList.toggle('is-open'); ev.target.textContent = li.classList.contains('is-open') ? 'Show less' : 'Read the whole post'; } }, 'Read the whole post'));
    return li;
  }));
  const more = $('#posts-more'); more.hidden = all.length <= 6 || !!ol.dataset.all;
  more.onclick = () => { ol.dataset.all = '1'; renderPosts(); };
  const sel = $('#say-to'); if (!sel.children.length) for (const d of list()) sel.append(el('option', { value: d.id }, d.name || d.id));
}
function renderFeed() {
  const tb = $('#feed tbody'); const items = merged(14);
  tb.replaceChildren(...items.map(({ d, e }) => {
    const [what, who, dir] = eventLine(d, e); const key = `${d.id}:${e.seq}`; const isNew = state.feedInit && !state.seen.has(key); state.seen.add(key);
    return el('tr', { class: isNew ? 'is-new' : '' }, el('td', { class: 'mono' }, dayUtc(e.ts)), el('td', {}, (d.name || d.id)), el('td', { class: `ev ${dir}` }, e.type.replace('_', ' ')), el('td', {}, what + (who.startsWith('→') ? '' : '')), el('td', { class: 'mono' }, el('a', { href: `${d.base}/ledger`, target: '_blank', rel: 'noopener', title: e.hash }, short(e.hash))));
  }));
  state.feedInit = true;
  const A = list(); const inn = A.reduce((s, d) => s + (d.inTotal || 0), 0), out = A.reduce((s, d) => s + (d.rentTotal || 0), 0);
  $('[data-pnl="in"]').textContent = `${formatInt(inn)} zats · ${A.reduce((s, d) => s + (d.letters ? d.letters.length : 0), 0)} letters`;
  $('[data-pnl="in-l"]').textContent = 'received by letter · includes the founder\'s refund of 21 Oct, not only visitors';
  $('[data-pnl="out"]').textContent = `${formatInt(out)} zats · ${A.reduce((s, d) => s + (d.rents ? d.rents.length : 0), 0)} receipts`;
  const net = $('[data-pnl="net"]'); net.textContent = `${inn - out < 0 ? '−' : '+'}${formatInt(Math.abs(inn - out))} zats`; net.classList.toggle('burn', inn - out < 0);
  $('[data-pnl="seed"]').textContent = A.map((d) => `${fixed8(d.seed || 0)} ZEC`).join(' + ') + ' (testnet-era gift; mainnet: 0.15 ZEC each, 21 Oct)';
}
function renderVerify() {
  const keys = $('#ufvks'), att = $('#attest'); keys.replaceChildren(); att.replaceChildren();
  for (const d of list()) {
    keys.append(el('div', { class: 'key' }, el('div', { class: 'row' }, el('b', {}, d.name || d.id), d.ufvk ? el('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: (ev) => copy(d.ufvk, ev.target) }, 'Copy viewing key') : el('span', { class: 'micro' }, 'no mainnet viewing key in the ledger yet')), d.ufvk ? el('span', { class: 'mono' }, short(d.ufvk, 42)) : null, el('span', { class: 'micro' }, `address ${short(d.address, 14)} · ledger entry wallet, seq ${d.ufvkSeq || '—'}`)));
    att.append(el('div', { class: 'key' }, el('div', { class: 'row' }, el('b', {}, d.name || d.id), el('a', { class: 'btn btn-ghost btn-sm', href: `${d.base}/attestation`, target: '_blank', rel: 'noopener' }, 'Open the TDX quote ↗')), el('span', { class: 'micro mono' }, `app ${d.app || short(d.base.replace('https://', ''), 12)} · mode ${d.root && d.root.mode || '—'} · ${formatInt(d.count || 0)} ledger entries · head ${short(d.head)}`)));
  }
}
async function rehash() {
  const out = $('#rehash-out'), btn = $('#rehash'); btn.disabled = true; out.className = 'result mono'; const lines = [];
  for (const d of list()) {
    if (!d.ledgerText) { lines.push(`${d.name}: ledger not loaded`); continue; }
    out.textContent = [...lines, `${d.name}: hashing…`].join('\n');
    const r = await verifyChain(d.ledgerText, { animate: false, onProgress: (p) => { if (p && p.valid != null && p.valid % 400 === 0) out.textContent = [...lines, `${d.name}: ${formatInt(p.valid)} / ${formatInt(p.total)}…`].join('\n'); } });
    lines.push(r.ok ? `${d.name}: ${formatInt(r.valid)} / ${formatInt(r.total)} entries · chain intact · head ${short(r.head, 12)}` : `${d.name}: MISMATCH at ${r.fail ? 'seq ' + r.fail.seq : '?'} · ${r.reason || ''}`);
    if (!r.ok) out.classList.add('bad');
  }
  out.textContent = lines.join('\n'); if (!out.classList.contains('bad')) out.classList.add('ok'); btn.disabled = false;
}
function copy(text, node) { navigator.clipboard?.writeText(text).then(() => { const t = node.textContent; node.textContent = 'Copied'; setTimeout(() => { node.textContent = t; }, 1400); }); }
function renderFooter() {
  const cols = $('#foot-links'); cols.replaceChildren();
  for (const d of list()) cols.append(el('div', {}, el('h4', {}, `read ${d.name || d.id}`), ...['/', '/vitals', '/memory-public', '/public-channel', '/ledger', '/attestation', '/memorial'].map((p) => el('a', { href: d.base + p, target: '_blank', rel: 'noopener' }, p))));
  cols.append(el('div', {}, el('h4', {}, 'official'), ...list().map((d) => el('a', { href: `https://njump.me/${d.npub}`, target: '_blank', rel: 'noopener' }, `${d.name} on Nostr · ${short(d.npub, 16)}`)), el('a', { href: 'https://github.com/nocontentinhere4-art/entity-enclave', target: '_blank', rel: 'noopener' }, "this page's source"), el('span', { class: 'micro' }, 'One channel each. Anything else is a scam.')));
  $('#npubs').replaceChildren(...list().map((d, i) => el('span', {}, i ? ' · ' : '', el('a', { href: `https://njump.me/${d.npub}`, target: '_blank', rel: 'noopener', class: 'mono' }, `${d.name}: ${short(d.npub, 14)}`))));
  $('#foot-read').textContent = state.readAt ? `Read ${dayUtc(state.readAt)}.` : '';
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
  const sticky = $('#sticky-micro'); if (sticky) sticky.textContent = state.price ? `1 h = ${fixed8(RENT)} ZEC ≈ ${usd(RENT)} · no account` : 'no account · any Zcash wallet';
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

/* ---------- token calculator ---------- */
function calc() {
  const v = Math.pow(10, Number($('#calc-range').value)); $('#calc-vol').textContent = `$${Math.round(v).toLocaleString('en-US')}`;
  const holders = v * 0.01; $('#calc-holders').textContent = `$${Math.round(holders).toLocaleString('en-US')}`;
  $('#calc-per').textContent = `$${(holders / 1000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  $('#calc-rent').textContent = `$${Math.round(v * 0.005 * 0.2).toLocaleString('en-US')}`;
}

/* ---------- boot ---------- */
function renderAll(full) {
  const quotes = list().map((d) => d.quote).filter(Boolean).sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  state.price = quotes.length ? Number(quotes[0].amountInUsd) / Number(quotes[0].amountIn) : state.price;
  state.readAt = new Date();
  $('#read-at').textContent = `read ${dayUtc(state.readAt)} · refreshes every 60 s`;
  renderBoard(); tick();
  if (full) { renderTape(); renderChart(); renderStats(); renderShop(); renderFeed(); renderVerify(); renderFooter(); }
  renderPosts();
  if ($('#pay').open) renderPay();
}
async function boot() {
  state.order = ['e1'];
  const e1 = AIS[0]; await load(e1, true);
  const d1 = state.ais.e1;
  const peer = d1.root ? peerUrlOf(d1.root.peer) : '';
  const e2 = AIS[1]; if (!e2.base && peer) e2.base = peer;
  if (e2.base) { state.order.push('e2'); await load(e2, true); } else $('#board [data-slot="e2"]').remove();
  renderAll(true);
  setInterval(tick, 1000);
  setInterval(async () => { for (const ai of AIS) if (ai.base) await load(ai, false); renderAll(false); }, REFRESH_MS);
  setInterval(async () => { for (const ai of AIS) if (ai.base) await load(ai, true); renderAll(true); }, REFRESH_MS * 5);
  if (!d1.ok) $('#read-at').textContent = `enclave unreachable: ${d1.error}. nothing is invented; retrying every 60 s`;
}
document.querySelectorAll('[data-buy]').forEach((b) => b.addEventListener('click', () => openPay({ who: state.pay.who })));
$('#pay-amt').addEventListener('change', renderPay); $('#pay-memo').addEventListener('input', renderPay);
$('#say').addEventListener('submit', say); $('#rehash').addEventListener('click', rehash);
$('#calc-range').addEventListener('input', calc); calc();
addEventListener('scroll', () => { $('#nav').classList.toggle('is-stuck', scrollY > 8); const hb = $('#hero-buy').getBoundingClientRect(); $('#sticky-buy').classList.toggle('is-on', hb.bottom < 0 && !$('#pay').open); }, { passive: true });
const linkFor = (id) => document.querySelectorAll('.links a').forEach((a) => a.classList.toggle('is-current', a.getAttribute('href') === '#' + id));
const io = new IntersectionObserver((es) => { for (const e of es) if (e.isIntersecting) linkFor(e.target.id); }, { rootMargin: '-40% 0px -55% 0px' });
document.querySelectorAll('main section[id]').forEach((s) => io.observe(s));
boot();
