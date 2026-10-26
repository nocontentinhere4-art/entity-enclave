import { corrupt } from './film.js?v=51';

export default function makeFall(api) {
  // ONE skull (Higgsfield gpt_image_2_5, 2026-10-26): open and closed jaw frames of the same photograph
  const COLS = api.isPhone ? 110 : 220;
  const open = api.field('vendor/skull-eye.jpg', { cols: COLS });
  const closed = api.field('vendor/skull-eye-closed.jpg', { cols: COLS });
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

      if (!open.ready || !closed.ready) {
        ctx.fillStyle = '#060606';
        ctx.fillRect(0, 0, W, H);
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

      open.drawCrossfade(ctx, cam, closed, kJaw, hint);

      if (p > 0.85) drawSparks(ctx, dt, p);

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
