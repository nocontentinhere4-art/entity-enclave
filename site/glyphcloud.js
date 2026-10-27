// glyphcloud.js — one of the site's monochrome renders as a breathing cloud of glyphs on a canvas.
// The same rule as everything else on the page: a photoreal render on black → luminance → glyphs with relief.
const RAMP = ' .:-=+*#%@';
const cache = new Map();   // src → Promise<{cells, cols}>

function sample(src, cols) {
  const key = `${src}@${cols}`;
  if (!cache.has(key)) {
    cache.set(key, new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const rows = cols;
        const c = document.createElement('canvas'); c.width = cols; c.height = rows;
        const g = c.getContext('2d'); g.drawImage(img, 0, 0, cols, rows);
        const px = g.getImageData(0, 0, cols, rows).data;
        const cells = [];
        for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
          const i = (y * cols + x) * 4, l = (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255;
          if (l > 0.14) cells.push(x, y, l);
        }
        resolve({ cells, cols });
      };
      img.onerror = () => reject(new Error(`cloud: ${src} did not load`));
      img.src = src;
    }));
  }
  return cache.get(key);
}

/**
 * Draws `src` into `canvas` as a glyph cloud and keeps it breathing until the returned function is called.
 * @param {HTMLCanvasElement} canvas
 * @param {string} src
 * @param {{cols?:number, dim?:number}} [opts]  cols: sampling grid (64); dim: overall alpha (1)
 */
export function mountCloud(canvas, src, opts = {}) {
  const cols = opts.cols || 64, dim = opts.dim == null ? 1 : opts.dim;
  let alive = true, raf = 0, t = Math.random() * 10, cells = null;
  sample(src, cols).then((s) => { if (alive) { cells = s.cells; loop(); } }).catch(() => {});

  function loop() {
    if (!alive) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) { raf = requestAnimationFrame(loop); return; }
    if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const cell = Math.min(w, h) / cols, ox = (w - cols * cell) / 2, oy = (h - cols * cell) / 2;
    ctx.font = `${Math.max(7, cell * 1.6)}px "JetBrains Mono", "SF Mono", Menlo, monospace`;
    ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
    t += 1 / 60;
    const breath = 0.92 + 0.08 * Math.sin(t * 1.7);
    for (let i = 0; i < cells.length; i += 3) {
      const x = cells[i], y = cells[i + 1];
      let l = cells[i + 2];
      const n = (Math.sin(x * 12.9898 + y * 78.233 + t * 2.3) * 43758.5453) % 1;
      if (n > 0.985) l = Math.min(1, l + 0.5); else if (n < -0.985) l *= 0.3;
      const k = Math.min(RAMP.length - 1, Math.floor(l * RAMP.length));
      const a = (0.25 + 0.75 * l) * breath * dim;
      ctx.fillStyle = l > 0.93 ? `rgba(244,183,40,${a})` : `rgba(242,242,238,${a})`;
      ctx.fillText(RAMP[k], ox + (x + 0.5) * cell, oy + (y + 0.5) * cell);
    }
    raf = requestAnimationFrame(loop);
  }
  return () => { alive = false; cancelAnimationFrame(raf); };
}
