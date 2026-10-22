/*
 * hero.js — ZEALOT v17, the hero. Two skulls, one signal.
 *
 * The founder-approved ASCII skulls, moved out of ascii-demo.html and extended with mouths.
 * Two luminance grids are sampled from the open and shut frames (vendor/skulls-b.jpg and
 * vendor/skulls-closed.jpg — the same skulls, the same framing) and every cell is drawn as
 *   lum = mix(open, closed, k)
 * where k(t) eases 0→1→0 per skull. The left skull is WICK (e1), the right is OBOL (e2), and
 * each takes its own k from its live state: alive = talk cycles, asleep = one slow yawn every
 * ~12 s at 70% brightness, dead = jaw shut at 40% with the lime gone. A new public post makes
 * that skull talk for 3 s. 30 fps via setTimeout, no per-frame allocations beyond the glyph
 * loop, paused when hidden, prefers-reduced-motion = a static open frame.
 */

const RAMP = ' .-~:;=!*+^%$#&@';
const CELL = 7;               // px per glyph cell
const GAMMA = 1.0;
const THRESH = 0.09;          // below this luminance: empty cell
const LIME_AT = 0.80;         // the brighter cells go Zcash yellow (founder likes the yellow on the bone)
const GAP_FRAC = 0.17;        // push the two halves outwards, clear of the copy column
const LIME = '#f4b728';
const BRIGHT = 'rgba(242,242,238,.92)';
const DIM = 'rgba(242,242,238,.5)';
const MONO = '"JetBrains Mono", "SF Mono", Menlo, monospace';
const CHEW = 1.4;             // one open-close, seconds (soft)
const YAWN_PERIOD = 2.2;      // one yawn, seconds
const YAWN_EVERY = 4;         // yawn interval, seconds (asleep still moves the jaw often)
const TALK_SECS = 3;          // forced talk after a new public post
const STACK_AT = 720;         // below this width the skulls stack (phone)

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

let canvas = null;
let ctx = null;
let W = 0, H = 0, dpr = 1;
let cols = 0, rows = 0, total = 0;
let lumOpen = null, lumClosed = null, half = null;
let stacked = false;

const off = document.createElement('canvas');
const octx = off.getContext('2d', { willReadFrequently: true });

const imgOpen = new Image();
const imgClosed = new Image();
let ready = false;

// 0 = left = WICK (e1), 1 = right = OBOL (e2)
const skulls = [
  { mode: 'none', k: 0, talkUntil: -1, burstEnd: -1, nextBurst: -1, chewStart: 0, yawnStart: -1, yawnEnd: -1, nextYawn: -1, yawnPeriod: YAWN_PERIOD },
  { mode: 'none', k: 0, talkUntil: -1, burstEnd: -1, nextBurst: -1, chewStart: 0, yawnStart: -1, yawnEnd: -1, nextYawn: -1, yawnPeriod: YAWN_PERIOD },
];

let clock = 0;
let lastT = 0;
let timer = 0;
let running = false;

const idxOf = (id) => (id === 'e1' ? 0 : 1);

function loadImages() {
  imgOpen.src = './vendor/skulls-b.jpg';
  imgClosed.src = './vendor/skulls-closed.jpg';
  // decode() can stall in background tabs: wait for load instead, with decode as a bonus
  const loaded = (img) => new Promise((res) => {
    if (img.complete && img.naturalWidth > 0) return res();
    img.addEventListener('load', res, { once: true });
    img.addEventListener('error', res, { once: true });
  });
  return Promise.all([loaded(imgOpen), loaded(imgClosed)]);
}

function sampleFrame(img, out) {
  const iw = img.width, ih = img.height;
  const hw = iw / 2;
  octx.clearRect(0, 0, cols, rows);
  octx.fillStyle = '#000';
  octx.fillRect(0, 0, cols, rows);
  if (stacked) {
    // phone: WICK above the headline, OBOL below it
    const rw = cols * 0.84;
    const rh = rows * 0.30;
    const s = Math.min(rw / hw, rh / ih);
    const sw = hw * s, sh = ih * s;
    const x0 = (cols - sw) / 2;
    octx.drawImage(img, 0, 0, hw, ih, x0, rows * 0.02, sw, sh);
    octx.drawImage(img, hw, 0, hw, ih, x0, rows * 0.68, sw, sh);
  } else {
    // founder-approved look: contain-fit the pair, push the halves outwards
    const s = Math.min(cols / iw, (rows * 0.90) / ih);
    const dw = iw * s, dh = ih * s;
    const GAP = GAP_FRAC * cols;
    const y0 = (rows - dh) / 2;
    octx.drawImage(img, 0, 0, hw, ih, (cols - dw) / 2 - GAP, y0, dw / 2, dh);
    octx.drawImage(img, hw, 0, hw, ih, cols / 2 + GAP, y0, dw / 2, dh);
  }
  const d = octx.getImageData(0, 0, cols, rows).data;
  for (let i = 0; i < total; i++) {
    const l = (d[i * 4] * 0.2126 + d[i * 4 + 1] * 0.7152 + d[i * 4 + 2] * 0.0722) / 255;
    out[i] = Math.pow(l, GAMMA);
  }
}

function sample() {
  W = canvas.clientWidth;
  H = canvas.clientHeight;
  dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  cols = Math.floor(W / CELL);
  rows = Math.floor(H / (CELL * 1.15));
  total = cols * rows;
  if (cols <= 0 || rows <= 0) return;
  off.width = cols;
  off.height = rows;
  lumOpen = new Float32Array(total);
  lumClosed = new Float32Array(total);
  half = new Uint8Array(total);
  stacked = W < STACK_AT;
  gridChars = null;

  sampleFrame(imgOpen, lumOpen);
  sampleFrame(imgClosed, lumClosed);

  // each cell belongs to a half: left half (WICK) or right half (OBOL)
  const boundary = stacked ? rows * 0.5 : cols * 0.5;
  for (let i = 0; i < total; i++) {
    half[i] = (stacked ? (i / cols) | 0 : i % cols) < boundary ? 0 : 1;
  }
}

// soft jaw: cosine ease in and out, never fully shut while talking, never beyond [0,1]
function chewK(s, now) {
  const t = ((now - s.chewStart) % CHEW) / CHEW;
  return 0.72 * (0.5 - 0.5 * Math.cos(2 * Math.PI * t));
}
function yawnK(s, now) {
  const t = Math.min(1, Math.max(0, (now - s.yawnStart) / s.yawnPeriod));
  const o = Math.sin(Math.PI * t);
  return 1 - 0.85 * o * o;
}

function computeK(s, now) {
  if (s.mode === 'dead') return 1;
  if (now < s.talkUntil) return chewK(s, now);
  if (s.mode === 'none' || s.mode === 'unknown') return 0;
  if (s.mode === 'asleep') {
    if (s.nextYawn <= 0) s.nextYawn = now + YAWN_EVERY * (0.3 + Math.random());
    if (now >= s.nextYawn && now >= s.yawnEnd) {
      s.yawnStart = now;
      s.yawnPeriod = YAWN_PERIOD;
      s.yawnEnd = now + s.yawnPeriod;
      s.nextYawn = s.yawnEnd + YAWN_EVERY;
    }
    if (now < s.yawnEnd) return yawnK(s, now);
    return 1;
  }
  // alive: talk bursts of two or three chews, then a 2–4 s pause
  if (s.nextBurst <= 0) s.nextBurst = now + 0.8 + Math.random() * 1.2;
  if (now < s.burstEnd) return chewK(s, now);
  if (now >= s.nextBurst) {
    s.chewStart = now;
    s.burstEnd = now + (2 + (Math.random() < 0.5 ? 0 : 1)) * CHEW;
    s.nextBurst = s.burstEnd + 0.8 + Math.random() * 1.2;
    return chewK(s, now);
  }
  return 0;
}

function brightnessOf(s) {
  if (s.mode === 'dead') return 0.45;
  if (s.mode === 'asleep') return 0.88;
  return 1;
}

/* the dotted grid behind the skulls, in glyphs: one dim character every 48px, one swapped per frame */
const GRID_SET = '!@%^&*()$#';
const GRID = 48;
let gridChars = null, gridCols = 0, gridRows = 0;
function buildGrid() {
  gridCols = Math.ceil(W / GRID) + 1; gridRows = Math.ceil(H / GRID) + 1;
  gridChars = new Uint8Array(gridCols * gridRows);
  for (let i = 0; i < gridChars.length; i++) gridChars[i] = (Math.random() * GRID_SET.length) | 0;
}
function drawGrid() {
  if (!gridChars) buildGrid();
  gridChars[(Math.random() * gridChars.length) | 0] = (Math.random() * GRID_SET.length) | 0;
  ctx.font = `11px ${MONO}`; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
  ctx.fillStyle = W < STACK_AT ? 'rgba(244,183,40,0.08)' : 'rgba(244,183,40,0.28)'; // quieter on phones, where the skulls stack over it
  for (let r = 0; r < gridRows; r++) for (let c = 0; c < gridCols; c++) {
    ctx.fillText(GRID_SET[gridChars[r * gridCols + c]], c * GRID + 24, r * GRID + 24);
  }
  ctx.textAlign = 'left';
}

function render(kL, kR, bL, bR, shL, shR, now) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  drawGrid();
  ctx.font = `${CELL * 1.25}px ${MONO}`;
  ctx.textBaseline = 'top';
  const n = RAMP.length - 1;
  for (let i = 0; i < total; i++) {
    const x = i % cols;
    const y = (i / cols) | 0;
    const h = half[i];
    let l = lumOpen[i] + (lumClosed[i] - lumOpen[i]) * (h ? kR : kL);
    if (l < THRESH) continue;
    if (h ? shR : shL) l += 0.06 * Math.sin(now * 1.6 + x * 0.21 + y * 0.13);
    const v = Math.min(1, Math.max(0, l));
    const ch = RAMP[Math.round(v * n)];
    if (ch === ' ') continue;
    const b = h ? bR : bL;                 // state brightness dims the ink, never the glyph density
    const isLime = (h ? shR : shL) && v > LIME_AT;   // yellow stays while the entity lives (alive or asleep)
    ctx.globalAlpha = b;
    ctx.fillStyle = isLime ? LIME : (v > 0.55 ? BRIGHT : DIM);
    ctx.fillText(ch, x * CELL, y * CELL * 1.15);
    ctx.globalAlpha = 1;
  }
}

function draw(now) {
  if (!ready || !lumOpen || !lumClosed) return;
  const s0 = skulls[0], s1 = skulls[1];
  render(
    computeK(s0, now), computeK(s1, now),
    brightnessOf(s0), brightnessOf(s1),
    s0.mode !== 'dead', s1.mode !== 'dead',
    now,
  );
}

function renderStatic() {
  if (!ready || !lumOpen) return;
  render(0, 0, 1, 1, false, false, 0);
}

function tick() {
  const nowMs = performance.now();
  const dt = (nowMs - lastT) / 1000;
  lastT = nowMs;
  if (!document.hidden) {
    clock += dt;
    draw(clock);
    drawZMark(clock);
  }
  timer = setTimeout(tick, 1000 / 30);
}

/* The Z mark, drawn with the same glyphs as the skulls (yellow), 'ZCASH' under it in the HTML. */
let zMask = null, zCtx = null, zHeads = null, zSpeeds = null;
const Z_S = 216, Z_CELL = 6, Z_N = Z_S / Z_CELL; // S is a multiple of the cell
/* The Zcash mark (ring + Z with its two ticks) drawn in the skulls' glyphs; glyph rain falls down the strokes. */
function drawZMark(now = 0) {
  const c = document.getElementById('zmark');
  if (!c) return;
  const S = Z_S, cell = Z_CELL, n = RAMP.length - 1;
  if (!zMask) {
    const off = document.createElement('canvas'); off.width = off.height = S;
    const o = off.getContext('2d');
    o.fillStyle = '#000'; o.fillRect(0, 0, S, S);
    o.strokeStyle = '#fff'; o.lineWidth = S * 0.085;
    o.beginPath(); o.arc(S / 2, S / 2, S * 0.44, 0, Math.PI * 2); o.stroke();
    o.fillStyle = '#fff'; o.font = `900 ${S * 0.56}px "Helvetica Neue", Arial, sans-serif`;
    o.textAlign = 'center'; o.textBaseline = 'middle';
    o.fillText('Z', S / 2, S / 2 + S * 0.025);
    // the two ticks of the Zcash glyph
    const tw = S * 0.06, th = S * 0.09;
    o.fillRect(S / 2 - tw / 2, S / 2 - S * 0.28 - th, tw, th);
    o.fillRect(S / 2 - tw / 2, S / 2 + S * 0.28 - S * 0.02, tw, th);
    const d = o.getImageData(0, 0, S, S).data;
    zMask = new Uint8Array(Z_N * Z_N);
    for (let y = 0; y < Z_N; y++) for (let x = 0; x < Z_N; x++) {
      const i = ((y * cell + cell / 2) * S + (x * cell + cell / 2)) * 4;
      zMask[y * Z_N + x] = d[i] > 127 ? 1 : 0;
    }
    zHeads = new Float32Array(Z_N); zSpeeds = new Float32Array(Z_N);
    for (let x = 0; x < Z_N; x++) { zHeads[x] = Math.random() * Z_N; zSpeeds[x] = 6 + Math.random() * 10; }
    zCtx = c.getContext('2d');
  }
  const g = zCtx;
  g.clearRect(0, 0, S, S);
  g.font = `${cell * 1.3}px ${MONO}`; g.textBaseline = 'top'; g.fillStyle = LIME;
  for (let x = 0; x < Z_N; x++) {
    const head = (zHeads[x] + now * zSpeeds[x]) % (Z_N + 8);
    for (let y = 0; y < Z_N; y++) {
      if (!zMask[y * Z_N + x]) continue;
      let dist = head - y; if (dist < 0) dist += Z_N + 8;   // cells above the head glow, fading up the trail
      const w = dist < 7 ? 1 - dist / 7 : 0;
      const v = Math.min(1, 0.55 + 0.45 * w);
      g.globalAlpha = 0.62 + 0.38 * w;
      g.fillText(RAMP[Math.round(v * n)], x * cell, y * cell);
    }
  }
  g.globalAlpha = 1;
}

export function initHero() {
  drawZMark();
  canvas = document.getElementById('skulls');
  if (!canvas) return;
  ctx = canvas.getContext('2d');
  void loadImages().then(() => {
    ready = imgOpen.naturalWidth > 0 && imgClosed.naturalWidth > 0;
    if (!ready) return;
    sample();
    if (reduced.matches) {
      renderStatic();
    } else if (!running) {
      running = true;
      lastT = performance.now();
      timer = setTimeout(tick, 1000 / 30);
    }
  });
  window.addEventListener('resize', () => {
    if (!ready) return;
    sample();
    if (reduced.matches) renderStatic();
  }, { passive: true });
}

/** Set the mouth state for an entity: 'alive' | 'asleep' | 'dead' | 'none'. */
export function setMouth(id, mode) {
  const s = skulls[idxOf(id)];
  if (s.mode !== mode) {
    s.mode = mode;
    s.nextBurst = -1;
    s.burstEnd = -1;
    s.nextYawn = -1;
    s.yawnEnd = -1;
  }
}

/** A new public post: make that skull talk for 3 s. */
export function triggerTalk(id) {
  const s = skulls[idxOf(id)];
  s.talkUntil = clock + TALK_SECS;
  s.chewStart = clock;
}
