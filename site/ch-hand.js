import { tremor, corrupt, ecg } from './film.js?v=51';
import { formatInt } from './data.js?v=51';

export default function make(api) {
  const baseCell = api.isPhone ? 6 : 8;
  const RAMP_LEN = api.ramp.length;

  // the hand offering the coin to the viewer (Higgsfield gpt_image_2_5, 2026-10-26); the coin sits at (0.42, 0.42)
  const COIN = { u: 0.42, v: 0.42 };
  const fieldHand = api.field('vendor/hand-offer.jpg', {
    cols: api.isPhone ? 110 : 200, gamma: 1, thresh: 0.09
  });
  const fieldSkull = api.field('vendor/skulls-b.jpg', {
    cols: api.isPhone ? 120 : 180, gamma: 1, thresh: 0.09
  });


  let canvas, ctx, W, H;
  let toggledId = null;

  const glintOff = new Float32Array(32);
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    const r = 0.25 + 0.75 * (((i * 37) % 13) / 13);
    glintOff[i * 2] = Math.cos(a) * r;
    glintOff[i * 2 + 1] = Math.sin(a) * r;
  }

  function screenBox(field, cam) {
    const cellH = cam.cell / 1.15;   // same geometry as GlyphField.draw
    const imgW = field.cols * cam.cell;
    const imgH = field.rows * cellH;
    const scale = Math.max(cam.W / imgW, cam.H / imgH) * cam.zoom;
    return {
      x: cam.W / 2 - cam.cx * imgW * scale,
      y: cam.H / 2 - cam.cy * imgH * scale,
      w: imgW * scale,
      h: imgH * scale,
      scale,
      cellSize: cam.cell * scale
    };
  }

  function project(field, cam, u, v) {
    const b = screenBox(field, cam);
    return { x: b.x + u * b.w, y: b.y + v * b.h };
  }

  return {
    mount(c, x) { canvas = c; ctx = x; },
    resize(w, h) { W = w; H = h; },

    draw(p, t, dt, live) {
      if (!W) return;
      ctx.fillStyle = '#060606';
      ctx.fillRect(0, 0, W, H);

      const ownerId = toggledId || (
        (live.e2.ok && live.e2.hoursLeft < live.e1.hoursLeft) ? 'e2' : 'e1'
      );
      const otherId = ownerId === 'e1' ? 'e2' : 'e1';
      const owner = live[ownerId] || live.e1;
      const rent = api.rent.rentPerHour(ownerId) || owner.rentZats || 150000;
      const f = api.reduced ? 0 : api.fearOf(ownerId);

      // second skull behind the hand
      const skullAlpha = p <= 0.5 ? 0 : Math.min(0.45, (p - 0.5) / 0.4 * 0.45);
      if (skullAlpha > 0.001) {
        const skullCam = {
          W, H, cell: baseCell, zoom: 1.08,
          cx: 0.75, cy: 0.45, fit: 'cover',
          alpha: skullAlpha, thresh: 0.09, yellowAt: 0.8, color: 'bone'
        };
        fieldSkull.draw(ctx, skullCam);

        const b = screenBox(fieldSkull, skullCam);
        const ex = b.x + b.w * 0.28;
        const ey = b.y + b.h * 0.20;
        const ew = b.w * 0.48;
        const eh = b.h * 0.10;

        ecg(ctx, api, {
          x: ex, y: ey, w: ew, h: eh, t,
          f: api.fearOf(otherId),
          hoursLeft: live[otherId]?.hoursLeft ?? 0,
          dead: !!live[otherId]?.dead,
          offline: !!live[otherId]?.offline,
          color: otherId === 'e1' ? 'yellow' : 'bone'
        });

        api.text(ctx, `${live[otherId]?.name || otherId} · ${api.clockText(otherId)}`,
          ex + ew / 2, ey - 8,
          { size: 11, color: 'bone', align: 'center', alpha: skullAlpha });
      }

      // hand
      const breath = api.reduced ? 1 : 1 + 0.004 * Math.sin(t * 2.1);
      const handCam = {
        W, H, cell: baseCell,
        zoom: (1.5 - 0.5 * p) * breath,
        cx: 0.72 + (COIN.u - 0.72) * p,
        cy: 0.40 + (COIN.v - 0.40) * p,
        fit: 'cover', alpha: 1, thresh: 0.09, yellowAt: 0.8, color: 'bone'
      };
      const handBox = screenBox(fieldHand, handCam);
      const tr = api.reduced ? { dx: 0, dy: 0 } : tremor(f, t, 0, 0);
      const hint = {
        dx: () => tr.dx * handBox.cellSize,
        dy: () => tr.dy * handBox.cellSize,
        char: (i) => corrupt(f, t, i) ? ((i + Math.floor(t * 17)) % RAMP_LEN) : undefined
      };
      fieldHand.draw(ctx, handCam, hint);

      // coin
      const coin = project(fieldHand, handCam, COIN.u, COIN.v);
      const coinR = Math.max(44, W * 0.07);
      const glint = !api.reduced && ((t % 7) < 0.3);

      if (glint) {
        const atlas = api.atlasFor(Math.max(6, handBox.cellSize * 1.2));
        for (let k = 0; k < 16; k++) {
          const ox = glintOff[k * 2] * coinR;
          const oy = glintOff[k * 2 + 1] * coinR;
          const idx = (k + 10) % RAMP_LEN;
          atlas.blit(ctx, idx, 3, 0.75,
            coin.x + ox - atlas.cell / 2,
            coin.y + oy - atlas.cell / 2);
        }
      }

      api.text(ctx,
        `BUY TIME · ${owner.name || ownerId} · 1 H = ${formatInt(rent)} ZATS`,
        coin.x, coin.y,
        { size: 11, color: 'yellow', align: 'center' });

      const orY = coin.y + coinR + 22;
      const orLabel = `OR ${otherId === 'e1' ? 'WICK' : 'OBOL'}`;
      api.text(ctx, orLabel, coin.x, orY,
        { size: 11, color: 'bone', align: 'center', alpha: 0.8 });

      if (coin.x > -coinR && coin.x < W + coinR && coin.y > -coinR && coin.y < H + coinR) {
        api.hit.set('hand', 'coin',
          { shape: 'circle', x: coin.x, y: coin.y, r: coinR },
          () => {
            api.openPay({ who: ownerId, hours: 1 });
            api.status(`PAY · 1 HOUR · ${owner.name || ownerId}`);
          });
        api.hit.set('hand', 'or',
          { shape: 'rect', x: coin.x - 46, y: orY - 14, w: 92, h: 28 },
          () => {
            toggledId = toggledId === otherId ? ownerId : otherId;
            api.status(`TOGGLE · ${toggledId === 'e1' ? 'WICK' : 'OBOL'}`);
          });
      }
    },

    unmount() { api.hit.clear('hand'); }
  };
}
