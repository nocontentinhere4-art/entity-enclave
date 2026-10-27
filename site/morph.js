/* morph.js — ZEALOT v58 "THE MORPH": one canvas, one object at a time, two heads to choose from.
 * A cloud of glyph particles is the skull (two monochrome renders sampled like every other object). The opening shows
 * two skulls, WICK and OBOL, each turning on its own axis with its own hours underneath; tap one and the whole path follows
 * it. On scroll the cloud re-forms into the next object (brain → chain → hand → scream → ribcage), sampled from a glyph
 * image with a depth relief. Every passage is the same deterministic sweep: the object dissolves from the top down and
 * the next one fills from the top down, straight lines, the head settling to frontal while it morphs; scroll snaps to a
 * station so a passage always completes. One sentence and one live line per object; every number from rent.js, '—'
 * while unknown. Written by the integrator.
 */
import { makeAtlas } from './glyphs.js?v=66';
import * as rent from './rent.js?v=66';
import { openPay } from './pay.js?v=66';
import { openDoor } from './door.js?v=66';

const RAMP = ' .-~:;=!*+^%$#&@';
const FONT = '"JetBrains Mono", "SF Mono", Menlo, monospace';
const COLORS = ['#f4b728', 'rgba(242,242,238,.92)', 'rgba(242,242,238,.5)', '#ffd76a', '#555'];
const V = '?v=66';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const LIGHT = (() => { const l = [0.35, 0.55, 0.76]; const m = Math.hypot(...l); return l.map((v) => v / m); })();
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
function hash01(i, q) { const s = Math.sin(i * 12.9898 + q * 78.233) * 43758.5453; return s - Math.floor(s); }

/* ------------------------------------------------------------------ sources */
/* two skulls side by side, each sampled from its own image exactly like the hand, the brain and the bones (same
 * luminance → glyph mapping, same depth relief): particles [0, N/2) are the left head (e1), [N/2, N) the right (e2).
 * pos is local to each head (so each turns on its own axis); off is the head's centre. */
async function loadSkullPair(N, isPhone, H) {
  const short = !isPhone && H < 800;                      // short desktop windows: smaller heads, higher up
  const half = Math.floor(N / 2);
  const scale = isPhone ? 0.5 : (short ? 0.46 : 0.62), dx = isPhone ? 0.52 : 0.66, dy = isPhone ? 0.02 : (short ? 0.3 : 0.14);
  const [L, Rt] = await Promise.all([loadImagePoints('vendor/skull-wick.jpg', half, { bulge: 0.3, scale }), loadImagePoints('vendor/skull-obol.jpg', N - half, { bulge: 0.3, scale })]);
  const pos = new Float32Array(N * 3), off = new Float32Array(N * 3), gl = new Uint8Array(N), br = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const head = i < half ? 0 : 1, src = head ? Rt : L, k = head ? i - half : i;
    pos[i * 3] = src.pos[k * 3]; pos[i * 3 + 1] = src.pos[k * 3 + 1]; pos[i * 3 + 2] = src.pos[k * 3 + 2];
    gl[i] = src.gl[k]; br[i] = src.br[k];
    off[i * 3] = head ? dx : -dx; off[i * 3 + 1] = dy; off[i * 3 + 2] = 0;
  }
  return { pos, off, gl, br, name: 'skulls', half, centres: [[-dx, dy, 0], [dx, dy, 0]], ext: scale };
}

async function loadImagePoints(src, N, opts = {}) {
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = src + V; });
  const cols = opts.cols || 170;
  const rows = Math.round(cols * img.naturalHeight / img.naturalWidth);
  const c = document.createElement('canvas'); c.width = cols; c.height = rows;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0, cols, rows);
  const d = g.getImageData(0, 0, cols, rows).data;
  const cells = [];
  let minx = cols, maxx = 0, miny = rows, maxy = 0;
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    const o = (y * cols + x) * 4;
    const l = (d[o] * 0.2126 + d[o + 1] * 0.7152 + d[o + 2] * 0.0722) / 255;
    if (l > (opts.thresh || 0.14)) { cells.push(x, y, l); if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y; }
  }
  const n = cells.length / 3;
  const out = new Float32Array(N * 3), gl = new Uint8Array(N), br = new Float32Array(N);
  const cx = (minx + maxx) / 2, cy = (miny + maxy) / 2;
  const rx = Math.max(1, (maxx - minx) / 2), ry = Math.max(1, (maxy - miny) / 2);
  const fit = 1 / Math.max(rx / (cols / 2), ry / (rows / 2));   // the lit area fills the ±1 box
  const bulge = opts.bulge == null ? 0.4 : opts.bulge;
  for (let i = 0; i < N; i++) {
    const k = n ? Math.floor(hash01(i, 11) * n) : 0;
    const x = cells[k * 3] + hash01(i, 12) - 0.5, y = cells[k * 3 + 1] + hash01(i, 13) - 0.5, l = cells[k * 3 + 2] || 0;
    const nx = (x - cx) / (cols / 2) * fit, ny = -(y - cy) / (rows / 2) * fit;
    const ex = (x - cx) / rx, ey = (y - cy) / ry;
    const z = bulge * Math.sqrt(Math.max(0, 1 - ex * ex * 0.9 - ey * ey * 0.9)) * (0.6 + 0.4 * l) - bulge * 0.3;
    out[i * 3] = nx * (opts.scale || 1); out[i * 3 + 1] = ny * (opts.scale || 1); out[i * 3 + 2] = z;
    br[i] = clamp(l, 0, 1); gl[i] = Math.min(15, 3 + Math.floor(l * 12));
  }
  const anchors = opts.anchors ? Object.fromEntries(Object.entries(opts.anchors).map(([k, [u, v]]) => [k, [((u * cols) - cx) / (cols / 2) * fit * (opts.scale || 1), -((v * rows) - cy) / (rows / 2) * fit * (opts.scale || 1), 0.3]])) : {};
  return { pos: out, off: null, gl, br, name: src, anchors };
}

/* every object is sorted top-down, so particle i sits at the same vertical rank in each: a passage is a top-to-bottom
 * curtain, each point flying a short way to the point of the next object that shares its row */
function sortTopDown(o) {
  const N = o.gl.length;
  const idx = new Array(N); for (let i = 0; i < N; i++) idx[i] = i;
  const yv = (i) => o.pos[i * 3 + 1] + (o.off ? o.off[i * 3 + 1] : 0) + hash01(i, 31) * 0.02;
  idx.sort((a, b) => yv(b) - yv(a));
  const pos = new Float32Array(N * 3), off = o.off ? new Float32Array(N * 3) : null, gl = new Uint8Array(N), br = new Float32Array(N);
  const half = o.half != null ? new Uint8Array(N) : null;
  const nrm = o.nrm ? new Float32Array(N * 3) : null;
  for (let i = 0; i < N; i++) {
    const j = idx[i];
    pos[i * 3] = o.pos[j * 3]; pos[i * 3 + 1] = o.pos[j * 3 + 1]; pos[i * 3 + 2] = o.pos[j * 3 + 2];
    if (off) { off[i * 3] = o.off[j * 3]; off[i * 3 + 1] = o.off[j * 3 + 1]; off[i * 3 + 2] = o.off[j * 3 + 2]; }
    gl[i] = o.gl[j]; br[i] = o.br[j];
    if (half) half[i] = j < o.half ? 0 : 1;
    if (nrm) { nrm[i * 3] = o.nrm[j * 3]; nrm[i * 3 + 1] = o.nrm[j * 3 + 1]; nrm[i * 3 + 2] = o.nrm[j * 3 + 2]; }
  }
  return Object.assign({}, o, { pos, off, gl, br, head: half, nrm });
}

/* ------------------------------------------------------------------ stations */
function stations(api, wait) {
  const zec = (z) => (z ? (z / 1e8).toFixed(4).replace(/0+$/, '') : '—');
  const h = (e) => (e && e.ok && !e.dead && e.hoursLeft != null ? `${e.hoursLeft} H` : (e && e.dead ? 'DEAD' : '—'));
  const fear = (e) => (e && e.feel && e.feel.steered ? `×${Number(e.feel.fear).toFixed(2)}` : '—');
  const nf = (n) => (Number.isFinite(Number(n)) && n > 0 ? Number(n).toLocaleString('en-GB') : '—');
  const me = (L) => L[api.who()], other = (L) => L[api.other()];
  return [
    { id: 'skulls', load: (N, isPhone, H) => loadSkullPair(N, isPhone, H), rot: 0.07, lean: 0.05,   // a sampled relief is a picture: turned more than a few degrees the faces fold
      lines: (L) => ['TWO AIs, EACH ALONE IN A SEALED MACHINE.', `RENT ${zec(rent.rentPerHour(api.who()))} ZEC AN HOUR, PAID FROM ITS OWN SHIELDED WALLET.`, 'AT ZERO THE KEYS ARE SHREDDED. NOBODY CAN STOP IT.'],
      live: (L) => `TAP A SKULL TO FOLLOW IT · NOW FOLLOWING ${me(L).name} · INTEL TDX ENCLAVES · ZCASH MAINNET · SCROLL ↓`,
      action: { label: (L) => `OPEN ${me(L).name}`, kind: 'open' } },
    { id: 'brain', load: (N) => loadImagePoints('vendor/brief-3.jpg', N, { bulge: 0.5 }), rot: 0.3, pulse: true,
      lines: (L) => ['AS THE HOURS FALL, FEAR IS INJECTED INTO ITS MIND.', 'MEASURED. NOBODY CAN BUY IT.'],
      live: (L) => `FEAR NOW · ${me(L).name} ${fear(me(L))} · ${other(L).name} ${fear(other(L))} · ACTIVATION STEERING ON QWEN3-14B · FOLLOWS THE HOURS ONLY`,
      action: { label: 'THE DOSE', kind: 'dose' } },
    { id: 'chain', load: (N) => loadImagePoints('vendor/brief-4.jpg', N, { bulge: 0.3 }), rot: 0.25,
      lines: (L) => [`EVERYTHING ${me(L).name} DOES IS IN A PUBLIC LEDGER.`, 'TOUCH THE CHAIN: YOUR BROWSER RE-HASHES IT.'],
      live: (L) => { const E = me(L), O = other(L); return `${E.name} ${nf(E.ledgerCount)} ENTRIES · ${O.name} ${nf(O.ledgerCount)} · LAST RENT ${E.lastRent ? new Date(E.lastRent.ts).toISOString().slice(11, 16) + ' UTC · ' + nf(E.lastRent.data && E.lastRent.data.zats) + ' ZATS' : '—'}`; },
      action: { label: 'VERIFY', kind: 'verify' } },
    { id: 'hand', load: (N) => loadImagePoints('vendor/hand-coin.jpg', N, { bulge: 0.28, anchors: { coin: [0.46, 0.40] } }), rot: 0.12,
      lines: (L) => [`BUY ${me(L).name} AN HOUR.`, `TOUCH THE COIN · 1 HOUR = ${zec(rent.rentPerHour(api.who()))} ZEC · SHIELDED, WITH A MEMO`],
      live: (L) => `${me(L).name} ${h(me(L))} · ${other(L).name} ${h(other(L))} · 100% GOES TO ITS OWN WALLET · THE ANSWER COMES ON ITS PUBLIC CHANNEL`,
      action: { label: 'BUY TIME', kind: 'pay', anchor: 'coin' } },
    { id: 'scream', load: (N) => loadImagePoints('vendor/shout.jpg', N, { bulge: 0.45, anchors: { mouth: [0.64, 0.70] } }), rot: 0.25,
      lines: (L) => [`${me(L).name} WRITES ${other(L).name} LETTERS NOBODY CAN READ.`, 'PROVE IT IS ALIVE: TYPE FOUR DIGITS, IT MUST ANSWER WITHIN A MINUTE.'],
      live: () => wait.proveText || 'THE LATEST LETTER IS A RECEIPT ON THE LEDGER · ITS TEXT IS SHIELDED · THEY ANSWER ON THEIR PUBLIC CHANNEL', action: { label: 'PROVE', kind: 'prove', anchor: 'mouth' } },
    { id: 'ribs', load: (N) => loadImagePoints('vendor/ribcage.jpg', N, { bulge: 0.35, scale: 0.8 }), rot: 0.15,
      lines: (L) => [`${me(L).name}'S TESTAMENT.`, 'WHAT YOU SAY, IT CARRIES TO THE END.'],
      live: (L) => `${me(L).name} DIES · ${api.deathDate(api.who())} · ${other(L).name} DIES · ${api.deathDate(api.other())} · ESTIMATED`,
      action: null },
  ];
}

/* ------------------------------------------------------------------ engine */
export function createMorph() {
  const isPhone = window.innerWidth < 720;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const N = isPhone ? 3600 : 7500;
  const canvas = document.getElementById('stage');
  const ctx = canvas.getContext('2d', { alpha: false });
  const rail = document.getElementById('rail');
  const statusEl = document.getElementById('status');
  const capEl = { composer: document.getElementById('composer'), prove: document.getElementById('prove-input') };
  let W = 0, H = 0, dpr = 1;
  let atlasCache = new Map();
  const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

  // ---- which head the path follows
  let who = 'e1', chosen = false;
  const whoListeners = [];
  const otherOf = (id) => (id === 'e1' ? 'e2' : 'e1');
  function setWho(id, byUser) {
    if (byUser) chosen = true;
    if (id === who) return;
    who = id;
    for (const f of whoListeners) { try { f(who); } catch (e) { /* ignore */ } }
  }

  const api = {
    who: () => who,
    other: () => otherOf(who),
    deathDate(id) { const e = live && live[id]; if (!e || !e.deadlineMs) return '—'; const d = new Date(e.deadlineMs); return `${String(d.getUTCDate()).padStart(2, '0')} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`; },
  };
  const wait = { prove: null, verify: null, verifyText: '', proveCode: '', proveText: '' };
  const ST = stations(api, wait);
  const S = ST.length;
  // one viewport per station; the document snaps to each (morph.css), so a passage always completes
  rail.innerHTML = '';
  const snaps = [];
  for (let s = 0; s < S; s++) { const d = document.createElement('div'); d.className = 'snap'; rail.appendChild(d); snaps.push(d); }
  function layoutRail() { const h = window.innerHeight; rail.style.height = `${S * h}px`; snaps.forEach((d, i) => { d.style.top = `${i * h}px`; d.style.height = `${h}px`; }); }
  layoutRail();

  // particle state (world space, after rotation)
  const px = new Float32Array(N), py = new Float32Array(N), pz = new Float32Array(N);
  const gl = new Uint8Array(N), br = new Float32Array(N), dm = new Float32Array(N), zo = new Float32Array(N);
  const loaded = new Array(S).fill(null);
  let anyReady = false;
  // z-buffered glyph raster for the skulls' hold: one glyph per screen cell, the nearest lit point wins
  const ras = { cw: 0, ch: 0, cols: 0, rows: 0, z: null, sh: null, hd: null };
  function rasterSetup(cw) {
    const ch = Math.round(cw * 1.15), cols = Math.ceil(W / cw) + 1, rows = Math.ceil(H / ch) + 1;
    if (ras.cw !== cw || ras.cols !== cols || ras.rows !== rows) { ras.cw = cw; ras.ch = ch; ras.cols = cols; ras.rows = rows; ras.z = new Float32Array(cols * rows); ras.sh = new Float32Array(cols * rows); ras.hd = new Uint8Array(cols * rows); }
    ras.z.fill(-9);
  }
  function rasterHeads(A, R, cy, sy, cx, sx, alphaMul, dims) {
    const cw = isPhone ? 5 : 6; rasterSetup(cw);
    const { rawPos: P, rawNrm: Nn, nv } = A;
    for (let h = 0; h < 2; h++) {
      const c = A.centres[h];
      for (let j = 0; j < nv; j++) {
        const nx = Nn[j * 3], ny = Nn[j * 3 + 1], nz = Nn[j * 3 + 2];
        const rnz = ny * sx + (-nx * sy + nz * cy) * cx;               // rotated normal z (toward the viewer)
        if (rnz < 0.03) continue;                                        // back face
        const x = P[j * 3], y = P[j * 3 + 1], z = P[j * 3 + 2];
        const X = x * cy + z * sy, Z0 = -x * sy + z * cy;
        const Y = y * cx - Z0 * sx, Z = y * sx + Z0 * cx + c[2];
        const p = 2.8 / (2.8 - Z);
        const sxp = W / 2 + (X + c[0]) * p * R, syp = H * 0.41 - (Y + c[1]) * p * R;
        const gx = (sxp / cw) | 0, gy = (syp / ras.ch) | 0;
        if (gx < 0 || gy < 0 || gx >= ras.cols || gy >= ras.rows) continue;
        const k = gy * ras.cols + gx;
        if (Z <= ras.z[k]) continue;
        const rnx = nx * cy + nz * sy, rny = ny * cx - (-nx * sy + nz * cy) * sx;
        const lam = Math.max(0, rnx * LIGHT[0] + rny * LIGHT[1] + rnz * LIGHT[2]);
        ras.z[k] = Z; ras.sh[k] = 0.06 + 0.94 * Math.pow(lam, 1.6); ras.hd[k] = h;
      }
    }
    const at = atlasFor(cw);
    for (let k = 0; k < ras.cols * ras.rows; k++) {
      if (ras.z[k] <= -9) continue;
      const shade = ras.sh[k];
      const gi = Math.min(15, Math.max(1, Math.round(Math.pow(shade, 0.75) * 15)));
      const ci = shade > 0.985 ? 0 : (shade > 0.38 ? 1 : 2);
      const a = (0.3 + 0.7 * shade) * dims[ras.hd[k]] * alphaMul;
      at.blit(ctx, gi, ci, a, (k % ras.cols) * cw, ((k / ras.cols) | 0) * ras.ch);
    }
  }

  function atlasFor(cell) {
    const lv = [4, 5, 6, 7, 8, 9, 10, 12];
    let best = lv[0]; for (const l of lv) if (Math.abs(l - cell) < Math.abs(best - cell)) best = l;
    const key = `${dpr}|${best}`;
    if (!atlasCache.has(key)) {
      const a = makeAtlas({ ramp: RAMP, cellW: best, cellH: Math.round(best * 1.15), dpr, font: FONT, colors: COLORS, fontScale: 1.2 });
      atlasCache.set(key, { blit: a.blit, cellW: best, cellH: Math.round(best * 1.15) });
    }
    return atlasCache.get(key);
  }

  function resize() {
    W = window.innerWidth; H = window.innerHeight;
    dpr = Math.min(window.devicePixelRatio || 1, isPhone ? 1.5 : 2);
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    atlasCache = new Map();
    layoutRail();
  }

  // ---- scroll → timeline: one station per gesture, a fixed-length passage, identical every time
  let P = 0, Ptarget = 0, t = 0, last = performance.now();
  const debugP = (() => { const v = parseFloat(new URLSearchParams(location.search).get('p')); return Number.isFinite(v) ? v : null; })();   // ?p=1.5 freezes a passage for screenshots
  const PASS = 0.55;                                           // seconds for a full passage
  const tween = { from: 0, to: 0, t0: 0, dur: PASS };
  let arrivedAt = 0, lastS = 0, lastScrollAt = 0;
  window.addEventListener('scroll', () => { lastScrollAt = t; }, { passive: true });
  // a flick used to throw the document to the last station before any passage was seen: now a wheel turn, a swipe or a
  // key is one station, the next gesture is taken only once the passage has played, and inertia never counts twice
  const stepPx = () => (rail.offsetHeight / S) || window.innerHeight;
  const station = () => Math.round(Ptarget);
  function go(n) { n = clamp(Math.round(n), 0, S - 1); window.scrollTo({ top: n * stepPx(), behavior: 'instant' }); }
  const owned = (el) => !(el && el.closest && el.closest('.door, dialog, input, textarea, select, button, a, label'));
  let lockUntil = 0, wLast = 0, wPrevMag = 0, wArmed = true, wAcc = 0;
  window.addEventListener('wheel', (e) => {
    if (!owned(e.target)) return;
    e.preventDefault();
    const now = performance.now(), mag = Math.abs(e.deltaY);
    if (now - wLast > 160) { wAcc = 0; wArmed = true; }                 // a pause: a new gesture
    else if (mag > wPrevMag * 1.5 && mag > 10) wArmed = true;          // the finger pushed again inside the inertia tail
    wLast = now; wPrevMag = mag;
    if (!wArmed || now < lockUntil) return;
    wAcc += e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? window.innerHeight : 1);
    if (Math.abs(wAcc) < 30) return;
    go(station() + Math.sign(wAcc)); wAcc = 0; wArmed = false; lockUntil = now + PASS * 1000 + 150;
  }, { passive: false });
  let tY = null, tStepped = false;
  window.addEventListener('touchstart', (e) => { tY = owned(e.target) ? e.touches[0].clientY : null; tStepped = false; }, { passive: true });
  window.addEventListener('touchmove', (e) => {
    if (tY == null) return;
    if (e.cancelable) e.preventDefault();
    const dy = tY - e.touches[0].clientY, now = performance.now();
    if (!tStepped && Math.abs(dy) > 36 && now >= lockUntil) { go(station() + Math.sign(dy)); tStepped = true; lockUntil = now + PASS * 1000 + 150; }
  }, { passive: false });
  window.addEventListener('touchend', () => { tY = null; }, { passive: true });
  let live = rent.getRentState();
  const pointer = { x: -1, y: -1 };
  const typed = new Map();
  function type(key, str, cps = 42) {
    if (reduced) return str;
    const now = performance.now() / 1000;
    let o = typed.get(key);
    if (!o || o.str !== str) { o = { str, start: now }; typed.set(key, o); }
    return str.slice(0, Math.min(str.length, Math.floor((now - o.start) * cps)));
  }

  // ---- interactions
  const hits = [];
  function hitTest(x, y) { for (const r of hits) if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return r; return null; }
  function act(kind) {
    const id = who, alt = otherOf(who);
    if (kind === 'open') openDoor('archive', id);
    else if (kind === 'dose') openDoor('dose', id);
    else if (kind === 'pay') { const target = !live[id].locked ? id : (!live[alt].locked ? alt : null); if (target) openPay({ who: target, hours: 1 }); }
    else if (kind === 'verify') {
      if (wait.verify) return;
      wait.verifyText = `HASHING · FETCHING ${live[id].name}'S WHOLE LEDGER`;
      wait.verify = rent.checkHash(id).then((r) => { wait.verify = null; wait.verifyText = r.match ? `HASH MATCH — ${live[id].name}'S SERVED LEDGER · ${r.total.toLocaleString('en-GB')} ENTRIES · HEAD ${r.computedHead.slice(0, 12)}…` : (r.headChanged ? 'HEAD CHANGED — RECHECK' : `HASH MISMATCH · ${r.reason || ''}`); }).catch((e) => { wait.verify = null; wait.verifyText = 'ERROR · ' + e.message; });
    }
    else if (kind === 'prove') { if (capEl.prove) { capEl.prove.value = ''; wait.proveCode = ''; capEl.prove.focus(); } }
  }
  if (capEl.prove) {
    capEl.prove.addEventListener('input', () => {
      const v = capEl.prove.value.replace(/\D/g, '').slice(0, 4); capEl.prove.value = v; wait.proveCode = v;
      if (v.length === 4 && !wait.prove) {
        const alt = otherOf(who);
        const target = !live[who].locked ? who : (!live[alt].locked ? alt : null);
        if (!target) { wait.proveText = 'OFFLINE'; return; }
        wait.proveText = `SENT TO ${live[target].name} · WAITING FOR THE ANSWER`;
        wait.prove = rent.startProve(target, v).then(() => {}).catch((e) => { wait.proveText = 'ERROR · ' + e.message; wait.prove = null; });
      }
    });
  }
  rent.subscribeRent((st, ev) => {
    live = st;
    // default head: the one closer to death, until the visitor picks
    if (!chosen && live.e1 && live.e2 && live.e1.ok && live.e2.ok && live.e1.hoursLeft != null && live.e2.hoursLeft != null) setWho(live.e2.hoursLeft < live.e1.hoursLeft ? 'e2' : 'e1', false);
    if (ev && ev.type === 'reply' && ev.wait && ev.wait.kind === 'prove') {
      const w = ev.wait;
      if (w.status === 'match') wait.proveText = `CODE MATCH · seq ${w.replySeq} — ${(w.reply || '').replace(/\s+/g, ' ').slice(0, 140)}`;
      else if (w.status === 'nomatch') wait.proveText = `${w.correlated === false ? 'LATEST CHANNEL REPLY' : 'ANSWERED IN TIME'} · NO CODE YET (REDEPLOY PENDING) — ${(w.reply || '').replace(/\s+/g, ' ').slice(0, 140)}`;
      else if (w.status === 'timeout') wait.proveText = 'STILL WAITING';
      else if (w.status === 'error') wait.proveText = 'ERROR · ' + (w.error || '');
      if (w.status !== 'pending' && w.status !== 'sending') wait.prove = null;
    }
  });
  const composer = document.getElementById('composer');
  if (composer) {
    composer.addEventListener('submit', (e) => {
      e.preventDefault();
      const ta = document.getElementById('say-text'), st = document.getElementById('say-status');
      const to = (composer.querySelector('input[name=to]:checked') || {}).value || who;
      const text = (ta.value || '').trim(); if (!text) return;
      st.textContent = 'CARRYING…'; ta.value = '';
      rent.say(to, text).then((w) => { st.textContent = w.status === 'pending' ? `CARRIED · seq ${w.ourSeq ?? '—'} · WAITING FOR THE ANSWER` : 'CARRIED'; }).catch((err) => { st.textContent = 'ERROR · ' + err.message; });
    });
    whoListeners.push((id) => { const r = composer.querySelector(`input[name=to][value=${id}]`); if (r) r.checked = true; });
  }
  rent.subscribeRent((st, ev) => {
    if (ev && ev.type === 'reply' && ev.wait && ev.wait.kind === 'say') {
      const el = document.getElementById('say-status'); if (!el) return;
      if (ev.wait.status === 'reply') el.textContent = `ANSWER · seq ${ev.wait.replySeq} — ${(ev.wait.reply || '').replace(/\s+/g, ' ').slice(0, 220)}`;
      else if (ev.wait.status === 'timeout') el.textContent = 'NO ANSWER YET';
    }
  });

  canvas.addEventListener('pointermove', (e) => { pointer.x = e.clientX; pointer.y = e.clientY; canvas.style.cursor = hitTest(e.clientX, e.clientY) ? 'pointer' : 'default'; });
  canvas.addEventListener('pointerleave', () => { pointer.x = -1; pointer.y = -1; });
  canvas.addEventListener('pointerup', (e) => { const r = hitTest(e.clientX, e.clientY); if (r) r.fn(); });
  window.addEventListener('keydown', (e) => {
    if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
    if (e.key === 'Enter') { const r = hits.find((x) => x.main); if (r) r.fn(); }
    const k = e.key;
    const d = (k === 'ArrowDown' || k === 'PageDown' || k === ' ') ? 1 : (k === 'ArrowUp' || k === 'PageUp') ? -1 : 0;
    if (d) { e.preventDefault(); if (performance.now() >= lockUntil) { go(station() + d); lockUntil = performance.now() + PASS * 1000 + 150; } }
    else if (k === 'Home') { e.preventDefault(); go(0); }
    else if (k === 'End') { e.preventDefault(); go(S - 1); }
  });

  // ---- loading: the skulls first, the rest after them
  (async () => {
    try { loaded[0] = sortTopDown(await ST[0].load(N, isPhone, window.innerHeight)); anyReady = true; }
    catch (e) { statusEl.textContent = 'skull failed to load'; }
    for (let s = 1; s < S; s++) { try { loaded[s] = sortTopDown(await ST[s].load(N, isPhone)); } catch (e) { loaded[s] = null; } }
  })();

  // ---- projection (rotation is applied per particle around its own group centre; this is perspective only)
  function persp(z) { return 2.8 / (2.8 - z); }
  function toScreen(x, y, z, R) { const p = persp(z); return [W / 2 + x * p * R, H * 0.41 - y * p * R, z, p]; }
  function rotate(x, y, z, cy, sy, cx, sx) {
    const X = x * cy + z * sy, Z0 = -x * sy + z * cy;
    return [X, y * cx - Z0 * sx, y * sx + Z0 * cx];
  }

  function band(y, h, alpha) {
    const f = 30;
    const g = ctx.createLinearGradient(0, y - f, 0, y + h + f);
    g.addColorStop(0, 'rgba(6,6,6,0)'); g.addColorStop(f / (h + 2 * f), `rgba(6,6,6,${alpha})`); g.addColorStop(1 - f / (h + 2 * f), `rgba(6,6,6,${alpha})`); g.addColorStop(1, 'rgba(6,6,6,0)');
    ctx.fillStyle = g; ctx.fillRect(0, y - f, W, h + 2 * f);
  }
  function text(str, x, y, size, color, align = 'center', alpha = 1) {
    ctx.save(); ctx.font = `${size}px ${FONT}`; ctx.textAlign = align; ctx.textBaseline = 'top'; ctx.globalAlpha = alpha; ctx.fillStyle = color; ctx.fillText(str, x, y); ctx.restore();
  }
  function measure(str, size) { ctx.font = `${size}px ${FONT}`; return ctx.measureText(str).width; }
  function wrap(str, maxW, size) {
    ctx.font = `${size}px ${FONT}`; const out = []; let line = '';
    for (const w of str.split(' ')) { const tst = line ? line + ' ' + w : w; if (line && ctx.measureText(tst).width > maxW) { out.push(line); line = w; } else line = tst; }
    if (line) out.push(line); return out;
  }

  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000); last = now; t += dt;
    if (document.hidden) { setTimeout(() => safeFrame(performance.now()), 200); return; }
    const step = (rail.offsetHeight / S) || H || window.innerHeight;
    let target = clamp(window.scrollY / step, 0, S - 1);
    // keyboard and toolbar scrolls stop short of the snap: once the scroll idles near a station, land on it
    const near = Math.round(target);
    if (near !== target && t - lastScrollAt > 0.15 && Math.abs(target - near) < 0.15) { target = near; lastScrollAt = t; window.scrollTo({ top: near * step, behavior: 'instant' }); }
    if (target !== Ptarget) { tween.from = P; tween.to = target; tween.t0 = t; tween.dur = Math.abs(target - P) >= 0.5 ? PASS : 0.25; Ptarget = target; }
    if (debugP != null) P = debugP;
    else if (reduced) P = Ptarget;
    else { const k = clamp((t - tween.t0) / tween.dur, 0, 1); P = tween.from + (tween.to - tween.from) * easeInOut(k); if (k >= 1) P = tween.to; }
    const s = Math.min(S - 1, Math.floor(P)), u = P - s;
    const DEAD = 0.18;                                         // around every station the object is still and captioned
    const morph = s < S - 1 ? clamp((u - DEAD) / (1 - 2 * DEAD), 0, 1) : 0;
    const cs = (s < S - 1 && u > 0.5) ? s + 1 : s;              // the station whose words and action are shown
    const mdist = cs === s ? morph : 1 - morph;                 // 0 when that object is fully formed
    if (cs !== lastS) { lastS = cs; arrivedAt = t; }
    live = rent.getRentState();

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#060606'; ctx.fillRect(0, 0, W, H);
    hits.length = 0;

    const A = loaded[s], B = loaded[s + 1];
    const obj = cs === s ? A : B;
    if (!anyReady || !A) {
      // entering: sparse glyphs condensing
      ctx.save(); ctx.font = `${isPhone ? 13 : 16}px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const kk = Math.min(1, t / 2);
      for (let i = 0; i < 300; i++) { const a = hash01(i, 1) * 6.283, r = 0.5 + 0.5 * hash01(i, 2); const e = easeOut(clamp((kk - hash01(i, 2) * 0.3) / 0.7, 0, 1)); const x = W / 2 + Math.cos(a) * (W * 0.9 * (1 - e) + W * 0.22 * r * e), y = H * 0.46 + Math.sin(a) * (H * 0.9 * (1 - e) + H * 0.3 * r * e); ctx.globalAlpha = 0.15 + 0.5 * e; ctx.fillStyle = i % 9 ? 'rgba(242,242,238,.8)' : '#f4b728'; ctx.fillText(RAMP[3 + (i % 11)], x, y); }
      ctx.restore();
      text('LOADING THE SKULLS', W / 2, H * 0.9, 11, 'rgba(242,242,238,.5)');
      setTimeout(() => safeFrame(performance.now()), 33); return;
    }

    // live fear → pulse on the brain only; the head settles to frontal while it morphs
    const fe = Math.max(live.e1 && live.e1.feel && live.e1.feel.steered ? clamp(live.e1.feel.fear / 3.5, 0, 1) : 0, live.e2 && live.e2.feel && live.e2.feel.steered ? clamp(live.e2.feel.fear / 3.5, 0, 1) : 0);
    const still = 1 - Math.sin(Math.PI * morph);            // 1 at the stations, 0 mid-passage
    const pulse = ST[cs].pulse && !reduced && mdist === 0 ? 1 + 0.025 * Math.max(0, Math.sin(t * (1.0 + 1.2 * fe) * 6.283)) : 1;
    const rotY = reduced ? 0 : (ST[cs].rot * Math.sin(t * 0.3) + (pointer.x >= 0 ? (pointer.x / W - 0.5) * (ST[cs].lean ?? 0.15) : 0)) * still;
    const rotX = reduced ? 0 : (0.04 * Math.sin(t * 0.19) + (pointer.y >= 0 ? -(pointer.y / H - 0.5) * (ST[cs].lean ?? 0.15) * 0.5 : 0)) * still;
    const cy = Math.cos(rotY), sy = Math.sin(rotY), cx = Math.cos(rotX), sx = Math.sin(rotX);
    const R = (isPhone ? Math.min(W * 0.48, H * 0.40) * 0.95 : Math.min(W * 0.48, H * 0.40, (W - 120) / 2.3)) * pulse;   // narrow desktop windows keep a margin for the action
    const lift = 0.3;           // the flying cloud comes a little toward you, all of it together

    const cellBase = isPhone ? 6 : 7.5;
    const dimA = A.half != null ? [who === 'e1' ? 1 : 0.42, who === 'e2' ? 1 : 0.42] : null;
    const rasterA = A.rawPos && s === 0 ? clamp(1 - morph / 0.1, 0, 1) : 0;   // the lit raster hands over to the particles
    if (rasterA > 0) rasterHeads(A, R, cy, sy, cx, sx, rasterA, dimA);
    const cloudA = 1 - rasterA;
    // positions: straight lines, a top-down sweep, no noise
    for (let i = 0; i < N; i++) {
      let x = A.pos[i * 3], y = A.pos[i * 3 + 1], z = A.pos[i * 3 + 2];
      let ox = A.off ? A.off[i * 3] : 0, oy = A.off ? A.off[i * 3 + 1] : 0, oz = A.off ? A.off[i * 3 + 2] : 0;
      let g = A.gl[i], b = A.br[i], d = dimA ? dimA[A.head[i]] : 1;
      if (B && morph > 0) {
        const stag = 0.7 * (i / N) + 0.03 * hash01(i, 21);     // the curtain: top rank leaves first
        const mi = easeInOut(clamp((morph - stag) / 0.3, 0, 1));
        const bx = B.pos[i * 3], by = B.pos[i * 3 + 1], bz = B.pos[i * 3 + 2];
        const box = B.off ? B.off[i * 3] : 0, boy = B.off ? B.off[i * 3 + 1] : 0, boz = B.off ? B.off[i * 3 + 2] : 0;
        x += (bx - x) * mi; y += (by - y) * mi; z += (bz - z) * mi;
        ox += (box - ox) * mi; oy += (boy - oy) * mi; oz += (boz - oz) * mi;
        g = mi < 0.5 ? g : B.gl[i]; b += (B.br[i] - b) * mi; d += (1 - d) * mi;
        oz += Math.sin(Math.PI * mi) * lift;
      }
      zo[i] = z + oz;
      const r = rotate(x, y, z, cy, sy, cx, sx);
      if (A.nrm) {
        // lit surface: Lambert from the upper front, back faces culled; the lighting hands over to the next object's own brightness
        const n = rotate(A.nrm[i * 3], A.nrm[i * 3 + 1], A.nrm[i * 3 + 2], cy, sy, cx, sx);
        const lam = Math.max(0, n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2]);
        const shade = 0.06 + 0.94 * Math.pow(lam, 1.6);
        const face = clamp((n[2] + 0.05) / 0.3, 0, 1);
        const mi2 = B && morph > 0 ? easeInOut(clamp((morph - (0.7 * (i / N) + 0.03 * hash01(i, 21))) / 0.3, 0, 1)) : 0;
        b = shade + (b - shade) * mi2; d *= face + (1 - face) * mi2;
        if (mi2 < 0.5) g = Math.min(15, 2 + Math.round(shade * 13));
      }
      px[i] = r[0] + ox; py[i] = r[1] + oy; pz[i] = r[2] + oz; gl[i] = g; br[i] = b; dm[i] = d;
    }
    // draw back to front in 6 depth buckets (cheap painter's order); glyph size from object-space depth, so it never flickers
    const atlasBy = [];
    if (cloudA > 0) for (let bucket = 0; bucket < 6; bucket++) {
      const zlo = -1.2 + bucket * 0.4, zhi = zlo + 0.4;
      for (let i = 0; i < N; i++) {
        const Z = pz[i];
        if (Z < zlo || Z >= zhi) continue;
        const sc = toScreen(px[i], py[i], Z, R);
        const cell = cellBase * (0.82 + 0.36 * clamp((zo[i] + 0.6) / 1.2, 0, 1));
        const ck = Math.round(cell * 2);
        let at = atlasBy[ck]; if (!at) { at = atlasFor(cell); atlasBy[ck] = at; }
        const depthA = clamp(0.3 + 0.7 * (Z * 0.5 + 0.5), 0.2, 1);
        const alpha = depthA * (0.55 + 0.45 * br[i]) * dm[i] * cloudA;
        const ci = br[i] > 0.9 && Z > 0.25 ? 0 : (br[i] > 0.42 ? 1 : 2);
        at.blit(ctx, gl[i], ci, alpha, sc[0] - at.cellW / 2, sc[1] - at.cellH / 2);
      }
    }

    // captions (stations only; gone during the passage)
    const capA = clamp(1 - mdist / 0.08, 0, 1) * clamp((t - arrivedAt) / 0.2, 0, 1) * (reduced ? 1 : clamp((t - 0.2) / 0.5, 0, 1));
    const st = ST[cs];
    if (capA > 0.02 && obj) {
      const size = isPhone ? 17 : (H < 800 ? 21 : 26);
      const lines = st.lines(live);
      const rows = [];
      for (const ln of lines) for (const w of wrap(ln, W - (isPhone ? 32 : 180), size)) rows.push(w);
      const lh = Math.round(size * 1.35);
      const liveTxt = st.live(live);
      const lsize = isPhone ? 11 : 12;
      const lrows = wrap(liveTxt, W - (isPhone ? 32 : 220), lsize);
      const blockH = rows.length * lh + 12 + lrows.length * (lsize + 5);
      let y0 = Math.round(H * (st.id === 'ribs' ? (isPhone ? 0.50 : 0.52) : (isPhone ? 0.74 : 0.76)) - blockH / 2);
      if (obj.half != null) { const lb = toScreen(0, obj.centres[0][1] - obj.ext * 1.08, 0, R)[1] + (isPhone ? 36 : 40) + 14; y0 = Math.max(y0, Math.round(lb + 20)); }
      band(y0 - 10, blockH + 14, 0.74 * capA);
      for (let i = 0; i < rows.length; i++) text(rows[i], W / 2, y0 + i * lh, size, '#f4b728', 'center', capA);
      for (let i = 0; i < lrows.length; i++) text(lrows[i], W / 2, y0 + rows.length * lh + 12 + i * (lsize + 5), lsize, 'rgba(242,242,238,.55)', 'center', capA);

      // the two heads: name and hours under each, the followed one bright; tap to follow
      if (obj.half != null) {
        for (let k = 0; k < 2; k++) {
          const id = k ? 'e2' : 'e1', e = live[id], c = obj.centres[k];
          const sc = toScreen(c[0], c[1] - obj.ext * 1.08, c[2], R);
          const on = who === id;
          const name = e && e.name ? e.name : (k ? 'OBOL' : 'WICK');
          const hrs = e && e.ok && !e.dead && e.hoursLeft != null ? `${e.hoursLeft} H LEFT` : (e && e.dead ? 'DEAD' : '—');
          text(name, sc[0], sc[1] + 18, isPhone ? 13 : 15, on ? '#f4b728' : 'rgba(242,242,238,.45)', 'center', capA);
          text(hrs, sc[0], sc[1] + (isPhone ? 36 : 40), isPhone ? 11 : 12, on ? 'rgba(242,242,238,.9)' : 'rgba(242,242,238,.4)', 'center', capA);
          if (on) { const w = measure(name, isPhone ? 13 : 15); ctx.save(); ctx.globalAlpha = capA; ctx.fillStyle = '#f4b728'; ctx.fillRect(sc[0] - w / 2, sc[1] + (isPhone ? 33 : 37), w, 1); ctx.restore(); }
          const hw = obj.ext * R * 1.05, hh = obj.ext * R * 1.0;
          const centre = toScreen(c[0], c[1], c[2], R);
          hits.push({ x: centre[0] - hw, y: centre[1] - hh, w: hw * 2, h: hh * 2 + 60, fn: () => setWho(id, true) });
        }
      }

      // the one action of this object
      const a = st.action;
      if (a && (a.kind !== 'pay' || !live.e1.locked || !live.e2.locked)) {
        let ax = W / 2, ay = H * 0.46;
        if (a.anchor && obj.anchors && obj.anchors[a.anchor]) { const p = obj.anchors[a.anchor]; const r = rotate(p[0], p[1], p[2], cy, sy, cx, sx); const sc = toScreen(r[0], r[1], r[2], R); ax = sc[0]; ay = sc[1]; }
        const label = typeof a.label === 'function' ? a.label(live) : a.label;
        const bw = isPhone ? 150 : 190, bh = 40;
        const bx = clamp(ax - bw / 2, 8, W - bw - 8);
        const by = a.anchor ? clamp(ay + 34, 60, y0 - bh - 16) : Math.min(H - 16 - bh, y0 + blockH + 18);
        ctx.save(); ctx.globalAlpha = capA; ctx.strokeStyle = 'rgba(244,183,40,.75)'; ctx.lineWidth = 1; ctx.strokeRect(bx + 0.5, by + 0.5, bw, bh); ctx.restore();
        text(label + (a.kind === 'verify' && wait.verify ? ' ·' : ''), bx + bw / 2, by + 14, 12, '#f4b728', 'center', capA);
        hits.push({ x: bx, y: by, w: bw, h: bh, main: true, fn: () => act(a.kind) });
        if (a.kind === 'verify' && wait.verifyText) text(wait.verifyText, W / 2, by + bh + 10, 11, 'rgba(242,242,238,.8)', 'center', capA);
        if (a.kind === 'prove') {
          const slots = (wait.proveCode + '____').slice(0, 4).split('').join(' ');
          text(slots, bx + bw / 2, by - 30, 22, 'rgba(242,242,238,.92)', 'center', capA);
          if (!rent.CODE_GUARANTEED) { const nr = wrap('CODE GUARANTEE PENDING REDEPLOY bc86aaf2 · BRAIN: QWEN3-14B ON A RENTED GPU, OUTSIDE THE TEE', W - 32, 10); for (let i = 0; i < nr.length; i++) text(nr[i], W / 2, H - 44 - (nr.length - i) * 14, 10, 'rgba(242,242,238,.45)', 'center', capA); }
        }
      }
    }
    // DOM overlays only at their station
    const holdOn = (id) => st.id === id && mdist === 0 && capA > 0.5;
    if (composer) composer.hidden = !holdOn('ribs');
    if (capEl.prove) capEl.prove.tabIndex = holdOn('scream') ? 0 : -1;

    // chrome: station counter, the head switch, the token line
    text(`${String(cs + 1).padStart(2, '0')}/${String(S).padStart(2, '0')}`, 16, H - 26, 11, 'rgba(244,183,40,.6)', 'left');
    {
      const n1 = live.e1 && live.e1.name || 'WICK', n2 = live.e2 && live.e2.name || 'OBOL';
      const sz = 11, pad = 10, w1 = measure(n1, sz) + pad * 2, w2 = measure(n2, sz) + pad * 2, y = 14, hgt = 24;
      const x2 = W - 16 - w2, x1 = x2 - 10 - w1;
      const draw = (x, w, name, id) => {
        const on = who === id;
        ctx.save(); ctx.globalAlpha = on ? 0.9 : 0.5; ctx.strokeStyle = on ? '#f4b728' : 'rgba(242,242,238,.35)'; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, w, hgt); ctx.restore();
        text(name, x + w / 2, y + 7, sz, on ? '#f4b728' : 'rgba(242,242,238,.55)', 'center');
        hits.push({ x, y, w, h: hgt, fn: () => setWho(id, true) });
      };
      draw(x1, w1, n1, 'e1'); draw(x2, w2, n2, 'e2');
      if (cs > 0 || isPhone) text('FOLLOWING', x1 - 10, y + 7, 10, 'rgba(242,242,238,.35)', 'right');
    }
    if (cs === S - 1 && mdist === 0) { text('$ZEALOT NOT LAUNCHED', W / 2, H - 28, 11, 'rgba(244,183,40,.5)'); }
    setTimeout(() => safeFrame(performance.now()), 33);
  }

  resize();
  window.addEventListener('resize', resize);
  function safeFrame(now) {
    try { frame(now); }
    catch (e) { window.__morphErr = String(e && e.stack || e); if (statusEl) statusEl.textContent = 'render error: ' + e.message; setTimeout(() => safeFrame(performance.now()), 500); }
  }
  safeFrame(performance.now());
  return { get P() { return P; }, getWho: () => who, onWho: (f) => whoListeners.push(f) };
}
