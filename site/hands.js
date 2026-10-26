/* hands.js — ZEALOT v50 RENT HAND: the overlay canvas (hands, coins, NEXT RENT, labels, hit regions, focus proxies,
 * skull clocks via hero.drawClockText). Written by Kimi K2.7 Code from the integrator's contract; reviewed and patched
 * by the integrator (atlas cells, ascii align strings, px/cell travel, touch pointer, clock label placement). */
import { getRentState, subscribeRent } from './rent.js?v=50';
import * as hero from './hero.js?v=50';
import { mountAscii } from './ascii.js?v=50';
import { makeAtlas } from './glyphs.js?v=50';
import { openDoor, closeDoor } from './door.js?v=50';
import { openPay } from './term.js?v=50';

const RAMP = ' .-~:;=!*+^%$#&@';
const C = {
  void: '#060606',
  yellow: '#f4b728',
  bone: 'rgba(242,242,238,.92)',
  boneDim: 'rgba(242,242,238,.5)',
};

/* Boxes are computed from the stage size in layoutHands(): the hands are sized from their image geometry
 * (hand-coin.jpg 640×358: the pinched coin sits at (0.46, 0.40); hand-coin-down.jpg 358×640: at (0.53, 0.46)). */
const COIN_IN_HAND = { x: 0.46, y: 0.40 };
const COIN_IN_DOWN = { x: 0.53, y: 0.46 };
const HAND_ASPECT = 640 / 358;

let W = 0, H = 0, dpr = 1, cell = 7, isPhone = false;
let skullOff = { x: 0, y: 0, w: 0, h: 0 };   // the #skulls canvas band inside the stage
let gridChars = null, gridCols = 0, gridRows = 0;
const GRID = 48, GRID_SET = '!@%^&*()$#';
let ctx, overlay, proxiesEl, statusEl;
let atlas = null, coinPositions = [];
let layout = {}, heroLayout = null;
let reduced = false;
let dirty = true, lastSec = -1, timer = null, running = true;
let state = null;
let prevEnt = {};
let pointer = { x: 0, y: 0, hover: null };
let focusProxy = null;
let receiptAnim = null, receiptLabel = null, receiptLabelUntil = 0;
let lift = { e1: 0, e2: 0 }, liftAnim = { e1: null, e2: null };
let payAnim = { e1: null, e2: null };
let rentHandDy = 0, rentHandAlpha = 1;

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function easeOutCubic(t) { return 1 - Math.pow(1 - clamp(t, 0, 1), 3); }
function easeInOutCubic(t) {
  t = clamp(t, 0, 1);
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function makeCoinAtlas() {
  if (atlas) atlas.dispose();
  atlas = makeAtlas({
    ramp: RAMP,
    cellW: cell,
    cellH: Math.round(cell * 1.15),
    dpr,
    font: '"JetBrains Mono","SF Mono",Menlo,monospace',
    colors: [C.yellow, C.bone],
    fontScale: 1.1,
  });
  const r = 3;
  coinPositions = [];
  for (let y = -r; y <= r; y++) {
    for (let x = -r; x <= r; x++) {
      if (x * x + y * y <= r * r + 1) {
        coinPositions.push({ x, y, g: (Math.abs(x * 7 + y * 13) % 3) });
      }
    }
  }
}

function setHandPos(id, box) {
  const c = document.getElementById('hand-' + id);
  if (!c) return;
  c.style.left = box[0] + 'px';
  c.style.top = box[1] + 'px';
  c.style.width = box[2] + 'px';
  c.style.height = box[3] + 'px';
  if (handScenes[id]) handScenes[id].resample();
}

const handScenes = {};

/* hero.getLayout() is in #skulls-canvas coordinates; the overlay covers the whole stage */
function half(id) {
  const b = heroLayout.halves[id];
  return { x0: b.x0 + skullOff.x, y0: b.y0 + skullOff.y, w: b.w, h: b.h };
}

function eyeCenter(id) {
  const b = half(id);
  return {
    x: b.x0 + b.w * (id === 'e1' ? 0.72 : 0.28),
    y: b.y0 + b.h * 0.40,
  };
}

function jawRect(id) {
  const b = half(id);
  const w = b.w * 0.45, h = b.h * 0.22;
  const cx = b.x0 + b.w * (id === 'e1' ? 0.70 : 0.30);
  const cy = b.y0 + b.h * 0.80;
  return [cx - w / 2, cy - h / 2, w, h];
}

function circleBB(o, r) { return [o.x - r, o.y - r, r * 2, r * 2]; }

function getProxy(act, id) {
  return proxiesEl.querySelector(`button[data-act="${act}"]` + (id ? `[data-id="${id}"]` : ''));
}

function setProxyBox(act, id, box) {
  const btn = getProxy(act, id);
  if (!btn || !box) return;
  btn.style.left = box[0] + 'px';
  btn.style.top = box[1] + 'px';
  btn.style.width = box[2] + 'px';
  btn.style.height = box[3] + 'px';
}

function positionProxies() {
  if (!heroLayout) return;
  setProxyBox('buy', 'e1', layout.hitCoinE1);
  setProxyBox('buy', 'e2', layout.hitCoinE2);
  setProxyBox('prove', 'e1', circleBB(eyeCenter('e1'), Math.max(26, half('e1').w * 0.11)));
  setProxyBox('prove', 'e2', circleBB(eyeCenter('e2'), Math.max(26, half('e2').w * 0.11)));
  setProxyBox('speak', 'e1', jawRect('e1'));
  setProxyBox('speak', 'e2', jawRect('e2'));
  const h1 = half('e1'), h2 = half('e2');
  setProxyBox('open', 'e1', [h1.x0, h1.y0, h1.w, h1.h]);
  setProxyBox('open', 'e2', [h2.x0, h2.y0, h2.w, h2.h]);
  setProxyBox('rent', null, layout.nextRent);
}

function layoutHands(width, height) {
  W = Math.max(320, Math.round(width));
  H = Math.max(480, Math.round(height));
  isPhone = W < 720;
  dpr = Math.min(window.devicePixelRatio || 1, isPhone ? 1.5 : 2);
  cell = isPhone ? 5 : 7;
  overlay.width = W * dpr;
  overlay.height = H * dpr;
  overlay.style.width = W + 'px';
  overlay.style.height = H + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  makeCoinAtlas();
  const sk = document.getElementById('skulls');
  skullOff = { x: sk.offsetLeft, y: sk.offsetTop, w: sk.clientWidth, h: sk.clientHeight };
  // visitor hands: bottom corners, sized so the hand reads as a hand (image contain-fit, vertically centred)
  const hw = isPhone ? Math.round(W * 0.48) : Math.round(Math.min(460, W * 0.32));
  const hh = Math.round(hw / HAND_ASPECT);
  const hy = H - hh - (isPhone ? 26 : 36);
  layout.coinE1 = [0, hy, hw, hh];
  layout.coinE2 = [W - hw, hy, hw, hh];
  const r = isPhone ? 30 : 44;
  const c1 = { x: hw * COIN_IN_HAND.x, y: hy + hh * COIN_IN_HAND.y };
  const c2 = { x: W - hw * COIN_IN_HAND.x, y: hy + hh * COIN_IN_HAND.y };
  layout.hitCoinE1 = [c1.x - r, c1.y - r, 2 * r, 2 * r];
  layout.hitCoinE2 = [c2.x - r, c2.y - r, 2 * r, 2 * r];
  // the rent hand comes from above, centred, cover-fit from the top so the pinch is visible
  const rw = isPhone ? Math.round(W * 0.30) : Math.round(Math.min(320, W * 0.22));
  const rh = Math.round(rw * 0.94);
  const rx = isPhone ? Math.round(W * 0.08) : Math.round((W - rw) / 2);
  layout.rentHand = [rx, 0, rw, rh];
  // the pinch of the cover-fitted (top-aligned) hand image: x at 0.53 of the drawn width, y at 0.46 of the drawn height
  layout.rentCoin = { x: rx + rw * COIN_IN_DOWN.x, y: (rw / 358 * 640) * COIN_IN_DOWN.y };
  // NEXT RENT: under the rent hand between the skulls on desktop; top-right beside the hand on phones
  const nw = isPhone ? Math.round(W * 0.56) : 260;
  layout.nextRent = isPhone ? [Math.round(W * 0.42), 10, nw, 64] : [Math.round((W - nw) / 2), rh + 4, nw, 64];
  setHandPos('rent', layout.rentHand);
  setHandPos('e1', layout.coinE1);
  setHandPos('e2', layout.coinE2);
  heroLayout = hero.getLayout();
  positionProxies();
  buildGrid();
  dirty = true;
}

function onResize() {
  const rect = document.getElementById('stage').getBoundingClientRect();
  layoutHands(rect.width, rect.height);
}

/* ascii.js motion hints are in px; hand travel is expressed in cells here */
const rentHint = { dy: 0, alpha: 1 };
const e1Hint = { dy: 0, alpha: 1 };
const e2Hint = { dy: 0, alpha: 1 };
function rentMotion() { rentHint.dy = rentHandDy * cell; rentHint.alpha = rentHandAlpha; return rentHint; }
function e1Motion() { e1Hint.dy = -lift.e1 * cell; return e1Hint; }
function e2Motion() { e2Hint.dy = -lift.e2 * cell; return e2Hint; }

function hitPoint(x, y) {
  const inBox = (b) => b && x >= b[0] && x <= b[0] + b[2] && y >= b[1] && y <= b[1] + b[3];
  const inCirc = (o, r) => (x - o.x) ** 2 + (y - o.y) ** 2 <= r * r;
  if (inBox(layout.hitCoinE1)) return { act: 'buy', id: 'e1' };
  if (inBox(layout.hitCoinE2)) return { act: 'buy', id: 'e2' };
  if (heroLayout) {
    for (const id of ['e1', 'e2']) {
      const eye = eyeCenter(id);
      const r = Math.max(26, half(id).w * 0.11);
      if (inCirc(eye, r)) return { act: 'prove', id };
    }
    for (const id of ['e1', 'e2']) {
      if (inBox(jawRect(id))) return { act: 'speak', id };
    }
  }
  if (inBox(layout.nextRent)) return { act: 'rent' };
  if (heroLayout) {
    for (const id of ['e1', 'e2']) {
      const b = half(id);
      if (inBox([b.x0, b.y0, b.w, b.h])) return { act: 'open', id };
    }
  }
  return null;
}

let downPos = null, downT = 0;

function onPointerMove(e) {
  readPointer(e);
  hero.setLantern(pointer.x, pointer.y, isPhone ? 64 : 88);
  dirty = true;
}

function readPointer(e) {
  const rect = overlay.getBoundingClientRect();
  pointer.x = e.clientX - rect.left;
  pointer.y = e.clientY - rect.top;
  pointer.hover = hitPoint(pointer.x, pointer.y);
}

function onPointerDown(e) { readPointer(e); downPos = { x: pointer.x, y: pointer.y }; downT = performance.now(); }

function onPointerUp(e) {
  if (!downPos) return;
  readPointer(e);
  const dx = pointer.x - downPos.x, dy = pointer.y - downPos.y;
  const dt = performance.now() - downT;
  downPos = null;
  if (Math.hypot(dx, dy) < 12 && dt < 600) doAction(pointer.hover);
}

function doAction(h) {
  if (!h) return;
  const st = state || getRentState();
  if (h.act === 'buy') {
    const ent = st && st[h.id];
    if (ent && !ent.locked) { openPay({ who: h.id, hours: 1 }); triggerLift(h.id); }
    return;
  }
  if (h.act === 'prove') { openDoor('prove', h.id); return; }
  if (h.act === 'speak') { openDoor('speak', h.id); return; }
  if (h.act === 'rent') { openDoor('rent', (st && st.appointment && st.appointment.id) || 'e1'); return; }
  if (h.act === 'open') { openDoor('archive', h.id); }
}

function triggerLift(id) {
  if (reduced) return;
  liftAnim[id] = { start: performance.now() };
}

function onProxyClick(e) {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  doAction({ act: btn.dataset.act, id: btn.dataset.id });
}

function onProxyFocus(e) {
  const btn = e.target.closest('button[data-act]');
  focusProxy = btn ? { act: btn.dataset.act, id: btn.dataset.id || null } : null;
  dirty = true;
}

function onKey(e) {
  if (e.key === 'Escape') { closeDoor(); }
}

function setStatus(s) {
  if (statusEl && statusEl.textContent !== s) statusEl.textContent = s;
}

function applyState(st, now) {
  if (!st) return;
  for (const id of ['e1', 'e2']) {
    const ent = st[id], p = prevEnt[id] || {};
    const hrs = ent.hoursLeft == null ? 0 : ent.hoursLeft;
    if (hrs !== p.hours) hero.setHours(id, hrs);
    const mouth = ent.dead ? 'dead' : ent.asleep ? 'asleep' : ent.ok ? 'alive' : 'none';
    if (mouth !== p.mouth) hero.setMouth(id, mouth);
    const feel = ent.feel && ent.feel.steered ? ent.feel : { fear: 0, despair: 0 };
    if (!p.feel || feel.fear !== p.feel.fear || feel.despair !== p.feel.despair) hero.setFeel(id, feel);
    if (ent.dead !== p.dead) hero.setDeath(id, ent.dead);
    prevEnt[id] = { hours: hrs, mouth, feel, dead: ent.dead };
  }
  updateClocks(st, now);
}

function updateClocks(st, now) {
  for (const id of ['e1', 'e2']) {
    const ent = st[id];
    let text, fill = '#';
    if (ent.dead) { text = '0:00:00'; fill = '#'; }
    else if (!ent.fresh || ent.deadlineMs == null) { text = '--:--:--'; fill = '#'; }
    else {
      const s = Math.max(0, Math.ceil((ent.deadlineMs - Date.now()) / 1000));
      const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
      text = `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
      fill = s < 3600 ? '@' : s < 86400 ? '+' : '#';
    }
    hero.drawClockText(id, text, fill);
  }
}

function stateLabel(id, now) {
  if (!state) return 'WAITING FOR VITALS';
  const ent = state[id];
  if (!ent) return null;
  if (ent.dead) return 'DEAD · NO REVIVAL';
  if (ent.offline) return 'OFFLINE';
  if (ent.stale) {
    const m = Math.floor((now - (ent.sampleAt || 0)) / 60000);
    return `DATA STALE · ${m} MIN`;
  }
  if (ent.asleep) return 'SLEEPING';
  return null;
}

function drawLabel(text, x, y, alpha) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = C.yellow;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.font = '11px "JetBrains Mono","SF Mono",Menlo,monospace';
  ctx.fillText(text, x, y);
  ctx.restore();
}

function drawNextRent(now) {
  const box = layout.nextRent;
  const cx = box[0] + box[2] / 2, top = box[1];
  let line1 = 'NEXT RENT', line2 = '—', line3 = '';
  const ap = state && state.appointment;
  if (receiptLabel && now < receiptLabelUntil) {
    line1 = 'RENT PAID';
    line2 = receiptLabel;
    line3 = '';
  } else if (ap && ap.id && ap.at) {
    const name = ap.id === 'e1' ? 'WICK' : 'OBOL';
    const s = Math.floor((ap.at - Date.now()) / 1000);
    if (!ap.overdue) {
      line1 = `NEXT RENT · ${name}`;
      const m = Math.floor(Math.max(0, s) / 60), sec = Math.max(0, s) % 60;
      line2 = `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
      line3 = 'ESTIMATED';
    } else {
      line1 = `AWAITING RECEIPT · ${name}`;
      const o = Math.abs(s);
      const m = Math.floor(o / 60), sec = o % 60;
      line2 = `OVERDUE +${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    }
  }
  drawLabel(line1, cx, top + 4, 0.9);
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = C.yellow;
  ctx.font = '14px "JetBrains Mono","SF Mono",Menlo,monospace';
  ctx.fillText(line2, cx, top + 22);
  ctx.font = '11px "JetBrains Mono","SF Mono",Menlo,monospace';
  ctx.globalAlpha = 0.65;
  ctx.fillText(line3, cx, top + 42);
  ctx.restore();
}

function glyphIndex(ch) {
  const i = RAMP.indexOf(ch);
  return i >= 0 ? i : 0;
}

function drawCoinDisc(cx, cy, alpha) {
  if (!atlas) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  for (const p of coinPositions) {
    const gi = p.g === 0 ? glyphIndex('@') : p.g === 1 ? glyphIndex('#') : glyphIndex('%');
    atlas.blit(ctx, gi, 0, alpha, Math.round(cx + p.x * cell), Math.round(cy + p.y * cell * 1.15));
  }
  ctx.restore();
}

function arcPoint(a, b, t) {
  const e = easeInOutCubic(t);
  const mx = (a.x + b.x) / 2;
  const my = Math.min(a.y, b.y) - Math.min(W, H) * 0.12;
  const x = (1 - e) * (1 - e) * a.x + 2 * (1 - e) * e * mx + e * e * b.x;
  const y = (1 - e) * (1 - e) * a.y + 2 * (1 - e) * e * my + e * e * b.y;
  return { x, y };
}

function startPayment(id, entry) {
  if (reduced) return;
  const target = id === 'e1' ? layout.hitCoinE1 : layout.hitCoinE2;
  if (!target || !heroLayout) return;
  const jaw = jawRect(id);
  payAnim[id] = {
    start: performance.now(),
    from: { x: target[0] + target[2] / 2, y: target[1] + target[3] / 2 },
    to: { x: jaw[0] + jaw[2] / 2, y: jaw[1] + jaw[3] / 2 },
  };
}

function startReceipt(entry) {
  const now = performance.now();
  const cx = layout.rentCoin ? layout.rentCoin.x : W / 2;
  const cy = layout.rentCoin ? layout.rentCoin.y : 80;
  receiptLabelUntil = now + 820 + 6000;
  const zats = Number(entry && entry.data && entry.data.zats) || 0;
  const ts = entry && entry.ts ? new Date(entry.ts).toISOString().slice(11, 16) + ' UTC' : '—';
  receiptLabel = `${zats.toLocaleString('en-GB')} ZATS · ${ts}`;
  if (reduced) return;
  receiptAnim = {
    start: now,
    from: { x: cx, y: cy + 9 * cell },
    to: { x: cx, y: cy },
    entry,
  };
}

function updateAnimations(now) {
  let animating = false;
  if (receiptAnim && !reduced) {
    animating = true;
    const t = clamp((now - receiptAnim.start) / 240, 0, 1);
    const w = clamp((now - (receiptAnim.start + 500)) / 320, 0, 1);
    rentHandDy = now < receiptAnim.start + 500 ? 6 * easeOutCubic(t) : 6 * (1 - easeOutCubic(w));
  } else {
    rentHandDy = 0;
  }
  for (const id of ['e1', 'e2']) {
    const a = liftAnim[id];
    if (a) {
      animating = true;
      const t = now - a.start;
      if (t < 160) lift[id] = 1.5 * easeOutCubic(t / 160);
      else if (t < 320) lift[id] = 1.5 * (1 - easeOutCubic((t - 160) / 160));
      else { lift[id] = 0; liftAnim[id] = null; }
    } else {
      lift[id] = 0;
    }
  }
  for (const id of ['e1', 'e2']) {
    const a = payAnim[id];
    if (a) {
      animating = true;
      if (now - a.start >= 720) payAnim[id] = null;
    }
  }
  if (animating) dirty = true;
}

function drawCoins(now) {
  for (const id of ['e1', 'e2']) {
    const target = id === 'e1' ? layout.hitCoinE1 : layout.hitCoinE2;
    if (!target) continue;
    drawCoinDisc(target[0] + target[2] / 2, target[1] + target[3] / 2 - lift[id] * cell, 1);
  }
  for (const id of ['e1', 'e2']) {
    const a = payAnim[id];
    if (!a) continue;
    const t = clamp((now - a.start) / 720, 0, 1);
    const p = arcPoint(a.from, a.to, t);
    drawCoinDisc(p.x, p.y, 1);
    if (t >= 1) payAnim[id] = null;
  }
  if (receiptAnim && !reduced) {
    const t = clamp((now - receiptAnim.start - 180) / 380, 0, 1);
    const p = {
      x: receiptAnim.from.x + (receiptAnim.to.x - receiptAnim.from.x) * easeInOutCubic(t),
      y: receiptAnim.from.y + (receiptAnim.to.y - receiptAnim.from.y) * easeInOutCubic(t),
    };
    drawCoinDisc(p.x, p.y, 1);
    if (now - receiptAnim.start >= 980) receiptAnim = null;
  }
}

function getFocusBox(fp) {
  if (!fp) return null;
  if (fp.act === 'rent') return layout.nextRent;
  if (fp.act === 'buy') return fp.id === 'e1' ? layout.hitCoinE1 : layout.hitCoinE2;
  if (!heroLayout) return null;
  if (fp.act === 'prove') return circleBB(eyeCenter(fp.id), Math.max(26, half(fp.id).w * 0.11));
  if (fp.act === 'speak') return jawRect(fp.id);
  if (fp.act === 'open') {
    const b = half(fp.id);
    return [b.x0, b.y0, b.w, b.h];
  }
  return null;
}

function drawBrackets() {
  if (!focusProxy) return;
  const box = getFocusBox(focusProxy);
  if (!box) return;
  ctx.save();
  ctx.strokeStyle = C.bone;
  ctx.lineWidth = 2;
  ctx.globalAlpha = 0.9;
  ctx.strokeRect(box[0] + 2, box[1] + 2, box[2] - 4, box[3] - 4);
  ctx.restore();
}

function drawLabels(now) {
  for (const id of ['e1', 'e2']) {
    const target = id === 'e1' ? layout.hitCoinE1 : layout.hitCoinE2;
    const hover = pointer.hover;
    const a = isPhone ? 0.55 : (hover && hover.act === 'buy' && hover.id === id ? 0.92 : 0.55);
    if (target) drawLabel('BUY TIME', target[0] + target[2] / 2, target[1] + target[3] + 6, a);
    if (heroLayout) {
      const eye = eyeCenter(id);
      const r = Math.max(26, half(id).w * 0.11);
      const ah = isPhone ? 0.55 : (hover && hover.act === 'prove' && hover.id === id ? 0.92 : 0.55);
      drawLabel('PROVE', eye.x, eye.y - r - 14, ah);
      const jaw = jawRect(id);
      const as = isPhone ? 0.55 : (hover && hover.act === 'speak' && hover.id === id ? 0.92 : 0.55);
      drawLabel('SPEAK', jaw[0] + jaw[2] / 2, jaw[1] + jaw[3] + 4, as);
      const b = half(id);
      const ao = isPhone ? 0.55 : (hover && hover.act === 'open' && hover.id === id ? 0.92 : 0.55);
      drawLabel('OPEN', b.x0 + b.w / 2, b.y0 - 16, ao);
    }
    const sl = stateLabel(id, now);
    if (sl) {
      const stacked = skullOff.w < 720;
      const cx = skullOff.x + (stacked ? skullOff.w / 2 : (id === 'e1' ? skullOff.w * 0.25 : skullOff.w * 0.75));
      const cy = skullOff.y + (stacked ? (id === 'e1' ? skullOff.h * 0.36 : skullOff.h * 0.80) + 7 * 3 + 8 : skullOff.h * 0.68 + 7 * 4 + 8);
      drawLabel(sl, cx, cy, 0.7);
    }
  }
  if (layout.nextRent) drawNextRent(now);
}

function buildGrid() {
  gridCols = Math.ceil(W / GRID) + 1; gridRows = Math.ceil(H / GRID) + 1;
  gridChars = new Uint8Array(gridCols * gridRows);
  for (let i = 0; i < gridChars.length; i++) gridChars[i] = (Math.random() * GRID_SET.length) | 0;
}
function drawGrid() {
  if (!gridChars) buildGrid();
  gridChars[(Math.random() * gridChars.length) | 0] = (Math.random() * GRID_SET.length) | 0;
  ctx.save();
  ctx.font = '11px "JetBrains Mono","SF Mono",Menlo,monospace'; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
  ctx.fillStyle = isPhone ? 'rgba(244,183,40,0.08)' : 'rgba(244,183,40,0.22)';
  for (let r = 0; r < gridRows; r++) for (let c = 0; c < gridCols; c++) {
    ctx.fillText(GRID_SET[gridChars[r * gridCols + c]], c * GRID + 24, r * GRID + 24);
  }
  ctx.restore();
}

function draw(now) {
  if (!ctx) return;
  dirty = false;
  ctx.clearRect(0, 0, W, H);
  drawGrid();
  const hl = hero.getLayout();
  if (hl && hl !== heroLayout) { heroLayout = hl; positionProxies(); }
  updateAnimations(now);
  applyState(state, now);
  drawLabels(now);
  drawCoins(now);
  drawBrackets();
}

function loop() {
  const now = performance.now();
  const sec = Math.floor(now / 1000);
  if (sec !== lastSec) { dirty = true; lastSec = sec; }
  if (!document.hidden && dirty) draw(now);
  timer = running ? setTimeout(loop, 33) : null;
}

function onRent(st, event) {
  state = st;
  if (event) {
    if (event.type === 'receipt') { startReceipt(event.entry); setStatus(`RENT PAID ${st[event.id].name}`); }
    if (event.type === 'payment') { startPayment(event.id, event.entry); setStatus(`PAYMENT OBSERVED ${st[event.id].name}`); }
    if (event.type === 'reply' && event.wait && (event.wait.status === 'reply' || event.wait.status === 'match' || event.wait.status === 'nomatch')) {
      hero.triggerTalk(event.id); setStatus(`REPLY FROM ${st[event.id].name}`);
    }
    if (event.type === 'death') { setStatus(`${st[event.id].name} DEAD`); }
  }
  applyState(st, performance.now());
  if (st && st.bothDead && running) {
    running = false;
    if (timer) { clearTimeout(timer); timer = null; }
    draw(performance.now());
    return;
  }
  dirty = true;
}

export function mountHands() {
  hero.setGrid(false);
  reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (mql.addEventListener) mql.addEventListener('change', (e) => { reduced = e.matches; dirty = true; });
  overlay = document.getElementById('overlay');
  ctx = overlay.getContext('2d', { alpha: true });
  proxiesEl = document.getElementById('proxies');
  statusEl = document.getElementById('status');
  window.addEventListener('resize', onResize);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) dirty = true; });
  overlay.addEventListener('pointermove', onPointerMove);
  overlay.addEventListener('pointerdown', onPointerDown);
  overlay.addEventListener('pointerup', onPointerUp);
  overlay.addEventListener('pointerleave', () => { hero.setLantern(null); });
  proxiesEl.addEventListener('click', onProxyClick);
  proxiesEl.addEventListener('focusin', onProxyFocus);
  document.addEventListener('keydown', onKey);
  handScenes.rent = mountAscii(document.getElementById('hand-rent'), {
    src: 'vendor/hand-coin-down.jpg',
    cell: isPhone ? 5 : 6,
    fit: 'cover',
    align: 'top',
    motion: rentMotion,
  });
  handScenes.e1 = mountAscii(document.getElementById('hand-e1'), {
    src: 'vendor/hand-coin.jpg',
    cell: isPhone ? 5 : 6,
    fit: 'contain',
    align: 'left',
    motion: e1Motion,
  });
  handScenes.e2 = mountAscii(document.getElementById('hand-e2'), {
    src: 'vendor/hand-coin-r.jpg',
    cell: isPhone ? 5 : 6,
    fit: 'contain',
    align: 'right',
    motion: e2Motion,
  });
  onResize();
  subscribeRent(onRent);
  loop();
}

export function destroyHands() {
  running = false;
  if (timer) { clearTimeout(timer); timer = null; }
  for (const k of Object.keys(handScenes)) { if (handScenes[k]) handScenes[k].destroy(); }
  if (atlas) atlas.dispose();
}
