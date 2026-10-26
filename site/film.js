/* film.js — ZEALOT v51 THE FILM: scroll/camera engine, GlyphField renderer (image → luminance → atlas-blitted glyphs with a
 * moving camera), hit regions, opt-in WebAudio, tremor/corrupt/ecg helpers. Kimi K2.7 Code from the integrator's contract;
 * reviewed and patched by the integrator (ctx passed to draw, api.ramp, null hints keep the base, audio only after opt-in). */
import { makeAtlas } from './glyphs.js?v=51';
import { openPay } from './term.js?v=51';
import { openDoor } from './door.js?v=51';

const RAMP = ' .-~:;=!*+^%$#&@';
const COLORS = ['#f4b728', 'rgba(242,242,238,.92)', 'rgba(242,242,238,.5)', '#ffd76a', '#555'];
const FONT = '"JetBrains Mono", "SF Mono", Menlo, monospace';
const ATLAS_LEVELS = [4, 5, 6, 8, 10, 13, 16, 20, 26, 32, 44, 64, 96];
const CELL_ASPECT = 1.15;
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const COLOR_MAP = { yellow: 0, bone: 1, dim: 2, hot: 3, dead: 4 };

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function colorStyle(name) { return COLORS[COLOR_MAP[name] ?? 1]; }

const fieldCache = new Map();
const imgCache = new Map();

function loadImage(src) {
  let e = imgCache.get(src);
  if (e) return e.promise;
  const img = new Image();
  const promise = new Promise((res, rej) => {
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = src;
  });
  imgCache.set(src, { img, promise });
  return promise;
}

function createField(src, opts, atlasForFn) {
  const cols = opts.cols ?? 240;
  const gamma = opts.gamma ?? 1;
  const field = { ready: false, src, cols: 0, rows: 0, lum: null };

  loadImage(src).then((img) => {
    const aspect = img.naturalWidth / img.naturalHeight || 1;
    const rows = Math.max(1, Math.round(cols * CELL_ASPECT / aspect));
    const cvs = document.createElement('canvas');
    cvs.width = cols;
    cvs.height = rows;
    const ctx = cvs.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, cols, rows);
    const data = ctx.getImageData(0, 0, cols, rows).data;
    const lum = new Float32Array(cols * rows);
    if (gamma === 1) {
      for (let i = 0; i < lum.length; i++) {
        const o = i * 4;
        lum[i] = (data[o] + data[o + 1] + data[o + 2]) / (3 * 255);
      }
    } else {
      const g = 1 / gamma;
      for (let i = 0; i < lum.length; i++) {
        const o = i * 4;
        lum[i] = Math.pow((data[o] + data[o + 1] + data[o + 2]) / (3 * 255), g);
      }
    }
    field.cols = cols;
    field.rows = rows;
    field.lum = lum;
    field.ready = true;
  }).catch(() => { field.ready = false; });

  function lumAt(u, v) {
    if (!field.ready) return 0;
    const fx = u * field.cols - 0.5;
    const fy = v * field.rows - 0.5;
    const x0 = clamp(Math.floor(fx), 0, field.cols - 1);
    const x1 = clamp(x0 + 1, 0, field.cols - 1);
    const y0 = clamp(Math.floor(fy), 0, field.rows - 1);
    const y1 = clamp(y0 + 1, 0, field.rows - 1);
    const wx = fx - x0;
    const wy = fy - y0;
    const l00 = field.lum[y0 * field.cols + x0];
    const l10 = field.lum[y0 * field.cols + x1];
    const l01 = field.lum[y1 * field.cols + x0];
    const l11 = field.lum[y1 * field.cols + x1];
    return (l00 * (1 - wx) + l10 * wx) * (1 - wy) + (l01 * (1 - wx) + l11 * wx) * wy;
  }

  function evalHint(h, idx, x, y, base) {
    if (h == null) return base;
    const ty = typeof h;
    if (ty === 'function') { const r = h(idx, x, y, base); return r == null ? base : r; }
    if (h instanceof Float32Array || h instanceof Uint8Array || h instanceof Uint8ClampedArray || Array.isArray(h)) return h[idx];
    return h;
  }

  function drawCore(ctx, cam, other, otherK, hint) {
    if (!field.ready) return;
    const W = cam.W, H = cam.H;
    if (!W || !H) return;
    const zoom = cam.zoom ?? 1;
    const cellBase = cam.cell ?? 8;
    const fit = cam.fit || 'cover';
    const cx = cam.cx ?? 0.5;
    const cy = cam.cy ?? 0.5;
    const baseW = field.cols * cellBase;
    const baseH = field.rows * cellBase / CELL_ASPECT;
    let s = 1;
    if (fit === 'cover') s = Math.max(W / baseW, H / baseH);
    else if (fit === 'contain') s = Math.min(W / baseW, H / baseH);
    const drawCell = clamp(cellBase * s * zoom, 3, 96);
    const drawH = drawCell / CELL_ASPECT;
    const imgW = field.cols * drawCell;
    const imgH = field.rows * drawH;
    const left = W / 2 - imgW * cx;
    const top = H / 2 - imgH * cy;
    const mirror = cam.mirror ?? false;
    const alpha = cam.alpha ?? 1;
    const thresh = cam.thresh ?? 0.09;
    const yellowAt = cam.yellowAt ?? 0.80;
    const baseCi = COLOR_MAP[cam.color] ?? 1;
    const atlas = atlasForFn(drawCell, cam.dpr);

    const col0 = Math.max(0, Math.floor(-left / drawCell));
    const col1 = Math.min(field.cols - 1, Math.ceil((W - left) / drawCell));
    const row0 = Math.max(0, Math.floor(-top / drawH));
    const row1 = Math.min(field.rows - 1, Math.ceil((H - top) / drawH));
    if (col0 >= col1 || row0 >= row1) return;

    for (let row = row0; row < row1; row++) {
      const v = (row + 0.5) / field.rows;
      const y = top + row * drawH;
      const idxBase = row * field.cols;
      for (let col = col0; col < col1; col++) {
        const u = mirror ? 1 - (col + 0.5) / field.cols : (col + 0.5) / field.cols;
        let l = lumAt(u, v);
        const idx = idxBase + col;
        if (other && other.ready && otherK != null) {
          l = l * (1 - otherK) + other.lumAt(u, v) * otherK;
        }
        l = evalHint(hint?.lum, idx, col, row, l);
        if (l < thresh) continue;
        let gi = Math.min(RAMP.length - 1, Math.floor(l * RAMP.length));
        gi = evalHint(hint?.char, idx, col, row, gi);
        if (RAMP[gi] === ' ') continue;
        let a = evalHint(hint?.alpha, idx, col, row, alpha);
        if (a <= 0.01) continue;
        let ci = baseCi;
        if (baseCi === 0 && l < yellowAt) ci = 2;
        else if (baseCi === 1 && l < 0.2) ci = 2;
        if (evalHint(hint?.yellow, idx, col, row, false)) ci = 0;
        const dx = evalHint(hint?.dx, idx, col, row, 0);
        const dy = evalHint(hint?.dy, idx, col, row, 0);
        const x = left + col * drawCell + dx;
        const y2 = y + dy;
        atlas.blit(ctx, gi, ci, a, x, y2, drawCell, drawH);
      }
    }
  }

  function draw(ctx, cam, hint) { drawCore(ctx, cam, null, null, hint); }
  function drawCrossfade(ctx, cam, other, k, hint) { drawCore(ctx, cam, other, clamp(k, 0, 1), hint); }
  return Object.assign(field, { lumAt, draw, drawCrossfade });
}

function buildAtlas(level, dpr) {
  const cellH = Math.round(level * CELL_ASPECT);
  const atlas = makeAtlas({ ramp: RAMP, cellW: level, cellH, dpr, font: FONT, colors: COLORS, fontScale: 1.2 });
  const cssW = level + 2;
  const cssH = cellH + 4;
  const orig = atlas.blit;
  return Object.assign(atlas, {
    level, cell: level, cellW: level, cellH, cssW, cssH,
    blit(ctx, gi, ci, a, x, y, w, h) {
      if (w == null) w = level;            // callers without a target size draw at the atlas' own cell
      if (h == null) h = cellH;
      const left = Math.round(x + (w - cssW) / 2);
      const top = Math.round(y + (h - cssH) / 2);
      orig.call(atlas, ctx, gi, ci, a, left, top);
    }
  });
}

function nearestLevel(cell) {
  let best = ATLAS_LEVELS[0], bestD = Infinity;
  for (const l of ATLAS_LEVELS) {
    const d = Math.abs(l - cell);
    if (d < bestD) { bestD = d; best = l; }
  }
  return best;
}

const D5x7 = {
  '0': [' ### ', '#   #', '#  ##', '# # #', '##  #', '#   #', ' ### '],
  '1': ['  #  ', ' ##  ', '  #  ', '  #  ', '  #  ', '  #  ', ' ### '],
  '2': [' ### ', '#   #', '    #', '   # ', '  #  ', ' #   ', '#####'],
  '3': [' ### ', '#   #', '    #', '  ## ', '    #', '#   #', ' ### '],
  '4': ['   # ', '  ## ', ' # # ', '#  # ', '#####', '   # ', '  ###'],
  '5': ['#####', '#    ', '#### ', '    #', '    #', '#   #', ' ### '],
  '6': [' ### ', '#   #', '#    ', '#### ', '#   #', '#   #', ' ### '],
  '7': ['#####', '    #', '   # ', '  #  ', ' #   ', ' #   ', ' #   '],
  '8': [' ### ', '#   #', '#   #', ' ### ', '#   #', '#   #', ' ### '],
  '9': [' ### ', '#   #', '#   #', ' ####', '    #', '#   #', ' ### '],
  ':': ['     ', '  #  ', '     ', '  #  ', '     ', '     ', '     '],
  '-': ['     ', '     ', '     ', '#####', '     ', '     ', '     '],
  '_': ['     ', '     ', '     ', '     ', '     ', '     ', '#####'],
  'A': [' ### ', '#   #', '#   #', '#####', '#   #', '#   #', '#   #'],
  'B': ['#### ', '#   #', '#   #', '#### ', '#   #', '#   #', '#### '],
  ' ': ['     ', '     ', '     ', '     ', '     ', '     ', '     ']
};

export function createFilm({ chapters, rent }) {
  let dpr = Math.min(window.devicePixelRatio || 1, window.innerWidth < 720 ? 1.5 : 2);
  let isPhone = window.innerWidth < 720;
  let reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const atlasCache = new Map();
  function atlasFor(cell, dprOverride) {
    const level = nearestLevel(cell);
    const d = dprOverride ?? dpr;
    const key = `${d}|${level}`;
    if (!atlasCache.has(key)) atlasCache.set(key, buildAtlas(level, d));
    return atlasCache.get(key);
  }

  function field(src, opts = {}) {
    const key = `${src}|${opts.cols ?? 240}|${opts.gamma ?? 1}`;
    if (!fieldCache.has(key)) fieldCache.set(key, createField(src, opts, atlasFor));
    return fieldCache.get(key);
  }

  const typedMap = new Map();
  const hits = new Map();
  let liveState = null;
  const instances = [];
  let statusEl = null, barEl = null, mainEl = null;
  let running = false, timer = null, t = 0, last = 0;

  function ensureAudio() {
    if (api.sound.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    api.sound.ctx = new AC();
  }

  function createWind() {
    if (!api.sound.ctx || api.sound.windNode) return;
    const ctx = api.sound.ctx;
    const len = 2 * ctx.sampleRate;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 600;
    bp.Q.value = 0.6;
    const g = ctx.createGain();
    g.gain.value = 0;
    src.connect(bp);
    bp.connect(g);
    g.connect(ctx.destination);
    src.start();
    api.sound.windNode = src;
    api.sound.windGain = g;
  }

  function thump(freq = 55, ms = 60, gainVal = 0.08) {
    if (!api.sound.on) return;
    ensureAudio();
    if (!api.sound.ctx) return;
    const ctx = api.sound.ctx;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gainVal, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + ms / 1000);
    o.connect(g);
    g.connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + ms / 1000 + 0.05);
  }

  function wind(level01) {
    if (!api.sound.on) { if (api.sound.windGain) api.sound.windGain.gain.value = 0; return; }
    ensureAudio();
    if (!api.sound.ctx) return;
    createWind();
    if (api.sound.windGain) {
      api.sound.windGain.gain.setTargetAtTime(clamp(level01, 0, 1) * 0.12, api.sound.ctx.currentTime, 0.05);
    }
  }

  const api = {
    field, atlasFor,
    text(ctx, str, x, y, opts = {}) {
      const size = opts.size || 11;
      const align = opts.align || 'left';
      const alpha = opts.alpha ?? 1;
      ctx.save();
      ctx.font = `${size}px ${FONT}`;
      ctx.textAlign = align;
      ctx.textBaseline = 'top';
      ctx.globalAlpha = alpha;
      ctx.fillStyle = colorStyle(opts.color || 'yellow');
      ctx.fillText(str, x, y);
      ctx.restore();
    },
    typed(key, str, cps = 55) {
      if (reduced) return str;
      const now = performance.now() / 1000;
      let o = typedMap.get(key);
      if (!o || o.str !== str) { o = { str, start: now }; typedMap.set(key, o); }
      const n = Math.floor((now - o.start) * cps);
      return str.slice(0, Math.min(str.length, n));
    },
    digits5x7(ctx, str, x, y, cell, color) {
      ctx.save();
      ctx.fillStyle = colorStyle(color);
      const ch = String(str).toUpperCase();
      let dx = x;
      for (let k = 0; k < ch.length; k++) {
        const map = D5x7[ch[k]] || D5x7[' '];
        for (let r = 0; r < 7; r++) {
          const row = map[r];
          for (let c = 0; c < 5; c++) {
            if (row[c] === '#') ctx.fillRect(Math.round(dx + c * cell), Math.round(y + r * cell), Math.ceil(cell), Math.ceil(cell));
          }
        }
        dx += 6 * cell;
      }
      ctx.restore();
    },
    hit: {
      clear(id) { hits.set(id, new Map()); },
      set(chId, regId, region, onActivate) {
        const m = hits.get(chId) || new Map();
        m.set(regId, { ...region, onActivate });
        hits.set(chId, m);
      }
    },
    live() { return liveState; },
    ramp: RAMP,
    rent,
    openPay,
    openDoor,
    sound: { on: false, ctx: null, windNode: null, windGain: null, thump, wind },
    reduced,
    get isPhone() { return isPhone; },
    fearOf(id) {
      const e = liveState?.[id];
      if (!e || !e.ok || e.dead || e.offline || !e.feel) return 0;
      return clamp((e.feel.fear || 0) / 3.5, 0, 1);
    },
    clockText(id) {
      const e = liveState?.[id];
      if (!e) return '—';
      if (e.dead) return '0:00:00';
      if (e.offline || !e.fresh || !e.deadlineMs) return '—';
      const sec = Math.max(0, Math.floor((e.deadlineMs - liveState.at) / 1000));
      const h = Math.floor(sec / 3600);
      const m = Math.floor((sec % 3600) / 60);
      const s = sec % 60;
      return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    },
    deathDate(id) {
      const e = liveState?.[id];
      if (!e || !e.deadlineMs) return '—';
      const d = new Date(e.deadlineMs);
      return `${String(d.getUTCDate()).padStart(2, '0')} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} · ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
    },
    status(text) { if (statusEl) statusEl.textContent = text; }
  };

  const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (mq.addEventListener) mq.addEventListener('change', (e) => { api.reduced = reduced = e.matches; });
  else if (mq.addListener) mq.addListener((e) => { api.reduced = reduced = e.matches; });

  function resizeChapter(ch) {
    if (!ch.stick) return;
    const r = ch.stick.getBoundingClientRect();
    ch.W = r.width;
    ch.H = r.height;
    ch.canvas.width = Math.max(1, Math.round(ch.W * dpr));
    ch.canvas.height = Math.max(1, Math.round(ch.H * dpr));
    ch.inst.resize(ch.W, ch.H, dpr);
  }

  function hitTest(ch, px, py) {
    const m = hits.get(ch.id);
    if (!m) return null;
    for (const reg of m.values()) {
      if (reg.shape === 'circle') {
        const dx = px - reg.x, dy = py - reg.y;
        if (dx * dx + dy * dy <= reg.r * reg.r) return reg;
      } else if (reg.shape === 'rect') {
        if (px >= reg.x && px <= reg.x + reg.w && py >= reg.y && py <= reg.y + reg.h) return reg;
      }
    }
    return null;
  }

  function onPointerUp(e) {
    const ch = instances.find(c => c.canvas === e.currentTarget);
    if (!ch) return;
    const reg = hitTest(ch, e.offsetX, e.offsetY);
    if (reg && reg.onActivate) { e.preventDefault(); reg.onActivate(); }
  }

  function onPointerMove(e) {
    const ch = instances.find(c => c.canvas === e.currentTarget);
    if (!ch) return;
    ch.canvas.style.cursor = hitTest(ch, e.offsetX, e.offsetY) ? 'pointer' : 'default';
  }

  function onKeyDown(e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const ch = instances.find(c => c.canvas === e.currentTarget);
    if (!ch) return;
    const m = hits.get(ch.id);
    if (!m || !m.size) return;
    e.preventDefault();
    let first = null;
    for (const reg of m.values()) {
      if (!first || reg.y < first.y || (reg.y === first.y && reg.x < first.x)) first = reg;
    }
    if (first && first.onActivate) first.onActivate();
  }

  function setupChapters() {
    mainEl = document.getElementById('film');
    for (const cfg of chapters) {
      const sec = document.querySelector(`section[data-ch="${cfg.id}"]`);
      if (!sec) continue;
      const stick = sec.querySelector('.stick');
      const canvas = sec.querySelector('canvas');
      if (!canvas) continue;
      const ctx = canvas.getContext('2d', { alpha: false });
      const inst = cfg.make(api);
      inst.mount(canvas, ctx);
      const ch = { id: cfg.id, sec, stick, canvas, ctx, inst, W: 0, H: 0, p: 0, visible: false };
      instances.push(ch);
      canvas.addEventListener('pointerup', onPointerUp);
      canvas.addEventListener('pointermove', onPointerMove);
      canvas.addEventListener('keydown', onKeyDown);
      canvas.setAttribute('tabindex', '0');
      canvas.setAttribute('role', 'group');
      canvas.setAttribute('aria-label', cfg.id.toUpperCase());
      resizeChapter(ch);
    }
  }

  function tick(now) {
    if (!running || document.hidden) { timer = null; return; }
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    t += dt;
    liveState = rent.getRentState();
    const vh = window.innerHeight;
    const scrollY = window.scrollY;
    const totalH = document.documentElement.scrollHeight - vh;
    if (barEl) barEl.style.width = totalH > 0 ? `${(scrollY / totalH) * 100}%` : '0%';

    for (const ch of instances) {
      const denom = ch.sec.offsetHeight - vh;
      const target = denom <= 0 ? 1 : clamp((scrollY - ch.sec.offsetTop) / denom, 0, 1);
      ch.p = reduced ? target : ch.p + (target - ch.p) * 0.18;
      const r = ch.stick.getBoundingClientRect();
      ch.visible = r.bottom > 0 && r.top < vh;
    }

    for (const ch of instances) {
      if (!ch.visible) continue;
      ch.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ch.ctx.clearRect(0, 0, ch.W, ch.H);
      api.hit.clear(ch.id);
      ch.inst.draw(ch.p, t, dt, liveState, ch.ctx);
    }

    timer = setTimeout(() => tick(performance.now()), 33);
  }

  function onResize() {
    dpr = Math.min(window.devicePixelRatio || 1, window.innerWidth < 720 ? 1.5 : 2);
    isPhone = window.innerWidth < 720;
    for (const ch of instances) resizeChapter(ch);
  }

  function onVis() {
    if (!document.hidden && running && !timer) {
      last = performance.now();
      timer = setTimeout(() => tick(performance.now()), 33);
    }
  }

  function start() {
    if (running) return;
    statusEl = document.getElementById('status');
    barEl = document.getElementById('bar');
    setupChapters();
    running = true;
    last = performance.now();
    t = 0;
    tick(last);
    window.addEventListener('resize', onResize);
    document.addEventListener('visibilitychange', onVis);
  }

  function destroy() {
    running = false;
    clearTimeout(timer);
    timer = null;
    window.removeEventListener('resize', onResize);
    document.removeEventListener('visibilitychange', onVis);
    for (const ch of instances) ch.inst.unmount?.();
    instances.length = 0;
  }

  return {
    start, destroy,
    progressOf(id) { const ch = instances.find(c => c.id === id); return ch ? ch.p : 0; },
    debug() { return instances.map(c => ({ id: c.id, W: c.W, H: c.H, cw: c.canvas.width, chh: c.canvas.height, p: +c.p.toFixed(3), visible: c.visible, top: c.sec.offsetTop })); },
    scrollTo(id) {
      const sec = document.querySelector(`section[data-ch="${id}"]`);
      if (sec) sec.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth' });
    },
    get sound() { return api.sound; }
  };
}

function hash01(i, q) {
  const s = Math.sin(i * 12.9898 + q * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

export function tremor(f, t, x, y) {
  if (!f) return { dx: 0, dy: 0 };
  const a = 0.35 * f * f;
  const q = Math.floor(t * 12);
  const dx = Math.sin((x * 13 + y * 7 + q * 1.7) * 1.618);
  const dy = Math.cos((x * 11 + y * 17 + q * 2.3) * 1.414);
  return { dx: dx * a, dy: dy * a };
}

export function corrupt(f, t, i) {
  if (!f) return false;
  const p = 0.005 * f * f * f;
  return hash01(i, Math.floor(t * 60)) < p;
}

export function ecg(ctx, api, { x, y, w, h, t, f, hoursLeft, dead, offline, color }) {
  const cell = Math.max(5, Math.min(16, Math.floor(h / 4)));
  const atlas = api.atlasFor(cell);
  const cols = Math.ceil(w / cell);
  const rows = Math.max(3, Math.floor(h / (cell / CELL_ASPECT)));
  const mid = Math.floor(rows / 2);
  const speed = 48;
  const scroll = (t * speed) % 48;
  const hf = dead ? 0 : 0.35 + 0.65 * clamp((hoursLeft ?? 0) / 240, 0, 1);   // peaks shrink with the hours but never vanish while alive
  const jit = (f || 0) * 0.8;
  const ci = COLOR_MAP[color] ?? 1;
  const baseAlpha = offline ? 0.25 : dead ? 0.4 : 1;
  for (let col = 0; col < cols; col++) {
    let phase = (col + scroll) % 48;
    if (phase < 0) phase += 48;
    const dist = Math.min(phase, 48 - phase);
    let rowOff = 0;
    let ch = '-';
    if (!dead && !offline && dist < 3) {
      const amp = (1 - dist / 3) * (rows - 2) / 2 * hf;
      rowOff = -Math.round(amp);
      const ratio = amp / ((rows - 2) / 2);
      if (ratio > 0.65) ch = '@';
      else if (ratio > 0.3) ch = '^';
      else ch = '!';
    }
    if (!dead && !offline && jit > 0) {
      rowOff += Math.round(Math.sin(col * 1.9 + t * 18) * 0.5 * jit);
    }
    const cx = x + col * cell;
    const cy = y + (mid + rowOff) * (cell / CELL_ASPECT);
    const gi = RAMP.indexOf(ch);
    atlas.blit(ctx, gi >= 0 ? gi : 2, ci, baseAlpha, cx, cy, cell, cell / CELL_ASPECT);
  }
}
