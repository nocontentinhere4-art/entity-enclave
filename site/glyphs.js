/* glyphs.js — shared glyph-atlas builder and stats probe (ZEALOT v50)
 * Written by Kimi K2.7 Code from the integrator's spec; gutter fix by the integrator.
 * Bakes (ramp × colour × alpha-level) sprites onto offscreen canvas(s).
 * Exports makeAtlas() and fpsProbe(); no runtime dependencies. */

export function makeAtlas({ ramp, cellW, cellH, dpr, font, colors, fontScale = 1.2, maxSide = 4096 }) {
  const glyphCount = ramp.length;
  const colorCount = colors.length;
  // sprites carry a 1 px horizontal / 2 px vertical gutter so wide glyphs and descenders never clip
  const PX = 1, PY = 2;
  const cssW = cellW + 2 * PX;
  const cssH = cellH + 2 * PY;
  const sw = Math.max(1, Math.round(cssW * dpr));
  const sh = Math.max(1, Math.round(cssH * dpr));
  const fontSize = cssW * fontScale * dpr;

  const key = [ramp, cellW, cellH, dpr, font, colors.join('\x00'), fontScale].join('\x00');

  const maxPerRow = Math.max(1, Math.floor(maxSide / sw));
  const maxRows = Math.max(1, Math.floor(maxSide / sh));
  const maxPerCanvas = maxPerRow * maxRows;

  let levels = 8;
  let totalSprites = glyphCount * colorCount * levels;
  if (totalSprites > maxPerCanvas) {
    levels = 4;
    totalSprites = glyphCount * colorCount * levels;
  }
  const canvasCount = Math.max(1, Math.ceil(totalSprites / maxPerCanvas));
  // size each sheet to what it holds (a 4096² sheet for 1,152 sprites made drawImage crawl)
  const perSheet = Math.min(totalSprites, maxPerCanvas);
  const rowsUsed = Math.max(1, Math.ceil(perSheet / maxPerRow));
  const canvasW = Math.min(perSheet, maxPerRow) * sw;
  const canvasH = rowsUsed * sh;

  const canvases = [];
  const contexts = [];
  for (let i = 0; i < canvasCount; i++) {
    const c = document.createElement('canvas');
    c.width = canvasW;
    c.height = canvasH;
    const x = c.getContext('2d');
    x.textBaseline = 'top';
    x.textAlign = 'left';
    canvases.push(c);
    contexts.push(x);
  }

  for (let g = 0; g < glyphCount; g++) {
    const ch = ramp[g];
    if (ch === ' ') continue;
    for (let ci = 0; ci < colorCount; ci++) {
      const fill = colors[ci];
      for (let a = 0; a < levels; a++) {
        const globalIdx = ((g * colorCount + ci) * levels + a);
        const cIdx = Math.floor(globalIdx / maxPerCanvas);
        const localIdx = globalIdx % maxPerCanvas;
        const x = contexts[cIdx];
        const sx = (localIdx % maxPerRow) * sw;
        const sy = Math.floor(localIdx / maxPerRow) * sh;
        x.fillStyle = fill;
        x.globalAlpha = (a + 1) / levels;
        x.font = `${fontSize}px ${font}`;
        x.fillText(ch, sx + PX * dpr, sy + PY * dpr);
      }
    }
  }

  function blit(ctx, glyphIndex, colorIndex, alpha01, x, y) {
    let idx = Math.round(alpha01 * levels);
    if (idx <= 0) return;
    if (idx > levels) idx = levels;
    const a = idx - 1;
    const globalIdx = ((glyphIndex * colorCount + colorIndex) * levels + a);
    const cIdx = Math.floor(globalIdx / maxPerCanvas);
    if (cIdx >= canvases.length) return;
    const localIdx = globalIdx % maxPerCanvas;
    const sx = (localIdx % maxPerRow) * sw;
    const sy = Math.floor(localIdx / maxPerRow) * sh;
    ctx.drawImage(canvases[cIdx], sx, sy, sw, sh, Math.round(x) - PX, Math.round(y) - PY, cssW, cssH);
  }

  function dispose() {
    for (const c of canvases) { c.width = 0; c.height = 0; }
    canvases.length = 0;
    contexts.length = 0;
  }

  return { key, levels, blit, dispose };
}

export function fpsProbe() {
  const o = { ms: 0 };
  let last = 0;
  const alpha = 0.1;
  o.start = () => { last = performance.now(); };
  o.end = () => {
    const d = performance.now() - last;
    o.ms = o.ms ? o.ms + (d - o.ms) * alpha : d;
  };
  return o;
}
