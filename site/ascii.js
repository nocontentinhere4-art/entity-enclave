/*
 * ascii.js — reusable ASCII-scene engine (ZEALOT v50: v21 engine + glyph-atlas fast path via glyphs.js).
 *
 * mountAscii(canvas, opts) samples an image once into a luminance grid (the approved glyph
 * renderer from hero.js: luminance sampling, ramp ' .-~:;=!*+^%$#&@', yellow #f4b728 for the
 * brightest cells) and renders it at 30 fps from ONE shared setTimeout clock. Each scene supplies
 * a `motion(inst, t)` that returns a small, pre-allocated hint describing per-cell luminance /
 * alpha / char / yellow — the hint functions are pure math over the scene's own closure state, so
 * nothing is allocated per frame beyond the glyph loop itself. An IntersectionObserver means only
 * canvases in view render; the loop pauses while the tab is hidden; prefers-reduced-motion draws a
 * single static frame. Device pixel ratio is capped at 2.
 *
 * Do not import this into hero.js — hero.js keeps its own clock and its own renderer. This module
 * is for every OTHER scene on the page.
 */

import { makeAtlas } from './glyphs.js';

export const RAMP = ' .-~:;=!*+^%$#&@';

const LIME = '#f4b728';
const BRIGHT = 'rgba(242,242,238,.92)';
const DIM = 'rgba(242,242,238,.5)';
const MONO = '"JetBrains Mono", "SF Mono", Menlo, monospace';
const GAMMA = 1.0;
const THRESH = 0.09;
const YELLOW_AT = 0.80;
const CELL_ASPECT = 1.15;
const FPS = 30;

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

const instances = [];
const byCanvas = new Map();
let timer = 0;
let running = false;
let io = null;

function ensureIO() {
  if (io) return io;
  io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const inst = byCanvas.get(entry.target);
      if (!inst) continue;
      inst.visible = entry.isIntersecting;
      if (inst.visible && inst.ready && inst.draw) inst.draw(performance.now() / 1000);
    }
  }, { rootMargin: '120px' });
  return io;
}

function startClock() {
  if (running) return;
  running = true;
  timer = setTimeout(tick, 1000 / FPS);
}

function tick() {
  const now = performance.now();
  if (!document.hidden) {
    const t = now / 1000;
    for (let i = 0; i < instances.length; i++) {
      const inst = instances[i];
      if (inst.ready && inst.visible && !inst.reduced) inst.draw(t);
    }
  }
  timer = setTimeout(tick, 1000 / FPS);
}

function resolve(f, i, x, y, base) {
  const t = typeof f;
  if (t === 'function') return f(i, x, y, base);
  if (t === 'number') return f;
  return f[i];
}
function resolveBool(f, i, x, y, base) {
  if (typeof f === 'boolean') return f;
  return f(i, x, y, base);
}

/**
 * mountAscii(canvas, {
 *   src,            image URL
 *   cell = 7,       px per glyph cell (horizontal)
 *   fit = 'contain','contain' | 'cover'
 *   align = 'center', 'center' | 'top' | 'bottom' | 'left' | 'right' | 'top-left' …
 *   gap = 0,        px of inset padding on each side of the grid
 *   ramp = RAMP,
 *   yellowAt = 0.80, luminance above which the brightest cells go yellow
 *   yellow = true,   false to disable the yellow accent entirely (low-contrast scenes)
 *   thresh = 0.09,   below this luminance: empty cell
 *   opacity = 1,     uniform global alpha
 *   motion,          (inst, t) => { lum?, alpha?, char?, yellow? } (pre-allocated per scene)
 * })
 * Returns { canvas, resample, destroy }.
 */
export function mountAscii(canvas, opts = {}) {
  const cell = opts.cell || 7;
  const fit = opts.fit || 'contain';
  const align = opts.align || 'center';
  const gap = opts.gap || 0;
  const ramp = opts.ramp || RAMP;
  const yellowAt = opts.yellowAt != null ? opts.yellowAt : YELLOW_AT;
  const thresh = opts.thresh != null ? opts.thresh : THRESH;
  const opacity = opts.opacity != null ? opts.opacity : 1;
  const yellow = opts.yellow !== false;
  const motion = opts.motion || null;

  const rampIndex = Object.create(null);
  for (let i = 0; i < ramp.length; i++) rampIndex[ramp[i]] = i;

  const img = new Image();
  const off = document.createElement('canvas');
  const octx = off.getContext('2d', { willReadFrequently: true });
  const ctx = canvas.getContext('2d');

  const inst = {
    canvas, ctx, img, off, octx,
    cell, fit, align, gap, ramp, yellowAt, thresh, opacity, yellow, motion,
    W: 0, H: 0, dpr: 1, cols: 0, rows: 0, total: 0,
    lum: null, ready: false, visible: true, reduced: reduced.matches,
    atlas: null, atlasReady: false, atlasGen: 0,
    colors: [LIME, BRIGHT, DIM],
    rampIndex,
  };

  function blit() {
    const iw = img.width, ih = img.height;
    if (!iw || !ih) return;
    const cols = inst.cols, rows = inst.rows;
    octx.clearRect(0, 0, cols, rows);
    octx.fillStyle = '#000';
    octx.fillRect(0, 0, cols, rows);
    const cw = cols - gap * 2;
    const ch = rows - gap * 2;
    if (cw <= 0 || ch <= 0) return;
    const imgAspect = iw / ih;
    const cellAspect = cw / ch;
    let dw, dh;
    if (fit === 'cover') {
      if (imgAspect > cellAspect) { dh = ch; dw = ch * imgAspect; }
      else { dw = cw; dh = cw / imgAspect; }
    } else {
      if (imgAspect > cellAspect) { dw = cw; dh = cw / imgAspect; }
      else { dh = ch; dw = ch * imgAspect; }
    }
    let dx = gap + (cw - dw) / 2;
    let dy = gap + (ch - dh) / 2;
    if (align === 'left' || align === 'top-left' || align === 'bottom-left') dx = gap;
    else if (align === 'right' || align === 'top-right' || align === 'bottom-right') dx = gap + (cw - dw);
    if (align === 'top' || align === 'top-left' || align === 'top-right') dy = gap;
    else if (align === 'bottom' || align === 'bottom-left' || align === 'bottom-right') dy = gap + (ch - dh);
    octx.drawImage(img, dx, dy, dw, dh);
  }

  function readLum() {
    const d = octx.getImageData(0, 0, inst.cols, inst.rows).data;
    const lum = inst.lum;
    for (let i = 0; i < inst.total; i++) {
      const l = (d[i * 4] * 0.2126 + d[i * 4 + 1] * 0.7152 + d[i * 4 + 2] * 0.0722) / 255;
      lum[i] = Math.pow(l, GAMMA);
    }
  }

  function sample() {
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    if (!W || !H) return;
    inst.W = W;
    inst.H = H;
    inst.dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(W * inst.dpr);
    canvas.height = Math.round(H * inst.dpr);
    inst.cols = Math.floor(W / inst.cell);
    inst.rows = Math.floor(H / (inst.cell * CELL_ASPECT));
    inst.total = inst.cols * inst.rows;
    if (inst.cols <= 0 || inst.rows <= 0) { inst.lum = null; return; }
    off.width = inst.cols;
    off.height = inst.rows;

    const cellH = inst.cell * CELL_ASPECT;
    inst.atlasGen++;
    const myGen = inst.atlasGen;
    if (inst.atlas) { inst.atlas.dispose(); inst.atlas = null; }
    inst.atlas = makeAtlas({ ramp, cellW: inst.cell, cellH, dpr: inst.dpr, font: MONO, colors: inst.colors, fontScale: 1.25 });
    inst.atlasReady = !document.fonts || document.fonts.status === 'loaded';
    if (document.fonts && document.fonts.status !== 'loaded') {
      document.fonts.ready.then(() => {
        if (myGen !== inst.atlasGen || !inst.atlas) return;
        inst.atlas.dispose();
        inst.atlas = makeAtlas({ ramp, cellW: inst.cell, cellH, dpr: inst.dpr, font: MONO, colors: inst.colors, fontScale: 1.25 });
        inst.atlasReady = true;
        if (inst.reduced && inst.draw) inst.draw(0);
      });
    }

    inst.lum = new Float32Array(inst.total);
    blit();
    readLum();
    inst.draw(inst.reduced ? 0 : performance.now() / 1000);
  }

  function draw(t) {
    if (!inst.ready || !inst.lum) return;
    const cols = inst.cols, total = inst.total, lum = inst.lum;
    const n = ramp.length - 1;
    const atlas = inst.atlas;
    const atlasReady = inst.atlasReady;
    ctx.setTransform(inst.dpr, 0, 0, inst.dpr, 0, 0);
    ctx.clearRect(0, 0, inst.W, inst.H);
    ctx.font = `${inst.cell * 1.25}px ${MONO}`;
    ctx.textBaseline = 'top';
    const hint = inst.motion ? inst.motion(inst, t) : null;
    for (let i = 0; i < total; i++) {
      const x = i % cols;
      const y = (i / cols) | 0;
      const base = lum[i];
      let l = base;
      let a = inst.opacity;
      let ci = null;
      let yel = null;
      let jx = 0, jy = 0;
      if (hint) {
        if (hint.lum != null) l = resolve(hint.lum, i, x, y, base);
        if (hint.alpha != null) a = inst.opacity * resolve(hint.alpha, i, x, y, 1);
        if (hint.char != null) ci = resolve(hint.char, i, x, y, base);
        if (hint.yellow != null) yel = resolveBool(hint.yellow, i, x, y, base);
        if (hint.dx != null) jx = resolve(hint.dx, i, x, y, base);
        if (hint.dy != null) jy = resolve(hint.dy, i, x, y, base);
      }
      if (l < inst.thresh) continue;
      const v = Math.min(1, Math.max(0, l));
      let c;
      if (ci == null) c = Math.round(v * n);
      else { c = Math.round(ci); if (c < 0) c = 0; else if (c > n) c = n; }
      const ch = ramp[c];
      if (ch === ' ') continue;
      const isLime = inst.yellow && (yel === true || (yel == null && v > inst.yellowAt));
      const colorIdx = isLime ? 0 : (v > 0.55 ? 1 : 2);
      const alpha01 = a;
      if (alpha01 <= 0) continue;
      const dx = x * inst.cell + jx;
      const dy = y * inst.cell * CELL_ASPECT + jy;
      if (atlasReady && atlas) {
        const gi = inst.rampIndex[ch];
        if (gi != null) atlas.blit(ctx, gi, colorIdx, alpha01, dx, dy);
      } else {
        ctx.globalAlpha = a;
        ctx.fillStyle = isLime ? LIME : (v > 0.55 ? BRIGHT : DIM);
        ctx.fillText(ch, dx, dy);
      }
    }
    ctx.globalAlpha = 1;
  }

  inst.draw = draw;

  const onload = () => {
    if (inst.ready) return;
    inst.ready = img.naturalWidth > 0;
    if (inst.ready) sample();
  };
  img.addEventListener('load', onload);
  img.addEventListener('error', () => { inst.ready = false; });
  img.src = opts.src;
  if (img.complete) onload();

  let ro = null;
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => { if (inst.ready) sample(); });
    ro.observe(canvas);
  } else {
    window.addEventListener('resize', () => { if (inst.ready) sample(); }, { passive: true });
  }

  ensureIO().observe(canvas);
  instances.push(inst);
  byCanvas.set(canvas, inst);
  startClock();

  return {
    canvas,
    resample: () => { if (inst.ready) sample(); },
    redraw: () => { if (inst.ready && inst.reduced) inst.draw(0); },
    setSrc: (url) => { inst.ready = false; img.src = url; },
    get reduced() { return inst.reduced; },
    get lum() { return inst.lum; },
    destroy() {
      if (ro) ro.disconnect();
      ensureIO().unobserve(canvas);
      if (inst.atlas) { inst.atlas.dispose(); inst.atlas = null; }
      const at = instances.indexOf(inst);
      if (at >= 0) instances.splice(at, 1);
      byCanvas.delete(canvas);
    },
  };
}

export function getInstances() {
  return instances;
}
