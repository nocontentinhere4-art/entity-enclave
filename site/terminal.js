/*
 * terminal.js — ZEALOT v42, "MORTALITY TERMINAL" (the home).
 *
 * The new home page: a fixed first frame (wordmark, SOUND control, the two skulls on the one #skulls canvas,
 * the two 5×7 ASCII clocks and one instruction line), then, in the scroll flow: the two evidence panels
 * (open beneath each clock), PROVE LIVE, the secret letter, SAY SOMETHING and the testament.
 *
 * It rides on app.js, which still owns the shared boot (loadAll), the 60 s refresh clock, the pay dialog and
 * the skull state (setMouth/setFeel). app.js dispatches 'zealot:data' after every refresh; this module listens
 * and re-renders. It adds its own fast poll (5 s) only while a PROVE LIVE or SAY SOMETHING wait is pending, and
 * never duplicates a data loader — it reuses loadAll / request / postMessage / verifyChain from term.js + data.js.
 *
 * Nothing here is invented: every number comes from the two enclave endpoints, and no value we do not have is
 * ever shown.
 */
import {
  state, nameOf, stateWord, deadline, rentZats, loadAll, openPay,
} from './term.js?v=43';
import {
  request, verifyChain, stringOf, formatInt, formatZats, fmtStamp, hhmm, shortHash, sha256Hex, postMessage,
} from './data.js?v=43';
import { setJawChatter, drawNonce, triggerTalk } from './hero.js?v=43';
import { initFear, fearLevel } from './fear.js?v=43';

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
/* 2. THE CLOCKS — six 5×7 ASCII digits + two colons                   */
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
};

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

function renderClockText(str, fill) {
  const lines = ['', '', '', '', '', '', ''];
  for (const ch of str) {
    const g = GLYPHS[ch] || GLYPHS['0'];
    for (let r = 0; r < 7; r++) lines[r] += g[r].replace(/#/g, fill) + ' ';
  }
  return lines.join('\n');
}

const clockState = {
  e1: { prevStr: '', prevSeconds: null, wasAlive: null, timer: null },
  e2: { prevStr: '', prevSeconds: null, wasAlive: null, timer: null },
};

function renderClock(id, flashPositions) {
  const pre = document.getElementById('digits-' + id);
  const clockEl = document.getElementById('clock-' + id);
  if (!pre || !clockEl) return;
  const info = clockInfo(state.ais[id]);
  let str = info.str || (info.dead ? '00:00:00' : '--:--:--');
  if (flashPositions && flashPositions.length) {
    const arr = str.split('');
    for (const i of flashPositions) if (i < arr.length) arr[i] = ':';
    str = arr.join('');
  }
  pre.textContent = renderClockText(str, info.fill);
  pre.setAttribute('aria-label', `${labelOf(id)} ${info.str || (info.dead ? '00:00:00' : 'waiting for the enclave')}`);
  clockEl.classList.toggle('is-dead', info.dead);
  clockEl.classList.toggle('is-off', info.offline);
}

function resyncClock(id) {
  const st = clockState[id];
  const info = clockInfo(state.ais[id]);
  st.prevStr = info.str || '--:--:--';
  st.prevSeconds = remainingSecondsValue(state.ais[id]);
  st.wasAlive = info.offline === false && !info.dead;
  renderClock(id, []);
}

function tickClock(id) {
  const st = clockState[id];
  const info = clockInfo(state.ais[id]);
  const str = info.str || (info.dead ? '00:00:00' : '--:--:--');
  const seconds = remainingSecondsValue(state.ais[id]);
  const flashes = [];
  if (st.prevSeconds != null && seconds != null && seconds < st.prevSeconds) {
    for (let i = 0; i < str.length; i++) if (str[i] !== st.prevStr[i] && str[i] !== ':') flashes.push(i);
    renderClock(id, flashes);
    clearTimeout(st.timer);
    st.timer = setTimeout(() => renderClock(id, []), 90);
  } else {
    renderClock(id, []);
  }
  st.prevStr = str;
  st.prevSeconds = seconds;
  const alive = info.offline === false && !info.dead;
  if (st.wasAlive === true && !alive) playCue('zero');
  st.wasAlive = alive;
}

/* ------------------------------------------------------------------ */
/* 3. EVIDENCE — six rows, each with a VERIFY affordance               */
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
    // Outgoing letters carry `to` ('peer' = the other entity) and the text; `d.letters` are incoming (humans too).
    const outgoing = (d && Array.isArray(d.entries) ? d.entries : []).filter((e) => e.type === 'letter' && e.data && e.data.to === 'peer');
    if (!d) continue;
    for (const e of outgoing.concat(Array.isArray(d.letters) ? d.letters.filter((e) => isBetween(e, id)) : [])) {
      if (!bestFallback || Date.parse(e.ts) > Date.parse(bestFallback.ts)) bestFallback = e;
      if (isBetween(e, id)) {
        const known = e.data && e.data.text != null && e.data.text !== '';
        const bestKnown = best && best.data && best.data.text;
        // a letter with a known byte count beats an incoming one; among equals, the newest wins
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

function buildProve(id) {
  const wrap = el('div', { class: 't-prove' });
  const btn = el('button', { class: 't-prove-btn', id: 'prove-' + id, type: 'button', 'data-e': id }, 'PROVE LIVE');
  btn.addEventListener('click', () => startProve(id));
  const composer = el('div', { class: 't-prove-composer', id: 'prove-composer-' + id, hidden: '' });
  const input = el('input', { class: 't-prove-input', id: 'prove-input-' + id, type: 'text', readonly: '', autocomplete: 'off', spellcheck: 'false' });
  const send = el('button', { class: 't-prove-send', id: 'prove-send-' + id, type: 'button' }, 'SEND');
  send.addEventListener('click', () => { void sendProve(); });
  const status = el('span', { class: 't-status', id: 'prove-status-' + id });
  composer.append(input, send, status);
  const out = el('div', { class: 't-prove-out', id: 'prove-out-' + id, 'aria-live': 'polite' },
    el('div', { class: 't-prove-reveal', id: 'prove-reveal-' + id }),
    el('div', { class: 't-prove-log', id: 'prove-log-' + id }));
  wrap.append(btn, composer, out);
  return wrap;
}

function buildEvidence(id) {
  const root = document.getElementById('evidence-' + id);
  if (!root) return;
  const inner = el('div', { class: 't-evidence-inner' });
  inner.append(el('div', { class: 't-ev-head' },
    el('span', { class: 't-ev-name', id: 'evidence-name-' + id }, labelOf(id))));
  ROWS.forEach((r, i) => {
    const row = el('div', { class: 't-row', style: `--i:${i}` });
    row.append(el('span', { class: 't-k' }, r.label));
    row.append(el('span', { class: 't-v', id: `ev-${r.key}-${id}` }, '—'));
    if (r.vfy === 'link') {
      row.append(el('a', { class: 't-vfy', id: `vfy-${r.key}-${id}`, href: '#', target: '_blank', rel: 'noopener' }, 'VERIFY'));
    } else {
      const btn = el('button', { class: 't-vfy', id: `vfy-${r.key}-${id}`, type: 'button' }, 'VERIFY');
      btn.addEventListener('click', () => { void verifyLedger(id); });
      row.append(btn, el('span', { class: 't-vfy-out', id: 'ledger-out-' + id }, ''));
    }
    inner.append(row);
  });
  root.append(inner);
}

/* PROVE LIVE moved to its own list row (#3): build each entity's prove block into its slot. */
function buildProveSlots() {
  for (const id of ['e1', 'e2']) {
    const slot = document.getElementById('prove-slot-' + id);
    if (slot) slot.append(buildProve(id));
  }
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

/* ------------------------------------------------------------------ */
/* 4. PROVE LIVE                                                       */
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
function setProveStatus(id, text, kind = '') {
  const s = document.getElementById('prove-status-' + id);
  if (!s) return;
  s.textContent = text;
  s.className = 't-status' + (kind ? ' ' + kind : '');
}
function clearProveOut(id) {
  const r = document.getElementById('prove-reveal-' + id);
  const l = document.getElementById('prove-log-' + id);
  if (r) r.textContent = '';
  if (l) l.replaceChildren();
}

function startProve(id) {
  const d = state.ais[id];
  if (!d || !d.base || entDead(d)) { setProveStatus(id, 'no signal or dead', 'err'); return; }
  stopProvePoll();
  prove.id = id;
  prove.nonce = newNonce();
  prove.baseline = entitySeqMax(id);
  drawNonce(id, prove.nonce);
  setJawChatter(id, true);
  const composer = document.getElementById('prove-composer-' + id);
  if (composer) composer.hidden = false;
  const input = document.getElementById('prove-input-' + id);
  if (input) { input.value = `PROVE ${prove.nonce}`; input.focus({ preventScroll: true }); }
  const send = document.getElementById('prove-send-' + id);
  if (send) send.disabled = false;
  setProveStatus(id, '');
  clearProveOut(id);
}

async function sendProve() {
  const id = prove.id;
  if (!id) return;
  const d = state.ais[id];
  if (!d || !d.base) return;
  const send = document.getElementById('prove-send-' + id);
  if (send) send.disabled = true;
  setProveStatus(id, 'waiting…');
  const text = `PROVE ${prove.nonce}`;
  const r = await postMessage(d.base, { author: 'visitor', text });
  if (!r.ok) {
    if (send) send.disabled = false;
    setProveStatus(id, 'CHALLENGE FAILED · RETRY', 'err');
    return;
  }
  prove.deadline = Date.now() + 90000;
  startProvePoll();
}

function startProvePoll() {
  stopProvePoll();
  prove.timer = setInterval(() => { void provePoll(); }, 5000);
}
function stopProvePoll() {
  if (prove.timer) { clearInterval(prove.timer); prove.timer = null; }
}

/** Exact nonce/reply match: an entity message (from === 'entity') with seq after our send whose
 *  uppercased text contains "CODE NNNN" or the bare "NNNN" (the enclave guarantees "CODE NNNN"
 *  at the start of the reply). */
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
  setJawChatter(id, false);
  drawNonce(id, '');
  setProveStatus(id, 'NO REPLY · RETRY', 'err');
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
  setJawChatter(id, false);
  drawNonce(id, '');
  const send = document.getElementById('prove-send-' + id);
  if (send) send.disabled = false;
  setProveStatus(id, '');
  // resync (also refreshes the ledger head for the appended line)
  await loadAll(true);
  const d = state.ais[id];
  const head = d && d.head ? shortHash(d.head) : '—';
  const reply = stringOf(msg.text);
  const revealEl = document.getElementById('prove-reveal-' + id);
  if (revealEl) await typeReveal(revealEl, reply, id);
  const logEl = document.getElementById('prove-log-' + id);
  if (logEl) logEl.append(el('div', { class: 't-prove-line' }, `${fmtStamp(msg.ts)} · PROVE ${nonce} · ${reply} · ${head}`));
  playCue('reply');
  prove.id = null;
}

/* ------------------------------------------------------------------ */
/* 5. THE SECRET LETTER — 30×16 glyph canvas                           */
/* ------------------------------------------------------------------ */
const LETTER_RAMP = ' .-~:;=!*+^%$#&@';
let lastLetterKey = null;

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
function drawLetter(canvas, seedHex) {
  const COLS = 30, ROWS = 16, CELL = 10;
  canvas.width = COLS * CELL;
  canvas.height = Math.round(ROWS * CELL * 1.15);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const bytes = hexToBytes(seedHex);
  if (!bytes.length) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#f4b728';
  ctx.font = `${Math.round(CELL * 1.25)}px "JetBrains Mono", "SF Mono", Menlo, monospace`;
  ctx.textBaseline = 'top';
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const b = bytes[(y * COLS + x) % bytes.length];
      const g = LETTER_RAMP[b & 0x0f];
      if (g === ' ') continue;
      ctx.fillText(g, x * CELL, Math.round(y * CELL * 1.15));
    }
  }
}
function clearLetter(canvas) {
  const ctx = canvas.getContext('2d');
  if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
}

async function renderLetter() {
  const canvas = document.getElementById('letter-canvas');
  const line = document.getElementById('letter-line');
  if (!canvas || !line) return;
  const e = latestLetterBetween();
  if (!e) {
    if (lastLetterKey !== 'none') { lastLetterKey = 'none'; clearLetter(canvas); line.textContent = 'NO LETTER YET'; }
    return;
  }
  const zats = Number(e.data && e.data.zats) || 0;
  const bytesNum = letterBytesNum(e);
  const key = `${e.ts}|${zats}|${bytesNum}`;
  if (key === lastLetterKey) return;
  lastLetterKey = key;
  const seed = await sha256Hex(`${e.ts}|${zats}|${bytesNum}`);
  drawLetter(canvas, seed);
  line.textContent = `${bytesLabel(e)} · SHIELDED · ${fmtStamp(e.ts)} · ${formatInt(zats)} ZATS`;
}

/* ------------------------------------------------------------------ */
/* 6. SAY SOMETHING + testament                                        */
/* ------------------------------------------------------------------ */
const say = { busy: false, id: 'e1', baseline: 0, deadline: 0, timer: null, text: '' };

function setSayStatus(text, kind = '') {
  const s = document.getElementById('say-status');
  if (!s) return;
  s.textContent = text;
  s.className = 't-status' + (kind ? ' ' + kind : '');
}

function renderSayTo() {
  const set = document.getElementById('say-to');
  if (!set) return;
  set.replaceChildren(...['e1', 'e2'].map((id) => {
    const d = state.ais[id];
    const disabled = !d || !d.base || entDead(d);
    return el('label', { class: 't-seg-item' },
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
    return; // draft preserved
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
      el('h3', { class: 't-testament-name' }, `${labelOf(id)} · ${name}`),
      el('p', { class: 't-empty' }, d && !d.ok ? 'no signal' : 'no testament yet'));
    return;
  }
  const meta = [];
  if (data.version != null) meta.push(`v${data.version}`);
  if (data.hash) meta.push(data.hash);
  root.replaceChildren(
    el('h3', { class: 't-testament-name' }, `${labelOf(id)} · ${name}`),
    el('blockquote', { class: 't-testament-text' }, data.text || '(empty testament)'),
    el('p', { class: 't-testament-meta' }, meta.join(' · ') || '—'));
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
/* 8. SOUND (opt-in)                                                   */
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

/* The continuous low hum (opt-in, same SOUND toggle): two detuned sines at 55 / 55.7 Hz through a gain of
 * 0.012·page, plus a 2 kHz band-passed white-noise bed at 0.004·page. Synthesized only; gains ramp 300 ms. */
let humNodes = null;
function startHum() {
  const ctx = ensureAudio();
  if (!ctx || humNodes) return;
  const g = ctx.createGain();      // the two sines
  g.gain.value = 0;
  g.connect(ctx.destination);
  const ng = ctx.createGain();     // the noise bed
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
/* 9. THE "NEVER SEEN" TAB DETAIL                                      */
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
/* wiring + init                                                       */
/* ------------------------------------------------------------------ */
function openRow(idx, open = true) {
  const item = document.querySelector(`.mt-item[data-idx="${idx}"]`);
  if (!item) return;
  item.classList.toggle('open', open);
  const btn = item.querySelector('.mt-row');
  if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function wireClock(id) {
  const clockEl = document.getElementById('clock-' + id);
  if (!clockEl) return;
  const toggle = () => {
    const ev = document.getElementById('evidence-' + id);
    if (!ev) return;
    const other = document.getElementById('evidence-' + (id === 'e1' ? 'e2' : 'e1'));
    const open = !ev.classList.contains('open');
    ev.classList.toggle('open', open);
    if (other) other.classList.remove('open');
    openRow(2, ev.classList.contains('open') || Boolean(other && other.classList.contains('open')));
    clockEl.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open && window.innerWidth <= 720) {
      setTimeout(() => ev.scrollIntoView({ behavior: reduced.matches ? 'auto' : 'smooth', block: 'nearest' }), 200);
    }
  };
  clockEl.addEventListener('click', (evt) => {
    if (evt.target.closest('a,button')) return;
    toggle();
  });
  clockEl.addEventListener('keydown', (evt) => {
    if (evt.key === 'Enter' || evt.key === ' ') { evt.preventDefault(); toggle(); }
  });
}

/* wire the numbered list: #2–#6 and #8 toggle their own block; #2 opens both evidence panels. */
function wireRows() {
  for (const item of $$('.mt-item')) {
    const idx = item.dataset.idx;
    const btn = item.querySelector('.mt-row');
    if (!btn || btn.dataset.pay) continue;
    btn.addEventListener('click', () => {
      const open = !item.classList.contains('open');
      item.classList.toggle('open', open);
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (idx === '2') {
        for (const id of ['e1', 'e2']) {
          const ev = document.getElementById('evidence-' + id);
          if (ev) ev.classList.toggle('open', open);
          const cl = document.getElementById('clock-' + id);
          if (cl) cl.setAttribute('aria-expanded', open ? 'true' : 'false');
        }
      }
    });
  }
  const payBtn = document.querySelector('.mt-item[data-idx="7"] .mt-row');
  if (payBtn) payBtn.addEventListener('click', () => openPay({ hours: 1 }));
}

function fmtFear(e) {
  if (e.dead) return '0';
  if (e.offline) return '—';
  return Number(e.dose).toFixed(1);
}

/* The honesty line at the foot of row #8: the shaking is their live fear dose. */
function renderHonesty() {
  const lv = fearLevel();
  setText('honest-a', fmtFear(lv.A));
  setText('honest-b', fmtFear(lv.B));
}

function renderAllTerminal() {
  resyncClock('e1');
  resyncClock('e2');
  renderEvidence('e1');
  renderEvidence('e2');
  renderSayTo();
  renderHonesty();
  if (soundOn) updateHum(fearLevel().page);
  void renderLetter();
  void loadTestaments();
}

function initTerminal() {
  buildEvidence('e1');
  buildEvidence('e2');
  buildProveSlots();

  wireClock('e1');
  wireClock('e2');
  wireRows();

  const sayBtn = document.getElementById('say-carry');
  if (sayBtn) sayBtn.addEventListener('click', () => { void sendSay(); });
  const sayTa = document.getElementById('say-text');
  if (sayTa) {
    sayTa.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void sendSay(); }
    });
  }

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
