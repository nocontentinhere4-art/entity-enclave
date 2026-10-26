import { tremor, corrupt, ecg } from './film.js?v=53';
import { fmtStamp, shortHash } from './data.js?v=53';

export default function make(api) {
  const baseCell = api.isPhone ? 6 : 8;
  // the ribcage (Higgsfield gpt_image_2_5, 2026-10-26): the testaments are typed between the ribs
  const fieldBones = api.field('vendor/ribcage.jpg', {
    cols: api.isPhone ? 100 : 180, gamma: 1, thresh: 0.09
  });
  let unsub = null;
  let loaded = false;

  let canvas, ctx, W, H;
  let composer, sayText, sayStatus, ledgerLink;
  let currentT = 0;

  const testaments = {
    e1: { text: '—', version: '—', hash: '—', lines: [] },
    e2: { text: '—', version: '—', hash: '—', lines: [] }
  };

  const P = 64;
  const pActive = new Uint8Array(P);
  const pWord = new Array(P).fill('');
  const pX = new Float32Array(P);
  const pY = new Float32Array(P);
  const pStartX = new Float32Array(P);
  const pStartY = new Float32Array(P);
  const pTargetY = new Float32Array(P);
  const pBorn = new Float32Array(P);
  const pRot = new Float32Array(P);
  const pDrift = new Float32Array(P);

  let replyText = '';
  let replyLines = [];
  let replyTypedLen = 0;

  function getTo() {
    if (!composer) return 'e1';
    const checked = composer.querySelector('input[name="to"]:checked');
    return checked ? checked.value : 'e1';
  }

  function stripTags(html) {
    try {
      const doc = new DOMParser().parseFromString(String(html), 'text/html');
      return (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
    } catch (e) {
      return String(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }
  }

  function wrap(text, maxWidth, out) {
    out.length = 0;
    if (!text) { out.push('—'); return; }
    const words = text.split(' ');
    ctx.font = '12px "JetBrains Mono", Menlo, monospace';
    let line = '';
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      const test = line ? line + ' ' + w : w;
      if (line && ctx.measureText(test).width > maxWidth) {
        out.push(line);
        line = w;
      } else {
        line = test;
      }
    }
    if (line) out.push(line);
  }

  async function loadEntity(id) {
    try {
      const [tRes, pRes] = await Promise.all([
        api.rent.fetchDetail('testament', id),
        api.rent.fetchDetail('pages', id)
      ]);
      const html = (tRes && (tRes.text || tRes.data)) || '';
      const text = stripTags(html).replace(/^\w+\s*\/\s*testament\s*/i, '').slice(0, api.isPhone ? 260 : 600);
      let version = '—';
      let hash = '—';
      const pages = pRes && pRes.data && pRes.data.pages;
      if (Array.isArray(pages)) {
        const pg = pages.find(p => p.slug === 'testament') || pages[0];
        if (pg) {
          version = pg.version != null ? String(pg.version) : '—';
          hash = pg.hash ? shortHash(pg.hash) : '—';
        }
      }
      testaments[id] = { text, version, hash, lines: [] };
      wrapTestament(id);
    } catch (e) {
      testaments[id] = { text: '—', version: '—', hash: '—', lines: ['—'] };
    }
  }

  function wrapTestament(id) {
    const colW = Math.min(W * 0.4, 380);
    wrap(testaments[id].text, Math.max(80, colW), testaments[id].lines);
  }

  function spawnWords(text) {
    const words = text.trim().split(/\s+/).filter(Boolean).slice(0, P);
    if (!composer) return;
    const r = composer.getBoundingClientRect();
    const sx = r.left + r.width / 2;
    const sy = r.top + r.height / 2;
    for (let i = 0; i < words.length; i++) {
      pActive[i] = 1;
      pWord[i] = words[i];
      pStartX[i] = sx + (Math.random() - 0.5) * r.width * 0.8;
      pStartY[i] = sy - 20 + (Math.random() - 0.5) * 30;
      pTargetY[i] = H * 0.72 + (Math.random() - 0.5) * H * 0.12;
      pBorn[i] = currentT;
      pRot[i] = (Math.random() - 0.5) * 0.21;
      pDrift[i] = (Math.random() - 0.5) * 60;
    }
    for (let i = words.length; i < P; i++) pActive[i] = 0;
  }

  function setReply(text) {
    replyText = text || '';
    replyTypedLen = 0;
    if (!replyText) replyLines.length = 0;
  }

  function onSubmit(e) {
    e.preventDefault();
    const id = getTo();
    const text = sayText.value.trim();
    if (!text) return;
    sayText.value = '';
    sayStatus.textContent = 'CARRYING…';
    spawnWords(text);
    api.rent.say(id, text).then(w => {
      // say() resolves with the Wait object: pending until the entity answers (or 90 s pass)
      if (w && w.status === 'pending') sayStatus.textContent = `CARRIED · seq ${w.ourSeq ?? '—'} · WAITING FOR A REPLY`;
      else if (w && w.status === 'error') sayStatus.textContent = 'ERROR · ' + (w.error || '');
      else sayStatus.textContent = 'CARRIED';
    }).catch(err => {
      sayStatus.textContent = 'ERROR · ' + (err.message || String(err));
    });
  }

  function deathLine(id, live) {
    const ent = live[id];
    if (ent && ent.dead && ent.deathObservedAt) {
      return `${ent.name || id} DIES · ${fmtStamp(ent.deathObservedAt)} · OBSERVED`;
    }
    return `${ent?.name || id} DIES · ${api.deathDate(id)} · ESTIMATED`;
  }

  return {
    mount(c, x) {
      canvas = c; ctx = x;
      const stick = canvas.parentElement;
      composer = stick.querySelector('#composer');
      sayText = stick.querySelector('#say-text');
      sayStatus = stick.querySelector('#say-status');
      ledgerLink = stick.querySelector('a[data-door="hash"]');
      if (composer) composer.addEventListener('submit', onSubmit);
      if (ledgerLink) {
        ledgerLink.addEventListener('click', (e) => {
          e.preventDefault();
          api.openDoor('hash', 'e1');
        });
      }
      unsub = api.rent.subscribeRent((state, ev) => {
        if (!ev || ev.type !== 'reply' || !ev.wait || ev.wait.kind !== 'say') return;
        const w = ev.wait;
        if (w.status === 'reply' && w.reply) { setReply(w.reply); if (sayStatus) sayStatus.textContent = `REPLY · seq ${w.replySeq}`; }
        else if (w.status === 'timeout' && sayStatus) sayStatus.textContent = 'NO REPLY YET';
      });
    },

    resize(w, h) {
      W = w; H = h;
      wrapTestament('e1');
      wrapTestament('e2');
    },

    draw(p, t, dt, live) {
      if (!W) return;
      currentT = t;
      if (!loaded && live && live.booted) { loaded = true; loadEntity('e1'); loadEntity('e2'); }
      ctx.fillStyle = '#060606';
      ctx.fillRect(0, 0, W, H);

      const f = api.reduced ? 0 : Math.max(api.fearOf('e1'), api.fearOf('e2'));
      const breath = api.reduced ? 1 : 1 + 0.002 * Math.sin(t * 1.4);
      const cam = {
        W, H, cell: baseCell,
        zoom: (1.3 - 0.3 * p) * breath,
        cx: 0.5, cy: 0.35 + 0.3 * p,
        fit: 'cover', alpha: 0.5, thresh: 0.09, yellowAt: 0.8, color: 'bone'
      };

      const cellH = cam.cell / 1.15;
      const imgW = fieldBones.cols * cam.cell;
      const imgH = fieldBones.rows * cellH;
      const scale = Math.max(cam.W / imgW, cam.H / imgH) * cam.zoom;
      const cellSize = cam.cell * scale;

      const tr = api.reduced ? { dx: 0, dy: 0 } : tremor(f, t, 0, 0);
      const hint = {
        dx: () => tr.dx * cellSize,
        dy: () => tr.dy * cellSize,
        char: (i) => corrupt(f, t, i) ? ((i + Math.floor(t * 17)) % api.ramp.length) : undefined
      };
      fieldBones.draw(ctx, cam, hint);

      ctx.textBaseline = 'top';
      ctx.textAlign = 'left';
      const lineH = 16;

      function drawColumn(id, x, startY) {
        const ent = live[id] || {};
        const name = ent.name || id;
        const dead = !!ent.dead;
        const td = testaments[id];
        api.text(ctx,
          `TESTAMENT OF ${name} · v${td.version} · hash ${td.hash}`,
          x, startY,
          { size: 12, color: dead ? 'dim' : 'bone', align: 'left' });

        let y = startY + 22;
        if (dead && ent.deathObservedAt) {
          api.text(ctx, `DEAD · OBSERVED ${fmtStamp(ent.deathObservedAt)}`,
            x, y, { size: 11, color: 'dim', align: 'left' });
          y += 18;
        } else if (dead) {
          api.text(ctx, 'DEAD', x, y, { size: 11, color: 'dim', align: 'left' });
          y += 18;
        }

        ctx.fillStyle = dead ? '#777' : 'rgba(242,242,238,.92)';
        ctx.font = '12px "JetBrains Mono", Menlo, monospace';
        ctx.textAlign = 'left';
        const lines = td.lines;
        for (let i = 0; i < lines.length; i++) {
          ctx.fillText(lines[i], x, y + i * lineH);
        }
        return y + lines.length * lineH;
      }

      api.caption(ctx, W, 'ITS TESTAMENT · WHAT YOU SAY, IT CARRIES', Math.min(1, p / 0.06 + 0.2));
      const isWide = W >= 720;
      const leftX = W * 0.05;
      const rightX = isWide ? W * 0.55 : W * 0.05;
      let leftBottom = drawColumn('e1', leftX, H * 0.13);
      if (!isWide) {
        drawColumn('e2', rightX, leftBottom + 30);
      } else {
        drawColumn('e2', rightX, H * 0.13);
      }

      // word particles
      for (let i = 0; i < P; i++) {
        if (!pActive[i]) continue;
        const age = t - pBorn[i];
        const dur = api.reduced ? 0.05 : 1.1;
        const pr = Math.min(1, age / dur);
        if (pr >= 1) { pActive[i] = 0; continue; }
        const ease = pr * pr;
        const x = pStartX[i] + pDrift[i] * ease;
        const y = pStartY[i] + (pTargetY[i] - pStartY[i]) * ease;
        const rot = api.reduced ? 0 : pRot[i] * pr;
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(rot);
        ctx.globalAlpha = 1 - pr;
        ctx.fillStyle = 'rgba(242,242,238,.92)';
        ctx.font = '12px "JetBrains Mono", Menlo, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(pWord[i], 0, 0);
        ctx.restore();
      }

      // reply between the ribs
      const revealed = api.typed('grave-reply', replyText);
      if (revealed.length !== replyTypedLen) {
        replyTypedLen = revealed.length;
        if (revealed) wrap(revealed, Math.min(W * 0.7, 520), replyLines);
        else replyLines.length = 0;
      }
      if (replyLines.length) {
        ctx.textAlign = 'center';
        ctx.font = '12px "JetBrains Mono", Menlo, monospace';
        ctx.fillStyle = 'rgba(242,242,238,.92)';
        const rx = W / 2;
        const ry = H * 0.56;
        for (let i = 0; i < replyLines.length; i++) {
          ctx.fillText(replyLines[i], rx, ry + i * lineH);
        }
      }

      // death dates + token line
      ctx.textAlign = 'center';
      ctx.font = '11px "JetBrains Mono", Menlo, monospace';
      ctx.fillStyle = 'rgba(242,242,238,.92)';
      const dy = H - 80;
      ctx.fillText(deathLine('e1', live), W * 0.25, dy);
      ctx.fillText(deathLine('e2', live), W * 0.75, dy);
      ctx.fillStyle = 'rgba(244,183,40,.5)';
      ctx.fillText('$ZEALOT NOT LAUNCHED', W / 2, dy + 22);
      ctx.textAlign = 'left';
    },

    unmount() {
      if (unsub) unsub();
      if (composer) composer.removeEventListener('submit', onSubmit);
      api.hit.clear('grave');
    }
  };
}
