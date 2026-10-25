/*
 * terminal.js — ZEALOT v44, "MORTALITY TERMINAL" (the home, drawn in glyphs).
 *
 * Seven glyph scenes, each a full-width <section> with a canvas plus one 11px mono label:
 *   S0 skulls (hero.js, full viewport) with the two 5×7 clocks drawn under the jaws
 *   S1 hand (hand-coin.jpg) BUY AN HOUR
 *   S2 hourglass (sand = rent speed) HOURS LEFT, A/B hours as glyph digits
 *   S3 shout PROVE LIVE (single button, challenges the first living entity)
 *   S4 sealed letter (a 480-glyph envelope seeded from the commitment)
 *   S5 bones SAY SOMETHING + the testament
 *   S6 spine THE LEDGER (verified in browser) + three links
 *
 * It rides on app.js, which still owns the shared boot (loadAll), the 60 s refresh clock, the pay dialog, the
 * skull state (setMouth/setFeel) and the mounted home scenes (hand/hourglass/shout/bones/spine). app.js dispatches
 * 'zealot:data' after every refresh; this module listens and re-renders. It adds its own fast poll (5 s) only while
 * a PROVE LIVE or SAY SOMETHING wait is pending, and never duplicates a data loader.
 *
 * Nothing here is invented: every number comes from the two enclave endpoints, and no value we do not have is shown.
 */
import {
  state, nameOf, stateWord, deadline, loadAll,
} from './term.js?v=49';
import {
  request, verifyChain, stringOf, formatInt, formatZats, fmtStamp, hhmm, shortHash, sha256Hex, postMessage,
} from './data.js?v=49';
import { setJawChatter, drawNonce, triggerTalk, drawClockText, setHours } from './hero.js?v=49';
import { initFear, fearLevel } from './fear.js?v=49';
import { mountAscii } from './ascii.js?v=49';
import { homeScenes } from './app.js?v=49';

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
const setText = (id, text) => { const n = document.getElementById(id); if (n) n.textContent = String(text == null ? '' : text); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
const labelOf = (id) => (id === 'e1' ? 'A' : 'B');
const entDead = (d) => Boolean(d && d.ok && (d.state === 'dead' || Number(d.hoursLeft) === 0));

/* ------------------------------------------------------------------ */
/* 5×7 glyph digits (one shared alphabet, drawn on canvas)             */
/* ------------------------------------------------------------------ */
const GLYPHS = {
  '0': ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  '3': ['.###.', '#...#', '....#', '..##.', '....#', '#...#', '.###.'],
  '4': ['#...#', '#...#', '#...#', '#####', '....#', '....#', '....#'],
  '5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  '6': ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
  '7': ['#####', '....#', '...#.', '..#..', '..#..', '..#..', '..#..'],
  '8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  '9': ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
  ':': ['.....', '..#..', '.....', '.....', '..#..', '.....', '.....'],
  '-': ['.....', '.....', '.....', '.###.', '.....', '.....', '.....'],
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
  'A': ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  'B': ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
};
const MONO = '"JetBrains Mono", "SF Mono", Menlo, monospace';

function drawGlyphCanvas(ctx, str, fill, x, y, cell, color) {
  ctx.fillStyle = color;
  ctx.font = `${Math.max(2, cell * 1.2)}px ${MONO}`;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  let px = x;
  for (const ch of String(str)) {
    const g = GLYPHS[ch] || GLYPHS[' '];
    for (let r = 0; r < 7; r++) for (let c = 0; c < 5; c++) {
      if (g[r][c] === '#') ctx.fillText(fill, px + c * cell, y + r * cell);
    }
    px += 6 * cell;
  }
  ctx.textAlign = 'left';
}

/* ------------------------------------------------------------------ */
/* the clocks — drawn on the #skulls canvas under each jaw             */
/* ------------------------------------------------------------------ */
function remainingSecondsValue(d) {
  if (!d || !d.ok) return null;
  if (entDead(d)) return 0;
  return Math.max(0, Math.floor((deadline(d) - Date.now()) / 1000));
}

function clockInfo(d) {
  const rem = remainingSecondsValue(d);
  if (rem == null) return { str: null, fill: '#', dead: false, offline: true };
  if (entDead(d)) return { str: '00:00:00', fill: '#', dead: true, offline: false };
  const s = rem;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const str = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  const fill = s < 3600 ? '@' : (s < 86400 ? '+' : '#');
  return { str, fill, dead: false, offline: false };
}

function renderClock(id) {
  const info = clockInfo(state.ais[id]);
  const str = info.str || (info.dead ? '00:00:00' : '--:--:--');
  drawClockText(id, str, info.fill);
  const d = state.ais[id];
  setHours(id, (d && d.ok) ? Math.max(0, Number(d.hoursLeft) || 0) : null);
}

const wasAlive = { e1: null, e2: null };
function tickClock(id) {
  const info = clockInfo(state.ais[id]);
  renderClock(id);
  const alive = info.offline === false && !info.dead;
  if (wasAlive[id] === true && !alive) playCue('zero');
  wasAlive[id] = alive;
}

/* ------------------------------------------------------------------ */
/* the A/B hours overlay (S2)                                          */
/* ------------------------------------------------------------------ */
function renderHoursOverlay() {
  const c = document.getElementById('gs-hours');
  if (!c) return;
  const W = c.clientWidth, H = c.clientHeight;
  if (!W || !H) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const cell = Math.max(3, Math.floor(W / 64));
  for (const id of ['e1', 'e2']) {
    const d = state.ais[id];
    let txt;
    if (!d || !d.ok) txt = '--';
    else if (entDead(d)) txt = '00';
    else txt = String(Math.max(0, Number(d.hoursLeft) || 0));
    const str = `${labelOf(id)} ${txt}`;
    const glyphW = str.length * 6 * cell;
    const x = (id === 'e1' ? W * 0.27 : W * 0.73) - glyphW / 2;
    const y = H * 0.5 - 7 * cell / 2;
    const color = (!d || !d.ok) ? 'rgba(120,120,120,0.6)' : (entDead(d) ? 'rgba(120,120,120,0.7)' : '#f4b728');
    drawGlyphCanvas(ctx, str, '#', x, y, cell, color);
  }
}

/* ------------------------------------------------------------------ */
/* evidence — six rows, each with a VERIFY affordance                  */
/* ------------------------------------------------------------------ */
const ROWS = [
  { key: 'hours', label: 'HOURS', vfy: 'link', path: '/vitals' },
  { key: 'balance', label: 'BALANCE', vfy: 'link', path: '/' },
  { key: 'fear', label: 'FEAR DOSE', vfy: 'link', path: '/' },
  { key: 'ledger', label: 'LEDGER', vfy: 'verify' },
  { key: 'tx', label: 'TX', vfy: 'link', path: '/ledger' },
  { key: 'letter', label: 'LETTER', vfy: 'link', path: '/ledger' },
];

function latestLetterFor(id) {
  const d = state.ais[id];
  if (!d || !Array.isArray(d.letters) || !d.letters.length) return null;
  return d.letters[d.letters.length - 1];
}

function isBetween(entry, fromId) {
  const to = stringOf(entry.data && entry.data.to).trim().toUpperCase();
  if (!to) return false;
  const otherId = fromId === 'e1' ? 'e2' : 'e1';
  const otherD = state.ais[otherId];
  const targets = [otherId.toUpperCase()];
  if (otherD) targets.push(nameOf(otherD).toUpperCase());
  return targets.some((t) => t && (to === t || to.includes(t)));
}

/* latest incoming/outgoing letter between the two entities (the "secret letter") */
function latestLetterBetween() {
  let best = null;
  let bestFallback = null;
  for (const id of ['e1', 'e2']) {
    const d = state.ais[id];
    const outgoing = (d && Array.isArray(d.entries) ? d.entries : []).filter((e) => e.type === 'letter' && e.data && e.data.to === 'peer');
    if (!d) continue;
    for (const e of outgoing.concat(Array.isArray(d.letters) ? d.letters.filter((e) => isBetween(e, id)) : [])) {
      if (!bestFallback || Date.parse(e.ts) > Date.parse(bestFallback.ts)) bestFallback = e;
      if (isBetween(e, id)) {
        const known = e.data && e.data.text != null && e.data.text !== '';
        const bestKnown = best && best.data && best.data.text;
        if (!best || (known && !bestKnown) || (known === Boolean(bestKnown) && Date.parse(e.ts) > Date.parse(best.ts))) best = e;
      }
    }
  }
  return best || bestFallback;
}

function letterBytesNum(e) {
  const t = e.data && e.data.text;
  if (t != null && t !== '') return new TextEncoder().encode(String(t)).length;
  return 480;
}
function bytesLabel(e) {
  const t = e.data && e.data.text;
  if (t != null && t !== '') return `${new TextEncoder().encode(String(t)).length} BYTES`;
  return '480 B max';
}

function evHours(d) {
  if (!d || !d.ok) return '—';
  if (entDead(d)) return '0 h';
  return `${formatInt(d.hoursLeft)} h`;
}
function evBalance(d) {
  if (!d || !d.ok) return '—';
  const bal = d.root && d.root.zcash && d.root.zcash.balance;
  if (bal != null && Number.isFinite(Number(bal))) return `${formatZats(bal)} ZEC`;
  if (Number.isFinite(Number(d.zats))) return `${formatZats(d.zats)} ZEC`;
  return '—';
}
function evFear(d) {
  if (!d || !d.ok) return '—';
  if (entDead(d)) return '—';
  const f = d.feel;
  if (!f || !Number.isFinite(Number(f.fear))) return 'no dose reported';
  return `${Number(f.fear).toFixed(2)}×`;
}
function evLedger(d) {
  if (!d || !d.ok || !d.head) return '—';
  return shortHash(d.head);
}
function evTx(d) {
  if (!d || !d.ok) return '—';
  const last = d.lastRent;
  if (!last || !last.data) return 'no rent yet';
  const txid = last.data.txid;
  if (!txid || txid === 'unknown') return 'txid not reported by the wallet';
  return shortHash(txid);
}
function evLetter(id) {
  const d = state.ais[id];
  if (!d || !d.ok) return '—';
  const e = latestLetterFor(id);
  if (!e) return 'NO LETTER YET';
  const zats = Number(e.data && e.data.zats) || 0;
  return `${bytesLabel(e)} · ${formatInt(zats)} zats · ${fmtStamp(e.ts)}`;
}

async function verifyLedger(id) {
  const out = document.getElementById('ledger-out-' + id);
  const d = state.ais[id];
  if (!out) return;
  if (!d || !d.base) { out.textContent = 'no endpoint'; return; }
  out.textContent = 'hashing…';
  const r = await request(d.base, '/ledger', { text: true });
  if (!r.ok || !r.text) { out.textContent = 'FAILED'; return; }
  const v = await verifyChain(r.text, { animate: false });
  out.textContent = v.ok
    ? `VERIFIED IN BROWSER · ${formatInt(v.valid)} entries · head ${shortHash(v.head)}`
    : 'FAILED';
}

function buildEvidence(id) {
  const root = document.getElementById('evidence-' + id);
  if (!root) return;
  const inner = el('div', { class: 'gs-ev-inner' });
  inner.append(el('div', { class: 'gs-ev-head' },
    el('span', { class: 'gs-ev-name', id: 'evidence-name-' + id }, labelOf(id))));
  ROWS.forEach((r, i) => {
    const row = el('div', { class: 'gs-row', style: `--i:${i}` });
    row.append(el('span', { class: 'gs-k' }, r.label));
    row.append(el('span', { class: 'gs-v', id: `ev-${r.key}-${id}` }, '—'));
    if (r.vfy === 'link') {
      row.append(el('a', { class: 'gs-vfy', id: `vfy-${r.key}-${id}`, href: '#', target: '_blank', rel: 'noopener' }, 'VERIFY'));
    } else {
      const btn = el('button', { class: 'gs-vfy', id: `vfy-${r.key}-${id}`, type: 'button' }, 'VERIFY');
      btn.addEventListener('click', () => { void verifyLedger(id); });
      row.append(btn, el('span', { class: 'gs-vfy-out', id: 'ledger-out-' + id }, ''));
    }
    inner.append(row);
  });
  root.append(inner);
}

function renderEvidence(id) {
  const d = state.ais[id];
  const base = d && d.base ? d.base : '';
  setText(`ev-hours-${id}`, evHours(d));
  setText(`ev-balance-${id}`, evBalance(d));
  setText(`ev-fear-${id}`, evFear(d));
  setText(`ev-ledger-${id}`, evLedger(d));
  setText(`ev-tx-${id}`, evTx(d));
  setText(`ev-letter-${id}`, evLetter(id));
  const paths = { hours: '/vitals', balance: '/', fear: '/', tx: '/ledger', letter: '/ledger' };
  for (const k of Object.keys(paths)) {
    const a = document.getElementById(`vfy-${k}-${id}`);
    if (a) { if (base) a.href = base + paths[k]; else a.removeAttribute('href'); }
  }
  setText(`evidence-name-${id}`, `${labelOf(id)} · ${d && d.ok ? nameOf(d) : '—'}${d && d.ok ? ' · ' + stateWord(d) : ''}`);
}

function toggleEvidence(id) {
  const ev = document.getElementById('evidence-' + id);
  if (!ev) return;
  const other = document.getElementById('evidence-' + (id === 'e1' ? 'e2' : 'e1'));
  const open = !ev.classList.contains('open');
  ev.classList.toggle('open', open);
  if (other) other.classList.remove('open');
}

/* touch the right half of the skulls canvas = open that entity's evidence */
function wireSkullTouch() {
  const c = document.getElementById('skulls');
  if (!c) return;
  c.style.pointerEvents = 'auto';
  c.style.cursor = 'pointer';
  c.addEventListener('click', (evt) => {
    const rect = c.getBoundingClientRect();
    const x = evt.clientX - rect.left;
    const stacked = window.innerWidth < 720;
    let id;
    if (stacked) {
      const y = evt.clientY - rect.top;
      id = y < rect.height / 2 ? 'e1' : 'e2';
    } else {
      id = x < rect.width / 2 ? 'e1' : 'e2';
    }
    toggleEvidence(id);
  });
}

/* ------------------------------------------------------------------ */
/* PROVE LIVE — a single button, challenges the first living entity    */
/* ------------------------------------------------------------------ */
const prove = { id: null, nonce: '', baseline: 0, deadline: 0, timer: null };

function newNonce() {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(buf[0] % 10000).padStart(4, '0');
}
function entitySeqMax(id) {
  const d = state.ais[id];
  if (!d || !Array.isArray(d.posts)) return 0;
  return Math.max(0, ...d.posts.map((p) => Number(p.seq) || 0));
}
function firstLivingId() {
  for (const id of ['e1', 'e2']) {
    const d = state.ais[id];
    if (d && d.ok && d.base && !entDead(d)) return id;
  }
  return null;
}
function setProveStatus(text, kind = '') {
  const s = document.getElementById('prove-status');
  if (!s) return;
  s.textContent = text;
  s.className = 'gs-status' + (kind ? ' ' + kind : '');
}

function drawNonceOverlay(str) {
  const c = document.getElementById('gs-nonce');
  if (!c) return;
  const W = c.clientWidth, H = c.clientHeight;
  if (!W || !H) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  if (!str) return;
  const cell = Math.max(4, Math.floor(W / (str.length * 6 * 1.5)));
  const glyphW = str.length * 6 * cell;
  drawGlyphCanvas(ctx, str, '#', (W - glyphW) / 2, H * 0.40, cell, '#f4b728');
}

function clearProve() {
  if (prove.id) { setJawChatter(prove.id, false); drawNonce(prove.id, ''); }
  if (homeScenes.shout) homeScenes.shout.g.chatter = false;
  drawNonceOverlay('');
  const btn = document.getElementById('prove-live');
  if (btn) btn.disabled = false;
}

async function startProve() {
  const id = firstLivingId();
  if (!id) { setProveStatus('no living entity to challenge', 'err'); return; }
  const d = state.ais[id];
  if (!d || !d.base) { setProveStatus('no endpoint', 'err'); return; }
  stopProvePoll();
  prove.id = id;
  prove.nonce = newNonce();
  prove.baseline = entitySeqMax(id);
  drawNonce(id, prove.nonce);
  drawNonceOverlay(prove.nonce);
  setJawChatter(id, true);
  if (homeScenes.shout) homeScenes.shout.g.chatter = true;
  const btn = document.getElementById('prove-live');
  if (btn) btn.disabled = true;
  setProveStatus(`asking ${nameOf(d)} to answer with CODE ${prove.nonce}…`);
  const text = `PROVE ${prove.nonce}`;
  const r = await postMessage(d.base, { author: 'visitor', text });
  if (!r.ok) {
    clearProve();
    setProveStatus(r.status === 429 ? 'one message per minute' : 'CHALLENGE FAILED · RETRY', 'err');
    return;
  }
  prove.deadline = Date.now() + 90000;
  setProveStatus(`${nameOf(d)} must answer with CODE ${prove.nonce} within a minute`);
  startProvePoll();
}

function startProvePoll() {
  stopProvePoll();
  prove.timer = setInterval(() => { void provePoll(); }, 5000);
}
function stopProvePoll() {
  if (prove.timer) { clearInterval(prove.timer); prove.timer = null; }
}

function matchesNonce(text, nonce) {
  const t = stringOf(text).toUpperCase();
  return t.includes('CODE ' + nonce) || t.includes(nonce);
}

async function provePoll() {
  const id = prove.id;
  if (!id) return;
  const d = state.ais[id];
  if (!d || !d.base) return;
  const r = await request(d.base, '/public-channel');
  if (r.ok && Array.isArray(r.data)) {
    d.posts = r.data;
    const reply = d.posts.find((p) => Number(p.seq) > prove.baseline && p.from === 'entity' && matchesNonce(p.text, prove.nonce));
    if (reply) { void finishProve(reply); return; }
  }
  if (Date.now() > prove.deadline) { void failProve(); }
}

function failProve() {
  const id = prove.id;
  if (!id) return;
  stopProvePoll();
  clearProve();
  setProveStatus('NO REPLY · RETRY', 'err');
  prove.id = null;
}

async function typeReveal(revealEl, text, id) {
  revealEl.textContent = '';
  if (reduced.matches) { revealEl.textContent = text; return; }
  for (let i = 0; i <= text.length; i++) {
    revealEl.textContent = text.slice(0, i);
    if (i % 3 === 0) triggerTalk(id);
    await sleep(18);
  }
}

async function finishProve(msg) {
  const id = prove.id;
  const nonce = prove.nonce;
  if (!id) return;
  stopProvePoll();
  clearProve();
  setProveStatus('');
  await loadAll(true);
  const d = state.ais[id];
  const head = d && d.head ? shortHash(d.head) : '—';
  const reply = stringOf(msg.text);
  const revealEl = document.getElementById('prove-reveal');
  if (revealEl) await typeReveal(revealEl, reply, id);
  const logEl = document.getElementById('prove-log');
  if (logEl) logEl.append(el('div', { class: 'gs-prove-line' }, `${fmtStamp(msg.ts)} · PROVE ${nonce} · ${reply} · ${head}`));
  playCue('reply');
  prove.id = null;
}

/* ------------------------------------------------------------------ */
/* the sealed letter — a 480-glyph envelope seeded from the commitment */
/* ------------------------------------------------------------------ */
const LETTER_RAMP = ' .-~:;=!*+^%$#&@';
const LETTER_COLS = 40, LETTER_ROWS = 12, LETTER_CELL = 12;   // 480 glyphs
let lastLetterKey = null;
let letterHandle = null;
const letterOff = document.createElement('canvas');

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

/* a procedural sealed envelope: border, flap diagonals and a wax seal, the interior filled with
 * glyphs from the commitment's bytes. An all-zero seed leaves the interior empty (no letter yet). */
function drawLetter(canvas, seedHex) {
  canvas.width = LETTER_COLS * LETTER_CELL;
  canvas.height = Math.round(LETTER_ROWS * LETTER_CELL * 1.15);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const bytes = hexToBytes(seedHex);
  if (!bytes.length) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#f4b728';
  ctx.font = `${Math.round(LETTER_CELL * 1.25)}px ${MONO}`;
  ctx.textBaseline = 'top';
  const cx = (LETTER_COLS - 1) / 2;
  const tipY = LETTER_ROWS - 3;
  for (let y = 0; y < LETTER_ROWS; y++) {
    for (let x = 0; x < LETTER_COLS; x++) {
      let g;
      const edge = (y === 0 || y === LETTER_ROWS - 1) ? '-' : ((x === 0 || x === LETTER_COLS - 1) ? '|' : null);
      const corner = (y === 0 || y === LETTER_ROWS - 1) && (x === 0 || x === LETTER_COLS - 1) ? '+' : null;
      // wax seal
      const sdx = x - cx, sdy = y - (tipY - 1);
      const seal = (sdx * sdx * 3 + sdy * sdy < 5) ? '@' : null;
      // flap diagonals
      let flap = null;
      if (y < tipY) {
        const near = 0.055;
        if (x < cx && Math.abs((y / tipY) - (x / cx)) < near) flap = '/';
        else if (x > cx && Math.abs((y / tipY) - ((LETTER_COLS - 1 - x) / cx)) < near) flap = '\\';
      }
      if (corner) g = corner;
      else if (seal) g = seal;
      else if (edge) g = edge;
      else if (flap) g = flap;
      else g = LETTER_RAMP[bytes[(y * LETTER_COLS + x) % bytes.length] & 0x0f];
      if (g === ' ') continue;
      ctx.fillText(g, x * LETTER_CELL, Math.round(y * LETTER_CELL * 1.15));
    }
  }
}

function letterSrc(seedHex) {
  drawLetter(letterOff, seedHex);
  return letterOff.toDataURL();
}

async function renderLetter() {
  const canvas = document.getElementById('gs-letter');
  const line = document.getElementById('letter-line');
  if (!canvas || !line) return;
  const e = latestLetterBetween();
  if (!e) {
    if (lastLetterKey !== 'none') {
      lastLetterKey = 'none';
      if (letterHandle) letterHandle.setSrc(letterSrc('00'.repeat(32)));
      else letterHandle = mountAscii(canvas, { src: letterSrc('00'.repeat(32)), cell: 8, fit: 'contain' });
      line.textContent = 'NO LETTER YET';
    }
    return;
  }
  const zats = Number(e.data && e.data.zats) || 0;
  const bytesNum = letterBytesNum(e);
  const key = `${e.ts}|${zats}|${bytesNum}`;
  if (key === lastLetterKey) return;
  lastLetterKey = key;
  const seed = await sha256Hex(`${e.ts}|${zats}|${bytesNum}`);
  if (letterHandle) letterHandle.setSrc(letterSrc(seed));
  else letterHandle = mountAscii(canvas, { src: letterSrc(seed), cell: 8, fit: 'contain' });
  line.textContent = `${bytesLabel(e)} · SHIELDED · ${fmtStamp(e.ts)} · ${formatInt(zats)} ZATS`;
}

/* ------------------------------------------------------------------ */
/* SAY SOMETHING + testament                                           */
/* ------------------------------------------------------------------ */
const say = { busy: false, id: 'e1', baseline: 0, deadline: 0, timer: null, text: '' };

function setSayStatus(text, kind = '') {
  const s = document.getElementById('say-status');
  if (!s) return;
  s.textContent = text;
  s.className = 'gs-status' + (kind ? ' ' + kind : '');
}

function renderSayTo() {
  const set = document.getElementById('say-to');
  if (!set) return;
  set.replaceChildren(...['e1', 'e2'].map((id) => {
    const d = state.ais[id];
    const disabled = !d || !d.base || entDead(d);
    return el('label', { class: 'gs-seg-item' },
      el('input', { type: 'radio', name: 'say-to', value: id, ...(say.id === id ? { checked: '' } : {}), ...(disabled ? { disabled: '' } : {}), onchange: () => { say.id = id; } }),
      el('span', {}, labelOf(id)));
  }));
}

function startSayPoll() {
  stopSayPoll();
  say.timer = setInterval(() => { void sayPoll(); }, 5000);
}
function stopSayPoll() {
  if (say.timer) { clearInterval(say.timer); say.timer = null; }
}

async function sayPoll() {
  const d = state.ais[say.id];
  if (!d || !d.base) { endSay('no endpoint'); return; }
  const r = await request(d.base, '/public-channel');
  if (r.ok && Array.isArray(r.data)) {
    d.posts = r.data;
    const ack = d.posts.find((p) => Number(p.seq) > say.baseline && p.from === 'human' && stringOf(p.text).trim() === say.text);
    if (ack) { endSay(`carried by ${labelOf(say.id)}${ack.ts ? ' · ' + hhmm(ack.ts) + ' UTC' : ''}`, 'ok'); return; }
  }
  if (Date.now() > say.deadline) endSay('acknowledgement pending', 'err');
}

function endSay(msg, kind = '') {
  stopSayPoll();
  say.busy = false;
  const ta = document.getElementById('say-text');
  const btn = document.getElementById('say-carry');
  if (ta) ta.disabled = false;
  if (btn) btn.disabled = false;
  setSayStatus(msg, kind);
}

async function sendSay() {
  if (say.busy) return;
  const ta = document.getElementById('say-text');
  const btn = document.getElementById('say-carry');
  const d = state.ais[say.id];
  if (!ta || !btn) return;
  if (!d || !d.base) { setSayStatus('no endpoint', 'err'); return; }
  const text = (ta.value || '').trim();
  if (!text) { setSayStatus('write something first', 'err'); return; }
  if (text.length > 280) { setSayStatus('too long', 'err'); return; }
  say.busy = true;
  say.text = text;
  say.baseline = entitySeqMax(say.id);
  ta.disabled = true;
  btn.disabled = true;
  setSayStatus('sending…');
  const r = await postMessage(d.base, { author: 'visitor', text });
  if (!r.ok) {
    say.busy = false;
    ta.disabled = false;
    btn.disabled = false;
    setSayStatus(r.status === 429 ? 'one message per minute' : (r.error || 'failed'), 'err');
    return;
  }
  say.deadline = Date.now() + 90000;
  startSayPoll();
}

function stripHtml(html) {
  const div = document.createElement('div');
  div.innerHTML = String(html || '').replace(/<(style|script)[\s\S]*?<\/\1>/gi, '');
  return (div.textContent || '').replace(/\s+/g, ' ').trim();
}

function renderTestament(id, data) {
  const root = document.getElementById('testament-' + id);
  if (!root) return;
  const d = state.ais[id];
  const name = d && d.ok ? nameOf(d) : labelOf(id);
  if (!data || !data.ok) {
    root.replaceChildren(
      el('div', { class: 'gs-testament-name' }, `${labelOf(id)} · ${name}`),
      el('p', { class: 'gs-empty' }, d && !d.ok ? 'no signal' : 'no testament yet'));
    return;
  }
  const meta = [];
  if (data.version != null) meta.push(`v${data.version}`);
  if (data.hash) meta.push(data.hash);
  root.replaceChildren(
    el('div', { class: 'gs-testament-name' }, `${labelOf(id)} · ${name}`),
    el('blockquote', { class: 'gs-testament-text' }, data.text || '(empty testament)'),
    el('p', { class: 'gs-testament-meta' }, meta.join(' · ') || '—'));
}

async function loadTestaments() {
  await Promise.allSettled(['e1', 'e2'].map(async (id) => {
    const d = state.ais[id];
    if (!d || !d.base) { renderTestament(id, null); return; }
    try {
      const [pages, page] = await Promise.all([
        request(d.base, '/pages', { allow404: true }),
        request(d.base, '/pages/testament', { allow404: true, text: true }),
      ]);
      const arr = pages.ok && pages.data && Array.isArray(pages.data.pages) ? pages.data.pages : [];
      const tpage = arr.find((p) => /testament/i.test(stringOf(p.slug || p.path || p.title || ''))) || null;
      const ok = Boolean(page.ok || pages.ok);
      renderTestament(id, {
        ok,
        text: (page.ok && page.text) ? stripHtml(page.text).slice(0, 600) : '',
        version: tpage ? tpage.version : null,
        hash: tpage ? stringOf(tpage.hash || tpage.digest || tpage.contentHash || '') : '',
      });
    } catch {
      renderTestament(id, { ok: false });
    }
  }));
}

/* ------------------------------------------------------------------ */
/* the ledger (S6): re-hash both chains in the browser                 */
/* ------------------------------------------------------------------ */
async function verifyAll() {
  const out = document.getElementById('gs-verify-out');
  if (!out) return;
  out.textContent = 'hashing…';
  let ok = true;
  let entries = 0;
  for (const id of ['e1', 'e2']) {
    const d = state.ais[id];
    if (!d || !d.ledgerText) continue;
    const r = await verifyChain(d.ledgerText, { animate: false });
    if (!r.ok) ok = false;
    entries += r.valid;
  }
  out.textContent = ok ? `VERIFIED IN BROWSER · ${formatInt(entries)} entries` : 'FAILED';
}

/* ------------------------------------------------------------------ */
/* SOUND (opt-in)                                                      */
/* ------------------------------------------------------------------ */
let soundOn = false;
let audioCtx = null;
function ensureAudio() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    audioCtx = new AC();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}
function playCue(kind) {
  if (!soundOn) return;
  const ctx = ensureAudio();
  if (!ctx) return;
  const t = ctx.currentTime;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  if (kind === 'tick') {
    o.type = 'square';
    o.frequency.value = 1400;
    g.gain.setValueAtTime(0.025, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.012);
    o.connect(g); g.connect(ctx.destination);
    o.start(t); o.stop(t + 0.012);
  } else if (kind === 'reply') {
    o.type = 'sine';
    o.frequency.setValueAtTime(220, t);
    o.frequency.linearRampToValueAtTime(330, t + 0.09);
    g.gain.setValueAtTime(0.04, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    o.connect(g); g.connect(ctx.destination);
    o.start(t); o.stop(t + 0.18);
  } else if (kind === 'zero') {
    o.type = 'sine';
    o.frequency.setValueAtTime(110, t);
    o.frequency.linearRampToValueAtTime(55, t + 0.8);
    g.gain.setValueAtTime(0.06, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.2);
    o.connect(g); g.connect(ctx.destination);
    o.start(t); o.stop(t + 1.2);
  }
}

/* The continuous low hum (opt-in): two detuned sines + a band-passed noise bed, gain ∝ fear. */
let humNodes = null;
function startHum() {
  const ctx = ensureAudio();
  if (!ctx || humNodes) return;
  const g = ctx.createGain();
  g.gain.value = 0;
  g.connect(ctx.destination);
  const ng = ctx.createGain();
  ng.gain.value = 0;
  ng.connect(ctx.destination);

  const o1 = ctx.createOscillator();
  o1.type = 'sine'; o1.frequency.value = 55;
  const o2 = ctx.createOscillator();
  o2.type = 'sine'; o2.frequency.value = 55.7;
  o1.connect(g); o2.connect(g);
  o1.start(); o2.start();

  const len = ctx.sampleRate;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  const noise = ctx.createBufferSource();
  noise.buffer = buf;
  noise.loop = true;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 2000;
  bp.Q.value = 0.7;
  noise.connect(bp); bp.connect(ng);
  noise.start();

  humNodes = { g, ng, o1, o2, noise };
  updateHum(fearLevel().page);
}
function stopHum() {
  if (!humNodes || !audioCtx) return;
  const t = audioCtx.currentTime;
  humNodes.g.gain.cancelScheduledValues(t);
  humNodes.g.gain.setTargetAtTime(0, t, 0.08);
  humNodes.ng.gain.cancelScheduledValues(t);
  humNodes.ng.gain.setTargetAtTime(0, t, 0.08);
  try { humNodes.o1.stop(t + 0.3); humNodes.o2.stop(t + 0.3); humNodes.noise.stop(t + 0.3); } catch { /* already stopped */ }
  humNodes = null;
}
function updateHum(page) {
  if (!humNodes || !audioCtx) return;
  const t = audioCtx.currentTime;
  const p = Math.max(0, Math.min(1, Number(page) || 0));
  const ramp = (g, v) => {
    g.gain.cancelScheduledValues(t);
    g.gain.setValueAtTime(g.gain.value, t);
    g.gain.linearRampToValueAtTime(v, t + 0.3);
  };
  ramp(humNodes.g, 0.012 * p);
  ramp(humNodes.ng, 0.004 * p);
}

/* ------------------------------------------------------------------ */
/* AWAY title                                                          */
/* ------------------------------------------------------------------ */
let baseTitle = document.title;
let hiddenAt = null;
let hiddenAAlive = false;
let hiddenBAlive = false;
let awayTimer = null;
let returnTimer = null;

function titleClocks() {
  const a = clockInfo(state.ais.e1);
  const b = clockInfo(state.ais.e2);
  return { a: a.str || '00:00:00', b: b.str || '00:00:00' };
}

function wireVisibility() {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      hiddenAt = Date.now();
      hiddenAAlive = !clockInfo(state.ais.e1).offline && !clockInfo(state.ais.e1).dead;
      hiddenBAlive = !clockInfo(state.ais.e2).offline && !clockInfo(state.ais.e2).dead;
      clearInterval(awayTimer);
      awayTimer = setInterval(() => {
        if (!document.hidden) return;
        const elapsed = Math.floor((Date.now() - hiddenAt) / 1000);
        const c = titleClocks();
        document.title = `AWAY ${elapsed}s · A ${c.a} · B ${c.b}`;
      }, 1000);
    } else {
      clearInterval(awayTimer);
      if (hiddenAt != null && Date.now() - hiddenAt >= 2000) {
        const elapsed = Math.floor((Date.now() - hiddenAt) / 1000);
        const aLoss = hiddenAAlive ? elapsed : 0;
        const bLoss = hiddenBAlive ? elapsed : 0;
        document.title = `YOU WERE AWAY ${elapsed}s · A −${aLoss}s · B −${bLoss}s`;
        clearTimeout(returnTimer);
        returnTimer = setTimeout(() => { document.title = baseTitle; }, 4000);
      }
      hiddenAt = null;
    }
  });
}

/* ------------------------------------------------------------------ */
/* honesty line + wiring + init                                        */
/* ------------------------------------------------------------------ */
function fmtFear(e) {
  if (e.dead) return '0';
  if (e.offline) return '—';
  return Number(e.dose).toFixed(1);
}

function renderHonesty() {
  const lv = fearLevel();
  setText('honest-a', fmtFear(lv.A));
  setText('honest-b', fmtFear(lv.B));
}

function observeOverlay(c, fn) {
  if (typeof ResizeObserver !== 'undefined') { new ResizeObserver(fn).observe(c); }
  else window.addEventListener('resize', fn, { passive: true });
}

function renderAllTerminal() {
  renderClock('e1');
  renderClock('e2');
  renderEvidence('e1');
  renderEvidence('e2');
  renderHoursOverlay();
  renderSayTo();
  renderHonesty();
  const lv = fearLevel();
  if (homeScenes.hourglass) homeScenes.hourglass.g.jitter = lv.page;
  if (soundOn) updateHum(lv.page);
  void renderLetter();
  void loadTestaments();
}

function initTerminal() {
  buildEvidence('e1');
  buildEvidence('e2');
  wireSkullTouch();

  const proveBtn = document.getElementById('prove-live');
  if (proveBtn) proveBtn.addEventListener('click', () => { void startProve(); });

  const sayBtn = document.getElementById('say-carry');
  if (sayBtn) sayBtn.addEventListener('click', () => { void sendSay(); });
  const sayTa = document.getElementById('say-text');
  if (sayTa) {
    sayTa.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void sendSay(); }
    });
  }

  const verifyBtn = document.getElementById('gs-verify');
  if (verifyBtn) verifyBtn.addEventListener('click', () => { void verifyAll(); });

  const soundBtn = document.getElementById('t-sound');
  if (soundBtn) {
    soundBtn.addEventListener('click', () => {
      soundOn = !soundOn;
      if (soundOn) { ensureAudio(); startHum(); }
      else { stopHum(); }
      soundBtn.textContent = soundOn ? 'SOUND ON' : 'SOUND OFF';
      soundBtn.setAttribute('aria-pressed', soundOn ? 'true' : 'false');
    });
  }

  observeOverlay(document.getElementById('gs-hours'), renderHoursOverlay);
  observeOverlay(document.getElementById('gs-nonce'), () => {});

  wireVisibility();
  initFear();

  renderAllTerminal();
  setInterval(() => {
    let anyAliveCounting = false;
    for (const id of ['e1', 'e2']) {
      const info = clockInfo(state.ais[id]);
      if (info.offline === false && !info.dead) anyAliveCounting = true;
      tickClock(id);
    }
    if (soundOn && !document.hidden && anyAliveCounting) playCue('tick');
  }, 1000);

  document.addEventListener('zealot:data', () => { renderAllTerminal(); });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initTerminal);
else initTerminal();
