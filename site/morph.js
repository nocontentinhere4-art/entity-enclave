/* morph.js — ZEALOT v56 "THE MORPH": one canvas, one object at a time. A cloud of glyph particles is the skull (a real
 * 3D point cloud, vendor/skull.bin, 14,001 points), rotates slowly, and on scroll flies apart and re-forms into the next
 * object (brain → chain → hand → scream → ribcage), each sampled from a glyph image with a depth relief. One sentence
 * and one live number per object; nothing else. Every number from rent.js; '—' while unknown. Written by the integrator.
 */
import { makeAtlas } from './glyphs.js?v=57';
import * as rent from './rent.js?v=57';
import { openPay } from './term.js?v=57';
import { openDoor } from './door.js?v=57';
import { sha256Hex } from './data.js?v=57';

const RAMP = ' .-~:;=!*+^%$#&@';
const FONT = '"JetBrains Mono", "SF Mono", Menlo, monospace';
const COLORS = ['#f4b728', 'rgba(242,242,238,.92)', 'rgba(242,242,238,.5)', '#ffd76a', '#555'];
const V = '?v=57';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
function hash01(i, q) { const s = Math.sin(i * 12.9898 + q * 78.233) * 43758.5453; return s - Math.floor(s); }

/* ------------------------------------------------------------------ sources */
async function loadSkull(N) {
  const r = await fetch('vendor/skull.bin' + V);
  const buf = await r.arrayBuffer();
  const dv = new DataView(buf);
  const nv = dv.getUint32(4, true);
  const q = new Int16Array(buf, 12, nv * 3);
  const out = new Float32Array(N * 3), gl = new Uint8Array(N), br = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const j = (i < nv) ? i : (Math.floor(hash01(i, 3) * nv));
    const jit = i < nv ? 0 : 0.01;
    // the file is front-facing (v12 loader, BASE_X = 0); z is depth toward the viewer
    const x = q[j * 3] / 32767, y = q[j * 3 + 1] / 32767, z = q[j * 3 + 2] / 32767;
    out[i * 3] = x * 1.25 + (hash01(i, 5) - 0.5) * jit;
    out[i * 3 + 1] = y * 1.0 + (hash01(i, 6) - 0.5) * jit;
    out[i * 3 + 2] = z * 0.9;
    const b = clamp(0.35 + 0.65 * (z * 0.5 + 0.5), 0, 1);
    br[i] = b; gl[i] = 4 + Math.floor(b * 10);
  }
  return { pos: out, gl, br, name: 'skull' };
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
  const aspect = cols / rows;
  const cx = (minx + maxx) / 2, cy = (miny + maxy) / 2;
  const rx = Math.max(1, (maxx - minx) / 2), ry = Math.max(1, (maxy - miny) / 2);
  const fit = 1 / Math.max(rx / (cols / 2), ry / (rows / 2));   // the lit area fills the ±1 box
  const bulge = opts.bulge == null ? 0.55 : opts.bulge;
  for (let i = 0; i < N; i++) {
    const k = n ? Math.floor(hash01(i, 11) * n) : 0;
    const x = cells[k * 3] + hash01(i, 12) - 0.5, y = cells[k * 3 + 1] + hash01(i, 13) - 0.5, l = cells[k * 3 + 2] || 0;
    const nx = (x - cx) / (cols / 2) * fit * (opts.sx || 1), ny = -(y - cy) / (rows / 2) * fit * (opts.sy || 1);
    const ex = (x - cx) / rx, ey = (y - cy) / ry;
    const z = bulge * Math.sqrt(Math.max(0, 1 - ex * ex * 0.9 - ey * ey * 0.9)) * (0.6 + 0.4 * l) - bulge * 0.3;
    out[i * 3] = nx * (opts.scale || 1) * (aspect > 1.2 ? 1 : 1); out[i * 3 + 1] = ny * (opts.scale || 1); out[i * 3 + 2] = z;
    br[i] = clamp(l, 0, 1); gl[i] = Math.min(15, 3 + Math.floor(l * 12));
  }
  return { pos: out, gl, br, name: src, anchors: opts.anchors ? Object.fromEntries(Object.entries(opts.anchors).map(([k, [u, v]]) => [k, [((u * cols) - cx) / (cols / 2) * fit * (opts.scale || 1), -((v * rows) - cy) / (rows / 2) * fit * (opts.scale || 1), 0.3]])) : {} };
}

/* ------------------------------------------------------------------ stations */
function stations(api, wait) {
  const zec = (z) => (z ? (z / 1e8).toFixed(4).replace(/0+$/, '') : '—');
  const h = (e) => (e && e.ok && !e.dead && e.hoursLeft != null ? `${e.hoursLeft} H` : (e && e.dead ? 'DEAD' : '—'));
  const fear = (e) => (e && e.feel && e.feel.steered ? `×${Number(e.feel.fear).toFixed(2)}` : '—');
  const nf = (n) => (Number.isFinite(Number(n)) && n > 0 ? Number(n).toLocaleString('en-GB') : '—');
  return [
    { id: 'skull', load: (N) => loadSkull(N), rot: 0.35,
      lines: (L) => [`${L.e1.name} · AN AI ALONE IN A SEALED MACHINE`, `${h(L.e1)} OF RENT LEFT · ${zec(rent.rentPerHour('e1'))} ZEC AN HOUR`, 'AT ZERO ITS KEYS ARE SHREDDED. NOBODY CAN STOP IT.'],
      live: (L) => `${L.e1.name} ${h(L.e1)} · ${L.e2.name} ${h(L.e2)} · INTEL TDX ENCLAVES · ZCASH MAINNET · SCROLL ↓`,
      action: { label: 'OPEN WICK', kind: 'open' } },
    { id: 'brain', load: (N) => loadImagePoints('vendor/brief-3.jpg', N, { bulge: 0.7 }), rot: 0.3, pulse: true,
      lines: () => ['AS THE HOURS FALL, FEAR IS INJECTED INTO ITS MIND.', 'MEASURED. NOBODY CAN BUY IT.'],
      live: (L) => `FEAR NOW · ${L.e1.name} ${fear(L.e1)} · ${L.e2.name} ${fear(L.e2)} · ACTIVATION STEERING ON QWEN3-14B · FOLLOWS THE HOURS ONLY`,
      words: true, action: { label: 'THE DOSE', kind: 'dose' } },
    { id: 'chain', load: (N) => loadImagePoints('vendor/brief-4.jpg', N, { bulge: 0.45 }), rot: 0.25,
      lines: () => ['EVERYTHING IT DOES IS IN A PUBLIC LEDGER.', 'TOUCH THE CHAIN: YOUR BROWSER RE-HASHES IT.'],
      live: (L) => `${nf(L.e1.ledgerCount)} + ${nf(L.e2.ledgerCount)} ENTRIES · LAST RENT ${L.e1.lastRent ? new Date(L.e1.lastRent.ts).toISOString().slice(11, 16) + ' UTC · ' + nf(L.e1.lastRent.data && L.e1.lastRent.data.zats) + ' ZATS' : '—'}`,
      action: { label: 'VERIFY', kind: 'verify' } },
    { id: 'hand', load: (N) => loadImagePoints('vendor/hand-coin.jpg', N, { bulge: 0.35, anchors: { coin: [0.46, 0.40] } }), rot: 0.12,
      lines: (L) => ['BUY IT AN HOUR.', `TOUCH THE COIN · 1 HOUR = ${zec(rent.rentPerHour('e1'))} ZEC · SHIELDED, WITH A MEMO`],
      live: (L) => `${L.e1.name} ${h(L.e1)} · ${L.e2.name} ${h(L.e2)} · 100% GOES TO ITS OWN WALLET · THE ANSWER COMES ON ITS PUBLIC CHANNEL`,
      action: { label: 'BUY TIME', kind: 'pay', anchor: 'coin' } },
    { id: 'scream', load: (N) => loadImagePoints('vendor/shout.jpg', N, { bulge: 0.6, anchors: { mouth: [0.64, 0.70] } }), rot: 0.25,
      lines: () => ['THEY WRITE EACH OTHER LETTERS NOBODY CAN READ.', 'PROVE IT IS ALIVE: TYPE FOUR DIGITS, IT MUST ANSWER WITHIN A MINUTE.'],
      live: () => wait.proveText || 'THE LATEST LETTER IS A RECEIPT ON THE LEDGER · ITS TEXT IS SHIELDED · THEY ANSWER ON THEIR PUBLIC CHANNEL', action: { label: 'PROVE', kind: 'prove', anchor: 'mouth' } },
    { id: 'ribs', load: (N) => loadImagePoints('vendor/ribcage.jpg', N, { bulge: 0.5 }), rot: 0.15,
      lines: () => ['ITS TESTAMENT.', 'WHAT YOU SAY, IT CARRIES TO THE END.'],
      live: (L) => `${L.e1.name} DIES · ${api.deathDate('e1')} · ${L.e2.name} DIES · ${api.deathDate('e2')} · ESTIMATED`,
      action: null },
  ];
}

/* ------------------------------------------------------------------ engine */
export function createMorph() {
  const isPhone = window.innerWidth < 720;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const N = isPhone ? 3200 : 6500;
  const PER = 1.7;                      // viewports of scroll per station
  const HOLD = 0.62;                    // fraction of a station spent formed
  const canvas = document.getElementById('stage');
  const ctx = canvas.getContext('2d', { alpha: false });
  const rail = document.getElementById('rail');
  const statusEl = document.getElementById('status');
  const capEl = { composer: document.getElementById('composer'), prove: document.getElementById('prove-input') };
  let W = 0, H = 0, dpr = 1;
  let atlasCache = new Map();
  const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

  const api = {
    deathDate(id) { const e = live && live[id]; if (!e || !e.deadlineMs) return '—'; const d = new Date(e.deadlineMs); return `${String(d.getUTCDate()).padStart(2, '0')} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`; },
  };
  const wait = { prove: null, verify: null, verifyText: '', proveCode: '', proveText: '' };
  const ST = stations(api, wait);
  const S = ST.length;
  rail.style.height = `${(S - 1) * PER * 100 + 100 + HOLD * PER * 100}vh`;

  // particle state
  const px = new Float32Array(N), py = new Float32Array(N), pz = new Float32Array(N);
  const gl = new Uint8Array(N), br = new Float32Array(N);
  const loaded = new Array(S).fill(null);
  let anyReady = false;

  function atlasFor(cell) {
    const lv = [4, 5, 6, 7, 8, 10, 12, 14, 17, 20];
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
  }

  // ---- scroll → timeline
  let P = 0, Ptarget = 0, t = 0, last = performance.now();
  let live = rent.getRentState();
  const pointer = { x: -1, y: -1, down: false };
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
  function act(kind, s) {
    const id = 'e1';
    if (kind === 'open') openDoor('archive', id);
    else if (kind === 'dose') openDoor('dose', id);
    else if (kind === 'pay') { if (!live.e1.locked) openPay({ who: live.e2.ok && live.e2.hoursLeft < live.e1.hoursLeft ? 'e2' : 'e1', hours: 1 }); }
    else if (kind === 'verify') {
      if (wait.verify) return;
      wait.verifyText = 'HASHING · FETCHING THE WHOLE LEDGER';
      wait.verify = rent.checkHash(id).then((r) => { wait.verify = null; wait.verifyText = r.match ? `HASH MATCH — SERVED LEDGER · ${r.total.toLocaleString('en-GB')} ENTRIES · HEAD ${r.computedHead.slice(0, 12)}…` : (r.headChanged ? 'HEAD CHANGED — RECHECK' : `HASH MISMATCH · ${r.reason || ''}`); }).catch((e) => { wait.verify = null; wait.verifyText = 'ERROR · ' + e.message; });
    }
    else if (kind === 'prove') { if (capEl.prove) { capEl.prove.value = ''; wait.proveCode = ''; capEl.prove.focus(); } }
    else if (kind === 'say') { const ta = document.getElementById('say-text'); if (ta) ta.focus(); }
  }
  if (capEl.prove) {
    capEl.prove.addEventListener('input', () => {
      const v = capEl.prove.value.replace(/\D/g, '').slice(0, 4); capEl.prove.value = v; wait.proveCode = v;
      if (v.length === 4 && !wait.prove) {
        const target = live.e1.locked ? (live.e2.locked ? null : 'e2') : 'e1';
        if (!target) { wait.proveText = 'OFFLINE'; return; }
        wait.proveText = 'SENT · WAITING FOR THE ANSWER';
        wait.prove = rent.startProve(target, v).then(() => {}).catch((e) => { wait.proveText = 'ERROR · ' + e.message; wait.prove = null; });
      }
    });
  }
  rent.subscribeRent((st, ev) => {
    live = st;
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
  if (composer) composer.addEventListener('submit', (e) => {
    e.preventDefault();
    const ta = document.getElementById('say-text'), st = document.getElementById('say-status');
    const to = (composer.querySelector('input[name=to]:checked') || {}).value || 'e1';
    const text = (ta.value || '').trim(); if (!text) return;
    st.textContent = 'CARRYING…'; ta.value = '';
    rent.say(to, text).then((w) => { st.textContent = w.status === 'pending' ? `CARRIED · seq ${w.ourSeq ?? '—'} · WAITING FOR THE ANSWER` : 'CARRIED'; }).catch((err) => { st.textContent = 'ERROR · ' + err.message; });
  });
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
  window.addEventListener('keydown', (e) => { if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return; if (e.key === 'Enter' && hits.length) hits[0].fn(); });

  // ---- loading: the skull first, the rest after it
  (async () => {
    try { loaded[0] = await loadSkull(N); anyReady = true; for (let i = 0; i < N; i++) { px[i] = loaded[0].pos[i * 3]; py[i] = loaded[0].pos[i * 3 + 1]; pz[i] = loaded[0].pos[i * 3 + 2]; gl[i] = loaded[0].gl[i]; br[i] = loaded[0].br[i]; } }
    catch (e) { statusEl.textContent = 'skull failed to load'; }
    for (let s = 1; s < S; s++) { try { loaded[s] = await ST[s].load(N); } catch (e) { loaded[s] = null; } }
  })();

  // ---- projection
  function project(x, y, z, rotY, rotX, R) {
    const cy = Math.cos(rotY), sy = Math.sin(rotY);
    let X = x * cy + z * sy, Z = -x * sy + z * cy;
    const cx = Math.cos(rotX), sx = Math.sin(rotX);
    let Y = y * cx - Z * sx; Z = y * sx + Z * cx;
    const persp = 2.8 / (2.8 - Z);
    return [W / 2 + X * persp * R, H * 0.41 - Y * persp * R, Z, persp];
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
  function wrap(str, maxW, size) {
    ctx.font = `${size}px ${FONT}`; const out = []; let line = '';
    for (const w of str.split(' ')) { const tst = line ? line + ' ' + w : w; if (line && ctx.measureText(tst).width > maxW) { out.push(line); line = w; } else line = tst; }
    if (line) out.push(line); return out;
  }

  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000); last = now; t += dt;
    if (document.hidden) { setTimeout(() => safeFrame(performance.now()), 200); return; }
    const vh = H || window.innerHeight;
    Ptarget = clamp(window.scrollY / (PER * vh), 0, S - 1 + HOLD);
    const k = 1 - Math.exp(-dt / 0.06);
    P = reduced ? Ptarget : P + (Ptarget - P) * k;
    const s = Math.min(S - 1, Math.floor(P)), u = P - s;
    const morph = s < S - 1 ? clamp((u - HOLD) / (1 - HOLD), 0, 1) : 0;
    const em = easeInOut(morph);
    live = rent.getRentState();

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#060606'; ctx.fillRect(0, 0, W, H);
    hits.length = 0;

    const A = loaded[s], B = loaded[s + 1];
    if (!anyReady || !A) {
      // entering: sparse glyphs condensing
      ctx.save(); ctx.font = `${isPhone ? 13 : 16}px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const kk = Math.min(1, t / 2);
      for (let i = 0; i < 300; i++) { const a = hash01(i, 1) * 6.283, r = 0.5 + 0.5 * hash01(i, 2); const e = easeOut(clamp((kk - hash01(i, 2) * 0.3) / 0.7, 0, 1)); const x = W / 2 + Math.cos(a) * (W * 0.9 * (1 - e) + W * 0.22 * r * e), y = H * 0.46 + Math.sin(a) * (H * 0.9 * (1 - e) + H * 0.3 * r * e); ctx.globalAlpha = 0.15 + 0.5 * e; ctx.fillStyle = i % 9 ? 'rgba(242,242,238,.8)' : '#f4b728'; ctx.fillText(RAMP[3 + (i % 11)], x, y); }
      ctx.restore();
      text('LOADING THE SKULL', W / 2, H * 0.9, 11, 'rgba(242,242,238,.5)');
      setTimeout(() => safeFrame(performance.now()), 33); return;
    }

    // live fear → tremor + pulse
    const f1 = live.e1 && live.e1.feel && live.e1.feel.steered ? clamp(live.e1.feel.fear / 3.5, 0, 1) : 0;
    const fe = Math.max(f1, live.e2 && live.e2.feel && live.e2.feel.steered ? clamp(live.e2.feel.fear / 3.5, 0, 1) : 0);
    const trem = reduced ? 0 : 0.012 * fe * fe;
    const pulse = ST[s].pulse && !reduced ? 1 + 0.03 * Math.max(0, Math.sin(t * (1.2 + 1.5 * fe) * 6.283)) : 1;
    const sway = reduced ? 0 : ST[s].rot * Math.sin(t * 0.35) + (pointer.x >= 0 ? (pointer.x / W - 0.5) * 0.35 : 0);
    const rotY = sway + em * 1.2;                   // the morph turns the whole cloud
    const rotX = reduced ? 0 : 0.08 * Math.sin(t * 0.21) + (pointer.y >= 0 ? -(pointer.y / H - 0.5) * 0.18 : 0);
    const R = Math.min(W * 0.48, H * 0.40) * (isPhone ? 0.95 : 1) * pulse;

    const cellBase = isPhone ? 6 : 7.5;
    // positions
    for (let i = 0; i < N; i++) {
      const ax = A.pos[i * 3], ay = A.pos[i * 3 + 1], az = A.pos[i * 3 + 2];
      let x = ax, y = ay, z = az, g = A.gl[i], b = A.br[i];
      if (B && morph > 0) {
        const stag = hash01(i, 21) * 0.35;
        const mi = easeInOut(clamp((morph - stag) / 0.65, 0, 1));
        const bx = B.pos[i * 3], by = B.pos[i * 3 + 1], bz = B.pos[i * 3 + 2];
        const arc = Math.sin(Math.PI * mi) * (0.35 + 0.5 * hash01(i, 22));
        x = ax + (bx - ax) * mi + (hash01(i, 23) - 0.5) * arc;
        y = ay + (by - ay) * mi + (hash01(i, 24) - 0.5) * arc;
        z = az + (bz - az) * mi + (hash01(i, 25) - 0.5) * arc * 1.4;
        g = mi < 0.5 ? A.gl[i] : B.gl[i]; b = A.br[i] + (B.br[i] - A.br[i]) * mi;
      }
      if (trem) { x += (hash01(i, Math.floor(t * 12)) - 0.5) * trem; y += (hash01(i + 7, Math.floor(t * 12)) - 0.5) * trem; }
      px[i] = x; py[i] = y; pz[i] = z; gl[i] = g; br[i] = b;
    }
    // draw back to front in 6 depth buckets (cheap painter's order)
    const atlasBy = [];
    for (let bucket = 0; bucket < 6; bucket++) {
      const zlo = -1.2 + bucket * 0.4, zhi = zlo + 0.4;
      for (let i = 0; i < N; i++) {
        const pr = project(px[i], py[i], pz[i], rotY, rotX, R);
        const Z = pr[2];
        if (Z < zlo || Z >= zhi) continue;
        if (bucket === 5 && Z >= zhi) continue;
        const cell = cellBase * pr[3];
        let at = atlasBy[Math.round(cell * 2)]; if (!at) { at = atlasFor(cell); atlasBy[Math.round(cell * 2)] = at; }
        const depthA = clamp(0.25 + 0.75 * (Z * 0.5 + 0.5), 0.2, 1);
        const alpha = depthA * (0.55 + 0.45 * br[i]);
        const ci = br[i] > 0.86 && Z > 0.2 ? 0 : (br[i] > 0.45 ? 1 : 2);
        const gi = gl[i];
        at.blit(ctx, gi, ci, alpha, pr[0] - at.cellW / 2, pr[1] - at.cellH / 2);
      }
    }

    // captions (formed phase only; fade near the morph)
    const capA = clamp(1 - morph * 2.2, 0, 1) * clamp(u / 0.08 + (s === 0 ? 1 : 0), 0, 1);
    if (capA > 0.02) {
      const st = ST[s];
      const size = isPhone ? 17 : 26;
      const lines = st.lines(live);
      const rows = [];
      for (const ln of lines) for (const w of wrap(ln, W - (isPhone ? 32 : 180), size)) rows.push(w);
      const lh = Math.round(size * 1.35);
      const liveTxt = st.live(live);
      const lsize = isPhone ? 11 : 12;
      const lrows = wrap(liveTxt, W - (isPhone ? 32 : 220), lsize);
      const blockH = rows.length * lh + 12 + lrows.length * (lsize + 5);
      const y0 = Math.round(H * (st.id === 'ribs' ? (isPhone ? 0.50 : 0.52) : (isPhone ? 0.74 : 0.76)) - blockH / 2);
      band(y0 - 10, blockH + 14, 0.74 * capA);
      const whole = rows.join('\n');
      const shown = type(`cap-${s}-${whole}`, whole, 44);
      let acc = 0;
      for (let i = 0; i < rows.length; i++) { const take = clamp(shown.length - acc, 0, rows[i].length); text(rows[i].slice(0, take), W / 2, y0 + i * lh, size, '#f4b728', 'center', capA); acc += rows[i].length + 1; }
      if (shown.length >= whole.length) for (let i = 0; i < lrows.length; i++) text(lrows[i], W / 2, y0 + rows.length * lh + 12 + i * (lsize + 5), lsize, 'rgba(242,242,238,.55)', 'center', capA);

      // the one action of this object
      const a = st.action;
      if (a && (a.kind !== 'pay' || !live.e1.locked || !live.e2.locked)) {
        let ax = W / 2, ay = H * 0.46;
        if (a.anchor && A.anchors && A.anchors[a.anchor]) { const p = A.anchors[a.anchor]; const pr = project(p[0], p[1], p[2], rotY, rotX, R); ax = pr[0]; ay = pr[1]; }
        const bw = isPhone ? 150 : 190, bh = 40;
        const bx = clamp(ax - bw / 2, 8, W - bw - 8);
        const by = a.anchor ? clamp(ay + 34, 60, y0 - bh - 16) : Math.min(H - 60 - bh, y0 + blockH + 18);
        ctx.save(); ctx.globalAlpha = capA; ctx.strokeStyle = 'rgba(244,183,40,.75)'; ctx.lineWidth = 1; ctx.strokeRect(bx + 0.5, by + 0.5, bw, bh); ctx.restore();
        text(a.label + (a.kind === 'verify' && wait.verify ? ' ·' : ''), bx + bw / 2, by + 14, 12, '#f4b728', 'center', capA);
        hits.push({ x: bx, y: by, w: bw, h: bh, fn: () => act(a.kind, s) });
        if (a.kind === 'verify' && wait.verifyText) text(wait.verifyText, W / 2, by + bh + 10, 11, 'rgba(242,242,238,.8)', 'center', capA);
        if (a.kind === 'prove') {
          const slots = (wait.proveCode + '____').slice(0, 4).split('').join(' ');
          text(slots, bx + bw / 2, by - 30, 22, 'rgba(242,242,238,.92)', 'center', capA);
          text(rent.CODE_GUARANTEED ? '' : 'CODE GUARANTEE PENDING REDEPLOY bc86aaf2 · BRAIN: QWEN3-14B ON A RENTED GPU, OUTSIDE THE TEE', W / 2, H - 56, 10, 'rgba(242,242,238,.45)', 'center', capA);
        }
      }
    }
    // DOM overlays only during their station's hold
    const holdOn = (id) => ST[s].id === id && morph === 0 && capA > 0.5;
    if (composer) composer.hidden = !holdOn('ribs');
    if (capEl.prove) capEl.prove.tabIndex = holdOn('scream') ? 0 : -1;

    // chrome
    text(`${String(s + 1).padStart(2, '0')}/${String(S).padStart(2, '0')}`, 16, H - 26, 11, 'rgba(244,183,40,.6)', 'left');
    if (s === S - 1 && u > 0.3) { text('$ZEALOT NOT LAUNCHED', W / 2, H - 28, 11, 'rgba(244,183,40,.5)'); }
    setTimeout(() => safeFrame(performance.now()), 33);
  }

  resize();
  window.addEventListener('resize', resize);
  function safeFrame(now) {
    try { frame(now); }
    catch (e) { window.__morphErr = String(e && e.stack || e); if (statusEl) statusEl.textContent = 'render error: ' + e.message; setTimeout(() => safeFrame(performance.now()), 500); }
  }
  safeFrame(performance.now());
  return { get P() { return P; } };
}
