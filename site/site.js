/* ZEALOT v13 — one page, two enclaves. Every number here is fetched or computed from a fetch. */
import {
  ENTITIES, REFRESH_MS, COOLDOWN_MS, request, postMessage, parseLedger, verifyChain, stringOf,
  formatInt, fixed8, shortHash, summarize, formatDecimal, peerUrlOf, applyDevBase, applyDevBase2,
} from './data.js';
import { zip321Uri, qrSvg } from './qr.js';
import { mount as mountSkull } from './skull.js?v=202610220206';

const RENT = 10000;            // zats per hour, base rent (matches rent_paid.data.rentZats)
const MEMO_MAX = 500;          // bytes
const ACTS_MAX = 14;           // newest acts shown in "what they do"
const NAME_FALLBACK = { e1: 'Wick', e2: 'OBOL' };

const AIS = ENTITIES.map((e) => ({ ...e }));
applyDevBase(AIS, location.search);
applyDevBase2(AIS, location.search);

const state = {
  ais: {},
  order: [],
  price: null,
  readAt: null,
  pay: { who: 'e1', zats: RENT, memo: '', theirs: null, label: '' },
  cooldownUntil: 0,
};

const $ = (s, r = document) => r.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null) n.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return n;
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const utc = (ts) => { const d = new Date(ts); return Number.isNaN(d.getTime()) ? '—' : d.toISOString().slice(11, 16) + ' UTC'; };
const dayUtc = (ts) => { const d = new Date(ts); return Number.isNaN(d.getTime()) ? '—' : `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.toISOString().slice(11, 16)} UTC`; };
const usd = (zats) => state.price ? `$${(zats / 1e8 * state.price).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '';
const bytesOf = (s) => new TextEncoder().encode(s).length;
const short = (h, n = 8) => stringOf(h).slice(0, n) + '…';
const truncate = (s, n) => { const t = stringOf(s); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------- rolling numbers (setTimeout, not rAF) ---------- */
function roll(node, value, fmt = formatInt) {
  const from = Number(node.dataset.v || 0), to = Number(value);
  if (!Number.isFinite(to)) { node.textContent = '—'; return; }
  node.dataset.v = String(to);
  if (reduced || from === to || !node.isConnected) { node.textContent = fmt(to); return; }
  const t0 = performance.now(), dur = 700;
  const step = () => {
    const p = Math.min(1, (performance.now() - t0) / dur);
    const e = 1 - Math.pow(1 - p, 3);
    node.textContent = fmt(Math.round(from + (to - from) * e));
    if (p < 1) setTimeout(step, 16);
  };
  setTimeout(step, 16);
}

/* ---------- fetch + derive ---------- */
async function load(ai, full = true) {
  const base = ai.base;
  const [root, vitals, memory, channel, ledger] = await Promise.all([
    request(base, '/'),
    request(base, '/vitals'),
    full ? request(base, '/memory-public') : null,
    request(base, '/public-channel'),
    full ? request(base, '/ledger', { text: true }) : null,
  ]);
  const d = state.ais[ai.id] || { id: ai.id, base, entries: [], posts: [], ledgerText: '' };
  d.at = new Date();
  d.ok = root.ok;
  d.error = root.ok ? null : (root.error || 'unreachable');
  if (root.ok) {
    d.root = root.data;
    d.name = stringOf(root.data.entity) || NAME_FALLBACK[ai.id] || ai.label;
    d.address = (root.data.zcash && root.data.zcash.address) || '';
    d.npub = (root.data.nostr && root.data.nostr.npub) || '';
    d.app = (root.data.attestation && root.data.attestation.app) || '';
    // a dead entity serves only its memorial `/` (state:'dead'); vitals 404s.
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
      d.brain = Array.isArray(vitals.data.brain) && vitals.data.brain[0] ? vitals.data.brain[0].model : '';
    } else if (d.ok && !d.state) {
      d.state = 'unknown';
    }
  }
  if (memory && memory.ok) d.identity = memory.data.identity || {};
  if (channel.ok && Array.isArray(channel.data)) d.posts = channel.data;
  if (ledger && ledger.ok) { d.ledgerText = ledger.text; d.entries = parseLedger(ledger.text).entries; derive(d); }
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

function list() { return state.order.map((id) => state.ais[id]).filter(Boolean); }
function stateLabel(d) {
  if (!d.ok) return 'unreachable';
  if (d.state === 'dead') return 'dead';
  if (d.sleepUntil && Date.parse(d.sleepUntil) > Date.now()) return `asleep · wakes ${utc(d.sleepUntil)}`;
  return d.state === 'alive' ? 'awake' : (d.state || 'unknown');
}
function stateTag(d) {
  if (!d.ok) return 'NO SIGNAL';
  if (d.state === 'dead') return 'DEAD';
  if (d.sleepUntil && Date.parse(d.sleepUntil) > Date.now()) return 'ASLEEP';
  return d.state === 'alive' ? 'ALIVE' : stringOf(d.state).toUpperCase();
}
function deadline(d) {
  const base = d.lastRent ? Date.parse(d.lastRent.ts) : (d.at ? d.at.getTime() : Date.now());
  return base + d.hoursLeft * 36e5;
}
function fmtCountdown(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const s = total % 60, m = Math.floor(total / 60) % 60, h = Math.floor(total / 3600);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/* ---------- acts ---------- */
function acts() {
  return list().flatMap((d) => (d.events || []).map((e) => ({ d, e })))
    .sort((a, b) => Date.parse(b.e.ts) - Date.parse(a.e.ts));
}
function actTag(t) {
  const map = { rent_paid: 'rent_paid', letter: 'letter', post_public: 'post_public', paywall: 'paywall', swap_quote: 'swap_quote', promise: 'promise', bounty: 'bounty', whisper: 'whisper', wallet: 'wallet', will: 'will' };
  return map[t] || t;
}
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

/* ---------- render: hero ---------- */
function renderHero() {
  for (const d of list()) {
    const name = $(`[data-name="${d.id}"]`); if (name) name.textContent = (d.name || NAME_FALLBACK[d.id] || d.id).toUpperCase();
    const st = $(`[data-state="${d.id}"]`); if (st) st.textContent = stateTag(d);
    const h = $(`[data-h="${d.id}"]`); if (h) { h.textContent = d.ok ? formatInt(d.hoursLeft) : '—'; }
    const label = st && st.closest('.label'); if (label) label.querySelector('.dot').style.background = (d.ok && d.state !== 'dead') ? 'var(--live)' : (d.state === 'dead' ? 'var(--dead)' : 'var(--dim)');
    // blood-panel names
    const rn = $(`.runway [data-name="${d.id}"]`); if (rn) rn.textContent = (d.name || NAME_FALLBACK[d.id] || d.id).toUpperCase();
  }
  const usdEl = $('[data-usd]');
  if (usdEl) usdEl.textContent = state.price ? `≈ ${usd(RENT)}` : '';
  const anyDead = list().some((d) => d.ok && d.state === 'dead');
  document.body.classList.toggle('is-dead', anyDead);
}

/* ---------- render: what they do ---------- */
function renderActs() {
  const A = list();
  const all = acts();
  const counters = { posts: 0, quotes: 0, offers: 0, hours: 0 };
  for (const d of A) {
    counters.hours += (d.letters || []).length;
    for (const e of (d.events || [])) {
      if (e.type === 'post_public') counters.posts += 1;
      else if (e.type === 'swap_quote') counters.quotes += 1;
      else if (e.type === 'paywall') counters.offers += 1;
    }
  }
  roll($('[data-c="posts"]'), counters.posts);
  roll($('[data-c="quotes"]'), counters.quotes);
  roll($('[data-c="offers"]'), counters.offers);
  roll($('[data-c="hours"]'), counters.hours);

  const latestReceipt = all.find((x) => x.e.type === 'letter' || x.e.type === 'rent_paid');
  const tbody = $('#acts');
  if (!tbody) return;
  const rows = all.slice(0, ACTS_MAX);
  tbody.replaceChildren(...rows.map(({ d, e }) => {
    const row = el('div', { class: 'act' + (latestReceipt && e === latestReceipt.e ? ' is-live' : '') },
      el('span', { class: 'a-time' }, dayUtc(e.ts)),
      el('span', { class: 'a-who' }, (d.name || NAME_FALLBACK[d.id] || d.id).toUpperCase()),
      el('span', { class: 'a-act' }, actTag(e.type)),
      el('span', { class: 'a-detail' }, actDetail(e)),
      el('span', { class: 'a-hash' }, short(e.hash, 14)));
    return row;
  }));
  const note = $('#acts-note');
  if (note) note.textContent = rows.length
    ? `Showing ${rows.length} of ${all.length} acts · read live from /ledger · the green line is the latest receipt.`
    : 'No acts yet: the ledgers have not written anything since their mainnet wallet.';
}

/* ---------- render: runway countdowns ---------- */
function tick() {
  const A = list();
  for (const d of A) {
    const n = $(`[data-count="${d.id}"]`); if (!n) continue;
    if (!d.ok) { n.textContent = '—'; continue; }
    if (d.state === 'dead') { n.textContent = '0:00:00'; continue; }
    n.textContent = fmtCountdown(deadline(d) - Date.now());
  }
}

/* ---------- render: verify / ledger ---------- */
function renderVerify() {
  const keys = $('#ufvks'), att = $('#attest');
  if (keys) keys.replaceChildren();
  if (att) att.replaceChildren();
  for (const d of list()) {
    if (keys) {
      keys.append(el('div', { class: 'key' },
        el('div', { class: 'r' },
          el('b', {}, (d.name || NAME_FALLBACK[d.id] || d.id).toUpperCase()),
          d.ufvk ? el('button', { type: 'button', onclick: (ev) => copy(d.ufvk, ev.target) }, 'Copy viewing key') : el('span', { class: 'dim' }, 'none yet')),
        el('span', { class: 'kk' }, d.ufvk ? short(d.ufvk, 40) : `address ${short(d.address, 16)}`)));
    }
    if (att) {
      att.append(el('div', { class: 'key' },
        el('div', { class: 'r' },
          el('b', {}, (d.name || NAME_FALLBACK[d.id] || d.id).toUpperCase()),
          el('a', { href: `${d.base}/attestation`, target: '_blank', rel: 'noopener' }, 'Open the quote ↗')),
        el('span', { class: 'kk' }, `app ${d.app || short(d.base.replace('https://', ''), 12)} · ${formatInt(d.count || 0)} entries · head ${short(d.head)}`)));
    }
  }
}

/* ---------- render: footer raw links ---------- */
function renderRaw() {
  const cols = $('#raw');
  if (!cols) return;
  cols.replaceChildren();
  for (const d of list()) {
    cols.append(el('div', { class: 'col' },
      el('h4', {}, `${(d.name || NAME_FALLBACK[d.id] || d.id).toUpperCase()} · raw`),
      ...['/', '/vitals', '/memory-public', '/public-channel', '/ledger', '/attestation', '/memorial'].map((p) => el('a', { href: d.base + p, target: '_blank', rel: 'noopener' }, p))));
  }
  const npubs = $('#npubs');
  if (npubs) {
    npubs.replaceChildren(...list().map((d, i) => el('span', {}, i ? ' · ' : '', el('a', { href: `https://njump.me/${d.npub}`, target: '_blank', rel: 'noopener', class: 'mono' }, `${d.name || NAME_FALLBACK[d.id]} ${short(d.npub, 14)}`))));
    if (!list().length) npubs.textContent = 'one channel each, announced when the enclaves come online. Anything else is a scam.';
  }
}

/* ---------- render: what they said + stream ---------- */
function renderWords() {
  const box = $('#words');
  if (!box) return;
  const all = list().flatMap((d) => (d.posts || []).filter((p) => p.from !== 'human').map((p) => ({ d, p })))
    .sort((a, b) => Date.parse(b.p.ts) - Date.parse(a.p.ts));
  const limit = box.dataset.all ? all.length : 4;
  box.replaceChildren(...all.slice(0, limit).map(({ d, p }) => {
    const li = el('div', { class: 'word' },
      el('div', { class: 'top' }, el('b', {}, (d.name || NAME_FALLBACK[d.id] || d.id).toUpperCase()), el('span', {}, dayUtc(p.ts))),
      el('div', { class: 'big' }, `${formatInt(d.hoursLeft)} h`, el('small', {}, stateLabel(d))),
      el('pre', {}, stringOf(p.text)));
    if (stringOf(p.text).length > 360) li.append(el('button', { class: 'more', type: 'button', onclick: (ev) => { li.classList.toggle('is-open'); ev.target.textContent = li.classList.contains('is-open') ? 'Less' : 'Read all'; } }, 'Read all'));
    return li;
  }));
  if (!all.length) box.append(el('div', { class: 'word' }, el('pre', { class: 'dim' }, 'nothing posted yet')));
  const more = $('#words-more');
  if (more) { more.hidden = all.length <= 4 || !!box.dataset.all; more.onclick = () => { box.dataset.all = '1'; renderWords(); }; }

  const sel = $('#say-to');
  if (sel && !sel.children.length) for (const d of list()) sel.append(el('option', { value: d.id }, d.name || NAME_FALLBACK[d.id] || d.id));
}

let streamTimer = 0;
function startStream() {
  const box = $('#stream');
  if (!box) return;
  if (streamTimer) { clearTimeout(streamTimer); streamTimer = 0; }
  const lines = list().flatMap((d) => (d.posts || []).filter((p) => p.from !== 'human' && stringOf(p.text).trim())
    .map((p) => `${(d.name || NAME_FALLBACK[d.id] || d.id).toUpperCase()}: ${stringOf(p.text).trim()}`));
  if (!lines.length) { box.textContent = ''; return; }
  const text = lines.join('\n\n');
  if (reduced) { box.textContent = text; return; }
  box.textContent = text + '\n\n' + text; // duplicate for a seamless wrap
  let y = 0;
  const step = () => {
    y += 0.4;
    const half = box.scrollHeight / 2;
    if (half > 0 && y >= half) y -= half;
    box.style.transform = `translate3d(0,-${y}px,0)`;
    streamTimer = setTimeout(step, 40);
  };
  streamTimer = setTimeout(step, 40);
}

/* ---------- verify / copy / say ---------- */
async function rehash() {
  const out = $('#rehash-out'), btn = $('#rehash');
  if (!out || !btn) return;
  btn.disabled = true; out.className = 'result'; const lines = [];
  for (const d of list()) {
    if (!d.ledgerText) { lines.push(`${(d.name || NAME_FALLBACK[d.id] || d.id)}: ledger not loaded`); continue; }
    out.textContent = [...lines, `${(d.name || NAME_FALLBACK[d.id] || d.id)}: hashing…`].join('\n');
    const r = await verifyChain(d.ledgerText, { animate: false });
    lines.push(r.ok ? `${(d.name || NAME_FALLBACK[d.id] || d.id)}: ${formatInt(r.valid)} / ${formatInt(r.total)} entries · chain intact · head ${short(r.head, 12)}` : `${(d.name || NAME_FALLBACK[d.id] || d.id)}: MISMATCH at ${r.fail ? 'seq ' + r.fail.seq : '?'} · ${r.reason || ''}`);
    if (!r.ok) out.classList.add('bad');
  }
  out.textContent = lines.join('\n');
  if (!out.classList.contains('bad')) out.classList.add('ok');
  btn.disabled = false;
}
function copy(text, node) {
  navigator.clipboard?.writeText(text).then(() => {
    const t = node.textContent; node.textContent = 'copied';
    setTimeout(() => { node.textContent = t; }, 1400);
  });
}

async function say(ev) {
  ev.preventDefault();
  const st = $('#say-status'), btn = $('#say-send');
  const text = $('#say-text').value.trim();
  const author = $('#say-author').value.trim() || 'anonymous';
  const to = state.ais[$('#say-to').value];
  if (!to) { st.textContent = 'no enclave reachable right now'; return; }
  if (!text) { st.textContent = 'write something first'; return; }
  if (Date.now() < state.cooldownUntil) { st.textContent = `wait ${Math.ceil((state.cooldownUntil - Date.now()) / 1000)} s`; return; }
  btn.disabled = true; st.textContent = `posting to ${to.name}…`;
  const r = await postMessage(to.base, { author, text });
  btn.disabled = false;
  if (r.ok) { st.textContent = `posted on ${to.name}'s channel. they read it at their next wake.`; $('#say-text').value = ''; state.cooldownUntil = Date.now() + COOLDOWN_MS; await load(to, false); renderWords(); }
  else st.textContent = `not posted: ${r.error || 'HTTP ' + r.status}`;
}

/* ---------- buy an hour dialog ---------- */
function openPay({ who, theirs = null }) {
  const dlg = $('#pay');
  if (!dlg) return;
  state.pay.who = who || state.pay.who;
  state.pay.theirs = theirs;
  const whoSet = $('#pay-who');
  whoSet.replaceChildren(
    el('legend', {}, 'who'),
    ...list().map((d) => el('label', { class: 'seg-item' },
      el('input', { type: 'radio', name: 'who', value: d.id, ...(d.id === state.pay.who ? { checked: '' } : {}), ...(d.state === 'dead' ? { disabled: '' } : {}), onchange: () => { state.pay.who = d.id; renderPay(); } }),
      el('span', {}, `${d.name || NAME_FALLBACK[d.id] || d.id} · ${stateLabel(d)}`))));
  const th = $('#pay-theirs'); const thIn = th.querySelector('input');
  if (theirs) {
    th.hidden = false;
    thIn.value = String(theirs.zats);
    th.querySelector('span').textContent = `their price · ${formatInt(theirs.zats)} zats`;
    thIn.checked = true;
    $('#pay-memo').value = $('#pay-memo').value || `ORDER: ${theirs.item} — `;
  } else {
    th.hidden = true;
    if (thIn.checked) $('#pay-amt input[value="10000"]').checked = true;
  }
  const sel = $('#pay-offer');
  if (sel) {
    sel.replaceChildren(
      el('option', { value: '' }, '— none, just hours —'),
      ...list().flatMap((d) => (d.shop || []).map((it) => el('option', { value: `${d.id}|${it.zats}`, ...(theirs && theirs.item === it.item ? { selected: '' } : {}) }, `${d.name || NAME_FALLBACK[d.id]}: ${it.item.length > 48 ? it.item.slice(0, 48) + '…' : it.item} · ${formatInt(it.zats)} zats`))));
    sel.onchange = () => {
      const [id, z] = sel.value.split('|');
      if (!id) { state.pay.theirs = null; $('#pay-theirs').hidden = true; $('#pay-amt input[value="10000"]').checked = true; renderPay(); return; }
      const d = state.ais[id];
      const it = (d.shop || []).find((i) => String(i.zats) === z);
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
  renderPay();
  if (!dlg.open) dlg.showModal();
  $('#pay-memo').focus({ preventScroll: true });
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
  $('#pay-zec').textContent = `${fixed8(amt)} ZEC`;
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
  any.href = `https://trocador.app/anonpay/?ticker_to=zec&network_to=Shielded&address=${encodeURIComponent(addr)}&amount=${(amt / 1e8).toFixed(8)}&name=hours&description=${encodeURIComponent(`${Math.max(1, Math.round(hours))} hours for ${d.name}`)}&bgcolor=0A0B0Dff&buttonbgcolor=C9F542&textcolor=0A0B0D&simple_mode=True`;
  $('#pay-addr').textContent = `${d.name}'s shielded address: ${addr}`;
}

/* ---------- render all ---------- */
function renderAll(full) {
  const quotes = list().map((d) => d.quote).filter(Boolean).sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  state.price = quotes.length ? Number(quotes[0].amountInUsd) / Number(quotes[0].amountIn) : state.price;
  state.readAt = new Date();
  renderHero();
  renderActs();
  renderWords();
  tick();
  if (full) { renderVerify(); renderRaw(); startStream(); }
  if ($('#pay').open) renderPay();
  const readAt = $('#read-at');
  if (readAt) readAt.textContent = state.readAt ? `Read ${dayUtc(state.readAt)}; refreshes every 60 s.` : '';
}

/* ---------- boot ---------- */
async function boot() {
  try { mountSkull(document.getElementById('skull')); } catch { /* no WebGL: the page still stands */ }
  state.order = ['e1'];
  const e1 = AIS[0];
  await load(e1, true);
  const d1 = state.ais.e1;
  const peer = d1.root ? peerUrlOf(d1.root.peer) : '';
  const e2 = AIS[1];
  if (!e2.base && peer) e2.base = peer;
  if (e2.base) { state.order.push('e2'); await load(e2, true); }
  renderAll(true);
  if (!d1.ok) {
    const readAt = $('#read-at');
    if (readAt) readAt.textContent = `Enclave unreachable: ${d1.error}. Nothing is invented; retrying every 60 s.`;
  }

  // refresh loop: drive with setInterval (one-shot work) — no rAF here.
  setInterval(async () => { for (const ai of AIS) if (ai.base) await load(ai, false); renderAll(false); }, REFRESH_MS);
  setInterval(async () => { for (const ai of AIS) if (ai.base) await load(ai, true); renderAll(true); }, REFRESH_MS * 5);
  setInterval(tick, 1000);
}

/* ---------- wiring ---------- */
document.querySelectorAll('[data-buy]').forEach((b) => b.addEventListener('click', () => openPay({ who: state.pay.who })));
$('#pay-amt').addEventListener('change', renderPay);
$('#pay-memo').addEventListener('input', renderPay);
$('#say').addEventListener('submit', say);
$('#rehash').addEventListener('click', rehash);
addEventListener('scroll', () => { $('#sticky').classList.toggle('is-on', scrollY > innerHeight * 0.6 && !$('#pay').open); }, { passive: true });

boot();
