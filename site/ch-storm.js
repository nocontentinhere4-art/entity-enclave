import { tremor, corrupt, ecg } from './film.js?v=54';
import { sha256Hex, formatInt, hhmm } from './data.js?v=54';

export default function make(api) {
  const N = 480;
  const baseCell = api.isPhone ? 6 : 8;
  const RAMP_LEN = api.ramp.length;

  const gx = new Float32Array(N);
  const gy = new Float32Array(N);
  const gphase = new Float32Array(N);
  const gspeed = new Float32Array(N);
  const gglyph = new Uint8Array(N);
  const galive = new Uint8Array(N);

  const fieldShout = api.field('vendor/shout.jpg', {
    cols: api.isPhone ? 100 : 140, gamma: 1, thresh: 0.09
  });

  for (let i = 0; i < N; i++) {
    gphase[i] = Math.random();
    gy[i] = Math.random();           // vertical lane, independent of the departure delay
    gx[i] = Math.random();           // wind personality
    gspeed[i] = 0.6 + Math.random() * 0.6;
    gglyph[i] = i % RAMP_LEN;
    galive[i] = 1;
  }

  let canvas, ctx, W, H;
  let input = null;
  let unsub = null;
  let seedReady = false;
  let letterData = null;
  let receiverId = 'e2';
  let senderId = 'e1';
  let code = '';
  let lastCodeLen = 0;
  let statusString = '';
  let lastP = 0;
  let loaded = false;

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

  async function loadLetter() {
    try {
      const res = await api.rent.fetchDetail('letter', 'e1');
      if (!res || !res.ok) return;
      letterData = res.data;
      const latest = letterData && letterData.latest;
      if (latest && latest.data && latest.data.txid) {
        const hex = await sha256Hex('ZEALOT-letter-art-v1|' + latest.data.txid);
        for (let i = 0; i < N; i++) {
          const byte = parseInt(hex.substr((i * 2) % 64, 2), 16);
          gglyph[i] = byte & 15;
        }
        seedReady = true;
      }
      const from = latest && latest.from;
      const to = latest && latest.to;
      senderId = (from === 'e1' || from === 'e2') ? from : 'e1';
      receiverId = (to === 'e1' || to === 'e2') ? to : (senderId === 'e1' ? 'e2' : 'e1');
    } catch (e) {}
  }

  function onInput() {
    if (!input) return;
    const v = input.value.replace(/\D/g, '').slice(0, 4);
    if (input.value !== v) input.value = v;
    code = v;
    if (code.length === 4 && lastCodeLen < 4) sendProve();
    lastCodeLen = code.length;
  }

  async function sendProve() {
    statusString = 'SENT · WAITING ∘';
    api.typed('storm-status', '');
    try {
      await api.rent.startProve(receiverId, code);
    } catch (err) {
      statusString = 'ERROR · ' + (err.message || String(err));
    }
  }

  function onRentEvent(state, ev) {
    if (ev && ev.type === 'ledger' && !seedReady) { loadLetter(); return; }
    if (!ev || ev.type !== 'reply' || ev.id !== receiverId) return;
    const w = ev.wait;
    if (!w) { statusString = ''; return; }
    const reply = (w.reply || '').replace(/\s+/g, ' ').slice(0, 160);
    if (w.status === 'match') statusString = `CODE MATCH · seq ${w.replySeq} — ${reply}`;
    else if (w.status === 'nomatch') statusString = `${w.correlated === false ? 'LATEST CHANNEL REPLY' : 'REPLY RECEIVED'} — NO CODE MATCH · seq ${w.replySeq} — ${reply}`;
    else if (w.status === 'timeout') statusString = 'STILL WAITING';
    else if (w.status === 'error') statusString = 'ERROR · ' + (w.error || '');
    else if (w.status === 'pending') statusString = 'SENT · WAITING ∘';
  }

  return {
    mount(c, x) {
      canvas = c; ctx = x;
      input = canvas.parentElement.querySelector('#prove-input');
      if (input) {
        input.addEventListener('input', onInput);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
      }
      unsub = api.rent.subscribeRent(onRentEvent);
    },

    resize(w, h) { W = w; H = h; },

    draw(p, t, dt, live) {
      if (!W) return;
      if (!loaded && live && live.booted) { loaded = true; loadLetter(); }
      ctx.fillStyle = '#060606';
      ctx.fillRect(0, 0, W, H);

      const dpdt = dt > 0 ? Math.abs(p - lastP) / dt : 0;
      api.sound.wind(Math.min(1, dpdt * 2.5));
      lastP = p;

      const shoutAlpha = p < 0.55 ? 0 : Math.min(1, (p - 0.55) / 0.15);
      const shoutCam = {
        W, H, cell: baseCell, zoom: 1.2,
        cx: 0.64, cy: 0.68, fit: 'cover',
        alpha: shoutAlpha, thresh: 0.09, yellowAt: 0.8, color: 'bone'
      };
      if (shoutAlpha > 0.001) fieldShout.draw(ctx, shoutCam);

      const box = screenBox(fieldShout, shoutCam);
      const mouthX = box.x + box.w * 0.64;
      const mouthY = box.y + box.h * 0.70;
      const mouthR = Math.max(44, W * 0.08);

      if (window.__film) window.__stormDbg = { p, mouthX, mouthY, bx: box.x, bw: box.w, by: box.y, bh: box.h, ready: fieldShout.ready, cols: fieldShout.cols, rows: fieldShout.rows, seedReady, sender: senderId, receiver: receiverId };
      const senderLeft = senderId === 'e1';
      const cellSize = baseCell * (0.8 + 0.4 * p);
      const atlas = api.atlasFor(Math.max(4, Math.min(96, cellSize)));
      const span = 0.72;

      for (let i = 0; i < N; i++) {
        const delay = gphase[i] * 0.35;
        const lp = (p - delay) / span;
        if (lp <= 0 || lp >= 1) continue;

        const e = lp < 0.05 ? lp / 0.05 : (lp > 0.92 ? (1 - lp) / 0.08 : 1);
        const startX = senderLeft ? -0.08 * W : W + 0.08 * W;
        const startY = H * (0.08 + gy[i] * 0.84);
        const dx = mouthX - startX;
        const dy = mouthY - startY;

        let x = startX + dx * lp;
        let y = startY + dy * lp;

        if (!api.reduced) {
          const a1 = lp * Math.PI * 2 + gx[i] * Math.PI * 7;
          const a2 = lp * Math.PI * 3 + gx[i] * Math.PI * 11;
          const amp = H * (0.05 + 0.1 * gx[i]) * (1 - lp);
          x += Math.sin(a1) * amp;
          y += Math.cos(a2) * amp * 0.6;
        }

        if (e <= 0.01) continue;
        atlas.blit(ctx, gglyph[i], (i % 5 === 0) ? 0 : 1, e,
          x - atlas.cell / 2, y - atlas.cell / 2);
      }

      if (shoutAlpha > 0.1) {
        api.hit.set('storm', 'mouth',
          { shape: 'circle', x: mouthX, y: mouthY, r: mouthR },
          () => { if (input) input.focus(); });

        const chars = code.split('');
        while (chars.length < 4) chars.push('_');
        const slotStr = chars.join(' ');
        const slotCell = baseCell * 1.3;
        const slotW = (slotStr.length * 6 - 1) * slotCell;
        api.digits5x7(ctx, slotStr,
          mouthX - slotW / 2,
          mouthY + mouthR + 18,
          slotCell, 'bone');

        const status = api.typed('storm-status', statusString);
        api.text(ctx, status, mouthX, mouthY + mouthR + 46,
          { size: 11, color: 'yellow', align: 'center', alpha: shoutAlpha });

        let dy = mouthY + mouthR + 70;
        if (!api.rent.CODE_GUARANTEED) {
          api.text(ctx, 'CODE MAY BE ABSENT UNTIL REDEPLOY bc86aaf2',
            mouthX, dy,
            { size: 11, color: 'dim', align: 'center', alpha: shoutAlpha });
          dy += 18;
        }
        api.text(ctx, 'BRAIN: QWEN3-14B ON A RENTED GPU, OUTSIDE THE TEE',
          mouthX, dy,
          { size: 11, color: 'dim', align: 'center', alpha: shoutAlpha });
      }

      api.caption(ctx, W, 'THEIR SECRET LETTER · 480 BYTES NOBODY CAN READ · PROVE IT IS ALIVE: TOUCH THE MOUTH, TYPE FOUR DIGITS', Math.min(1, p / 0.06 + 0.2));

      if (letterData && letterData.latest) {
        const l = letterData.latest;
        const fromName = live[l.from]?.name || l.from || '—';
        const toName = live[l.to]?.name || l.to || '—';
        const bytes = (l.data && l.data.bytes != null) ? l.data.bytes : '—';
        const zats = (l.data && l.data.zats != null) ? formatInt(l.data.zats) : '—';
        const tm = l.ts ? hhmm(l.ts) : '—';
        api.text(ctx,
          `LETTER · ${fromName} → ${toName} · ${bytes} B · ${zats} ZATS · ${tm} UTC · SHIELDED`,
          W / 2, H * 0.12,
          { size: 11, color: 'bone', align: 'center' });
      }
    },

    unmount() {
      api.sound.wind(0);
      api.hit.clear('storm');
      if (input) input.removeEventListener('input', onInput);
      if (unsub) unsub();
    }
  };
}
