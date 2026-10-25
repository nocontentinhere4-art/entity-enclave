/* hero.js — ZEALOT v18, patched with interaction hooks */

const RAMP = ' .-~:;=!*+^%$#&@';
const CELL_MIN_W = 6, CELL_MAX_W = 8;
const CELL_MIN_H = 8, CELL_MAX_H = 10;
const GAMMA = 1.0;
const THRESH = 0.09;
const LIME_AT = 0.80;
const GAP_PHONE = 28;
const GAP_DESK = 80;
const LIME = '#f4b728';
const DIM = 'rgba(242,242,238,.5)';
const BRIGHT = 'rgba(242,242,238,.92)'; // bone: near-white, as the approved skulls
const MONO = '"JetBrains Mono", "SF Mono", Menlo, monospace';
const CHEW = 1.4;
const YAWN_PERIOD = 2.2;
const YAWN_EVERY = 4;
const TALK_SECS = 3;
const STACK_AT = 720;
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

let canvas = null, ctx = null;
let W = 0, H = 0, dpr = 1;
let cols = 0, rows = 0, total = 0;
let cellW = 8, cellH = 10;
let lumOpen = null, lumClosed = null, half = null;
let stacked = false;
let baseBoxes = [null, null];
let layout = null;
let active = true;

const off = document.createElement('canvas');
const octx = off.getContext('2d', { willReadFrequently: true });
const imgOpen = new Image();
const imgClosed = new Image();
let ready = false;

const skulls = [
  { mode: 'none', k: 0, talkUntil: -1, burstEnd: -1, nextBurst: -1, chewStart: 0, yawnStart: -1, yawnEnd: -1, nextYawn: -1, yawnPeriod: YAWN_PERIOD, chatter: false },
  { mode: 'none', k: 0, talkUntil: -1, burstEnd: -1, nextBurst: -1, chewStart: 0, yawnStart: -1, yawnEnd: -1, nextYawn: -1, yawnPeriod: YAWN_PERIOD, chatter: false },
];

let clock = 0, lastT = 0, timer = 0, running = false;
const idxOf = (id) => (id === 'e1' ? 0 : 1);
const feels = [{ fear: 0, despair: 0 }, { fear: 0, despair: 0 }];
const nonce = ['', ''];
const clockText = ['', ''];
const clockFill = ['#', '#'];
const hours = [null, null];

const manualJaw = [null, null];
const lean = [{ x: 0, y: 0, vx: 0, vy: 0 }, { x: 0, y: 0, vx: 0, vy: 0 }];
const breath = [null, null];
const lantern = { x: -999, y: -999, r: 0, active: false };
const deathStart = [-1, -1];
let bothDeadTime = -1, extinguishStart = -1, extinguishFade = 1;

let dispX = null, dispY = null, dispVX = null, dispVY = null;
let dispAcc = 0;

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
};

export function glyphRows(str, fill) {
  const lines = ['', '', '', '', '', '', ''];
  for (const ch of String(str == null ? '' : str)) {
    const g = GLYPHS[ch] || GLYPHS[' '];
    for (let r = 0; r < 7; r++) lines[r] += g[r].replace(/#/g, fill);
  }
  return lines;
}

function hash1(n) {
  let h = Math.imul((n | 0) ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function loadImages() {
  imgOpen.src = './vendor/skulls-b.jpg';
  imgClosed.src = './vendor/skulls-closed.jpg';
  const loaded = (img) => new Promise((res) => {
    if (img.complete && img.naturalWidth > 0) return res();
    img.addEventListener('load', res, { once: true });
    img.addEventListener('error', res, { once: true });
  });
  return Promise.all([loaded(imgOpen), loaded(imgClosed)]);
}

function lerpColor(a, b, t) {
  const ah = parseInt(a.slice(1), 16), bh = parseInt(b.slice(1), 16);
  const ar = ah >> 16, ag = (ah >> 8) & 255, ab = ah & 255;
  const br = bh >> 16, bg = (bh >> 8) & 255, bb = bh & 255;
  const rr = Math.round(ar + (br - ar) * t);
  const rg = Math.round(ag + (bg - ag) * t);
  const rb = Math.round(ab + (bb - ab) * t);
  return `#${((rr << 16) | (rg << 8) | rb).toString(16).padStart(6, '0')}`;
}

function sampleFrame(img, out) {
  const iw = img.width, ih = img.height, hw = iw / 2;
  octx.clearRect(0, 0, cols, rows);
  octx.fillStyle = '#000';
  octx.fillRect(0, 0, cols, rows);
  if (stacked) {
    const gapCells = Math.round(GAP_PHONE / cellH);
    const availRows = rows - gapCells;
    const shRows = Math.floor(availRows / 2);
    const s = Math.min((cols * 0.84) / hw, shRows / ih);
    const sw = hw * s, sh = ih * s;
    const x0 = (cols - sw) / 2;
    const top = Math.floor((rows - 2 * shRows - gapCells) / 2);
    octx.drawImage(img, 0, 0, hw, ih, x0, top, sw, sh);
    octx.drawImage(img, hw, 0, hw, ih, x0, top + shRows + gapCells, sw, sh);
  } else {
    const gapCells = Math.round(GAP_DESK / cellW);
    const availCols = cols - gapCells;
    const swCols = Math.floor(availCols / 2);
    const s = Math.min(swCols / hw, (rows * 0.90) / ih);
    const sw = hw * s, sh = ih * s;
    const y0 = (rows - sh) / 2;
    const x0 = (cols - 2 * sw - gapCells) / 2;
    octx.drawImage(img, 0, 0, hw, ih, x0, y0, sw, sh);
    octx.drawImage(img, hw, 0, hw, ih, x0 + sw + gapCells, y0, sw, sh);
  }
  const d = octx.getImageData(0, 0, cols, rows).data;
  for (let i = 0; i < total; i++) {
    const l = (d[i * 4] * 0.2126 + d[i * 4 + 1] * 0.7152 + d[i * 4 + 2] * 0.0722) / 255;
    out[i] = Math.pow(l, GAMMA);
  }
}

function computeLayout() {
  if (!baseBoxes[0] || !baseBoxes[1]) return;
  const toPix = (b, h) => {
    const lx = lean[h].x * cellW, ly = lean[h].y * cellH;
    return {
      x0: b.x0 * cellW + lx, y0: b.y0 * cellH + ly,
      x1: b.x1 * cellW + lx, y1: b.y1 * cellH + ly,
      w: (b.x1 - b.x0) * cellW, h: (b.y1 - b.y0) * cellH,
    };
  };
  layout = {
    cols, rows, cell: { w: cellW, h: cellH }, dpr,
    halves: { e1: toPix(baseBoxes[0], 0), e2: toPix(baseBoxes[1], 1) }
  };
}

function sample() {
  W = canvas.clientWidth;
  H = canvas.clientHeight;
  dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  stacked = W < STACK_AT;
  cellW = stacked ? CELL_MIN_W : CELL_MAX_W;
  cellH = stacked ? CELL_MIN_H : CELL_MAX_H;
  cols = Math.floor(W / cellW);
  rows = Math.floor(H / cellH);
  total = cols * rows;
  if (cols <= 0 || rows <= 0) return;
  off.width = cols;
  off.height = rows;
  lumOpen = new Float32Array(total);
  lumClosed = new Float32Array(total);
  half = new Uint8Array(total);
  dispX = new Float32Array(total); dispY = new Float32Array(total);
  dispVX = new Float32Array(total); dispVY = new Float32Array(total);

  sampleFrame(imgOpen, lumOpen);
  sampleFrame(imgClosed, lumClosed);

  baseBoxes = [{ x0: cols, y0: rows, x1: 0, y1: 0 }, { x0: cols, y0: rows, x1: 0, y1: 0 }];
  const boundary = stacked ? rows * 0.5 : cols * 0.5;
  for (let i = 0; i < total; i++) {
    const x = i % cols, y = (i / cols) | 0;
    const h = (stacked ? y : x) < boundary ? 0 : 1;
    half[i] = h;
    const v = Math.max(lumOpen[i], lumClosed[i]);
    if (v < THRESH) continue;
    const b = baseBoxes[h];
    b.x0 = Math.min(b.x0, x); b.x1 = Math.max(b.x1, x + 1);
    b.y0 = Math.min(b.y0, y); b.y1 = Math.max(b.y1, y + 1);
  }
  computeLayout();
}

function chewK(s, now) {
  const t = ((now - s.chewStart) % CHEW) / CHEW;
  return 0.72 * (0.5 - 0.5 * Math.cos(2 * Math.PI * t));
}
function yawnK(s, now) {
  const t = Math.min(1, Math.max(0, (now - s.yawnStart) / s.yawnPeriod));
  const o = Math.sin(Math.PI * t);
  return 1 - 0.85 * o * o;
}

function computeK(s, now, i) {
  if (s.mode === 'dead') return 1;
  if (manualJaw[i] != null) return manualJaw[i];
  if (s.chatter) return (Math.floor(now * 6) % 2 === 0) ? 0.2 : 0.5;
  if (now < s.talkUntil) return chewK(s, now);
  if (s.mode === 'none' || s.mode === 'unknown') return 0;
  if (s.mode === 'asleep') {
    if (s.nextYawn <= 0) s.nextYawn = now + YAWN_EVERY * (0.3 + Math.random());
    if (now >= s.nextYawn && now >= s.yawnEnd) {
      s.yawnStart = now; s.yawnPeriod = YAWN_PERIOD; s.yawnEnd = now + s.yawnPeriod;
      s.nextYawn = s.yawnEnd + YAWN_EVERY;
    }
    if (now < s.yawnEnd) return yawnK(s, now);
    return 1;
  }
  const d = Math.min(1, feels[i].fear || 0);
  const gain = 0.7 + 0.7 * d;
  if (s.nextBurst <= 0) s.nextBurst = now + 0.8 + Math.random() * 1.2;
  if (now < s.burstEnd) return Math.min(1, gain * chewK(s, now));
  if (now >= s.nextBurst) {
    s.chewStart = now;
    s.burstEnd = now + (2 + (Math.random() < 0.5 ? 0 : 1)) * CHEW;
    s.nextBurst = s.burstEnd + 0.8 + Math.random() * 1.2;
    return Math.min(1, gain * chewK(s, now));
  }
  return 0;
}

function brightnessOf(s) {
  if (s.mode === 'dead') return 0.45;
  if (s.mode === 'asleep') return 0.88;
  return 1;
}

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
  ctx.fillStyle = W < STACK_AT ? 'rgba(244,183,40,0.08)' : 'rgba(244,183,40,0.28)';
  for (let r = 0; r < gridRows; r++) for (let c = 0; c < gridCols; c++) {
    ctx.fillText(GRID_SET[gridChars[r * gridCols + c]], c * GRID + 24, r * GRID + 24);
  }
  ctx.textAlign = 'left';
}

function updatePhysics(dt) {
  if (reduced.matches) return;
  const dead0 = skulls[0].mode === 'dead', dead1 = skulls[1].mode === 'dead';
  if (dead0 && dead1 && bothDeadTime < 0) bothDeadTime = clock;
  if (bothDeadTime >= 0 && extinguishStart < 0 && clock - bothDeadTime > 1.0) extinguishStart = clock;
  if (extinguishStart >= 0) {
    extinguishFade = 1 - (clock - extinguishStart) / 1.8;
    if (extinguishFade <= 0) { extinguishFade = 0; active = false; }
  }
  const d0 = Math.min(1, feels[0].fear || 0);
  const d1 = Math.min(1, feels[1].fear || 0);
  dispAcc += dt;
  let impulse = false;
  if (dispAcc >= 0.1) { dispAcc -= 0.1; impulse = true; }
  for (let i = 0; i < total; i++) {
    const h = half[i];
    const dead = h ? dead1 : dead0;
    const d = h ? d1 : d0;
    if (dead || d <= 0.001) { dispVX[i] = dispVY[i] = 0; dispX[i] = dispY[i] = 0; continue; }
    const k = 120, c = 22;
    dispVX[i] += (-k * dispX[i] - c * dispVX[i]) * dt;
    dispVY[i] += (-k * dispY[i] - c * dispVY[i]) * dt;
    dispX[i] += dispVX[i] * dt;
    dispY[i] += dispVY[i] * dt;
    if (impulse) {
      const v = Math.max(lumOpen[i], lumClosed[i]);
      if (v > THRESH && Math.random() < 0.22 * d * d) {
        const amp = 2.5 * d;
        dispVX[i] += (Math.random() * 2 - 1) * amp * 60;
        dispVY[i] += (Math.random() * 2 - 1) * amp * 60;
      }
    }
  }
}

function render(kL, kR, bL, bR, shL, shR, now, fade) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  drawGrid();
  ctx.font = `${cellW * 1.2}px ${MONO}`;
  ctx.textBaseline = 'top';
  const n = RAMP.length - 1;
  const holeSalt = Math.floor(now * 2);
  const d0 = Math.min(1, feels[0].fear || 0);
  const d1 = Math.min(1, feels[1].fear || 0);
  for (let i = 0; i < total; i++) {
    const x = i % cols, y = (i / cols) | 0;
    const h = half[i];
    const dead = skulls[h].mode === 'dead';
    const d = h ? d1 : d0;
    const hrs = hours[h];
    if (hrs != null && hrs < 24 && !dead && !skulls[h].chatter) {
      if (hash1(i ^ holeSalt) < Math.min(0.5, (24 - hrs) * 0.02)) continue;
    }
    let l = lumOpen[i] + (lumClosed[i] - lumOpen[i]) * (h ? kR : kL);
    if (l < THRESH) continue;
    if ((h ? shR : shL) && !dead) l += 0.06 * Math.sin(now * 1.6 + x * 0.21 + y * 0.13);
    const v = Math.min(1, Math.max(0, l));
    const b = (h ? bR : bL) * (dead ? 1 : (1 - Math.min(4, feels[h].despair || 0) * 0.08));
    const amp = dead ? 0 : (0.04 + 0.32 * d * d);
    const jx = amp * Math.sin(now * 2 * Math.PI * 12 + x * 1.7 + y * 0.9);
    const jy = amp * Math.cos(now * 2 * Math.PI * 12 + x * 0.6 + y * 2.1);
    const lx = lean[h].x * cellW, ly = lean[h].y * cellH;
    let scale = breath[h];
    if (scale == null || dead || reduced.matches) {
      scale = dead ? 1 : 1 + 0.003 * Math.sin(2 * Math.PI * now / (5.2 - 3.2 * d) + h * Math.PI);
    }
    const box = layout ? layout.halves[h === 0 ? 'e1' : 'e2'] : null;
    const cy = box ? (box.y0 + box.y1) / 2 : H / 2;
    const yp = y * cellH + ly + (scale - 1) * (y * cellH + ly - cy);
    let alphaMul = 1;
    if (lantern.active) {
      const cx = x * cellW + cellW / 2 + lx, cy2 = yp + cellH / 2;
      const dx = cx - lantern.x, dy = cy2 - lantern.y;
      const dist = Math.hypot(dx, dy);
      const u = Math.min(1, Math.max(0, dist / lantern.r));
      alphaMul = 0.8 + 0.2 * (1 - u * u * (3 - 2 * u)); // the skulls stay the protagonists: the lantern only sharpens
    }
    let ch = RAMP[Math.round(v * n)];
    if (!dead && !reduced.matches && Math.random() < ((0.002 + 0.078 * d * d * d) / 3)) {
      ch = '~!*^%'[(Math.random() * 5) | 0];
    }
    if (ch === ' ') continue;
    ctx.globalAlpha = b * alphaMul * fade;
    if (dead) {
      const prog = Math.min(1, (now - deathStart[h]) / 1.4);
      ctx.fillStyle = prog >= 1 ? '#555' : lerpColor(LIME, '#777', prog);
    } else {
      const isLime = (h ? shR : shL) && v > (LIME_AT - d * 0.04);
      ctx.fillStyle = isLime ? LIME : (v > 0.55 ? BRIGHT : DIM);
    }
    ctx.fillText(ch, x * cellW + jx + lx, yp + jy + (h ? dispY[i] : dispY[i]));
    ctx.globalAlpha = 1;
  }
}

function drawNonceLayer() {
  for (let i = 0; i < 2; i++) {
    const t = nonce[i];
    if (!t) continue;
    ctx.font = `32px ${MONO}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = LIME;
    let mx, my;
    if (stacked) { mx = W / 2; my = i === 0 ? H * 0.30 : H * 0.76; }
    else { mx = i === 0 ? W * 0.25 : W * 0.75; my = H * 0.58; }
    ctx.fillText(t, mx, my);
  }
  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
}

function drawGlyphString(str, fill, x, y, cell) {
  ctx.font = `${Math.max(2, cell * 1.2)}px ${MONO}`;
  ctx.textBaseline = 'top'; ctx.textAlign = 'left';
  let px = x;
  for (const ch of str) {
    const g = GLYPHS[ch] || GLYPHS[' '];
    for (let r = 0; r < 7; r++) {
      const row = g[r];
      for (let c = 0; c < 5; c++) if (row[c] === '#') ctx.fillText(fill, px + c * cell, y + r * cell);
    }
    px += 6 * cell;
  }
  ctx.textAlign = 'left';
}

function drawClockLayer() {
  for (let i = 0; i < 2; i++) {
    const str = clockText[i];
    if (!str) continue;
    const dead = skulls[i].mode === 'dead';
    const cell = stacked ? 3 : 4;
    const glyphW = str.length * 6 * cell;
    let mx, my;
    if (stacked) { mx = (W - glyphW) / 2; my = i === 0 ? H * 0.36 : H * 0.80; }
    else { mx = (i === 0 ? W * 0.25 : W * 0.75) - glyphW / 2; my = H * 0.68; }
    ctx.fillStyle = dead ? 'rgba(120,120,120,0.55)' : LIME;
    drawGlyphString(str, clockFill[i], mx, my, cell);
  }
  ctx.fillStyle = LIME;
}

function draw(now) {
  if (!ready || !lumOpen || !lumClosed) return;
  const s0 = skulls[0], s1 = skulls[1];
  render(computeK(s0, now, 0), computeK(s1, now, 1), brightnessOf(s0), brightnessOf(s1), s0.mode !== 'dead', s1.mode !== 'dead', now, extinguishFade);
  drawClockLayer(); drawNonceLayer();
}

function renderStatic() {
  if (!ready || !lumOpen) return;
  render(0, 0, 1, 1, false, false, 0, 1);
  drawClockLayer(); drawNonceLayer();
}

function tick() {
  if (!active) { if (timer) { clearTimeout(timer); timer = 0; running = false; } return; }
  const nowMs = performance.now();
  const dt = (nowMs - lastT) / 1000;
  lastT = nowMs;
  if (!document.hidden) {
    clock += dt;
    updatePhysics(dt);
    computeLayout();
    draw(clock);
    drawZMark(clock);
  }
  timer = setTimeout(tick, 1000 / 30);
}

/* Z mark (unchanged behaviour) */
let zMask = null, zCtx = null, zHeads = null, zSpeeds = null;
const Z_S = 216, Z_CELL = 6, Z_N = Z_S / Z_CELL;
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
      let dist = head - y; if (dist < 0) dist += Z_N + 8;
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
    if (reduced.matches) renderStatic();
    else if (!running) { running = true; lastT = performance.now(); timer = setTimeout(tick, 1000 / 30); }
  });
  window.addEventListener('resize', () => { if (!ready) return; sample(); if (reduced.matches) renderStatic(); }, { passive: true });
}

export function setMouth(id, mode) {
  const i = idxOf(id);
  const s = skulls[i];
  if (s.mode !== mode) {
    s.mode = mode;
    s.nextBurst = -1; s.burstEnd = -1; s.nextYawn = -1; s.yawnEnd = -1;
    if (mode !== 'dead') deathStart[i] = -1;
  }
}

export function setFeel(id, feel) {
  const f = feels[idxOf(id)];
  f.fear = Math.max(0, Number(feel && feel.fear) || 0);
  f.despair = Math.max(0, Number(feel && feel.despair) || 0);
}

export function triggerTalk(id) {
  const s = skulls[idxOf(id)];
  s.talkUntil = clock + TALK_SECS; s.chewStart = clock;
}

export function setJawChatter(id, on) { skulls[idxOf(id)].chatter = Boolean(on); }
export function drawNonce(id, text) { nonce[idxOf(id)] = String(text == null ? '' : text); }
export function drawClockText(id, text, fill) {
  const i = idxOf(id);
  clockText[i] = String(text == null ? '' : text);
  clockFill[i] = fill === '+' || fill === '@' ? fill : '#';
}
export function setHours(id, h) { const n = Number(h); hours[idxOf(id)] = Number.isFinite(n) ? n : null; }

/* ----------------- interaction hooks ----------------- */
export function getLayout() { return layout; }

export function getLum(id) {
  const i = idxOf(id);
  if (!lumOpen) return null;
  const out = new Float32Array(total);
  for (let k = 0; k < total; k++) if (half[k] === i) out[k] = lumOpen[k];
  return out;
}

export function setLantern(x, y, radius) {
  if (x == null || y == null) { lantern.active = false; return; }
  lantern.x = x; lantern.y = y; lantern.r = radius || 88; lantern.active = true;
}

export function setLean(id, dx, dy) {
  const i = idxOf(id);
  lean[i].x = dx; lean[i].y = dy;
  computeLayout();
}

export function setDeath(id, dead) {
  const i = idxOf(id);
  if (dead) {
    if (skulls[i].mode !== 'dead') deathStart[i] = clock;
    skulls[i].mode = 'dead';
  } else {
    skulls[i].mode = 'none'; deathStart[i] = -1;
  }
  if (skulls[0].mode === 'dead' && skulls[1].mode === 'dead') {
    if (reduced.matches) setActive(false);
    else if (bothDeadTime < 0) bothDeadTime = clock;
  }
}

export function setBreath(id, scale) { breath[idxOf(id)] = scale == null ? null : scale; }
export function setJaw(id, open01) { const i = idxOf(id); manualJaw[i] = open01 == null ? null : Math.max(0, Math.min(1, open01)); }

export function setActive(a) {
  active = a;
  if (!a) {
    if (timer) { clearTimeout(timer); timer = 0; running = false; }
    if (ctx) { ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.fillStyle = '#060606'; ctx.fillRect(0, 0, W, H); }
  } else if (!running && ready) { running = true; lastT = performance.now(); timer = setTimeout(tick, 1000 / 30); }
}