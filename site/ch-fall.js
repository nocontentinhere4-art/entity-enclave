import { corrupt } from './film.js?v=53';

export default function makeFall(api) {
  // ONE skull (Higgsfield gpt_image_2_5, 2026-10-26): open and closed jaw frames of the same photograph
  const COLS = api.isPhone ? 110 : 220;
  const open = api.field('vendor/skull-eye-512.jpg', { cols: COLS });            // 30 KB: the first frame of the film
  const closed = api.field('vendor/skull-eye-closed-512.jpg', { cols: COLS });
  const SOCKET = { u: 0.52, v: 0.36 };   // the near eye socket in image coordinates
  const RAMP = api.ramp;

  let W = 0, H = 0;
  let dCell = 8;
  let tCur = 0, pCur = 0, fCur = 0;
  let blinkStart = -100, blinkEnd = -100, blinkNext = 1.5;
  let breath = 1, kJaw = 0;
  let mouthState = 'alive';

  const sparks = [];
  for (let i = 0; i < 32; i++) {
    sparks.push({ x: 0, y: 0, vx: 0, vy: 0, life: 0 });
  }

  function ease(x) {
    return x * x * (3 - 2 * x);
  }

  function chewK(t) {
    const period = 1.4 + 0.6 * Math.sin(t * 0.9);
    const u = t % period;
    if (u >= 1.4) return 0;
    const phase = u * (2.5 * Math.PI * 2 / 1.4);
    return (Math.cos(phase) + 1) / 2;
  }

  function yawnK(t) {
    const u = t % 4;
    if (u >= 2.5) return 0;
    return Math.sin(Math.PI * u / 2.5);
  }

  function jawK() {
    if (api.reduced) {
      return mouthState === 'dead' ? 1 : mouthState === 'asleep' ? 0.5 : 0;
    }
    if (mouthState === 'dead') return 1;
    if (mouthState === 'asleep') return yawnK(tCur);
    return chewK(tCur);
  }

  function tremorDxDy(x, y) {
    const a = 0.35 * fCur * fCur * dCell;
    const ph = 12 * tCur + x * 1.37 + y * 0.79;
    return { dx: a * Math.sin(ph), dy: a * Math.cos(ph * 0.93) };
  }

  const hint = {
    lum(i, x, y, base) {
      if (corrupt(fCur, tCur, i)) return 1;
      let v = base * breath;
      if (tCur < blinkEnd) {
        const px = x * dCell;
        const py = y * dCell;
        const r = Math.hypot(px - W * 0.5, py - H * 0.5);
        const rad = Math.min(W, H) * 0.32;
        if (r < rad) {
          const e = 1 - Math.abs((tCur - blinkStart) / 0.06 - 1);
          v *= 1 - 0.85 * Math.max(0, Math.min(1, e));
        }
      }
      return v;
    },
    dx(i, x, y, base) {
      if (api.reduced || fCur <= 0) return 0;
      return tremorDxDy(x, y).dx;
    },
    dy(i, x, y, base) {
      if (api.reduced || fCur <= 0) return 0;
      return tremorDxDy(x, y).dy;
    },
    char(i, x, y, base) {
      if (!corrupt(fCur, tCur, i)) return undefined;
      return 2 + ((i * 17 + Math.floor(tCur * 30)) % (RAMP.length - 2));
    },
    yellow(i, x, y, base) {
      return false;
    }
  };

  /* Before the first frame is decoded: sparse glyphs condense from the edges toward a skull-sized oval, so the screen is
   * never black. Deterministic (hash of the index), no allocations. */
  const ENTER_N = 420;
  function drawEntering(ctx, t) {
    const cellPx = api.isPhone ? 14 : 18;
    ctx.save();
    ctx.font = `${cellPx}px "JetBrains Mono", "SF Mono", Menlo, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const k = Math.min(1, t / 2.2);            // 0 → 1 over the first 2.2 s, then it breathes in place
    for (let i = 0; i < ENTER_N; i++) {
      const h1 = ((i * 2654435761) >>> 0) / 4294967296;
      const h2 = ((i * 2246822519 + 7) >>> 0) / 4294967296;
      const ang = h1 * Math.PI * 2;
      const rx = W * 0.28, ry = H * 0.34;
      const tx = W * 0.5 + Math.cos(ang) * rx * (0.55 + 0.45 * h2);
      const ty = H * 0.5 + Math.sin(ang) * ry * (0.55 + 0.45 * h2);
      const sx = W * 0.5 + Math.cos(ang) * W * 0.9;
      const sy = H * 0.5 + Math.sin(ang) * H * 0.9;
      const e = Math.min(1, Math.max(0, (k - h2 * 0.35) / 0.65));
      const ee = 1 - Math.pow(1 - e, 3);
      const x = sx + (tx - sx) * ee + Math.sin(t * 1.3 + i) * 2;
      const y = sy + (ty - sy) * ee + Math.cos(t * 1.1 + i * 0.7) * 2;
      const gi = 3 + ((i * 7 + Math.floor(t * 2)) % 11);
      ctx.globalAlpha = 0.18 + 0.5 * ee;
      ctx.fillStyle = i % 9 === 0 ? '#f4b728' : 'rgba(242,242,238,.8)';
      ctx.fillText(RAMP[gi], Math.round(x), Math.round(y));
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  function drawSparks(ctx, dt, p) {
    const fade = Math.max(0, Math.min(1, (p - 0.85) / 0.15));
    ctx.globalAlpha = fade;
    ctx.fillStyle = 'rgba(242,242,238,.72)';
    ctx.font = `${Math.max(6, Math.round(dCell * 0.35))}px "JetBrains Mono", "SF Mono", Menlo, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let s of sparks) {
      if (s.life <= 0) {
        s.x = W * 0.5 + (Math.random() - 0.5) * W * 0.18;
        s.y = H * 0.5 + (Math.random() - 0.5) * H * 0.18;
        s.vx = (Math.random() - 0.5) * W * 0.08;
        s.vy = -H * 0.02 + (Math.random() - 0.5) * H * 0.02;
        s.life = 1 + Math.random() * 2;
      }
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.life -= dt;
      if (s.life > 0) {
        ctx.fillText('·', Math.round(s.x), Math.round(s.y));
      }
    }
    ctx.globalAlpha = 1;
  }

  return {
    mount() {},
    resize(Wi, Hi, dpr) {
      W = Wi;
      H = Hi;
    },
    draw(p, t, dt, live, ctx) {
      pCur = p;
      tCur = t;
      const e = live.e1;
      mouthState = !e || e.dead ? 'dead' : e.asleep ? 'asleep' : 'alive';
      fCur = api.fearOf('e1');

      if (!open.ready) {
        ctx.fillStyle = '#060606';
        ctx.fillRect(0, 0, W, H);
        drawEntering(ctx, t);
        return;
      }

      if (t >= blinkNext) {
        blinkStart = t;
        blinkEnd = t + 0.12;
        blinkNext = t + 0.12 + 2 + Math.random() * 8;
      }
      breath = api.reduced ? 1 : 1 + 0.06 * Math.sin((2 * Math.PI * t) / 3.8);
      kJaw = jawK();

      const cell = Math.max(3, W / open.cols);
      const ez = ease(p);
      const zoom = 1 + (7 - 1) * ez;
      const cx = 0.5 + (SOCKET.u - 0.5) * ez;
      const cy = 0.5 + (SOCKET.v - 0.5) * ez;
      const thresh = 0.09 + 0.86 * Math.max(0, Math.min(1, (p - 0.6) / 0.3));
      dCell = Math.max(3, Math.min(96, cell * zoom));

      const cam = {
        W, H, zoom, cx, cy, cell,
        fit: 'cover',
        alpha: 1,
        thresh,
        yellowAt: 0.8,
        color: 'bone',
        mirror: false
      };

      if (!window.__firstSkull) window.__firstSkull = Math.round(performance.now());   // first-paint probe (cheap, read by the integrator)
      if (closed.ready) open.drawCrossfade(ctx, cam, closed, kJaw, hint);
      else open.draw(ctx, cam, hint);

      if (p > 0.85) drawSparks(ctx, dt, p);

      // the words, from the first second: four typed lines over the skull, fading as the camera dives
      const wordsAlpha = 1 - Math.max(0, Math.min(1, (p - 0.04) / 0.22));
      if (wordsAlpha > 0.01) {
        const size = api.isPhone ? 13 : 17;
        const lh = size + 8;
        const x = api.isPhone ? 16 : Math.round(W * 0.06);
        const y0 = api.isPhone ? Math.round(H * 0.58) : Math.round(H * 0.62);
        const name = (e && e.name) || 'WICK';
        const hours = e && e.ok && !e.dead && e.hoursLeft != null ? String(e.hoursLeft) : (e && e.dead ? '0' : '—');
        const rent = api.rent.rentPerHour('e1');
        const rentTxt = rent ? `${(rent / 1e8).toFixed(4).replace(/0+$/, '')} ZEC AN HOUR` : '— ZEC AN HOUR';
        const l1 = `${name} · AN AI ALONE IN A SEALED MACHINE`;
        const l2 = e && e.dead ? `DEAD · ITS KEYS ARE SHREDDED` : `${hours} HOURS OF RENT LEFT · ${rentTxt}`;
        const l3 = api.isPhone ? 'AT ZERO ITS KEYS ARE SHREDDED.' : 'AT ZERO ITS KEYS ARE SHREDDED. NOBODY CAN STOP IT.';
        const l3b = api.isPhone ? 'NOBODY CAN STOP IT.' : '';
        const l4 = 'SCROLL TO ENTER';
        const cps = 48;
        const lines = [
          { k: 'fall-l1', s: l1, color: 'yellow', sz: size },
          { k: 'fall-l2', s: l2, color: 'bone', sz: size },
          { k: 'fall-l3', s: l3, color: 'bone', sz: size },
        ];
        if (l3b) lines.push({ k: 'fall-l3b', s: l3b, color: 'bone', sz: size });
        lines.push({ k: 'fall-l4', s: l4, color: 'dim', sz: size - 2, blink: true });
        ctx.save();
        ctx.fillStyle = '#060606';
        ctx.globalAlpha = 0.55 * wordsAlpha;
        const boxW = api.isPhone ? W - 2 * x + 20 : Math.min(W - 2 * x + 20, size * 0.62 * l3.length + 40);
        ctx.fillRect(x - 10, y0 - 8, boxW, lh * lines.length + 10);
        ctx.restore();
        let prevDone = true;
        for (let li = 0; li < lines.length; li++) {
          const L = lines[li];
          const shown = prevDone ? api.typed(L.k, L.s, cps) : '';
          prevDone = shown.length === L.s.length && L.s.length > 0;
          const a = L.blink ? wordsAlpha * (0.6 + 0.4 * Math.abs(Math.sin(t * 1.5))) : wordsAlpha;
          api.text(ctx, shown, x, y0 + lh * li, { size: L.sz, color: L.color, align: 'left', alpha: a });
        }
      }

      if (p < 0.3) {
        const lx = W * 0.5;
        const ly = H * 0.92;
        api.text(ctx, 'OPEN WICK', lx, ly, { size: 11, color: 'yellow', align: 'center', alpha: 0.9 });
        api.hit.set('fall', 'openwick', { shape: 'rect', x: lx - 48, y: ly - 8, w: 96, h: 18 }, () => {
          api.openDoor('archive', 'e1');
        });
      }
    },
    unmount() {
      api.hit.clear('fall');
    }
  };
}
