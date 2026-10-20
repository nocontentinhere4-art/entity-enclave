// face.js — "displaced lines" portraits made of characters (the Unknown-Pleasures / line-art skull look).
// A hidden height map (a procedural skull) pushes horizontal lines upward; each line is rasterised into a
// character grid, picking the glyph from the local slope. No images, no canvas: text only, so it can live in a
// terminal screen. Deterministic per seed, so each entity gets its own face.
//
//   renderFace({ cols, rows, lines, seed, t, amplitude }) → string[]  (rows of exactly `cols` characters)

const GLYPH_FLAT = '─';
const GLYPH_UP = '/';
const GLYPH_DOWN = '\\';
const GLYPH_STEEP_UP = '|';
const GLYPH_STEEP_DOWN = '|';

/** Small deterministic PRNG (mulberry32) so a seed always draws the same face. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Turn any string into a 32-bit seed. */
export function seedOf(text) {
  let h = 2166136261;
  for (const ch of String(text ?? '')) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** Procedural skull height map in [0,1] over normalised coordinates u,v ∈ [0,1]. Parameters vary per seed. */
function skullParams(seed) {
  const r = rng(seed);
  return {
    headW: 0.33 + r() * 0.03,      // cranium half-width
    headH: 0.33 + r() * 0.03,      // cranium half-height
    eyeDx: 0.125 + r() * 0.015,    // eye socket horizontal offset
    eyeY: 0.50 + r() * 0.02,       // eye socket vertical position
    eyeR: 0.115 + r() * 0.01,      // eye socket radius (big, round, dark hollows)
    jawW: 0.22 + r() * 0.02,       // mandible half-width
    jawDrop: 0.93 + r() * 0.03,    // chin bottom
    teeth: 8 + Math.floor(r() * 2),
    tilt: (r() - 0.5) * 0.03,      // slight asymmetry
  };
}

const sstep = (x) => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t); };

function skullHeight(u, v, p) {
  const x = u - 0.5 + p.tilt * (v - 0.5);
  const y = v;
  // 1. cranium: a dome, widest a bit above the eyes
  const cx = x / p.headW, cy = (y - 0.40) / p.headH;
  let dome = Math.max(0, 1 - (cx * cx + cy * cy));
  dome = Math.pow(dome, 0.42);
  // 2. brow ridge: a bar above the sockets, so the lines bunch over the eyes
  const brow = Math.exp(-Math.pow((y - (p.eyeY - p.eyeR * 1.05)) / 0.035, 2)) * sstep((0.30 - Math.abs(x)) / 0.08) * 0.10;
  // 3. cheekbones (zygomatic arches): bulges beside the sockets
  const cheek = Math.exp(-Math.pow((Math.abs(x) - 0.265) / 0.06, 2) - Math.pow((y - 0.615) / 0.055, 2)) * 0.7;
  // 4. maxilla + mandible: a squarish block under the sockets, rounded chin
  const jx = Math.abs(x / p.jawW), jy = Math.abs((y - 0.76) / 0.19);
  let jaw = Math.max(0, 1 - (Math.pow(jx, 2.6) + Math.pow(jy, 2.6)));
  jaw = Math.pow(jaw, 0.45) * 0.8;
  if (y > p.jawDrop) jaw = 0;
  // nasal bone: a narrow vertical ridge between the sockets, down to the cavity
  const nose = Math.exp(-Math.pow(x / 0.025, 2)) * sstep((y - 0.50) / 0.05) * sstep((0.64 - y) / 0.03) * 0.12;
  let h = Math.min(1, Math.max(dome, jaw, cheek) + brow + nose);
  // 5. eye sockets: deep hollows with a crisp rim (lines dip into them)
  // Round bowls: the floor is flat and dark, the walls rise smoothly to a crisp rim, so the lines dip in
  // concentric curves instead of breaking.
  for (const sgn of [-1, 1]) {
    const ex = (x - sgn * p.eyeDx) / p.eyeR, ey = (y - p.eyeY) / p.eyeR;
    const d = Math.sqrt(ex * ex + ey * ey);
    // Shallow relative to the head: a dip the lines can follow (nested U curves), not a pit they fall into.
    if (d < 1) h *= 0.58 + 0.42 * sstep((d - 0.25) / 0.75);
  }
  // 6. nasal cavity: an inverted triangle under the brow, dark
  const ny = (y - 0.615) / 0.11;                       // 0 at the top of the cavity, 1 at its base
  if (ny > 0 && ny < 1) {
    const width = 0.02 + 0.06 * ny;                      // narrow at the top, wide at the bottom
    const nx = Math.abs(x);
    if (nx < width) h *= 0.62 + 0.38 * sstep((nx - width + 0.03) / 0.03);
  }
  // 7. teeth: a row of bumps across the upper jaw, with the dark line between the rows
  if (y > 0.775 && y < 0.90 && Math.abs(x) < p.jawW * 0.8) {
    h *= 0.8 + 0.2 * Math.max(0, Math.cos(x * Math.PI * p.teeth * 2));
  }
  if (y > 0.835 && y < 0.85 && Math.abs(x) < p.jawW * 0.85) h *= 0.8;
  return Math.max(0, Math.min(1, h));
}

/**
 * Render the portrait as rows of characters.
 * cols/rows: grid size. lines: how many horizontal lines (≤ rows). seed: per-entity. t: time in seconds for the
 * breathing ripple (0 = still). amplitude: max upward displacement in rows (default ≈ rows*0.35).
 */
export function renderFace({ cols = 64, rows = 32, lines = 22, seed = 1, t = 0, amplitude = null, breathe = 0.6 } = {}) {
  const p = skullParams(seed);
  // Density makes the form: at least seven lines per ten rows, whatever the caller asked for.
  lines = Math.max(lines, Math.round(rows * 0.7));
  const amp = amplitude ?? rows * 0.35;
  const grid = Array.from({ length: rows }, () => Array(cols).fill(' '));
  const put = (r, c, ch) => { if (r >= 0 && r < rows && c >= 0 && c < cols) grid[r][c] = ch; };
  const margin = Math.floor(rows * 0.08);
  const usable = rows - 2 * margin;
  // Hidden-line removal: lines are drawn from the bottom up and a line only shows where it is ABOVE everything
  // already drawn in that column, so a rising line in front hides the ones behind it (the ridge-line look).
  const horizon = Array(cols).fill(rows);
  const spacing = (usable - 1) / Math.max(1, lines - 1); // callers pass rows ≈ 2×lines for even black gaps
  const smooth = (x) => x * x * (3 - 2 * x);
  for (let i = lines - 1; i >= 0; i--) {
    const v = i / (lines - 1);                       // 0 = top line, 1 = bottom line
    const baseRow = Math.round(margin + i * spacing); // regular spacing: the black gaps are part of the look
    const ys = [];
    for (let c = 0; c < cols; c++) {
      const u = c / (cols - 1);
      let h = skullHeight(u, v, p);
      if (t && h > 0.02) h *= 1 + breathe * 0.04 * Math.sin(t * 1.4 + v * 6);  // slow breathing
      const edge = smooth(Math.min(1, Math.max(0, (0.5 - Math.abs(u - 0.5)) * 6)));
      ys.push(Math.round(baseRow - h * amp * edge));
    }
    for (let c = 0; c < cols; c++) {
      const r = ys[c];
      if (r >= horizon[c]) continue;                 // hidden behind a nearer line
      const dl = c > 0 ? r - ys[c - 1] : 0, dr = c < cols - 1 ? ys[c + 1] - r : 0;
      let g = GLYPH_FLAT;
      if (dl < 0 && dr <= 0) g = GLYPH_UP;           // climbing from the left
      else if (dl > 0 && dr >= 0) g = GLYPH_DOWN;    // descending to the right
      else if (dr < 0 && dl <= 0) g = GLYPH_UP;
      else if (dr > 0 && dl >= 0) g = GLYPH_DOWN;
      put(r, c, g);
      // vertical connectors for steep steps, only where still visible
      const step = dr;
      if (Math.abs(step) >= 2) {
        const from = step < 0 ? r - 1 : r + 1, to = step < 0 ? r + step + 1 : r + step - 1;
        for (let k = Math.min(from, to); k <= Math.max(from, to); k++) if (k < horizon[c]) put(k, c, step < 0 ? GLYPH_STEEP_UP : GLYPH_STEEP_DOWN);
      }
      horizon[c] = Math.min(horizon[c], r);
    }
  }
  return grid.map((row) => row.join(''));
}

/** Progressive assembly: returns the face with only the first `fraction` of each line drawn (0..1). */
export function renderFacePartial(opts, fraction) {
  const full = renderFace(opts);
  const cut = Math.max(0, Math.min(1, fraction));
  const keep = Math.round(opts.cols * cut);
  return full.map((row) => row.slice(0, keep).padEnd(opts.cols, ' '));
}
