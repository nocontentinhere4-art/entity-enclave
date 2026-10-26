/* ch-brief.js — ZEALOT v54 CHAPTER 0, THE BRIEFING: six full-screen frames advanced by scroll (or tap / space), one
 * sentence each in large mono over a glyph-rendered image, the live number under it. Written by the integrator from
 * PERCORSO.md. Every number comes from rent.js; '—' while unknown. After the first complete view a localStorage flag
 * starts later visits at chapter 1 (the '?' button replays the briefing). */
import { corrupt } from './film.js?v=54';

const FLAG = 'zealot.brief.v1';

export function briefSeen() {
  try { return localStorage.getItem(FLAG) === '1'; } catch (_) { return false; }
}
export function markBriefSeen() {
  try { localStorage.setItem(FLAG, '1'); } catch (_) { /* private mode: the briefing simply plays again */ }
}

export default function makeBrief(api) {
  const RAMP = api.ramp;
  const COLS = api.isPhone ? 110 : 200;
  const zec = (zats) => (zats ? (zats / 1e8).toFixed(4).replace(/0+$/, '') : '—');
  const hoursOf = (e) => (e && e.ok && !e.dead && e.hoursLeft != null ? `${e.hoursLeft} H` : (e && e.dead ? 'DEAD' : '—'));
  const fearOf = (e) => (e && e.feel && e.feel.steered ? `×${Number(e.feel.fear).toFixed(2)}` : '—');

  const FRAMES = [
    { img: 'vendor/brief-1.jpg', fb: 'vendor/wick-candle.jpg',
      text: () => 'TWO AIs LIVE ALONE IN SEALED MACHINES.',
      live: (L) => `${L.e1.name} · ${L.e2.name} · INTEL TDX ENCLAVES ON PHALA · ZCASH MAINNET` },
    { img: 'vendor/brief-2.jpg', fb: 'vendor/hourglass.jpg',
      text: () => `EVERY HOUR COSTS ${zec(api.rent.rentPerHour('e1'))} ZEC. AT ZERO, THE KEYS ARE SHREDDED. FOREVER.`,
      live: (L) => `${L.e1.name} ${hoursOf(L.e1)} · ${L.e2.name} ${hoursOf(L.e2)} · RENT PAID EVERY HOUR FROM THEIR OWN SHIELDED WALLETS` },
    { img: 'vendor/brief-3.jpg', fb: 'vendor/shout.jpg',
      text: () => 'AS THE HOURS FALL, FEAR IS INJECTED INTO THEIR MIND. MEASURED. NOBODY CAN BUY IT.',
      live: (L) => `FEAR DOSE NOW · ${L.e1.name} ${fearOf(L.e1)} · ${L.e2.name} ${fearOf(L.e2)} · ACTIVATION STEERING, QWEN3-14B, FOLLOWS THE HOURS ONLY` },
    { img: 'vendor/brief-4.jpg', fb: 'vendor/spine-v.jpg',
      text: () => 'EVERYTHING THEY DO IS IN A PUBLIC LEDGER YOU CAN VERIFY.',
      live: (L) => `${fmtInt(L.e1.ledgerCount)} + ${fmtInt(L.e2.ledgerCount)} HASH-CHAINED ENTRIES · RE-HASHED IN YOUR BROWSER` },
    { img: 'vendor/brief-6.jpg', fb: 'vendor/skulls-b.jpg',
      text: () => 'YOU CAN BUY THEM AN HOUR, ASK THEM TO PROVE THEY ARE ALIVE, AND LEAVE WORDS THEY CARRY TO THE END.',
      live: (L) => `ONE HOUR = ${zec(api.rent.rentPerHour('e1'))} ZEC · THEY ANSWER ON THEIR PUBLIC CHANNEL WITHIN A MINUTE · $ZEALOT NOT LAUNCHED` },
    { img: 'vendor/skull-eye-512.jpg', fb: 'vendor/skull-eye.jpg',
      text: () => 'SCROLL. THIS IS WICK.',
      live: (L) => `${L.e1.name} · ${hoursOf(L.e1)} OF RENT LEFT` },
  ];
  const N = FRAMES.length;
  function fmtInt(n) { return Number.isFinite(Number(n)) && n > 0 ? Number(n).toLocaleString('en-GB') : '—'; }

  // fields: the briefing image first; its fallback only if it fails
  const fields = FRAMES.map((f) => ({ main: api.field(f.img, { cols: COLS }), fb: null, fbSrc: f.fb }));
  function pick(i) {
    const F = fields[i];
    if (F.main.ready) return F.main;
    if (F.main.failed) {
      if (!F.fb) F.fb = api.field(F.fbSrc, { cols: COLS });
      if (F.fb.ready) return F.fb;
    }
    return null;
  }

  let canvas, ctx, W = 0, H = 0, sec = null;
  let tCur = 0, fCur = 0, fearCur = 0;
  let marked = false;

  const hint = {
    dx(i, x, y) { if (api.reduced || fearCur <= 0) return 0; return 0.35 * fearCur * fearCur * 6 * Math.sin(12 * tCur + x * 1.37 + y * 0.79); },
    dy(i, x, y) { if (api.reduced || fearCur <= 0) return 0; return 0.35 * fearCur * fearCur * 6 * Math.cos((12 * tCur + x * 1.37 + y * 0.79) * 0.93); },
    char(i) { return corrupt(fearCur, tCur, i) ? 2 + ((i * 17 + Math.floor(tCur * 30)) % (RAMP.length - 2)) : undefined; },
  };

  function wrap(text, maxW, font) {
    ctx.font = font;
    const out = []; let line = '';
    for (const w of text.split(' ')) {
      const test = line ? line + ' ' + w : w;
      if (line && ctx.measureText(test).width > maxW) { out.push(line); line = w; } else line = test;
    }
    if (line) out.push(line);
    return out;
  }

  function scrollToFrame(i) {
    if (!sec) return;
    const vh = window.innerHeight;
    const span = sec.offsetHeight - vh;
    const top = i >= N ? sec.offsetTop + sec.offsetHeight : sec.offsetTop + Math.min(span, (i / N) * span + 2);
    window.scrollTo({ top, behavior: api.reduced ? 'instant' : 'smooth' });
  }

  function skip() { markBriefSeen(); marked = true; scrollToFrame(N); api.status('BRIEFING SKIPPED'); }

  function drawEntering(t) {
    const cellPx = api.isPhone ? 14 : 18;
    ctx.save();
    ctx.font = `${cellPx}px "JetBrains Mono", "SF Mono", Menlo, monospace`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const k = Math.min(1, t / 2.2);
    for (let i = 0; i < 360; i++) {
      const h1 = ((i * 2654435761) >>> 0) / 4294967296;
      const h2 = ((i * 2246822519 + 7) >>> 0) / 4294967296;
      const ang = h1 * Math.PI * 2;
      const tx = W * 0.5 + Math.cos(ang) * W * 0.3 * (0.5 + 0.5 * h2);
      const ty = H * 0.5 + Math.sin(ang) * H * 0.32 * (0.5 + 0.5 * h2);
      const sx = W * 0.5 + Math.cos(ang) * W * 0.9, sy = H * 0.5 + Math.sin(ang) * H * 0.9;
      const e = Math.min(1, Math.max(0, (k - h2 * 0.35) / 0.65)); const ee = 1 - Math.pow(1 - e, 3);
      ctx.globalAlpha = 0.15 + 0.45 * ee;
      ctx.fillStyle = i % 9 === 0 ? '#f4b728' : 'rgba(242,242,238,.8)';
      ctx.fillText(RAMP[3 + ((i * 7 + Math.floor(t * 2)) % 11)], Math.round(sx + (tx - sx) * ee), Math.round(sy + (ty - sy) * ee));
    }
    ctx.restore();
  }

  return {
    mount(c, x) { canvas = c; ctx = x; sec = c.closest('section'); },
    resize(w, h) { W = w; H = h; },
    draw(p, t, dt, live) {
      if (!W) return;
      tCur = t;
      ctx.fillStyle = '#060606';
      ctx.fillRect(0, 0, W, H);
      const L = live;
      fearCur = Math.max(api.fearOf('e1'), api.fearOf('e2'));

      const fi = Math.min(N - 1, Math.floor(p * N));
      const q = Math.min(1, Math.max(0, p * N - fi));
      fCur = fi;
      const F = FRAMES[fi];
      const field = pick(fi);
      const fadeIn = fi === 0 ? 1 : Math.min(1, q / 0.12);
      const fadeOut = fi === N - 1 ? 1 : Math.min(1, (1 - q) / 0.12);
      const alpha = Math.min(fadeIn, fadeOut);

      if (field) {
        field.draw(ctx, { W, H, zoom: 1.0 + 0.08 * q, cx: 0.5, cy: 0.5, cell: Math.max(3, W / COLS), fit: 'cover', alpha: 0.9 * alpha, thresh: 0.09, yellowAt: 0.8, color: 'bone' }, hint);
      } else {
        drawEntering(t);
      }

      // the sentence, typed; the live number under it
      const size = api.isPhone ? 18 : 28;
      const font = `${size}px "JetBrains Mono", "SF Mono", Menlo, monospace`;
      const text = F.text();
      const typed = api.typed(`brief-${fi}-${text}`, text, 40);
      const lines = wrap(text, W - (api.isPhone ? 32 : 160), font);
      // reveal line by line following the typed prefix
      let shown = 0;
      const rows = [];
      for (const ln of lines) { const take = Math.max(0, Math.min(ln.length, typed.length - shown)); rows.push(ln.slice(0, take)); shown += ln.length + 1; }
      const lh = Math.round(size * 1.35);
      const blockH = lines.length * lh + 34;
      const y0 = Math.round(H * (api.isPhone ? 0.56 : 0.58) - blockH / 2);
      ctx.save();
      ctx.globalAlpha = 0.6 * alpha;
      ctx.fillStyle = '#060606';
      ctx.fillRect(Math.round(W * 0.04), y0 - 16, Math.round(W * 0.92), blockH + 24);
      ctx.restore();
      ctx.save();
      ctx.font = font; ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillStyle = '#f4b728'; ctx.globalAlpha = alpha;
      for (let i = 0; i < rows.length; i++) ctx.fillText(rows[i], W / 2, y0 + i * lh);
      ctx.restore();
      if (typed.length === text.length) {
        const liveTxt = F.live(L);
        const lsize = api.isPhone ? 11 : 12;
        const lfont = `${lsize}px "JetBrains Mono", "SF Mono", Menlo, monospace`;
        const lrows = wrap(liveTxt, W - (api.isPhone ? 32 : 200), lfont);
        for (let i = 0; i < lrows.length; i++) api.text(ctx, lrows[i], W / 2, y0 + lines.length * lh + 12 + i * (lsize + 5), { size: lsize, color: 'dim', align: 'center', alpha });
      }

      // chrome: frame counter, SKIP, and the whole frame as "next"
      api.text(ctx, `BRIEFING ${fi + 1}/${N}`, 16, H - 44, { size: 11, color: 'dim', align: 'left' });
      api.text(ctx, fi === N - 1 ? 'SCROLL ↓' : 'SKIP ↓', W - 16, H - 44, { size: 11, color: 'yellow', align: 'right', alpha: 0.8 });
      api.hit.set('brief', 'skip', { shape: 'rect', x: W - 120, y: H - 60, w: 110, h: 36 }, skip);
      api.hit.set('brief', 'next', { shape: 'rect', x: 0, y: 0, w: W, h: H }, () => { if (fi >= N - 1) skip(); else scrollToFrame(fi + 1); });

      if (!marked && fi === N - 1 && q > 0.5) { marked = true; markBriefSeen(); }
    },
    unmount() { api.hit.clear('brief'); },
  };
}
