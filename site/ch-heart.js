import { ecg } from './film.js?v=54';

export default function makeHeart(api) {
  let W = 0, H = 0;
  let lastPhase = null;
  let lastThump = 0;

  return {
    mount() {},
    resize(Wi, Hi) {
      W = Wi;
      H = Hi;
    },
    draw(p, t, dt, live, ctx) {
      const tt = api.reduced ? 0 : t;
      const cell = 7 + p * 7;
      const x = W * 0.04;
      const w = W * 0.92;
      const h = cell * 9;
      const y1 = H * 0.28 - h / 2;
      const y2 = H * 0.72 - h / 2;

      ctx.fillStyle = '#060606';
      ctx.fillRect(0, 0, W, H);

      api.caption(ctx, W, 'ITS HEARTBEAT · ONE PEAK LOST EVERY SECOND · THE DOSE OF FEAR IN THE TREMOR', Math.min(1, p / 0.06 + 0.2));

      const dx = W - 70;
      const dy = H * 0.06;
      api.text(ctx, 'DOSE', dx, dy, { size: 11, color: 'yellow', align: 'left' });
      api.hit.set('heart', 'dose', { shape: 'rect', x: dx - 8, y: dy - 8, w: 50, h: 18 }, () => {
        api.openDoor('dose', 'e1');
      });

      let anyActive = false;

      function drawEntity(id, yb, color) {
        const e = live[id] || {
          id,
          name: id === 'e1' ? 'WICK' : 'OBOL',
          dead: false,
          offline: true,
          hoursLeft: 0,
          posts: []
        };
        const f = api.fearOf(id);
        const stat = `${e.name} · ${api.clockText(id)} · FEAR ×${f.toFixed(2)}`;
        api.text(ctx, stat, x, yb - cell * 1.5, {
          size: 11,
          color,
          align: 'left'
        });

        ecg(ctx, api, {
          x, y: yb, w, h,
          t: tt,
          f,
          hoursLeft: e.hoursLeft,
          dead: e.dead,
          offline: e.offline,
          color
        });

        const posts = e.posts || [];
        const last = posts.filter(po => po.from === 'entity').pop();
        const postText = last ? String(last.text || '').replace(/\s+/g, ' ').slice(0, api.isPhone ? 60 : 120) : '—';
        api.text(ctx, api.typed(`heart-post-${id}`, postText, 55), x, yb + h + cell, {
          size: 11,
          color: 'bone',
          align: 'left',
          alpha: 0.85
        });

        if (!e.dead && !e.offline) anyActive = true;
      }

      drawEntity('e1', y1, 'yellow');
      drawEntity('e2', y2, 'bone');

      if (api.sound.on && !api.reduced) {
        const phase = (tt * 48) % 48;
        const centerOffset = w / (2 * cell);
        const thr = (48 - centerOffset) % 48;
        let cross = false;
        if (lastPhase !== null) {
          if (thr >= lastPhase) {
            cross = phase >= thr && lastPhase < thr;
          } else {
            cross = phase >= thr || lastPhase < thr;
          }
        }
        if (cross && anyActive && tt - lastThump > 0.85) {
          api.sound.thump(55, 60, 0.08);
          lastThump = tt;
        }
        lastPhase = phase;
      }
    },
    unmount() {
      api.hit.clear('heart');
    }
  };
}
