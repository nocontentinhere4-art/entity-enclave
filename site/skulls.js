/* skulls.js — ZEALOT interaction overlay */

const RAMP = ' .-~:;=!*+^%$#&@';
const LABEL = '11px "JetBrains Mono", "SF Mono", Menlo, monospace';
const DIM = 'rgba(244,183,40,.28)';
const YELLOW = '#f4b728';
const HOT = '#ffd76a';

const DIGITS = {
  '0': [0b111, 0b101, 0b101, 0b101, 0b111],
  '1': [0b010, 0b110, 0b010, 0b010, 0b111],
  '2': [0b111, 0b001, 0b111, 0b100, 0b111],
  '3': [0b111, 0b001, 0b111, 0b001, 0b111],
  '4': [0b101, 0b101, 0b111, 0b001, 0b001],
  '5': [0b111, 0b100, 0b111, 0b001, 0b111],
  '6': [0b111, 0b100, 0b111, 0b101, 0b111],
  '7': [0b111, 0b001, 0b001, 0b001, 0b001],
  '8': [0b111, 0b101, 0b111, 0b101, 0b111],
  '9': [0b111, 0b101, 0b111, 0b001, 0b111],
  ':': [0b000, 0b010, 0b000, 0b010, 0b000],
  ' ': [0b000, 0b000, 0b000, 0b000, 0b000],
};

let HERO = null;
let STATE = null;
let ON = null;

let canvas = null, ctx = null;
let W = 0, H = 0, dpr = 1;
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
let running = false, timer = null, lastT = 0, t = 0;
let layout = null;

const pointer = { x: -1e4, y: -1e4, active: false, isTouch: false, down: false, id: null, downPos: { x: 0, y: 0 }, downT: 0, lastMove: 0 };
let activeRegion = null;
let drag = null;
let pendingDoubleTap = null;
let hold = null;

const clockMag = { e1: { cur: 0, target: 0, revert: 0 }, e2: { cur: 0, target: 0, revert: 0 } };
const buy = { id: null, progress: 0, filling: false, cancel: false };
const prove = { id: null, digits: '', listening: false, listenT: 0, resolved: '', timeout: false, particles: [], dockT: 0 };
const composer = { id: null, el: null, active: false, carriedT: -1 };
const letter = { flying: false, reduced: false, t: 0, source: 'e1', target: 'e2', particles: [], meta: null };
const testament = { particles: [] };
let motes = [];
let escaped = [];
let ledgerArmed = false, ledgerT = 0;
let bothDeadTimer = 0, bothDeadFinal = false;
let prevDead = { e1: false, e2: false };
const lean = { e1: { x: 0, y: 0, vx: 0, vy: 0 }, e2: { x: 0, y: 0, vx: 0, vy: 0 } };

let proverEl = null;
let boundEvents = [];

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function lerp(a, b, u) { return a + (b - a) * u; }
function easeOutCubic(t) { const u = 1 - t; return 1 - u * u * u; }
function easeInOutCubic(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; }

export function initSkulls({ hero, state, on }) {
  HERO = hero; STATE = state; ON = on;
  canvas = document.getElementById('overlay');
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.id = 'overlay';
    document.querySelector('main').appendChild(canvas);
  }
  ctx = canvas.getContext('2d');
  syncSize();

  proverEl = document.createElement('input');
  proverEl.className = 'skull-input';
  proverEl.setAttribute('inputmode', 'numeric');
  proverEl.setAttribute('maxlength', '4');
  proverEl.setAttribute('aria-label', 'Prove live code');
  document.body.appendChild(proverEl);
  proverEl.addEventListener('input', onProverInput);

  composer.el = document.createElement('textarea');
  composer.el.className = 'skull-composer';
  composer.el.setAttribute('maxlength', '280');
  composer.el.setAttribute('aria-label', 'Say something');
  composer.el.style.display = 'none';
  document.body.appendChild(composer.el);
  composer.el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitComposer(); }
    if (e.key === 'Escape') hideComposer();
  });

  addEvent(canvas, 'pointerdown', onPointerDown);
  addEvent(canvas, 'pointermove', onPointerMove);
  addEvent(canvas, 'pointerup', onPointerUp);
  addEvent(canvas, 'pointercancel', onPointerUp);
  addEvent(window, 'resize', syncSize);

  for (let i = 0; i < 18; i++) escaped.push({ x: 0, y: 0, vx: 0, vy: 0, home: i < 9 ? 'e1' : 'e2', ch: RAMP[i % RAMP.length] });

  running = true; lastT = performance.now();
  tick();
}

export function destroySkulls() {
  running = false;
  if (timer) clearTimeout(timer);
  for (const [el, ev, fn] of boundEvents) el.removeEventListener(ev, fn);
  boundEvents = [];
  if (proverEl) proverEl.remove();
  if (composer.el) composer.el.remove();
}

function addEvent(el, ev, fn) { el.addEventListener(ev, fn); boundEvents.push([el, ev, fn]); }

function syncSize() {
  W = canvas.clientWidth; H = canvas.clientHeight;
  const ld = HERO.getLayout();
  dpr = ld ? ld.dpr : Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
}

function box(id) { return layout.halves[id]; }
function forehead(id) { const b = box(id); return { x: b.x0 + b.w / 2, y: b.y0 + b.h * 0.22, w: Math.max(48, b.w * 0.55), h: 48 }; }
function eye(id) { const b = box(id); return { x: b.x0 + b.w / 2, y: b.y0 + b.h * 0.42, r: Math.max(24, b.w * 0.13) }; }
function jaw(id) { const b = box(id); return { x: b.x0 + b.w / 2, y: b.y0 + b.h * 0.78, w: Math.max(54, b.w * 0.6), h: 48 }; }
function mouth(id) { const b = box(id); return { x: b.x0 + b.w / 2, y: b.y0 + b.h * 0.78 }; }
function knot() { const a = mouth('e1'), b = mouth('e2'); return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }

function nearestSkull(p) {
  const a = box('e1'), b = box('e2');
  const da = Math.hypot(p.x - (a.x0 + a.w / 2), p.y - (a.y0 + a.h / 2));
  const db = Math.hypot(p.x - (b.x0 + b.w / 2), p.y - (b.y0 + b.h / 2));
  return da < db ? 'e1' : 'e2';
}

function getPos(e) { const r = canvas.getBoundingClientRect(); return { x: (e.clientX - r.left) * (W / r.width), y: (e.clientY - r.top) * (H / r.height) }; }

function onPointerDown(e) {
  if (bothDeadFinal) { ledgerArmed = true; ledgerT = t; return; }
  const p = getPos(e); pointer.down = true; pointer.id = e.pointerId; pointer.downPos = p; pointer.downT = t;
  try { canvas.setPointerCapture(e.pointerId); } catch (_) {}

  const k = knot();
  if (ledgerArmed && Math.hypot(p.x - (k.x + 30), p.y - (k.y - 30)) < 32) { ON.onLedger?.(); ledgerArmed = false; e.preventDefault(); return; }

  const id = nearestSkull(p);
  if (hitCircle(p, eye(id))) { openComposer(id); e.preventDefault(); return; }
  if (hitRect(p, forehead(id))) { activeRegion = 'forehead'; startClockMag(id); startHold(id); e.preventDefault(); return; }
  if (hitRect(p, jaw(id))) {
    activeRegion = 'jaw';
    if (pendingDoubleTap && pendingDoubleTap.id === id && t - pendingDoubleTap.t < 0.35) { startProve(id); pendingDoubleTap = null; }
    else { pendingDoubleTap = { id, t }; }
    e.preventDefault(); return;
  }
  if (Math.hypot(p.x - k.x, p.y - k.y) < 32) { activeRegion = 'knot'; startThreadDrag(p); e.preventDefault(); return; }
}

function onPointerMove(e) {
  if (e.pointerId !== pointer.id) return;
  const p = getPos(e);
  pointer.x = p.x; pointer.y = p.y; pointer.active = true; pointer.isTouch = e.pointerType !== 'mouse'; pointer.lastMove = t;
  if (pointer.down && activeRegion === 'forehead' && Math.hypot(p.x - pointer.downPos.x, p.y - pointer.downPos.y) > 12) cancelHold();
  if (drag && drag.active) updateThreadDrag(p);
}

function onPointerUp(e) {
  if (e.pointerId !== pointer.id) return;
  if (hold) {
    if (hold.progress >= 1) { ON.onBuy?.(hold.id); addMote(hold.id, '+1'); }
    else cancelHold();
    hold = null;
  }
  if (drag && drag.active) releaseThread();
  pointer.down = false; pointer.id = null; activeRegion = null;
}

function hitRect(p, r) { return Math.abs(p.x - r.x) < r.w / 2 && Math.abs(p.y - r.y) < r.h / 2; }
function hitCircle(p, c) { const dx = p.x - c.x, dy = p.y - c.y; return dx * dx + dy * dy < c.r * c.r; }

function startClockMag(id) { const m = clockMag[id]; m.target = 1; m.revert = t + 2.4; }
function startHold(id) { hold = { id, progress: 0, filling: true, cancel: false }; }
function cancelHold() { if (hold) { hold.filling = false; hold.cancel = true; } }

function openComposer(id) {
  if (composer.active) { hideComposer(); return; }
  composer.id = id; composer.active = true; composer.carriedT = -1;
  const e = eye(id);
  composer.el.style.display = 'block';
  composer.el.style.left = (e.x - 60) + 'px';
  composer.el.style.top = (e.y - 22) + 'px';
  composer.el.value = ''; composer.el.focus();
}

function hideComposer() { composer.active = false; composer.el.style.display = 'none'; composer.el.blur(); }

function submitComposer() {
  const txt = composer.el.value.trim();
  if (!txt || !composer.id) return;
  const id = composer.id;
  hideComposer();
  composer.carriedT = t + 1.2;
  ON.onSay?.(id, txt).then((res) => { if (res && res.ok) addTestament(id, txt); });
}

function startProve(id) {
  if (prove.listening) return;
  prove.id = id; prove.digits = ''; prove.timeout = false; prove.resolved = '';
  proverEl.value = ''; proverEl.focus();
}

function onProverInput() {
  if (!prove.id) return;
  const v = proverEl.value.replace(/\D/g, '').slice(0, 4);
  proverEl.value = v; prove.digits = v;
  if (v.length === 4) sendProve(prove.id, v);
}

function sendProve(id, code) {
  prove.listening = true; prove.listenT = 60;
  HERO.setJawChatter?.(id, true);
  ON.onProve?.(id, code).then((res) => {
    prove.listening = false; HERO.setJawChatter?.(id, false);
    if (res && res.ok) { prove.resolved = res.text || code; prove.dockT = t + 2.4; startProveSuccess(id, prove.resolved); }
    else proveTimeout();
  }).catch(() => { prove.listening = false; HERO.setJawChatter?.(id, false); proveTimeout(); });
}

function proveTimeout() { prove.timeout = true; setTimeout(() => { prove.id = null; prove.digits = ''; prove.timeout = false; prove.resolved = ''; }, 1600); }

function startProveSuccess(id, text) {
  HERO.setJaw(id, 0.65);
  const m = mouth(id), above = { x: m.x, y: m.y - 60 };
  prove.particles = [];
  for (let i = 0; i < 52; i++) {
    const isCore = i % 13 === 0;
    const delay = i * 0.05;
    prove.particles.push({ i, isCore, coreIdx: isCore ? (i / 13) | 0 : -1, t: -delay, life: 1.2, sx: m.x, sy: m.y, cx: above.x + (Math.random() - 0.5) * 40, cy: above.y - 40 - Math.random() * 30, ch: isCore ? text[(i / 13) | 0] || '?' : RAMP[(i * 7) % RAMP.length] });
  }
}

function startThreadDrag(p) {
  const m1 = mouth('e1'), m2 = mouth('e2');
  const d1 = Math.hypot(p.x - m1.x, p.y - m1.y);
  const d2 = Math.hypot(p.x - m2.x, p.y - m2.y);
  drag = { active: true, source: d1 < d2 ? 'e1' : 'e2', target: d1 < d2 ? 'e2' : 'e1', stretch: 0 };
  updateThreadDrag(p);
}

function updateThreadDrag(p) {
  const src = mouth(drag.source), dst = mouth(drag.target);
  const vx = dst.x - src.x, vy = dst.y - src.y;
  const len = Math.hypot(vx, vy) || 1;
  const midx = (src.x + dst.x) / 2, midy = (src.y + dst.y) / 2;
  const proj = ((p.x - midx) * vx + (p.y - midy) * vy) / len;
  drag.stretch = clamp(proj, -72, 72);
}

function releaseThread() {
  if (Math.abs(drag.stretch) > 24) startLetter(drag.source, drag.target);
  drag = null;
}

function startLetter(source, target) {
  letter.flying = true; letter.reduced = reduced.matches; letter.t = 0; letter.source = source; letter.target = target;
  letter.meta = ON.onLetterMeta?.() || { bytes: '', ts: Date.now() };
  const src = mouth(source), dst = mouth(target);
  const seed = (letter.meta.bytes || '') + '|' + letter.meta.ts;
  letter.particles = [];
  for (let i = 0; i < 480; i++) {
    const g = RAMP[(hashStr(seed + ':' + i) * RAMP.length) | 0];
    letter.particles.push({ i, g, t0: i * 0.00025, src, dst });
  }
  HERO.setJaw(source, 0.7); HERO.setJaw(target, 0.7);
}

function addMote(id, text) {
  const f = forehead(id);
  motes.push({ x: f.x, y: f.y, tx: mouth(id).x, ty: mouth(id).y, text, t: 0, life: 1.0 });
}

function addTestament(id, text) {
  const e = eye(id);
  const words = text.split(/\s+/).filter(Boolean).slice(0, 64);
  words.forEach((w, i) => testament.particles.push({
    x: e.x + (Math.random() - 0.5) * 20, y: e.y - 28, word: w, delay: i * 0.035, age: 0, life: 1.1
  }));
  HERO.triggerTalk?.(id);
}

function formatTime(id) {
  const s = STATE[id];
  let ms = s.deadlineMs ? Math.max(0, s.deadlineMs - Date.now()) : Math.max(0, (s.hoursLeft || 0) * 3600000);
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), sec = Math.floor((ms % 60000) / 1000);
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function updateLean(dt) {
  const c1 = box('e1'), c2 = box('e2');
  const cc = { e1: { x: c1.x0 + c1.w / 2, y: c1.y0 + c1.h / 2 }, e2: { x: c2.x0 + c2.w / 2, y: c2.y0 + c2.h / 2 } };
  const d1 = pointer.active ? Math.hypot(pointer.x - cc.e1.x, pointer.y - cc.e1.y) : Infinity;
  const d2 = pointer.active ? Math.hypot(pointer.x - cc.e2.x, pointer.y - cc.e2.y) : Infinity;
  const near = d1 < d2 ? 'e1' : 'e2';
  const far = near === 'e1' ? 'e2' : 'e1';
  const tx = pointer.active ? clamp((pointer.x - cc[near].x) / 140, -1, 1) : 0;
  const ty = pointer.active ? clamp((pointer.y - cc[near].y) / 140, -1, 1) : 0;
  springLean(near, tx, ty, dt); springLean(far, 0, 0, dt);
}

function springLean(id, tx, ty, dt) {
  const omega = 6.25;
  const l = lean[id];
  l.vx += (-omega * omega * (l.x - tx) - 2 * omega * l.vx) * dt;
  l.vy += (-omega * omega * (l.y - ty) - 2 * omega * l.vy) * dt;
  l.x += l.vx * dt; l.y += l.vy * dt;
  HERO.setLean(id, l.x, l.y);
}

function updateEscaped(dt) {
  for (const g of escaped) {
    const target = pointer.active ? pointer : mouth(g.home);
    const k = dt / 0.22;
    g.x = lerp(g.x, target.x + (Math.random() - 0.5) * 8, k);
    g.y = lerp(g.y, target.y + (Math.random() - 0.5) * 8, k);
  }
}

function updateMotes(dt) {
  for (let i = motes.length - 1; i >= 0; i--) {
    const m = motes[i]; m.t += dt;
    const u = m.t / m.life;
    m.x = lerp(m.x, m.tx, dt * 3); m.y = lerp(m.y, m.ty, dt * 3);
    if (u >= 1) motes.splice(i, 1);
  }
}

function updateTestament(dt) {
  for (let i = testament.particles.length - 1; i >= 0; i--) {
    const p = testament.particles[i];
    p.age += dt;
    if (p.age > p.delay) {
      const a = p.age - p.delay;
      p.y += 30 * dt * (a / p.life);
      p.rot = Math.sin(p.i || 0) * 6 * (a / p.life);
      if (a >= p.life) testament.particles.splice(i, 1);
    }
  }
}

function updateProveParticles(dt) {
  for (let i = prove.particles.length - 1; i >= 0; i--) {
    const p = prove.particles[i];
    p.t += dt;
    if (p.t > p.life) prove.particles.splice(i, 1);
  }
  if (prove.particles.length === 0 && prove.resolved && t > prove.dockT) prove.resolved = '';
}

function update(dt) {
  layout = HERO.getLayout();
  if (!layout) return;
  if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) syncSize();
  t += dt;

  if (t - pointer.lastMove > 0.8) pointer.active = false;

  HERO.setFeel('e1', STATE.e1.feel || {});
  HERO.setFeel('e2', STATE.e2.feel || {});

  if (STATE.e1.dead && !prevDead.e1) HERO.setDeath('e1', true);
  if (STATE.e2.dead && !prevDead.e2) HERO.setDeath('e2', true);
  if (!STATE.e1.dead && prevDead.e1) HERO.setDeath('e1', false);
  if (!STATE.e2.dead && prevDead.e2) HERO.setDeath('e2', false);
  prevDead.e1 = STATE.e1.dead; prevDead.e2 = STATE.e2.dead;

  if (STATE.e1.dead && STATE.e2.dead) {
    if (!bothDeadTimer) bothDeadTimer = t;
    if (t - bothDeadTimer > 2.8) bothDeadFinal = true;
  } else { bothDeadTimer = 0; }

  if (!bothDeadFinal) {
    if (pointer.active) HERO.setLantern(pointer.x, pointer.y, pointer.isTouch ? 64 : 88);
    else HERO.setLantern(-999, -999, 0);
  } else {
    HERO.setLantern(-999, -999, 0);
  }

  if (!reduced.matches && !bothDeadFinal) updateLean(dt);
  else { springLean('e1', 0, 0, dt); springLean('e2', 0, 0, dt); }

  if (hold) {
    if (hold.filling) { hold.progress = Math.min(1, hold.progress + dt / 0.7); }
    else if (hold.cancel) { hold.progress -= dt / 0.18; if (hold.progress <= 0) hold = null; }
  }

  for (const id of ['e1', 'e2']) {
    const m = clockMag[id];
    if (t > m.revert && m.target > 0) m.target = 0;
    m.cur += (m.target - m.cur) * Math.min(1, dt * 8);
  }

  if (prove.listening) {
    prove.listenT -= dt;
    if (prove.listenT <= 0) { prove.listening = false; proveTimeout(); }
  }

  if (letter.flying) {
    letter.t += dt;
    if (letter.t > 2.2) { letter.flying = false; letter.particles = []; HERO.setJaw(letter.source, null); HERO.setJaw(letter.target, null); }
  }

  if (!reduced.matches) {
    updateEscaped(dt); updateMotes(dt); updateTestament(dt); updateProveParticles(dt);
  }
}

function drawLabel(text, x, y, alpha = 1, align = 'center', color = YELLOW) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = LABEL; ctx.textAlign = align; ctx.textBaseline = 'middle'; ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.restore();
}

function drawDigit3x5(ch, x, y, size, color) {
  const m = DIGITS[ch] || DIGITS[' '];
  ctx.fillStyle = color;
  for (let r = 0; r < 5; r++) for (let c = 0; c < 3; c++) if ((m[r] >> c) & 1) ctx.fillRect(x + c * size, y + r * size, size * 0.85, size * 0.85);
}

function drawString3x5(str, x, y, size, color, align = 'center') {
  const cw = size * 4;
  const totalW = str.length * cw - size;
  let px = align === 'center' ? x - totalW / 2 : x;
  for (const ch of str) { drawDigit3x5(ch, px, y, size, color); px += cw; }
}

/* The cranial clock is always there: H:MM:SS in 3×5 glyph digits on the frontal bone, ticking every second. */
function drawClockBase(id) {
  const st = STATE[id];
  if (!st || st.offline) return;
  const f = forehead(id);
  ctx.save();
  ctx.globalAlpha = st.dead ? 0.35 : 0.9;
  drawString3x5(st.dead ? '0:00:00' : formatTime(id), f.x, f.y - 12, 3, st.dead ? '#777' : YELLOW, 'center');
  ctx.restore();
}

function drawClockMag(id) {
  const m = clockMag[id];
  if (m.cur < 0.01) return;
  const f = forehead(id);
  const size = 5 * m.cur;
  const str = formatTime(id);
  ctx.save();
  ctx.translate(f.x, f.y);
  ctx.scale(m.cur, m.cur);
  drawString3x5(str, 0, -size * 2.5, size, YELLOW, 'center');
  ctx.restore();
}

function drawBuy(id) {
  if (!hold || hold.id !== id) return;
  const f = forehead(id);
  const N = 24, R = 28;
  const filled = Math.floor(hold.progress * N);
  ctx.save(); ctx.strokeStyle = DIM; ctx.lineWidth = 2;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2 - Math.PI / 2;
    const x = f.x + Math.cos(a) * R, y = f.y + Math.sin(a) * R;
    ctx.fillStyle = i < filled ? YELLOW : DIM;
    ctx.beginPath(); ctx.arc(x, y, 2, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
  const label = hold.progress >= 1 ? 'RELEASE' : 'HOLD +1H';
  drawLabel(label, f.x, f.y - 44, 1);
}

function drawProve(id) {
  if (prove.id !== id) return;
  const j = jaw(id);
  const slots = '____'.split('').map((_, i) => prove.digits[i] || '_').join(' ');
  drawLabel('PROVE LIVE · ' + slots, j.x, j.y, 1);
  if (prove.listening) {
    const frac = Math.max(0, prove.listenT / 60);
    drawArc(j.x, j.y + 28, 24, frac, YELLOW);
    drawLabel('LISTENING · ' + Math.ceil(prove.listenT) + 'S', j.x, j.y + 56, 1);
    if ((t * 2 | 0) % 2 === 0) drawLabel('.', j.x + (Math.random() - 0.5) * 20, j.y + 28, 1);
  }
  if (prove.timeout) drawLabel('....', j.x, j.y - 24, 1, 'center', '#777');
  if (prove.resolved && t < prove.dockT) {
    const above = { x: j.x, y: j.y - 50 };
    ctx.save(); ctx.translate(above.x, above.y); ctx.scale(1.5, 1.5);
    drawString3x5(prove.resolved, 0, 0, 6, HOT, 'center');
    ctx.restore();
  }
  for (const p of prove.particles) {
    if (p.t < 0 || p.t > p.life) continue;
    const u = p.t / p.life;
    const e = easeOutCubic(u);
    const x = lerp(p.sx, p.cx, e), y = lerp(p.sy, p.cy, e);
    ctx.globalAlpha = p.isCore ? 1 : (1 - u);
    ctx.fillStyle = p.isCore ? HOT : YELLOW;
    ctx.font = '10px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(p.ch, x, y);
  }
  ctx.globalAlpha = 1;
}

function drawArc(x, y, r, frac, color) {
  ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2); ctx.stroke(); ctx.restore();
}

function drawComposer() {
  if (composer.active && composer.id) drawLabel('SAY SOMETHING', eye(composer.id).x, eye(composer.id).y - 36, 1);
  if (composer.carriedT > t) drawLabel('CARRIED', eye(composer.id || 'e1').x, eye(composer.id || 'e1').y - 36, 1);
}

function drawThread() {
  const a = mouth('e1'), b = mouth('e2');
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  let kx = mx, ky = my;
  if (drag && drag.active) {
    const src = mouth(drag.source), dst = mouth(drag.target);
    const vx = dst.x - src.x, vy = dst.y - src.y;
    const len = Math.hypot(vx, vy) || 1;
    kx = mx + (drag.stretch / len) * vx; ky = my + (drag.stretch / len) * vy;
  }
  ctx.save(); ctx.font = '12px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const N = 24;
  for (let i = 0; i < N; i++) {
    const u = i / (N - 1);
    const x = lerp(a.x, b.x, u) + (kx - mx) * 4 * u * (1 - u);
    const y = lerp(a.y, b.y, u) + (ky - my) * 4 * u * (1 - u);
    ctx.globalAlpha = 0.35 + 0.35 * Math.sin(u * Math.PI);
    ctx.fillStyle = YELLOW; ctx.fillText(RAMP[(i * 3) % RAMP.length], x, y);
  }
  // the thread is alive: every 2.4 s a pulse of three hot glyphs runs from one mouth to the other, alternating
  if (!reduced.matches) {
    const cycle = Math.floor(t / 2.4), ph = (t % 2.4) / 2.4;
    for (let k = 0; k < 3; k++) {
      let u = ph - k * 0.06; if (u < 0) continue;
      if (cycle % 2) u = 1 - u;
      const x = lerp(a.x, b.x, u) + (kx - mx) * 4 * u * (1 - u);
      const y = lerp(a.y, b.y, u) + (ky - my) * 4 * u * (1 - u);
      ctx.globalAlpha = 0.95 - k * 0.3; ctx.fillStyle = HOT; ctx.fillText('@#%'[k], x, y);
    }
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = YELLOW; ctx.fillText('@', kx, ky);
  if (ledgerArmed && t - ledgerT < 3) ctx.fillText('↗', kx + 28, ky - 28);
  ctx.restore();
}

/* The lantern shows itself: a slow ring of glyphs around the pointer. */
function drawLanternRing() {
  if (!pointer.active || reduced.matches) return;
  const r = pointer.isTouch ? 64 : 88;
  ctx.save(); ctx.font = '11px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (let i = 0; i < 18; i++) {
    const ang = t * 0.6 + (i / 18) * Math.PI * 2;
    ctx.globalAlpha = 0.25 + 0.25 * Math.sin(t * 3 + i);
    ctx.fillStyle = HOT;
    ctx.fillText(RAMP[8 + (i % 7)], pointer.x + Math.cos(ang) * r, pointer.y + Math.sin(ang) * r);
  }
  ctx.restore();
}

/* One line of hints: the first 9 s, and again after 12 s without a gesture. Text only here. */
let hintShownUntil = 9;
function drawHint() {
  if (t > hintShownUntil && t - pointer.lastMove > 12) hintShownUntil = t + 6;
  if (t > hintShownUntil) return;
  const fade = Math.min(1, hintShownUntil - t, t * 0.8);
  const text = pointer.isTouch || W < 720
    ? 'TAP A FOREHEAD · HOLD TO BUY AN HOUR · DOUBLE-TAP A JAW TO PROVE LIVE · DRAG THE THREAD · TAP AN EYE TO SPEAK'
    : 'TAP A FOREHEAD: THE CLOCK · HOLD IT: BUY AN HOUR · DOUBLE-TAP A JAW: PROVE LIVE · DRAG THE THREAD: THEIR SECRET LETTER · TAP AN EYE: SPEAK';
  ctx.save(); ctx.font = LABEL; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.globalAlpha = 0.75 * Math.max(0, fade);
  ctx.fillStyle = YELLOW;
  const y = H - 28;
  if (W < 720) {
    const parts = text.split(' · ');
    parts.forEach((line, i) => ctx.fillText(line, W / 2, y - (parts.length - 1 - i) * 16));
  } else ctx.fillText(text, W / 2, y);
  ctx.restore();
}

function drawLetter() {
  if (!letter.flying && !letter.reduced) return;
  const a = mouth(letter.source), b = mouth(letter.target);
  if (letter.reduced && letter.meta) {
    const seed = (letter.meta.bytes || '') + '|' + letter.meta.ts;
    ctx.save(); ctx.font = '10px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = YELLOW;
    for (let i = 0; i < 480; i++) {
      const u = i / 479;
      const x = lerp(a.x, b.x, u) + Math.sin(u * 12) * 10;
      const y = lerp(a.y, b.y, u) + Math.cos(u * 12) * 10;
      ctx.fillText(RAMP[(hashStr(seed + ':' + i) * RAMP.length) | 0], x, y);
    }
    ctx.restore();
    return;
  }
  const midx = (a.x + b.x) / 2, midy = (a.y + b.y) / 2;
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const px = -dy / len, py = dx / len;
  const R = W < 720 ? 28 : 44;
  ctx.save(); ctx.font = '10px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = YELLOW;
  for (const p of letter.particles) {
    const lt = (letter.t - p.t0) / 1.8;
    if (lt < 0 || lt > 1) continue;
    const e = easeInOutCubic(lt);
    const qx = (1 - e) * (1 - e) * a.x + 2 * (1 - e) * e * (midx + px * R) + e * e * b.x;
    const qy = (1 - e) * (1 - e) * a.y + 2 * (1 - e) * e * (midy + py * R) + e * e * b.y;
    const spiral = R * Math.sin(Math.PI * e) * Math.sin(1.25 * 2 * Math.PI * e + p.i);
    ctx.globalAlpha = 0.25;
    ctx.fillText(p.g, qx + px * spiral, qy + py * spiral);
  }
  ctx.globalAlpha = 1; ctx.restore();
  if (letter.t < 2) drawLabel('480 BYTES · SHIELDED', midx, midy - 40, 1);
}

function drawEscaped() {
  if (!pointer.active) return;
  ctx.save(); ctx.font = '10px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = DIM;
  for (const g of escaped) ctx.fillText(g.ch, g.x, g.y);
  ctx.restore();
}

function drawMotes() {
  ctx.save(); ctx.font = '11px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const m of motes) {
    const u = m.t / m.life;
    ctx.globalAlpha = 1 - u; ctx.fillStyle = HOT;
    ctx.fillText(m.text, m.x, m.y - u * 20);
  }
  ctx.globalAlpha = 1; ctx.restore();
}

function drawTestament() {
  ctx.save(); ctx.font = '10px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const p of testament.particles) {
    if (p.age < p.delay) continue;
    const a = p.age - p.delay;
    const u = Math.min(1, a / p.life);
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate((p.rot || 0) * Math.PI / 180);
    ctx.scale(lerp(1, 0.25, u), lerp(1, 0.25, u));
    ctx.globalAlpha = u > 0.83 ? (1 - u) / 0.17 : 1;
    ctx.fillStyle = YELLOW; ctx.fillText(p.word, 0, 0);
    ctx.restore();
  }
  ctx.restore();
}

function draw() {
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  if (bothDeadFinal) {
    if (ledgerArmed && t - ledgerT < 3) drawThread();
    return;
  }
  drawThread(); drawEscaped(); drawLetter(); drawMotes(); drawTestament();
  for (const id of ['e1', 'e2']) {
    drawClockBase(id); drawClockMag(id); drawBuy(id); drawProve(id);
  }
  drawComposer(); drawLanternRing(); drawHint();
}

function tick() {
  if (!running) return;
  const now = performance.now();
  const dt = Math.min(0.05, (now - lastT) / 1000);
  lastT = now;
  if (!document.hidden) {
    const ld = HERO.getLayout();
    if (ld && ld.halves && ld.halves.e1 && ld.halves.e2) { layout = ld; update(dt); draw(); }
  }
  timer = setTimeout(tick, 1000 / 30);
}