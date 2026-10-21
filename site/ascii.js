/* ascii.js — a character field, the way midjourney.com and zkpass.org draw their heroes:
   the whole picture is monospace glyphs on a canvas. Here the field is a tunnel of their own words,
   with Wick's flame and OBOL's coin standing in it, both sized by their real treasuries. */

const RAMP = ' .,:;-~=+*xo#%@';
const BLUE = ['#1a2152', '#2a3590', '#4452c9', '#7a86ff', '#b9c1ff'];
const WARM = ['#3a2810', '#8a5a1a', '#d9962b', '#ffd27a', '#fff3cf'];
const SILVER = ['#2a2e36', '#555c68', '#8d95a3', '#c6ccd6', '#f4f6fa'];
const LIME = ['#2d3a0e', '#6c8a1e', '#a9d12c', '#d6f54a', '#f1ffb0'];

export function mount(container, opts = {}) {
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  container.append(canvas);
  const ctx = canvas.getContext('2d', { alpha: false });
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const st = { cols: 0, rows: 0, cw: 8, ch: 15, dpr: 1, text: 'VIGIL ', wick: 0.5, obol: 0.5, wickOn: true, obolOn: true, mx: 0, my: 0, tmx: 0, tmy: 0, t: 0, heat: null, atlas: null, atlasKey: '', raf: 0, running: false, font: 13 };
  Object.assign(st, opts);

  function size() {
    const r = container.getBoundingClientRect();
    st.dpr = Math.min(2, devicePixelRatio || 1);
    const small = r.width < 700;
    st.font = small ? 10 : 13; st.cw = st.font * 0.602; st.ch = st.font * 1.15;
    canvas.width = Math.floor(r.width * st.dpr); canvas.height = Math.floor(r.height * st.dpr);
    canvas.style.width = r.width + 'px'; canvas.style.height = r.height + 'px';
    st.cols = Math.ceil(r.width / st.cw); st.rows = Math.ceil(r.height / st.ch);
    st.heat = new Float32Array(st.cols * st.rows);
    buildAtlas();
  }
  function buildAtlas() {
    const key = `${st.font}:${st.dpr}`; if (st.atlasKey === key) return; st.atlasKey = key;
    const chars = RAMP + 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789,.;:\'"-_/$()';
    const pal = [...BLUE, ...WARM, ...SILVER, ...LIME];
    const cw = Math.ceil(st.cw * st.dpr), ch = Math.ceil(st.ch * st.dpr);
    const a = document.createElement('canvas'); a.width = cw * chars.length; a.height = ch * pal.length;
    const c = a.getContext('2d'); c.font = `${st.font * st.dpr}px ui-monospace, Menlo, Consolas, monospace`; c.textBaseline = 'middle'; c.textAlign = 'center';
    pal.forEach((col, pi) => { c.fillStyle = col; for (let i = 0; i < chars.length; i++) c.fillText(chars[i], i * cw + cw / 2, pi * ch + ch / 2); });
    st.atlas = { img: a, cw, ch, chars, index: Object.fromEntries([...chars].map((ch, i) => [ch, i])) };
  }
  const glyph = (ch, pal, lvl, col, row) => {
    const A = st.atlas; const i = A.index[ch]; if (i == null || ch === ' ') return;
    ctx.drawImage(A.img, i * A.cw, (pal * 5 + lvl) * A.ch, A.cw, A.ch, Math.round(col * st.cw * st.dpr), Math.round(row * st.ch * st.dpr), A.cw, A.ch);
  };
  const lvlOf = (b) => Math.max(0, Math.min(4, Math.floor(b * 5)));
  const rampOf = (b) => RAMP[Math.max(0, Math.min(RAMP.length - 1, Math.floor(b * RAMP.length)))];
  // cheap value noise
  const hash = (x, y) => { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); };
  const noise = (x, y) => { const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi; const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf); return hash(xi, yi) * (1 - u) * (1 - v) + hash(xi + 1, yi) * u * (1 - v) + hash(xi, yi + 1) * (1 - u) * v + hash(xi + 1, yi + 1) * u * v; };

  function frame() {
    const { cols, rows, cw, ch } = st; if (!cols) return;
    st.t += reduced ? 0 : 1 / 30;
    st.mx += (st.tmx - st.mx) * 0.06; st.my += (st.tmy - st.my) * 0.06;
    ctx.fillStyle = '#070a1a'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    const aspect = ch / cw; const cx = cols / 2 + st.mx * cols * 0.08, cy = rows * 0.52 + st.my * rows * 0.08;
    const text = st.text; const tl = text.length; const t = st.t;
    const wide = cols > 90;
    // flame and coin anchors (cells)
    const fx = wide ? cols * 0.22 : cols * 0.5, fy = wide ? rows * 0.93 : rows * 0.96;
    const ox = wide ? cols * 0.78 : cols * 0.5, oy = wide ? rows * 0.5 : rows * 0.3;
    const fh = (0.25 + 0.55 * st.wick) * rows, fw = (0.07 + 0.09 * st.wick) * cols;
    const R = (wide ? 0.12 + 0.2 * st.obol : 0.08 + 0.12 * st.obol) * rows; const phi = t * 0.9; const cosp = Math.cos(phi);
    // 1. the tunnel of words
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const u = (col - cx), v = (row - cy) * aspect; const r = Math.sqrt(u * u + v * v) / (rows * aspect * 0.5); const a = Math.atan2(v, u);
        const depth = 1 / (r + 0.08);
        const ring = Math.floor(depth * 2.2 + t * 0.6);
        const idx = Math.floor(a / (2 * Math.PI) * (28 + ring * 9) + ring * 17 + t * 2) ;
        const chr = text[((idx % tl) + tl) % tl];
        const n = noise(col * 0.11 + t * 0.3, row * 0.17 - t * 0.2);
        let b = (1.0 - r * 0.7) * (0.55 + 0.45 * n) * (0.65 + 0.35 * Math.sin(ring * 1.7 + t * 1.3));
        if (r < 0.1) b *= r * 10; // dark centre for the wordmark
        if (b > 0.1 && chr !== ' ') glyph(chr, 0, lvlOf(b * 0.9), col, row);
      }
    }
    // 2. Wick's flame: a heat buffer rising
    if (st.wickOn) {
      const H = st.heat; const baseRow = Math.min(rows - 1, Math.floor(fy));
      for (let col = 0; col < cols; col++) { const d = Math.abs(col - fx) / fw; H[baseRow * cols + col] = d < 1 ? (1 - d * d) * (0.75 + 0.25 * noise(col * 0.5, t * 6)) : 0; }
      for (let row = 0; row < baseRow; row++) for (let col = 1; col < cols - 1; col++) {
        const below = (row + 1) * cols; const i = row * cols + col;
        const drift = noise(col * 0.2, row * 0.3 + t * 3) > 0.5 ? 1 : -1;
        const src = Math.max(1, Math.min(cols - 2, col + (Math.random() < 0.35 ? drift : 0)));
        const cool = (1 / Math.max(6, fh)) * (0.8 + 0.6 * noise(col * 0.3 + t, row * 0.3));
        H[i] = Math.max(0, (H[below + src] * 0.985) - cool);
      }
      for (let row = 0; row <= baseRow; row++) for (let col = 0; col < cols; col++) { const h = H[row * cols + col]; if (h > 0.06) glyph(rampOf(h), 1, lvlOf(h), col, row); }
      // the wick
      for (let row = baseRow + 1; row < Math.min(rows, baseRow + 3); row++) glyph('|', 2, 3, Math.round(fx), row);
    }
    // 3. OBOL's coin: a disc turning on its axis, rim-lit
    if (st.obolOn) {
      const rx = Math.max(0.08, Math.abs(cosp)) * R / aspect, ry = R;
      const c0 = Math.floor(ox - rx - 1), c1 = Math.ceil(ox + rx + 1), r0 = Math.floor(oy - ry / aspect - 1), r1 = Math.ceil(oy + ry / aspect + 1);
      for (let row = Math.max(0, r0); row < Math.min(rows, r1); row++) for (let col = Math.max(0, c0); col < Math.min(cols, c1); col++) {
        const x = (col - ox) / rx, y = (row - oy) * aspect / ry; const d2 = x * x + y * y; if (d2 > 1) continue;
        const z = Math.sqrt(1 - d2); const light = 0.35 + 0.65 * Math.max(0, (-x * 0.5 + -y * 0.6 + z * 0.62)) ;
        const rim = d2 > 0.86 ? 0.35 : 0; const ringIn = Math.abs(d2 - 0.42) < 0.07 ? 0.3 : 0; const grain = 0.08 * noise(col * 0.7 + t, row * 0.9);
        const b = Math.min(1, light * (0.75 + 0.25 * Math.abs(cosp)) + rim + ringIn + grain);
        glyph(rampOf(b), 2, lvlOf(b), col, row);
      }
    }
  }
  function loop() { if (!st.running) return; frame(); st.raf = setTimeout(() => requestAnimationFrame(loop), 1000 / 30); }
  function start() { if (st.running) return; st.running = true; loop(); }
  function stop() { st.running = false; clearTimeout(st.raf); }
  const onMove = (e) => { const r = container.getBoundingClientRect(); st.tmx = ((e.clientX - r.left) / r.width - 0.5) * 2; st.tmy = ((e.clientY - r.top) / r.height - 0.5) * 2; };
  addEventListener('pointermove', onMove, { passive: true });
  const ro = new ResizeObserver(() => { size(); if (reduced) frame(); }); ro.observe(container);
  size();
  const io = new IntersectionObserver((es) => { for (const e of es) { if (reduced) { frame(); return; } e.isIntersecting ? start() : stop(); } }); io.observe(container);
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); else if (!reduced) start(); });
  return {
    set(o) { Object.assign(st, o); if (reduced) frame(); },
    destroy() { stop(); ro.disconnect(); io.disconnect(); removeEventListener('pointermove', onMove); canvas.remove(); },
  };
}
