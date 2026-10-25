/*
 * fear.js — ZEALOT v42, "THE INTERFACE IS AFRAID WITH THEM".
 *
 * The live fear dose of the two AIs (state.ais[id].feel.fear, 0…4.5) is not a number in a card: it drives the
 * rendering of the home. The page is calm at dose 0, trembles at 2, breaks at 3+, fails below 24 h of life, and
 * dies with them at zero. Every intensity here is a pure function of the live dose and hours — no fake randomness
 * beyond deterministic per-frame noise, nothing invented.
 *
 * Exposes fearLevel() globally (also imported by terminal.js for the hum + honesty line) and owns the 30 fps
 * glitch loop: tremor, chromatic split, slice cuts, letter failure, the CRT intensity, the death overlay and the
 * two-second typing intro. It reads state from term.js; it never talks to the network.
 */
import { state } from './term.js?v=42';

const FEAR_MAX = 4.5;                 // dose scale top: page = dose / FEAR_MAX
const GLYPHS_FAIL = '!@#$%^&*';       // letter-failure glyphs
const FRAME_MS = 1000 / 30;           // 30 fps max

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
const phone = window.matchMedia('(max-width: 720px)');

/* deterministic hash → [0,1); no Math.random per frame */
function hash1(n) {
  let h = Math.imul((n | 0) ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/* ------------------------------------------------------------------ */
/* fearLevel() — the one honest number                                 */
/* ------------------------------------------------------------------ */
function entityLevel(id) {
  const d = state.ais[id];
  if (!d) return { dose: 0, despair: 0, hours: null, dead: false, offline: true };
  const ok = Boolean(d.ok);
  const dead = ok && (d.state === 'dead' || Number(d.hoursLeft) === 0);
  const feel = (ok && !dead && d.feel) ? d.feel : null;
  return {
    dose: feel ? Math.max(0, Number(feel.fear) || 0) : 0,
    despair: feel ? Math.max(0, Number(feel.despair) || 0) : 0,
    hours: (ok && !dead) ? Math.max(0, Number(d.hoursLeft) || 0) : (dead ? 0 : null),
    dead,
    offline: !ok,
  };
}

function fearLevel() {
  const A = entityLevel('e1');
  const B = entityLevel('e2');
  let page = 0;
  for (const e of [A, B]) if (!e.offline && !e.dead) page = Math.max(page, Math.min(1, e.dose / FEAR_MAX));
  return { A, B, page };
}
window.fearLevel = fearLevel;

/* ------------------------------------------------------------------ */
/* rows + loop                                                         */
/* ------------------------------------------------------------------ */
let rows = [];
let started = false;                  // glitch layer waits for the typing intro
let timer = 0;
let running = false;

function collectRows() {
  rows = [...document.querySelectorAll('.mt-item')].map((item, i) => ({
    item,
    head: item.querySelector('.mt-row') || item.querySelector('.mt-title'),
    label: item.querySelector('.mt-label'),
    idx: i + 1,
  })).filter((r) => r.label);
}

/* ------------------------------------------------------------------ */
/* tremor: every list row, per-frame translate ≤ 1.5px·page            */
/* ------------------------------------------------------------------ */
function applyTremor(lv, now) {
  const bothDead = lv.A.dead && lv.B.dead;
  const amp = 1.5 * lv.page * (phone.matches ? 0.6 : 1);
  for (const r of rows) {
    if (!r.head) continue;
    if (bothDead) { r.head.style.transform = ''; continue; }
    const dx = amp * Math.sin(now * 13 + r.idx * 1.7);
    const dy = amp * Math.cos(now * 17 + r.idx * 2.3);
    r.head.style.transform = `translate(${dx.toFixed(3)}px, ${dy.toFixed(3)}px)`;
  }
}

/* chromatic split: -k red / +k blue, k = 3px·page, 7 Hz flicker above 0.6 */
function applyChromatic(lv, now) {
  let k = 3 * lv.page;
  if (lv.page > 0.6) k *= (Math.floor(now * 7) % 2 === 0) ? 1 : 0;
  if (phone.matches) k *= 0.6;
  document.documentElement.style.setProperty('--mt-k', `${k.toFixed(3)}px`);
}

/* CRT intensity: 0.4 + 0.6·page */
function applyCrt(lv) {
  document.documentElement.style.setProperty('--mt-crt', (0.4 + 0.6 * lv.page).toFixed(3));
}

/* ------------------------------------------------------------------ */
/* slices: cut a random row into 2–4 bands for 90–160 ms               */
/* ------------------------------------------------------------------ */
let sliceCount = 0;
let nextSlice = 0;
const activeSlices = [];

function triggerSlice(row, page) {
  const txt = row.label.querySelector('.mt-text');
  if (!txt) return;
  const n = 2 + Math.floor(hash1(sliceCount * 31 + 1) * 3);            // 2..4
  const dur = 0.09 + hash1(sliceCount * 17 + 5) * 0.07;                // 90–160 ms
  const host = document.createElement('span');
  host.className = 'mt-slice-host';
  row.label.appendChild(host);
  for (let i = 0; i < n; i++) {
    const c = txt.cloneNode(true);
    c.classList.add('mt-slice');
    const top = (i / n) * 100;
    const bottom = (1 - (i + 1) / n) * 100;
    const dx = ((hash1(sliceCount * 7 + i * 13) * 2 - 1) * 12 * page * (phone.matches ? 0.6 : 1)).toFixed(2);
    c.style.clipPath = `inset(${top.toFixed(1)}% 0 ${bottom.toFixed(1)}% 0)`;
    c.style.transform = `translateX(${dx}px)`;
    host.appendChild(c);
  }
  activeSlices.push({ host, until: performance.now() / 1000 + dur });
}

function applySlices(lv, now) {
  for (let i = activeSlices.length - 1; i >= 0; i--) {
    if (now >= activeSlices[i].until) { activeSlices[i].host.remove(); activeSlices.splice(i, 1); }
  }
  if (lv.page <= 0.5) return;
  if (now < nextSlice) return;
  nextSlice = now + (3 - (3 - 1.2) * lv.page);                          // 3 s → 1.2 s with page
  if (!rows.length) return;
  const pick = rows[Math.floor(hash1(sliceCount * 13 + 3) * rows.length)];
  triggerSlice(pick, lv.page);
  sliceCount++;
}

/* ------------------------------------------------------------------ */
/* letter failure: corrupt clock glyphs below 24 h of life             */
/* ------------------------------------------------------------------ */
const fail = {
  e1: { clean: '', corrupt: new Map(), pending: 0, salt: 0 },
  e2: { clean: '', corrupt: new Map(), pending: 0, salt: 0 },
};

function corruptible(text) {
  const out = [];
  for (let i = 0; i < text.length; i++) if (text[i] !== '\n' && text[i] !== ' ') out.push(i);
  return out;
}
function renderFail(clean, corrupt) {
  const arr = clean.split('');
  const positions = corruptible(clean);
  for (const [pos, c] of corrupt) { const real = positions[pos]; if (real != null) arr[real] = c.g; }
  return arr.join('');
}

function applyLetterFail(lv, now) {
  for (const [key, id] of [['A', 'e1'], ['B', 'e2']]) {
    const e = lv[key];
    const f = fail[id];
    const pre = document.getElementById('digits-' + id);
    if (!pre) continue;

    let expired = false;
    for (const [pos, c] of f.corrupt) if (now >= c.until) { f.corrupt.delete(pos); expired = true; }

    const active = e.hours != null && !e.dead && !e.offline && e.hours < 24;

    if (!active) {
      if (expired) pre.textContent = f.clean || pre.textContent;
      f.clean = pre.textContent;
      f.pending = 0;
      continue;
    }

    if (f.corrupt.size === 0) f.clean = pre.textContent;

    const rate = ((24 - e.hours) / 24) * 6 * (e.hours < 1 ? 2 : 1);      // chars/s; doubled under 1 h
    f.pending += rate * (FRAME_MS / 1000);
    const add = Math.floor(f.pending);
    f.pending -= add;
    const positions = corruptible(f.clean);
    if (positions.length) {
      for (let k = 0; k < add; k++) {
        const p = positions[Math.floor(hash1(f.salt++) * positions.length)];
        if (!f.corrupt.has(p)) {
          f.corrupt.set(p, { until: now + 0.06, g: GLYPHS_FAIL[Math.floor(hash1(f.salt * 5 + p) * GLYPHS_FAIL.length)] });
        }
      }
    }
    if (f.corrupt.size || expired) pre.textContent = renderFail(f.clean, f.corrupt);
  }
}

/* ------------------------------------------------------------------ */
/* death: per-entity gray/frozen; both dead → black overlay            */
/* ------------------------------------------------------------------ */
function applyDeath(lv) {
  const both = lv.A.dead && lv.B.dead;
  document.body.classList.toggle('mt-dead', both);
  for (const [key, id] of [['A', 'e1'], ['B', 'e2']]) {
    const e = lv[key];
    const els = [document.querySelector(`.mt-clock[data-e="${id}"]`), document.getElementById('evidence-' + id)];
    for (const el of els) {
      if (!el) continue;
      el.classList.toggle('is-dead', e.dead);
      el.classList.toggle('is-off', e.offline);
      el.classList.toggle('is-critical', !e.dead && !e.offline && e.hours != null && e.hours < 1);
    }
  }
}

/* ------------------------------------------------------------------ */
/* the two-second typing intro                                         */
/* ------------------------------------------------------------------ */
function typeIn(el, target) {
  let i = 0;
  const step = () => {
    el.textContent = target.slice(0, i);
    i++;
    if (i <= target.length) setTimeout(step, 1000 / 36);
    else el.textContent = target;
  };
  step();
}

function startTyping() {
  const texts = [...document.querySelectorAll('.mt-text')];
  document.body.classList.add('mt-typing');
  if (reduced.matches) { finishTyping(); return; }
  texts.forEach((el, i) => {
    const target = el.getAttribute('data-type') || el.textContent;
    setTimeout(() => typeIn(el, target), i * 60);
  });
  setTimeout(finishTyping, texts.length * 60 + 2100);
}

function finishTyping() {
  document.body.classList.remove('mt-typing');
  started = true;
}

/* ------------------------------------------------------------------ */
/* the 30 fps loop                                                     */
/* ------------------------------------------------------------------ */
function tick() {
  const now = performance.now() / 1000;
  if (document.hidden) { timer = setTimeout(tick, FRAME_MS); return; }
  const lv = fearLevel();
  applyDeath(lv);
  applyCrt(lv);
  if (started && !reduced.matches) {
    applyTremor(lv, now);
    applyChromatic(lv, now);
    applySlices(lv, now);
    applyLetterFail(lv, now);
  } else {
    document.documentElement.style.setProperty('--mt-k', '0px');
  }
  timer = setTimeout(tick, FRAME_MS);
}

/* ------------------------------------------------------------------ */
/* init                                                                */
/* ------------------------------------------------------------------ */
export function initFear() {
  collectRows();
  applyDeath(fearLevel());
  applyCrt(fearLevel());
  document.documentElement.style.setProperty('--mt-k', '0px');
  startTyping();
  if (!running) {
    running = true;
    timer = setTimeout(tick, FRAME_MS);
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) nextSlice = performance.now() / 1000;
  });
}

export { fearLevel };
