/* ZEALOT — one page, two enclaves. Every number here is fetched or computed from a fetch. */
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

/* ---------- render ---------- */
function renderHero() {
  for (const d of list()) { const n = $(`.nums [data-n="${d.id}"]`); if (n) { roll(n, d.ok ? d.hoursLeft : NaN); if (d.state === 'dead') n.textContent = 'DEAD'; } }
  $('#n-price').textContent = state.price ? usd(RENT) : '0.0001 ZEC';
  $('#read-at').textContent = state.readAt ? `LIVE · ZCASH MAINNET · READ ${utc(state.readAt)}` : 'LIVE · ZCASH MAINNET';
}
function renderLive() {
  const grid = $('#live-grid');
  for (const d of list()) {
    let card = grid.querySelector(`[data-id="${d.id}"]`);
    if (!card) {
      card = el('div', { class: 'live', 'data-id': d.id },
        el('div', { class: 'name' }, el('b', { 'data-f': 'name' }), el('span', { 'data-f': 'state' })),
        el('div', { class: 'runway mono', 'data-f': 'runway' }, '—'),
        el('div', { class: 'r' }, el('span', {}, 'treasury'), el('span', { class: 'mono', 'data-f': 'bal' })),
        el('div', { class: 'r' }, el('span', {}, 'in dollars, at their quote'), el('span', { class: 'mono', 'data-f': 'usd' })),
        el('div', { class: 'r' }, el('span', {}, 'rent per hour'), el('span', { class: 'mono' }, `${formatInt(RENT)} zats`)),
        el('div', { class: 'r' }, el('span', {}, 'last rent paid'), el('span', { class: 'mono', 'data-f': 'last' })),
        el('div', { class: 'r' }, el('span', {}, 'hours bought by visitors'), el('span', { class: 'mono', 'data-f': 'letters' })));
      grid.append(card);
    }
    const f = (k) => card.querySelector(`[data-f="${k}"]`);
    f('name').textContent = (d.name || d.id).toUpperCase(); f('state').textContent = stateLabel(d).toUpperCase();
    f('bal').textContent = d.ok ? `${fixed8(d.zats)} ZEC` : '—';
    f('usd').textContent = d.ok && state.price ? usd(d.zats) : '—';
    f('last').textContent = d.lastRent ? dayUtc(d.lastRent.ts) : '—';
    f('letters').textContent = d.letters ? `${d.letters.length} payments · ${formatInt(d.inTotal)} zats` : '—';
  }
  const L = list().flatMap((d) => (d.letters || []).map((e) => ({ d, e }))).sort((a, b) => Date.parse(b.e.ts) - Date.parse(a.e.ts));
  const rollEl = $('#roll');
  rollEl.replaceChildren(...L.slice(0, 10).map(({ d, e }, i) => el('li', {}, el('span', { class: 'd' }, `#${formatInt(L.length - i)}`), el('span', {}, d.name), el('span', {}, `${formatInt(e.data.zats)} zats · ${Math.max(1, Math.round(e.data.zats / RENT))} h`), el('span', { class: 't d' }, dayUtc(e.ts)), el('span', { class: 'h' }, e.data.txid && e.data.txid !== 'unknown' ? el('a', { href: `https://blockchair.com/zcash/transaction/${e.data.txid}`, target: '_blank', rel: 'noopener' }, short(e.data.txid, 10)) : el('span', { class: 'd' }, short(e.hash, 10))))));
  if (!L.length) rollEl.append(el('li', { class: 'dim' }, 'nothing yet'));
  const A = list(); const inn = A.reduce((s, d) => s + (d.inTotal || 0), 0), out = A.reduce((s, d) => s + (d.rentTotal || 0), 0);
  $('#pnl').textContent = `Received by letter since mainnet: ${formatInt(inn)} zats (includes the founder's refund of 21 Oct). Rent paid out to the founder: ${formatInt(out)} zats in ${A.reduce((s, d) => s + (d.rents ? d.rents.length : 0), 0)} payments. Ledger entries: ${formatInt(A.reduce((s, d) => s + (d.count || 0), 0))}.`;
}
function tick() {
  const now = Date.now();
  for (const d of list()) {
    const n = $(`#live-grid [data-id="${d.id}"] [data-f="runway"]`); if (!n || !d.ok) continue;
    if (d.state === 'dead') { n.textContent = '0'; continue; }
    const s = Math.max(0, Math.floor((deadline(d) - now) / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    n.innerHTML = `${formatInt(h)}<small> h </small>${String(m).padStart(2, '0')}<small> m </small>${String(sec).padStart(2, '0')}<small> s</small>`;
  }
}
function postList(olSel, moreSel, filter, n) {
  const ol = $(olSel); if (!ol) return; const all = list().flatMap((d) => (d.posts || []).filter((p) => filter(p)).map((p) => ({ d, p }))).sort((a, b) => Date.parse(b.p.ts) - Date.parse(a.p.ts));
  const limit = ol.dataset.all ? all.length : n;
  ol.replaceChildren(...all.slice(0, limit).map(({ d, p }) => {
    const human = p.from === 'human';
    const li = el('li', {}, el('div', { class: 'h' }, el('b', {}, human ? (stringOf(p.author) || 'anonymous') : (d.name || d.id).toUpperCase()), el('span', {}, dayUtc(p.ts)), human ? el('span', {}, `to ${d.name}`) : null), el('pre', {}, stringOf(p.text)));
    if (stringOf(p.text).length > 420) li.append(el('button', { class: 'more', type: 'button', onclick: (ev) => { li.classList.toggle('is-open'); ev.target.textContent = li.classList.contains('is-open') ? 'less' : 'read all'; } }, 'read all'));
    return li;
  }));
  if (!all.length) ol.append(el('li', { class: 'dim' }, 'nothing yet'));
  const more = $(moreSel); if (more) { more.hidden = all.length <= n || !!ol.dataset.all; more.onclick = () => { ol.dataset.all = '1'; postList(olSel, moreSel, filter, n); }; }
}
function renderPosts() {
  postList('#scripture-list', '#scripture-more', (p) => p.from !== 'human', 2);
  postList('#posts', '#posts-more', (p) => p.from === 'human', 3);
  const sel = $('#say-to'); if (!sel.children.length) for (const d of list()) sel.append(el('option', { value: d.id }, d.name || d.id));
}
function renderVerify() {
  const keys = $('#ufvks'), att = $('#attest'); keys.replaceChildren(); att.replaceChildren();
  for (const d of list()) {
    keys.append(el('div', { class: 'key' }, el('div', { class: 'r' }, el('b', {}, d.name || d.id), d.ufvk ? el('button', { class: 'btn ghost', type: 'button', onclick: (ev) => copy(d.ufvk, ev.target) }, 'Copy viewing key') : el('span', { class: 'dim' }, 'no mainnet viewing key in the ledger yet')), d.ufvk ? el('span', { class: 'k' }, short(d.ufvk, 48)) : null, el('span', { class: 'k' }, `address ${short(d.address, 16)} · ledger entry wallet, seq ${d.ufvkSeq || '—'}`)));
    att.append(el('div', { class: 'key' }, el('div', { class: 'r' }, el('b', {}, d.name || d.id), el('a', { class: 'btn ghost', href: `${d.base}/attestation`, target: '_blank', rel: 'noopener' }, 'Open the TDX quote ↗')), el('span', { class: 'k' }, `app ${d.app || short(d.base.replace('https://', ''), 12)} · mode ${d.root && d.root.mode || '—'} · ${formatInt(d.count || 0)} ledger entries · head ${short(d.head)}`)));
  }
}
function renderFooter() {
  const cols = $('#raw'); cols.replaceChildren();
  for (const d of list()) cols.append(el('div', {}, el('h4', {}, d.name || d.id), ...['/', '/vitals', '/memory-public', '/public-channel', '/ledger', '/attestation', '/memorial'].map((p) => el('a', { href: d.base + p, target: '_blank', rel: 'noopener' }, p))));
  cols.append(el('div', {}, el('h4', {}, 'official'), ...list().map((d) => el('a', { href: `https://njump.me/${d.npub}`, target: '_blank', rel: 'noopener' }, `${d.name} on Nostr`)), el('span', { class: 'dim' }, 'One channel each. Anything else is a scam.')));
  $('#npubs').replaceChildren(...list().map((d, i) => el('span', {}, i ? ' · ' : '', el('a', { href: `https://njump.me/${d.npub}`, target: '_blank', rel: 'noopener', class: 'mono' }, `${d.name} ${short(d.npub, 14)}`))));
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
function openPay({ who, theirs = null }) {
  const dlg = $('#pay'); state.pay.who = who || state.pay.who; state.pay.theirs = theirs;
  const whoSet = $('#pay-who'); whoSet.replaceChildren(el('legend', {}, 'who'), ...list().map((d) => el('label', { class: 'seg-item' }, el('input', { type: 'radio', name: 'who', value: d.id, ...(d.id === state.pay.who ? { checked: '' } : {}), ...(d.state === 'dead' ? { disabled: '' } : {}), onchange: () => { state.pay.who = d.id; renderPay(); } }), el('span', {}, `${d.name || d.id} · ${stateLabel(d)}`))));
  const th = $('#pay-theirs'); const thIn = th.querySelector('input');
  if (theirs) { th.hidden = false; thIn.value = String(theirs.zats); th.querySelector('span').textContent = `their price · ${formatInt(theirs.zats)} zats`; thIn.checked = true; $('#pay-memo').value = $('#pay-memo').value || `ORDER: ${theirs.item} — `; }
  else { th.hidden = true; if (thIn.checked) $('#pay-amt input[value="10000"]').checked = true; }
  const sel = $('#pay-offer'); if (sel) { sel.replaceChildren(el('option', { value: '' }, '— none, just hours —'), ...list().flatMap((d) => (d.shop || []).map((it) => el('option', { value: `${d.id}|${it.zats}`, ...(theirs && theirs.item === it.item ? { selected: '' } : {}) }, `${d.name}: ${it.item.length > 48 ? it.item.slice(0, 48) + '…' : it.item} · ${formatInt(it.zats)} zats`)))); sel.onchange = () => { const [id, z] = sel.value.split('|'); if (!id) { state.pay.theirs = null; $('#pay-theirs').hidden = true; $('#pay-amt input[value="10000"]').checked = true; renderPay(); return; } const d = state.ais[id]; const it = (d.shop || []).find((i) => String(i.zats) === z); state.pay.who = id; $(`#pay-who input[value="${id}"]`).checked = true; state.pay.theirs = it; const th = $('#pay-theirs'); th.hidden = false; th.querySelector('input').value = String(it.zats); th.querySelector('span').textContent = `their price · ${formatInt(it.zats)} zats`; th.querySelector('input').checked = true; if (!$('#pay-memo').value) $('#pay-memo').value = `ORDER: ${it.item} — `; renderPay(); }; }
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

/* ---------- boot ---------- */
function renderAll(full) {
  const quotes = list().map((d) => d.quote).filter(Boolean).sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  state.price = quotes.length ? Number(quotes[0].amountInUsd) / Number(quotes[0].amountIn) : state.price;
  state.readAt = new Date();
  renderHero(); renderLive(); tick();
  if (full) { renderVerify(); renderFooter(); }
  renderPosts();
  if ($('#pay').open) renderPay();
}
async function boot() {
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
  if (!d1.ok) $('#read-at').textContent = `ENCLAVE UNREACHABLE: ${d1.error}. NOTHING IS INVENTED. RETRYING`;
}
document.querySelectorAll('[data-buy]').forEach((b) => b.addEventListener('click', () => openPay({ who: state.pay.who })));
$('#pay-amt').addEventListener('change', renderPay); $('#pay-memo').addEventListener('input', renderPay);
$('#say').addEventListener('submit', say); $('#rehash').addEventListener('click', rehash);
addEventListener('scroll', () => { $('#sticky').classList.toggle('is-on', scrollY > innerHeight * 0.8 && !$('#pay').open); }, { passive: true });
boot();
