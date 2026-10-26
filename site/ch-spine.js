import { corrupt } from './film.js?v=53';

export default function makeSpine(api) {
  const field = api.field('vendor/spine-v.jpg', { cols: api.isPhone ? 80 : 160 });   // the spine, vertical (sacrum at the bottom)

  let W = 0, H = 0;
  let dCell = 8, imgHpx = 1;
  let cy = 0.5, tCur = 0;
  let currentId = 'e1';
  let currentEntries = [];
  let currentF = 0;

  let pending = null;
  let result = null;
  const verifyIdx = { e1: -1, e2: -1 };

  const drips = [
    { x: 0, y: -1, s: 0 },
    { x: 0, y: -1, s: 0 },
    { x: 0, y: -1, s: 0 }
  ];

  function tremorDxDy(x, y) {
    const a = 0.35 * currentF * currentF * dCell;
    const ph = 12 * tCur + x * 1.37 + y * 0.79;
    return { dx: a * Math.sin(ph), dy: a * Math.cos(ph * 0.93) };
  }

  const hint = {
    lum(i, x, y, base) {
      const v = (y + 0.5) / (field.rows || 1);
      const len = currentEntries.length || 1;
      let idx = Math.floor(v * len);
      if (idx < 0) idx = 0;
      if (idx >= len) idx = len - 1;

      if (pending && pending.id === currentId && pending.progress > 0 && pending.progress < 1) {
        if (v > 1 - pending.progress) return 0.95;
      }

      const ent = currentEntries[idx];
      if (ent && ent.type === 'rent_paid') {
        return Math.min(1, base * 1.25 + 0.3);
      }
      return base * 0.52;
    },
    yellow(i, x, y, base) {
      const v = (y + 0.5) / (field.rows || 1);
      const len = currentEntries.length || 1;
      let idx = Math.floor(v * len);
      if (idx < 0) idx = 0;
      if (idx >= len) idx = len - 1;

      if (pending && pending.id === currentId && pending.progress > 0 && pending.progress < 1) {
        if (v > 1 - pending.progress) return true;
      }

      const ent = currentEntries[idx];
      return !!(ent && ent.type === 'rent_paid');
    },
    dx(i, x, y, base) {
      if (api.reduced || currentF <= 0) return 0;
      return tremorDxDy(x, y).dx;
    },
    dy(i, x, y, base) {
      if (api.reduced || currentF <= 0) return 0;
      return tremorDxDy(x, y).dy;
    },
    char(i, x, y, base) {
      if (!corrupt(currentF, tCur, i)) return undefined;
      return 2 + ((i * 19 + Math.floor(tCur * 40)) % (api.ramp.length - 2));
    }
  };

  function formatResult(res) {
    if (!res.ok || res.fail) return `HASH MISMATCH${res.reason ? ' — ' + res.reason : ''}`;
    if (res.headChanged) return 'HEAD CHANGED — RECHECK';
    const head = (res.servedHead || res.computedHead || '').slice(0, 8);
    return `HASH MATCH — SERVED LEDGER · ${res.total || 0} ENTRIES · head ${head}…`;
  }

  function startVerify(id) {
    if (pending) return;
    const t0 = tCur;
    const promise = api.rent.checkHash(id);
    pending = { id, t0, promise, progress: 0 };
    promise.then(res => {
      result = { id, res };
      pending = null;
    }).catch(err => {
      result = { id, res: { ok: false, fail: true, reason: String(err && err.message || 'ERROR') } };
      pending = null;
    });
  }

  function entryY(idx, len) {
    const v = (idx + 0.5) / len;
    return H * 0.5 + (v - cy) * imgHpx;
  }

  function drawHalf(ctx, id, clipX, centerX, p) {
    currentId = id;
    currentEntries = api.rent.entriesOf(id) || [];
    currentF = api.fearOf(id);
    const len = currentEntries.length || 1;

    ctx.save();
    ctx.beginPath();
    ctx.rect(clipX, 0, W / 2, H);
    ctx.clip();

    const cam = {
      W, H,
      zoom: 1,
      cx: id === 'e1' ? 0.75 : 0.25,
      cy,
      cell: Math.max(3, W / field.cols),
      fit: 'cover',
      alpha: 1,
      thresh: 0.12,
      yellowAt: 0.72,
      color: 'bone',
      mirror: id === 'e2'
    };
    field.draw(ctx, cam, hint);

    const visibleTop = cy - (H * 0.75) / imgHpx;
    const visibleBot = cy + (H * 0.75) / imgHpx;
    let lowest = -1;
    let lowestV = -Infinity;

    for (let i = 0; i < len; i++) {
      const ent = currentEntries[i];
      const v = (i + 0.5) / len;
      if (v < visibleTop || v > visibleBot) continue;

      if (ent.type !== 'rent_paid') {
        if (v > lowestV) {
          lowestV = v;
          lowest = i;
        }
        continue;
      }

      const py = entryY(i, len);
      const lx = centerX + (id === 'e1' ? W * 0.08 : -W * 0.08);
      const d = new Date(ent.ts);
      const hh = String(d.getUTCHours()).padStart(2, '0');
      const mm = String(d.getUTCMinutes()).padStart(2, '0');
      const zats = (ent.data && ent.data.zats) ? ent.data.zats : (api.rent.rentPerHour(id) || 0);
      api.text(ctx, `#${ent.seq} · ${hh}:${mm} UTC · ${zats.toLocaleString()} ZATS`, lx, py, {
        size: 11,
        color: 'yellow',
        align: id === 'e1' ? 'left' : 'right'
      });
    }

    verifyIdx[id] = lowest;

    if (p >= 0.35 && p <= 0.65 && lowest >= 0) {
      const py = entryY(lowest, len);
      api.text(ctx, 'VERIFY', centerX, py, { size: 11, color: 'hot', align: 'center' });
      api.hit.set('spine', `verify-${id}`, { shape: 'rect', x: centerX - 32, y: py - 10, w: 64, h: 20 }, () => {
        startVerify(id);
      });
    }

    const ledgerX = centerX + (id === 'e1' ? -W * 0.08 : W * 0.08);
    api.text(ctx, 'LEDGER ↗', ledgerX, H * 0.06, { size: 11, color: 'dim', align: 'center' });
    api.hit.set('spine', `ledger-${id}`, { shape: 'rect', x: ledgerX - 36, y: H * 0.06 - 10, w: 72, h: 20 }, () => {
      api.openDoor('hash', id);
    });

    if (result && result.id === id) {
      const txt = formatResult(result.res);
      const ry = verifyIdx[id] >= 0 ? entryY(verifyIdx[id], len) + 22 : H * 0.5;
      api.text(ctx, api.typed(`spine-result-${id}`, txt, 40), centerX, ry, {
        size: 11,
        color: 'yellow',
        align: 'center'
      });
    }

    ctx.restore();
  }

  function drawDrips(ctx, dt) {
    if (api.reduced) return;
    for (let i = 0; i < drips.length; i++) {
      const d = drips[i];
      if (d.y > H + 20 || d.y < -1) {
        d.x = (0.22 + 0.24 * i) * W + Math.sin(tCur * 0.7 + i) * W * 0.06;
        d.s = H * (0.08 + 0.02 * i);
        d.y = -10;
      }
      d.y += d.s * dt;
      api.text(ctx, '·', d.x, d.y, {
        size: Math.max(8, Math.round(dCell * 0.7)),
        color: 'hot',
        align: 'center',
        alpha: 0.9
      });
    }
  }

  return {
    mount() {},
    resize(Wi, Hi) {
      W = Wi;
      H = Hi;
    },
    draw(p, t, dt, live, ctx) {
      tCur = t;
      if (!field.ready) {
        ctx.fillStyle = '#060606';
        ctx.fillRect(0, 0, W, H);
        return;
      }

      cy = 0.08 + p * 0.84;
      const cell = Math.max(3, W / field.cols);
      dCell = Math.max(3, Math.min(96, cell));
      imgHpx = field.rows * (dCell / 1.15);

      if (pending) {
        if (api.reduced) {
          pending.progress = 1;
        } else {
          pending.progress = Math.min(1, (t - pending.t0) / 2.5);
        }
      }

      ctx.fillStyle = '#060606';
      ctx.fillRect(0, 0, W, H);

      drawHalf(ctx, 'e1', 0, W * 0.25, p);
      drawHalf(ctx, 'e2', W * 0.5, W * 0.75, p);
      api.caption(ctx, W, 'ITS LEDGER · EVERY RENT, VERIFIABLE · TOUCH A VERTEBRA', Math.min(1, p / 0.06 + 0.2));

      drawDrips(ctx, dt);
    },
    unmount() {
      api.hit.clear('spine');
    }
  };
}
