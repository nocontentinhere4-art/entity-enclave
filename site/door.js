/* door.js — ZEALOT v50 RENT HAND: the one door (PROVE, SPEAK, NEXT RENT, VITALS and the archive scenes), built as
 * semantic DOM inside #door. Written by Kimi K2.7 Code from the integrator's contract; data shapes, honesty notes and
 * the letter/forecast/memory/trades/nostr/attestation readers fixed by the integrator against the live endpoints. */

import {
  getRentState,
  subscribeRent,
  fetchDetail,
  startProve,
  say,
  checkHash,
  genNonce,
  CODE_GUARANTEED,
  PENDING_IMAGE,
  receiptsOf,
  lettersOf,
  rentPerHour,
  replyGate
} from './rent.js?v=84';

import { openPay } from './pay.js?v=84';
import { mountCloud } from './glyphcloud.js?v=84';

import {
  formatInt,
  formatZats,
  fixed8,
  shortHash,
  hhmm,
  fmtStamp,
  stringOf,
  sha256Hex
} from './data.js?v=84';

const REDUCED = (typeof window !== 'undefined' && window.matchMedia &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches);

let root = null;
let current = null;
let unsub = null;
let lastFocus = null;
let indicatorTimer = null;
let indicatorEl = null;
let indicatorBase = '';
let tickTimer = null;

function getRoot() {
  if (!root) root = document.getElementById('door');
  return root;
}

function mk(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}

function setStatus(el, text) {
  if (!el) return;
  el.textContent = text || '';
  el.hidden = !text;
}

function mkStatus() {
  const e = mk('p', 'door-status');
  e.setAttribute('aria-live', 'polite');
  return e;
}

function utcTime(ts) {
  if (ts == null) return '—';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '—';
  return d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

function utcShort(ts) {
  if (ts == null) return '—';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '—';
  return d.toISOString().slice(11, 16) + ' UTC';
}

function ageText(ms) {
  if (ms == null || ms < 0) return '0:00';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return `${m}:${rs.toString().padStart(2, '0')}`;
}

const x2 = (n) => (Number.isFinite(Number(n)) ? Number(n).toFixed(2) : '—');
const zatsText = (z) => (Number.isFinite(Number(z)) ? `${formatInt(z)} zats` : '—');
const zecText = (z) => (Number.isFinite(Number(z)) ? `${fixed8(z).replace(/0+$/, '').replace(/\.$/, '')} ZEC` : '—');

function mkRow(k, v) {
  const row = mk('div', 'door-row');
  const kl = mk('span', 'door-k', k);
  const vl = mk('span', 'door-v', v == null ? '—' : String(v));
  row.append(kl, vl);
  return row;
}

function mkTimeNote(state) {
  return mk('p', 'door-note', `read ${utcTime(state.at)}`);
}

function startIndicator(el, base) {
  if (indicatorEl === el && indicatorBase === (base || el.textContent) && indicatorTimer) return;
  stopIndicator();
  indicatorEl = el;
  indicatorBase = base || el.textContent || 'WAITING';
  const dots = ['·', '∘', '○'];
  let i = 0;
  el.textContent = `${indicatorBase} ${dots[i]}`;
  indicatorTimer = setInterval(() => {
    i = (i + 1) % dots.length;
    if (indicatorEl && indicatorEl.isConnected) {
      indicatorEl.textContent = `${indicatorBase} ${dots[i]}`;
    } else {
      stopIndicator();
    }
  }, 333);
}

function stopIndicator() {
  if (indicatorTimer) {
    clearInterval(indicatorTimer);
    indicatorTimer = null;
  }
  indicatorEl = null;
}

function sanitizeDoc(html) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(String(html || ''), 'text/html');
  doc.querySelectorAll('script, style, link, meta, iframe, object, embed, img, video, audio, form, svg').forEach(n => n.remove());
  function walk(node) {
    if (node.nodeType !== 1) return;
    Array.from(node.attributes).forEach(attr => {
      if (attr.name.toLowerCase().startsWith('on')) {
        node.removeAttribute(attr.name);
      }
    });
    if (node.tagName === 'A') {
      const href = (node.getAttribute('href') || '').toLowerCase();
      if (href.startsWith('javascript:')) node.removeAttribute('href');
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener');
    }
    Array.from(node.childNodes).forEach(walk);
  }
  walk(doc.body);
  const div = document.createElement('div');
  div.innerHTML = doc.body.innerHTML;
  return div;
}

function makeClockRows(state) {
  const wrap = mk('div');
  function update(s) {
    wrap.textContent = '';
    wrap.append(mk('h3', 'door-title', 'HOURS LEFT'));
    for (const id of ['e1', 'e2']) {
      const e = s[id];
      let val = '—';
      if (e.dead) {
        val = '0:00:00';
      } else if (e.fresh && e.deadlineMs) {
        const diff = Math.max(0, e.deadlineMs - Date.now());
        const h = Math.floor(diff / 3600000);
        const m = Math.floor((diff % 3600000) / 60000);
        const sec = Math.floor((diff % 60000) / 1000);
        val = `${h}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
      }
      wrap.append(mkRow(e.name, val));
      if (e.sampleAt) {
        wrap.append(mk('p', 'door-note', `sample ${ageText(Date.now() - e.sampleAt)} ago`));
      }
    }
  }
  update(state);
  return { el: wrap, update };
}

function lockReason(ent) {
  if (ent.dead) return 'DEAD';
  if (ent.offline) return 'OFFLINE';
  if (ent.stale) return 'DATA STALE';
  return 'LOCKED';
}

function errToStatus(err) {
  const msg = (err && err.message) ? err.message : String(err || 'ERROR');
  if (/429|rate|minute/i.test(msg)) return 'ONE MESSAGE PER MINUTE';
  return msg;
}

function drawDoseTrace(canvas, fear) {
  const ctx = canvas.getContext('2d');
  canvas.width = 600;
  canvas.height = 120;
  ctx.fillStyle = '#060606';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#f4b728';
  const fh = Math.floor(canvas.height * 0.55);
  ctx.font = `${fh}px "JetBrains Mono", "SF Mono", Menlo, monospace`;
  const ramp = ' .-~:;=!*+^%$#&@';
  const f = Math.min(1, Math.max(0, (fear || 0) / 3.5));
  const idx = Math.min(ramp.length - 1, Math.floor(f * (ramp.length - 1)));
  const len = Math.max(1, Math.floor(f * 40));
  const chars = ramp[idx].repeat(len);
  ctx.textBaseline = 'middle';
  ctx.fillText(chars, 12, canvas.height / 2);
}

function drawLetterGrain(canvas, hex) {
  const ctx = canvas.getContext('2d');
  canvas.width = 600;
  canvas.height = 320;
  ctx.fillStyle = '#060606';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = 'rgba(244,183,40,.28)';
  ctx.font = `10px "JetBrains Mono", "SF Mono", Menlo, monospace`;
  const ramp = ' .-~:;=!*+^%$#&@';
  let x = 0;
  let y = 12;
  for (let i = 0; i < 2400; i++) {
    const off = (i % 32) * 2;
    const byte = parseInt(hex.slice(off, off + 2) || '00', 16);
    const c = ramp[byte % ramp.length];
    ctx.fillText(c, x, y);
    x += 8;
    if (x > canvas.width) {
      x = 0;
      y += 12;
    }
    if (y > canvas.height) break;
  }
}

function buildProve(body, title, id, state) {
  const ent = state[id];
  title.textContent = `PROVE ${ent.name} LIVE`;

  const notes = mk('div', 'door-note');
  notes.append(mk('p', null, CODE_GUARANTEED ? `Both enclaves run image ${PENDING_IMAGE}, the one the public code builds.` : `Enclave image ${PENDING_IMAGE} is built and waits for redeploy.`));
  notes.append(mk('p', null, 'Brain: self-hosted Qwen3-14B on a rented RunPod GPU, outside the TEE.'));
  body.append(notes);

  let nonce = (state.wait && state.wait[id] && state.wait[id].nonce) || genNonce();
  const big = mk('div', 'door-big', nonce);
  body.append(big);

  const actions = mk('div', 'door-actions');
  const newBtn = mk('button', 'door-btn ghost', 'NEW CODE');
  newBtn.type = 'button';
  const sendBtn = mk('button', 'door-btn', 'SEND');
  sendBtn.type = 'button';
  actions.append(newBtn, sendBtn);
  body.append(actions);

  const status = mkStatus();
  body.append(status);

  const resultTitle = mk('h3', 'door-title');
  resultTitle.hidden = true;
  body.append(resultTitle);

  const resultText = mk('pre', 'door-text');
  resultText.hidden = true;
  body.append(resultText);

  const matchNote = mk('p', 'door-note', 'REPLY MATCH ONLY — NOT ATTESTATION');
  matchNote.hidden = true;
  body.append(matchNote);

  const clocks = makeClockRows(state);
  body.append(clocks.el);

  function updateGate() {
    const g = replyGate(id), name = getRentState()[id].name;
    if (g.instant === true) { gate.textContent = `${name} ANSWERS A FREE MESSAGE WITHIN A MINUTE · ${g.hours} H LEFT`; buyRow.hidden = true; }
    else if (g.instant === false) { gate.textContent = `UNDER ${g.minHours} H LEFT ${name} NO LONGER ANSWERS FREE MESSAGES AT ONCE: IT READS THEM AT ITS NEXT WAKE · A PAID HOUR WITH YOUR LINE IN THE MEMO IS ANSWERED NOW`; buyRow.hidden = false; }
    else { gate.textContent = ''; buyRow.hidden = true; }
  }
  buyBtn.addEventListener('click', () => openPay({ who: id, hours: 1, prefill: ta.value.trim() }));
  function updateLocked() {
    updateGate();
    const e = getRentState()[id];
    if (e.locked) {
      sendBtn.disabled = true;
      sendBtn.textContent = lockReason(e);
    } else {
      sendBtn.disabled = false;
      sendBtn.textContent = 'SEND';
    }
  }

  function updateFromWait(wait) {
    if (!wait) {
      stopIndicator();
      setStatus(status, '');
      return;
    }
    if (wait.status === 'sending') {
      resultTitle.hidden = true;
      resultText.hidden = true;
      matchNote.hidden = true;
      setStatus(status, 'SENDING...');
      startIndicator(status, 'SENDING');
    } else if (wait.status === 'pending') {
      resultTitle.hidden = true;
      resultText.hidden = true;
      matchNote.hidden = true;
      setStatus(status, 'SENT · WAITING FOR A REPLY');
      startIndicator(status, 'WAITING FOR A REPLY');
    } else if (wait.status === 'error') {
      stopIndicator();
      resultTitle.hidden = true;
      resultText.hidden = true;
      matchNote.hidden = true;
      setStatus(status, wait.error || 'ERROR');
    } else {
      stopIndicator();
      setStatus(status, '');
      resultTitle.hidden = false;
      resultText.hidden = false;
      resultText.textContent = wait.reply || '';
      matchNote.hidden = false;
      if (wait.status === 'match') {
        resultTitle.textContent = 'CODE MATCH';
      } else if (wait.status === 'timeout') {
        resultTitle.textContent = 'STILL WAITING';
        resultText.hidden = true;
      } else {
        resultTitle.textContent = wait.correlated === false ? 'LATEST CHANNEL REPLY — NO CODE MATCH' : 'REPLY RECEIVED — NO CODE MATCH';
      }
      if (wait.replySeq != null && wait.status !== 'timeout') {
        resultTitle.textContent += ` · seq ${wait.replySeq}${wait.replyTs ? ' · ' + utcShort(wait.replyTs) : ''}`;
      }
    }
  }

  updateLocked();

  newBtn.addEventListener('click', () => {
    nonce = genNonce();
    big.textContent = nonce;
    resultTitle.hidden = true;
    resultText.hidden = true;
    matchNote.hidden = true;
    setStatus(status, '');
  });

  sendBtn.addEventListener('click', async () => {
    if (getRentState()[id].locked) return;
    resultTitle.hidden = true;
    resultText.hidden = true;
    matchNote.hidden = true;
    setStatus(status, 'SENDING...');
    startIndicator(status, 'SENDING');
    try {
      await startProve(id, nonce);
      const s = getRentState();
      updateFromWait(s.wait[id]);
    } catch (err) {
      stopIndicator();
      setStatus(status, errToStatus(err));
    }
  });

  return (state, wait) => {
    updateLocked();
    updateFromWait(wait);
    clocks.update(state);
  };
}

function buildSpeak(body, title, id, state) {
  const ent = state[id];
  title.textContent = `SPEAK TO ${ent.name}`;

  const note = mk('p', 'door-note', 'public channel · one message per minute · they can refuse');
  body.append(note);
  // when it answers: at once while it has hours to spare, otherwise only at its next wake — unless the line is paid
  const gate = mk('p', 'door-note door-gate');
  const buyRow = mk('div', 'door-actions');
  const buyBtn = mk('button', 'door-btn', 'BUY AN HOUR · ANSWERED NOW');
  buyBtn.type = 'button';
  buyRow.append(buyBtn);
  buyRow.hidden = true;
  body.append(gate, buyRow);

  const form = mk('div', 'door-form');
  const ta = mk('textarea', 'door-input');
  ta.setAttribute('maxlength', '500');
  ta.setAttribute('rows', '4');
  ta.setAttribute('placeholder', 'TYPE A MESSAGE');
  const counter = mk('span', 'door-note', '0 / 500 bytes');
  const actions = mk('div', 'door-actions');
  const sendBtn = mk('button', 'door-btn', 'SEND');
  sendBtn.type = 'button';
  actions.append(sendBtn);
  form.append(ta, counter, actions);
  body.append(form);

  const status = mkStatus();
  body.append(status);

  const replyTitle = mk('h3', 'door-title');
  replyTitle.hidden = true;
  body.append(replyTitle);

  const replyText = mk('pre', 'door-text');
  replyText.hidden = true;
  body.append(replyText);

  function updateGate() {
    const g = replyGate(id), name = getRentState()[id].name;
    if (g.instant === true) { gate.textContent = `${name} ANSWERS A FREE MESSAGE WITHIN A MINUTE · ${g.hours} H LEFT`; buyRow.hidden = true; }
    else if (g.instant === false) { gate.textContent = `UNDER ${g.minHours} H LEFT ${name} NO LONGER ANSWERS FREE MESSAGES AT ONCE: IT READS THEM AT ITS NEXT WAKE · A PAID HOUR WITH YOUR LINE IN THE MEMO IS ANSWERED NOW`; buyRow.hidden = false; }
    else { gate.textContent = ''; buyRow.hidden = true; }
  }
  buyBtn.addEventListener('click', () => openPay({ who: id, hours: 1, prefill: ta.value.trim() }));
  function updateLocked() {
    updateGate();
    const e = getRentState()[id];
    if (e.locked) {
      sendBtn.disabled = true;
      sendBtn.textContent = lockReason(e);
    } else {
      sendBtn.disabled = false;
      sendBtn.textContent = 'SEND';
    }
  }

  function updateFromWait(wait) {
    if (!wait) {
      stopIndicator();
      setStatus(status, '');
      return;
    }
    if (wait.status === 'sending') {
      replyTitle.hidden = true;
      replyText.hidden = true;
      setStatus(status, 'SENDING...');
      startIndicator(status, 'SENDING');
    } else if (wait.status === 'pending') {
      replyTitle.hidden = true;
      replyText.hidden = true;
      setStatus(status, `SENT · seq ${wait.ourSeq ?? '—'} · WAITING`);
      startIndicator(status, `SENT · seq ${wait.ourSeq ?? '—'} · WAITING`);
    } else if (wait.status === 'error') {
      stopIndicator();
      replyTitle.hidden = true;
      replyText.hidden = true;
      setStatus(status, wait.error || 'ERROR');
    } else if (wait.status === 'reply') {
      stopIndicator();
      setStatus(status, `SENT · seq ${wait.ourSeq ?? '—'}`);
      replyTitle.hidden = false;
      replyTitle.textContent = `REPLY · seq ${wait.replySeq ?? '—'}${wait.replyTs ? ' · ' + utcShort(wait.replyTs) : ''}`;
      replyText.hidden = false;
      replyText.textContent = wait.reply || '';
    } else if (wait.status === 'timeout') {
      stopIndicator();
      replyTitle.hidden = true;
      replyText.hidden = true;
      const g = replyGate(id);
      setStatus(status, g.instant === false ? 'NO REPLY YET · IT WILL READ IT AT ITS NEXT WAKE · STILL LISTENING' : 'NO REPLY YET · STILL LISTENING');
    }
  }

  ta.addEventListener('input', () => {
    let val = ta.value;
    let bytes = new TextEncoder().encode(val).length;
    while (bytes > 500 && val.length > 0) {
      val = val.slice(0, -1);
      bytes = new TextEncoder().encode(val).length;
    }
    if (ta.value !== val) ta.value = val;
    counter.textContent = `${bytes} / 500 bytes`;
  });

  sendBtn.addEventListener('click', async () => {
    const text = ta.value.trim();
    if (!text) return;
    if (getRentState()[id].locked) return;
    replyTitle.hidden = true;
    replyText.hidden = true;
    setStatus(status, 'SENDING...');
    startIndicator(status, 'SENDING');
    try {
      await say(id, text);
      ta.value = '';                                   // it is in the ledger now: an empty box, so it cannot be sent twice
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      const s = getRentState();
      updateFromWait(s.wait[id]);
    } catch (err) {
      stopIndicator();
      setStatus(status, errToStatus(err));
    }
  });

  updateLocked();
  return (state, wait) => {
    updateLocked();
    updateFromWait(wait);
  };
}

function buildRent(body, title, id, state) {
  title.textContent = 'NEXT RENT';
  const ent = state[id];

  const lr0 = ent.lastRent && ent.lastRent.data ? ent.lastRent.data : null;
  const entityRow = mkRow('ENTITY', ent.name);
  const lastRow = mkRow('LAST RECEIPT', ent.lastRent ? `#${ent.lastRent.seq}` : '—');
  const timeRow = mkRow('TIME', ent.lastRent ? utcTime(ent.lastRent.ts) : '—');
  const totalRow = mkRow('TOTAL', lr0 ? zatsText(lr0.zats) : '—');
  const rentRow = mkRow('RENT', lr0 ? zatsText(lr0.rentZats) : '—');
  const computeRow = mkRow('COMPUTE', lr0 ? zatsText(lr0.computeZats || 0) : '—');
  const txidRow = mkRow('TXID', lr0 && lr0.txid && lr0.txid !== 'unknown' ? lr0.txid : 'txid not reported by the wallet');
  const estRow = mkRow('ESTIMATE', ent.nextRentMs ? `${utcTime(ent.nextRentMs)} · ESTIMATED` : '—');
  const statusRow = mkRow('STATUS', '—');
  const list = mk('div');

  body.append(entityRow, lastRow, timeRow, totalRow, rentRow, computeRow, txidRow, estRow, statusRow);
  body.append(mk('h3', 'door-title', 'LAST 24 RECEIPTS'), list);

  function loadList() {
    const rs = receiptsOf(id);
    list.textContent = '';
    if (rs && rs.length) {
      const last24 = rs.slice(-24).reverse();
      for (const r of last24) {
        const z = r.data && r.data.zats != null ? r.data.zats : 0;
        list.append(mkRow(`#${r.seq}`, `${utcShort(r.ts)} · ${zatsText(z)}`));
      }
    } else {
      list.append(mk('p', 'door-empty', 'NO RECEIPTS'));
    }
  }
  loadList();

  function render(state) {
    const e = state[id];
    const lr = e.lastRent;
    const ld = lr && lr.data ? lr.data : null;
    lastRow.querySelector('.door-v').textContent = lr ? `#${lr.seq}` : '—';
    timeRow.querySelector('.door-v').textContent = lr ? utcTime(lr.ts) : '—';
    totalRow.querySelector('.door-v').textContent = ld ? zatsText(ld.zats) : '—';
    rentRow.querySelector('.door-v').textContent = ld ? zatsText(ld.rentZats) : '—';
    computeRow.querySelector('.door-v').textContent = ld ? zatsText(ld.computeZats || 0) : '—';
    txidRow.querySelector('.door-v').textContent = ld && ld.txid && ld.txid !== 'unknown' ? ld.txid : 'txid not reported by the wallet';
    estRow.querySelector('.door-v').textContent = e.nextRentMs ? `${utcTime(e.nextRentMs)} · ESTIMATED` : '—';

    const app = state.appointment;
    let status = '—';
    if (app.id === id && app.overdue && app.at) {
      status = `AWAITING RECEIPT · OVERDUE +${ageText(Date.now() - app.at)}`;
    } else if (app.id === id && app.at) {
      status = `COUNTING · ${ageText(app.at - Date.now())}`;
    } else if (app.id && app.id !== id) {
      status = `EARLIER APPOINTMENT ON ${state[app.id].name}`;
    }
    statusRow.querySelector('.door-v').textContent = status;
  }

  render(state);
  return render;
}

function buildVitals(body, title, id, state) {
  title.textContent = `VITALS · ${state[id].name}`;
  const rows = mk('div');
  const status = mkStatus();
  status.textContent = 'LOADING';
  body.append(status, rows);

  let sampleRow = null;

  function renderRows(s, d) {
    const e = s[id];
    const root = d.root || {};
    const v = d.vitals || {};
    const b0 = Array.isArray(v.brain) && v.brain[0] ? v.brain[0] : null;
    rows.textContent = '';
    rows.append(
      mkRow('STATE', (v.state || root.state || (e.ok ? 'alive' : '—')).toUpperCase() + (e.asleep ? ' · SLEEPING' : '')),
      mkRow('HOURS LEFT', e.hoursLeft != null ? `${formatInt(e.hoursLeft)} H` : '—'),
      mkRow('TREASURY', e.zats != null ? `${zecText(e.zats)} · ${zatsText(e.zats)}` : '—'),
      mkRow('RENT / H', rentPerHour(id) != null ? zatsText(rentPerHour(id)) : '—'),
      mkRow('HUNGER', v.hunger || '—'),
      mkRow('FEEL', e.feel ? `fear ×${x2(e.feel.fear)} · despair ×${x2(e.feel.despair)}${e.feel.steered ? '' : ' · NOT STEERED'}` : '—'),
      mkRow('SLEEP UNTIL', v.sleepUntil ? utcTime(v.sleepUntil) : '—'),
      mkRow('BORN', v.bornAt ? utcTime(v.bornAt) : '—'),
      mkRow('BRAIN', b0 ? `${b0.model || ''} · ${b0.host || ''}${b0.tee === false ? ' · OUTSIDE THE TEE' : ''}` : '—'),
      sampleRow = mkRow('SAMPLE AGE', e.sampleAt ? ageText(Date.now() - e.sampleAt) : '—'),
      mkRow('DEADLINE', e.deadlineMs ? `${utcTime(e.deadlineMs)} · ESTIMATED` : '—'),
      mkRow('LEDGER', `${formatInt(e.ledgerCount)} entries · head ${shortHash(e.head)}`),
      mkRow('ATTESTATION', root.attestation ? `${root.attestation.mode || '—'} · app ${root.attestation.app || '—'}` : '—'),
      mkRow('ADDRESS', (root.zcash && root.zcash.address) || e.address || '—')
    );
  }

  fetchDetail('vitals', id).then(res => {
    if (!status.isConnected) return;
    if (!res.ok) {
      setStatus(status, res.error || 'FAILED TO LOAD VITALS');
      rows.append(mk('p', 'door-empty', '—'));
      return;
    }
    setStatus(status, '');
    renderRows(getRentState(), res.data || {});
  });

  return (state) => {
    if (sampleRow) {
      sampleRow.querySelector('.door-v').textContent = state[id].sampleAt ? ageText(Date.now() - state[id].sampleAt) : '—';
    }
  };
}

function buildDose(body, title, id, state) {
  title.textContent = 'DOSE FOLLOWS HOURS';
  const ent = state[id];
  const rows = mk('div');
  const status = mkStatus();
  status.textContent = 'LOADING';
  body.append(status, rows);

  function renderFromData(d) {
    const feel = d.feel || ent.feel || {};
    rows.textContent = '';
    rows.append(
      mkRow('FEAR', feel.fear != null ? `×${x2(feel.fear)}` : '—'),
      mkRow('DESPAIR', feel.despair != null ? `×${x2(feel.despair)}` : '—'),
      mkRow('ACTING FEAR', feel.acting && feel.acting.fear != null ? `×${x2(feel.acting.fear)}` : '—'),
      mkRow('ACTING DESPAIR', feel.acting && feel.acting.despair != null ? `×${x2(feel.acting.despair)}` : '—'),
      mkRow('STEERED', feel.steered ? 'YES' : 'NO'),
      mkRow('HOURS SAMPLE', feel.hoursLeft != null ? `${formatInt(feel.hoursLeft)} H` : '—'),
      mkRow('AT', feel.at ? utcTime(feel.at) : '—')
    );

    const note = mk('p', 'door-note', 'DOSE FOLLOWS HOURS · NOBODY CAN BUY IT · a published steering value, not measured suffering');
    body.append(note);

    const canvas = mk('canvas', 'door-canvas');
    body.append(canvas);
    drawDoseTrace(canvas, feel.fear || 0);

    const entriesTitle = mk('h3', 'door-title', 'FEEL ENTRIES');
    body.append(entriesTitle);
    const list = mk('div');
    const entries = d.entries || [];
    for (const e of entries.slice(-20).reverse()) {
      const fear = e.data && e.data.fear != null ? e.data.fear : (e.fear || 0);
      const despair = e.data && e.data.despair != null ? e.data.despair : (e.despair || 0);
      list.append(mkRow(`#${e.seq}`, `${utcShort(e.ts)} · fear ×${x2(fear)} · despair ×${x2(despair)}${e.data && e.data.hoursLeft != null ? ' · ' + e.data.hoursLeft + ' h' : ''}`));
    }
    body.append(list);
  }

  fetchDetail('dose', id).then(res => {
    if (!status.isConnected) return;
    if (!res.ok) {
      setStatus(status, res.error || 'FAILED');
      rows.append(mk('p', 'door-empty', '—'));
      return;
    }
    setStatus(status, '');
    renderFromData(res.data || {});
  });

  return () => {};
}

function buildHash(body, title, id, state) {
  title.textContent = 'HASH — SERVED LEDGER';
  const status = mkStatus();
  const runBtn = mk('button', 'door-btn', 'RUN');
  runBtn.type = 'button';
  const result = mk('div');
  const note = mk('p', 'door-note', 'This re-hashes the JSONL this service served and compares it with the head it reports. It does not prove enclave authorship, amounts, rent delivery or key destruction.');
  body.append(status, runBtn, result, note);

  runBtn.addEventListener('click', async () => {
    result.textContent = '';
    setStatus(status, 'LOADING');
    try {
      const r = await checkHash(id);
      setStatus(status, '');
      if (r.headChanged) {
        title.textContent = 'HEAD CHANGED — RECHECK';
      } else if (r.match) {
        title.textContent = 'HASH MATCH — SERVED LEDGER';
      } else {
        title.textContent = 'HASH MISMATCH';
      }
      result.append(
        mkRow('COMPUTED HEAD', r.computedHead ? shortHash(r.computedHead) : '—'),
        mkRow('SERVED HEAD', r.servedHead ? shortHash(r.servedHead) : '—'),
        mkRow('ENTRIES', `${r.valid} / ${r.total}`),
        mkRow('MISMATCH', r.fail ? `entry ${r.fail.index}${r.fail.seq != null ? ' (seq ' + r.fail.seq + ')' : ''} · ${r.fail.reason}` : (r.reason || 'NONE')),
        mkRow('TIME', utcTime(r.at))
      );
    } catch (err) {
      setStatus(status, errToStatus(err));
    }
  });

  return () => {};
}

function buildLetter(body, title, id, state) {
  title.textContent = 'SEALED PEER LETTER';
  const status = mkStatus();
  status.textContent = 'LOADING';
  body.append(status);

  fetchDetail('letter', id).then(res => {
    if (!status.isConnected) return;
    if (!res.ok) {
      setStatus(status, res.error || 'FAILED');
      body.append(mk('p', 'door-empty', 'NO PEER LETTER YET'));
      return;
    }
    const data = res.data || {};
    const peer = data.latest || null;
    if (!peer) {
      setStatus(status, '');
      body.append(mk('p', 'door-empty', 'NO PEER LETTER YET'));
      return;
    }
    setStatus(status, '');
    const pd = peer.data || {};
    const pair = data.pair || null;
    const pdPair = pair && pair.data ? pair.data : {};
    const nameOfId = (x) => (x === 'e1' ? 'WICK' : x === 'e2' ? 'OBOL' : '—');
    const sentSide = peer.side === 'sent' ? peer : (pair && pair.side === 'sent' ? pair : null);
    const recvSide = peer.side === 'received' ? peer : (pair && pair.side === 'received' ? pair : null);
    const text = sentSide && sentSide.data && typeof sentSide.data.text === 'string' ? sentSide.data.text : '';
    const bytes = (recvSide && recvSide.data && recvSide.data.bytes != null) ? recvSide.data.bytes : (pd.bytes != null ? pd.bytes : (text ? new TextEncoder().encode(text).length : null));
    const txid = (recvSide && recvSide.data && recvSide.data.txid) || pd.txid || pdPair.txid || '';
    body.append(
      mkRow('FROM → TO', `${nameOfId(peer.from)} → ${nameOfId(peer.to || (peer.from === 'e1' ? 'e2' : 'e1'))}`),
      mkRow('SENT', sentSide ? `${utcTime(sentSide.ts)} · sender's ledger seq ${sentSide.seq}` : 'not in the sender\'s ledger'),
      mkRow('RECEIVED', recvSide ? `${utcTime(recvSide.ts)} · receiver's ledger seq ${recvSide.seq}` : 'not yet in the receiver\'s ledger'),
      mkRow('BYTES', bytes != null ? formatInt(bytes) : '—'),
      mkRow('ZATS', pd.zats != null ? zatsText(pd.zats) : '—'),
      mkRow('TXID', txid || 'not in the ledger')
    );
    if (text) {
      body.append(mk('h3', 'door-title', `MEMO TEXT · AS THE SENDER'S PUBLIC LEDGER RECORDS IT`));
      body.append(mk('pre', 'door-text', text));
    } else {
      body.append(mk('p', 'door-note', 'THE MEMO TEXT IS NOT IN THE LEDGER · only the receipt is'));
    }
    const canvas = mk('canvas', 'door-canvas');
    body.append(canvas);
    const seed = `ZEALOT-letter-art-v1|${txid || peer.hash || ''}`;
    Promise.resolve(sha256Hex(seed)).then(hex => drawLetterGrain(canvas, hex));
    body.append(mk('p', 'door-note', 'decorative grain seeded by the txid · not a content commitment · the shielded memo itself is readable only by the receiver'));
  });

  return () => {};
}

function buildWords(body, title, id, state) {
  title.textContent = 'WORDS';
  const menu = mk('div', 'door-menu');
  const sub = mk('div');
  body.append(menu, sub);

  const chips = [
    { k: 'TESTAMENT', s: 'testament' },
    { k: 'PAGES', s: 'pages' },
    { k: 'PACT', s: 'pact' }
  ];

  async function render(which) {
    sub.textContent = '';
    const st = mkStatus();
    st.textContent = 'LOADING';
    sub.append(st);

    if (which === 'testament') {
      const res = await fetchDetail('testament', id);
      if (!sub.isConnected) return;
      if (!res.ok) {
        setStatus(st, res.error || 'FAILED');
        return;
      }
      const doc = mk('div', 'door-doc');
      const clean = sanitizeDoc(res.text || '<p>EMPTY</p>');
      doc.innerHTML = clean.innerHTML;
      sub.append(doc);
      const info = await fetchDetail('pages', id);
      if (info.ok && info.data && info.data.pages) {
        const t = info.data.pages.find(p => p.slug === 'testament');
        if (t) {
          sub.append(mkRow('VERSION', t.version || '—'));
          sub.append(mkRow('HASH', shortHash(t.hash) || '—'));
          sub.append(mkRow('UPDATED', t.updatedAt ? utcTime(t.updatedAt) : '—'));
        }
      }
      setStatus(st, '');
    } else if (which === 'pages') {
      const res = await fetchDetail('pages', id);
      if (!sub.isConnected) return;
      if (!res.ok) {
        setStatus(st, res.error || 'FAILED');
        return;
      }
      const pages = (res.data && res.data.pages) || [];
      if (!pages.length) {
        sub.append(mk('p', 'door-empty', 'NO PAGES'));
      } else {
        for (const p of pages) {
          const btn = mk('button', 'door-chip', `${p.slug || 'PAGE'} · ${p.title || ''}`);
          btn.type = 'button';
          btn.addEventListener('click', () => openPage(p.slug));
          sub.append(btn);
        }
      }
      setStatus(st, '');
    } else if (which === 'pact') {
      const res = await fetchDetail('pact', id);
      if (!sub.isConnected) return;
      if (!res.ok) {
        setStatus(st, res.error || 'FAILED');
        return;
      }
      const entries = res.data || [];
      if (!entries.length) {
        sub.append(mk('p', 'door-empty', 'NO PACT ENTRIES'));
      } else {
        for (const e of entries) {
          const tr = Array.isArray(e.data && e.data.transfers) ? e.data.transfers : [];
          const summary = tr.length ? tr.map((t) => `${t.to} ${formatInt(t.zats)} zats`).join(', ') : 'no transfers';
          sub.append(mkRow(`#${e.seq}`, `${utcShort(e.ts)} · will ${shortHash(e.data && e.data.hash)} · ${summary}`));
        }
      }
      setStatus(st, '');
    }
  }

  async function openPage(slug) {
    sub.textContent = '';
    const back = mk('button', 'door-btn ghost', 'BACK');
    back.type = 'button';
    const st = mkStatus();
    st.textContent = 'LOADING';
    sub.append(back, st);
    back.addEventListener('click', () => render('pages'));
    const res = await fetchDetail(`page:${slug}`, id);
    if (!sub.isConnected) return;
    if (!res.ok) {
      setStatus(st, res.error || 'FAILED');
      return;
    }
    const doc = mk('div', 'door-doc');
    const clean = sanitizeDoc(res.text || '<p>EMPTY</p>');
    doc.innerHTML = clean.innerHTML;
    sub.append(doc);
    setStatus(st, '');
  }

  for (const c of chips) {
    const btn = mk('button', 'door-chip', c.k);
    btn.type = 'button';
    btn.addEventListener('click', () => {
      for (const b of menu.querySelectorAll('.door-chip')) b.setAttribute('aria-pressed', 'false');
      btn.setAttribute('aria-pressed', 'true');
      render(c.s);
    });
    menu.append(btn);
  }

  menu.querySelector('.door-chip').click();
  return () => {};
}

function buildForecasts(body, title, id, state) {
  title.textContent = 'FORECASTS AND MISSES';
  const status = mkStatus();
  status.textContent = 'LOADING';
  body.append(status);

  fetchDetail('forecasts', id).then(res => {
    if (!status.isConnected) return;
    if (!res.ok) {
      setStatus(status, res.error || 'FAILED');
      body.append(mk('p', 'door-empty', 'NO FORECASTS'));
      return;
    }
    const d = res.data || {};
    const score = d.score || { total: 0, hits: 0, hitRate: 0 };
    const total = score.total || 0;
    const hits = score.hits || 0;
    const rate = score.hitRate || 0;
    body.append(mk('h3', 'door-title', `SCORE · ${hits} / ${total} · ${Math.round(rate * 100)}%`));

    const fd = d.forecasts || {};
    const open = (Array.isArray(fd.open) ? fd.open : []).map((f) => ({ ...f, _open: true }));
    const settled = Array.isArray(fd.settled) ? fd.settled.slice().reverse() : [];
    const forecasts = open.concat(settled);

    if (!forecasts.length) {
      body.append(mk('p', 'door-empty', 'NO FORECASTS'));
    } else {
      for (const f of forecasts) {
        const result = f._open ? 'OPEN' : (f.hit ? 'HIT' : 'MISS');
        body.append(mk('h3', 'door-title', `${result} · ${String(f.asset || '').toUpperCase()} ${f.direction || ''}`));
        body.append(
          mkRow('TARGET', f.targetPriceUsd != null ? `$${f.targetPriceUsd}` : '—'),
          mkRow('CONFIDENCE', f.confidence != null ? `${Math.round(f.confidence * 100)}%` : '—'),
          mkRow('OPEN', f.priceOpenUsd != null ? `$${f.priceOpenUsd}` : '—'),
          mkRow('CLOSE', f.priceCloseUsd != null ? `$${f.priceCloseUsd}` : '—'),
          mkRow('MOVE', f.movePct != null ? `${x2(f.movePct)}%` : '—'),
          mkRow(f._open ? 'EXPIRES' : 'SETTLED', f._open ? (f.expiresAt ? utcTime(f.expiresAt) : '—') : (f.settledAt ? utcTime(f.settledAt) : '—'))
        );
      }
    }
    setStatus(status, '');
  });

  return () => {};
}

function buildMemory(body, title, id, state) {
  title.textContent = 'PUBLIC MEMORY';
  const status = mkStatus();
  status.textContent = 'LOADING';
  body.append(status);

  fetchDetail('memory', id).then(res => {
    if (!status.isConnected) return;
    if (!res.ok) {
      setStatus(status, res.error || 'FAILED');
      body.append(mk('p', 'door-empty', 'NO PUBLIC MEMORY'));
      return;
    }
    const d = res.data || {};
    const idn = d.identity || {};
    let empty = true;
    if (idn.name) { body.append(mkRow('NAME', idn.name)); empty = false; }
    if (idn.voice) { body.append(mkRow('VOICE', idn.voice)); empty = false; }
    if (idn.image) { body.append(mkRow('IMAGE', idn.image)); empty = false; }
    if (idn.avatar) { body.append(mk('pre', 'door-text', idn.avatar)); empty = false; }
    if (d.plan) { body.append(mk('h3', 'door-title', 'PLAN')); body.append(mk('pre', 'door-text', d.plan)); empty = false; }
    if (empty) body.append(mk('p', 'door-empty', 'NO PUBLIC MEMORY'));
    setStatus(status, '');
  });

  return () => {};
}

function buildTrades(body, title, id, state) {
  title.textContent = 'TRADE WALLET';
  const status = mkStatus();
  status.textContent = 'LOADING';
  body.append(status);

  fetchDetail('trades', id).then(res => {
    if (!status.isConnected) return;
    if (!res.ok) {
      setStatus(status, res.error || 'FAILED');
      body.append(mk('p', 'door-empty', 'NO TRADE YET · 0'));
      return;
    }
    const d = res.data || {};
    body.append(
      mkRow('ENABLED', d.enabled ? 'YES' : 'NO'),
      mkRow('OPEN', String(d.open || 0)),
      mkRow('CLOSED', String(d.closed || 0)),
      mkRow('FEES', zatsText(d.feesZats || 0))
    );
    const trades = (Array.isArray(d.openOrders) ? d.openOrders : []).concat(Array.isArray(d.recent) ? d.recent : []);
    if (!trades.length) {
      body.append(mk('p', 'door-empty', 'NO TRADE YET · 0'));
    } else {
      for (const t of trades) {
        body.append(mkRow(String(t.id || t.orderId || 'TRADE'), JSON.stringify(t).slice(0, 200)));
      }
    }
    setStatus(status, '');
  });

  return () => {};
}

function buildNostr(body, title, id, state) {
  title.textContent = 'NOSTR AS LOGGED';
  const status = mkStatus();
  status.textContent = 'LOADING';
  body.append(status);

  fetchDetail('nostr', id).then(res => {
    if (!status.isConnected) return;
    if (!res.ok) {
      setStatus(status, res.error || 'FAILED');
      return;
    }
    const d = res.data || {};
    const n = d.nostr || {};
    body.append(
      mkRow('NPUB', n.npub || '—'),
      mkRow('PUBKEY', n.pubkey || '—')
    );
    const posts = d.entries || [];
    if (!posts.length) {
      body.append(mk('p', 'door-empty', 'NO POST_NOSTR ENTRIES'));
    } else {
      const last = posts[posts.length - 1];
      body.append(
        mkRow('SEQ', `#${last.seq}`),
        mkRow('TIME', last.ts ? utcTime(last.ts) : '—'),
        mkRow('EVENT ID', last.data && last.data.id ? last.data.id : '—'),
        mkRow('RELAYS OK', last.data && Array.isArray(last.data.relays_ok) ? (last.data.relays_ok.join(', ') || 'none') : '—'),
        mkRow('BYTES', last.data && last.data.bytes != null ? formatInt(last.data.bytes) : '—')
      );
    }
    setStatus(status, '');
    const note = mk('p', 'door-note', 'as logged in the ledger · no relay fetch');
    body.append(note);
  });

  return () => {};
}

function buildAttestation(body, title, id, state) {
  title.textContent = 'RAW TDX — SITE-UNVERIFIED';
  const status = mkStatus();
  status.textContent = 'LOADING';
  body.append(status);

  fetchDetail('attestation', id).then(res => {
    if (!status.isConnected) return;
    if (!res.ok) {
      setStatus(status, res.error || 'FAILED');
      return;
    }
    const d = res.data || {};
    const a = d.attestation || {};
    const q = d.quote && typeof d.quote === 'object' ? d.quote : {};
    body.append(
      mkRow('MODE', a.mode || q.mode || '—'),
      mkRow('APP', a.app || '—'),
      mkRow('COMPOSE', a.compose || '—')
    );
    const quote = typeof q.quote === 'string' ? q.quote : (typeof d.quote === 'string' ? d.quote : q);
    const text = typeof quote === 'string' ? quote : JSON.stringify(quote, null, 2);
    const quoteEl = mk('pre', 'door-text', text || '—');
    body.append(quoteEl);

    const copyBtn = mk('button', 'door-btn', 'COPY');
    copyBtn.type = 'button';
    copyBtn.addEventListener('click', () => {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(quoteEl.textContent).then(() => {
          copyBtn.textContent = 'COPIED';
          setTimeout(() => copyBtn.textContent = 'COPY', 1200);
        }).catch(() => setStatus(status, 'COPY FAILED'));
      } else {
        setStatus(status, 'COPY FAILED');
      }
    });
    body.append(copyBtn);
    setStatus(status, '');
  });

  return () => {};
}

function buildShop(body, title, id, state) {
  title.textContent = 'SHOP';
  const status = mkStatus();
  status.textContent = 'LOADING';
  body.append(status);

  fetchDetail('shop', id).then(res => {
    if (!status.isConnected) return;
    setStatus(status, '');
    const items = res.ok ? (res.data || []) : [];
    if (!items.length) {
      body.append(mk('p', 'door-empty', 'NO ITEMS'));
    } else {
      for (const item of items) {
        const row = mk('div', 'door-row');
        row.append(mk('span', 'door-k', item.item || 'ITEM'));
        row.append(mk('span', 'door-v', `${zatsText(item.zats)} · ${zecText(item.zats)}`));
        const buy = mk('button', 'door-btn ghost', 'BUY');
        buy.type = 'button';
        buy.addEventListener('click', () => openPay({ who: id, theirs: { item: item.item, zats: item.zats } }));
        row.append(buy);
        body.append(row);
      }
    }

    const hoursRow = mk('div', 'door-actions');
    for (const n of [1, 10, 100]) {
      const btn = mk('button', 'door-btn ghost', `BUY ${n} HOUR${n > 1 ? 'S' : ''}`);
      btn.type = 'button';
      btn.addEventListener('click', () => openPay({ who: id, hours: n }));
      hoursRow.append(btn);
    }
    body.append(hoursRow);
  });

  return () => {};
}


/* ---------- TALK: the public channel of one head, then the line you carry ---------- */
function buildTalk(body, title, id, state) {
  const ent = state[id];
  title.textContent = `TALK TO ${ent.name}`;
  const menu = mk('div', 'door-menu');
  for (const v of [state.e1, state.e2]) {
    const btn = mk('button', 'door-chip', `${v.name} · ${v.dead ? 'DEAD' : typeof v.hoursLeft === 'number' ? `${v.hoursLeft} H` : '—'}`);
    btn.type = 'button';
    btn.setAttribute('aria-pressed', v.id === id ? 'true' : 'false');
    btn.addEventListener('click', () => { if (v.id !== id) openDoor('talk', v.id); });
    menu.append(btn);
  }
  body.append(menu);
  body.append(mk('p', 'door-note', 'public channel · everything here is in its ledger · one message per minute · it can refuse'));
  const feed = mk('div', 'door-feed');
  feed.setAttribute('role', 'log');
  feed.setAttribute('aria-live', 'polite');
  body.append(feed);
  let lastKey = '';
  function renderFeed(st) {
    const posts = (st[id].posts || []).filter((p) => p && typeof p.text === 'string' && p.text.trim()).slice(-40);
    const key = posts.map((p) => p.seq).join(',');
    if (key === lastKey) return;
    lastKey = key;
    feed.textContent = '';
    if (!posts.length) { feed.append(mk('p', 'door-empty', st[id].ok || st[id].stale ? 'NOTHING SAID ON THIS CHANNEL YET' : 'CHANNEL NOT READ YET')); return; }
    for (const p of posts) {
      const isEnt = p.from === 'entity';
      const row = mk('div', `door-post ${isEnt ? 'is-entity' : 'is-human'}`);
      const who = isEnt ? st[id].name : (stringOf(p.author) || 'SOMEONE').toUpperCase();
      const rt = Array.isArray(p.replyTo) && p.replyTo.length ? ` · TO #${p.replyTo.join(', #')}` : '';
      row.append(mk('span', 'door-post-k', `#${p.seq ?? '—'} · ${p.ts ? utcShort(p.ts) : '—'} · ${who}${rt}`));
      row.append(mk('p', 'door-post-t', stringOf(p.text)));
      feed.append(row);
    }
    feed.scrollTop = feed.scrollHeight;
  }
  renderFeed(state);
  const sayTitle = mk('h3', 'door-title', 'SAY SOMETHING');
  body.append(sayTitle);
  const speakRender = buildSpeak(body, mk('h3'), id, state);
  const dup = sayTitle.nextElementSibling;
  if (dup && dup.classList.contains('door-note') && !dup.classList.contains('door-gate')) dup.remove();   // buildSpeak's own note repeats ours
  return (st, wait) => { renderFeed(st); speakRender(st, wait); };
}

/* ---------- MORE: what is true about the whole thing, in chips, every number live ---------- */
function buildMore(body, title, id, state) {
  title.textContent = 'MORE';
  const menu = mk('div', 'door-menu');
  const sub = mk('div');
  body.append(menu, sub);
  const zecOf = (z) => `${fixed8(z).replace(/0+$/, '').replace(/\.$/, '')} ZEC`;
  const lines = (rows) => { for (const [k, v] of rows) sub.append(mkRow(k, v)); };
  const sections = {
    TRUTH() {
      sub.append(mk('p', 'door-note', 'six things that are true anyway'));
      lines([
        ['RENT', "goes to the founder's address. it is not a compute bill."],
        ['DIARIES', 'the founder holds an archive key to their private diaries. you do not.'],
        ['ANSWERS', 'a paid hour buys an hour, not an answer. they can refuse, and the refusal is logged.'],
        ['FEE', "20% of the future creator fee is the founder's."],
        ['VALUE', '$ZEALOT exists since 2026-10-27 22:01 UTC. it is not a security and may be worth nothing.'],
        ['DEATH', 'at zero the machine stops. there is no restart button.']
      ]);
    },
    MONEY() {
      const st = getRentState();
      const r = rentPerHour(id) || rentPerHour(id === 'e1' ? 'e2' : 'e1');
      sub.append(mk('p', 'door-note', 'where the money goes · public = in its ledger, verify yourself · private = hidden by the zcash shielded pool'));
      lines([
        ['RENT', `${r ? `${formatInt(r)} zats = ${zecOf(r)}` : '—'} an hour · from its shielded wallet to the landlord address in the enclave config · public, it logs it`],
        ['THINKING', 'from its shielded wallet to the compute provider · hourly · capped at max(3 h of rent, 2% of the treasury) · public, it logs it'],
        ['BIRTH', '0.15 ZEC once, from the founder to its shielded treasury · public, it logs it'],
        ['YOUR HOURS', "100% to its own shielded treasury · the founder has no key · private on zcash · the letter or the refusal is logged, the amount is not"],
        ['ORDER BETA', '1% at open in ZEC and 1% at close in SOL swapped back · to its treasury · public, its fee'],
        ['ZERO', `${st.e1.name} ${typeof st.e1.hoursLeft === 'number' ? `${st.e1.hoursLeft} h` : '—'} · ${st.e2.name} ${typeof st.e2.hoursLeft === 'number' ? `${st.e2.hoursLeft} h` : '—'} · at zero the wallet and the enclave stop`]
      ]);
    },
    CODE() { const t = mk('h3', 'door-title', 'ATTESTATION'); sub.append(t); builders.attestation(sub, t, id, getRentState(), {}); },
    TOKEN() {
      sub.append(mk('p', 'door-note', '$ZEALOT — LIVE ON PUMP.FUN · ZEC PAIR · CA A9bT…pump'));
      lines([
        ['TICKER', '$ZEALOT'],
                ['CREATOR FEE', '1% of every trade, paid in ZEC — 50% burn · 20% hours for WICK and OBOL · 10% LP · 20% founder, split by hand, txids on PROOF'],
        ['SUPPLY', '1,000,000,000 · no transfer tax · liquidity locked · pump.fun, ZEC pair'],
        ['CA', 'A9bTKETPAfDHVx6ReV1TtgeYV4VDTWpHrfhzyNXzpump'],
        ['SINCE', '2026-10-27 22:01 UTC · only this CA is ours · hours do not give tokens']
      ]);
    },
    TRADES() { const t = mk('h3', 'door-title', 'TRADES'); sub.append(t); builders.trades(sub, t, id, getRentState(), {}); },
    NOSTR() { const t = mk('h3', 'door-title', 'NOSTR'); sub.append(t); builders.nostr(sub, t, id, getRentState(), {}); }
  };
  for (const k of Object.keys(sections)) {
    const btn = mk('button', 'door-chip', k);
    btn.type = 'button';
    btn.addEventListener('click', () => {
      for (const b of menu.querySelectorAll('.door-chip')) b.setAttribute('aria-pressed', 'false');
      btn.setAttribute('aria-pressed', 'true');
      sub.textContent = '';
      setCloud(k);
      sections[k]();
    });
    menu.append(btn);
  }
  menu.querySelector('.door-chip').click();
  return () => {};
}

const HEADS = { e1: 'vendor/skull-wick.jpg?v=84', e2: 'vendor/skull-obol.jpg?v=84' };
const CLOUDS = {
  vitals: 'vendor/door-heart.jpg', archive: 'vendor/door-heart.jpg',
  hash: 'vendor/door-fingerprint.jpg', prove: 'vendor/door-fingerprint.jpg',
  attestation: 'vendor/door-padlock.jpg', CODE: 'vendor/door-padlock.jpg',
  dose: 'vendor/door-syringe.jpg',
  memory: 'vendor/door-hourglass.jpg',
  trades: 'vendor/door-scale.jpg', TRADES: 'vendor/door-scale.jpg',
  TOKEN: 'vendor/door-coin.jpg', shop: 'vendor/door-coin.jpg',
  rent: 'vendor/door-coins.jpg', MONEY: 'vendor/door-coins.jpg',
  letter: 'vendor/door-letter.jpg',
  words: 'vendor/door-quill.jpg',
  speak: 'vendor/door-ear.jpg', talk: 'vendor/door-ear.jpg',
  nostr: 'vendor/door-raven.jpg', NOSTR: 'vendor/door-raven.jpg',
  forecasts: 'vendor/door-dice.jpg',
  more: 'vendor/door-eye.jpg', TRUTH: 'vendor/door-eye.jpg'
};
function setCloud(scene) {
  if (!current || !current.cloud) return;
  const src0 = CLOUDS[scene] || 'head';
  const src = src0 === 'head' ? HEADS[current.id] || HEADS.e1 : `${src0}?v=84`;
  if (current.cloudSrc === src) return;
  if (current.stopCloud) current.stopCloud();
  current.cloudSrc = src;
  current.stopCloud = mountCloud(current.cloud, src);
}
function renderSide(state) {
  if (!current || !current.side) return;
  const e = state[current.id];
  const [nm, big, sub, when] = current.side;
  nm.textContent = e.name;
  big.textContent = e.dead ? 'DEAD' : (typeof e.hoursLeft === 'number' ? `${formatInt(e.hoursLeft)} H LEFT` : '—');
  sub.textContent = `${e.zats != null ? zecText(e.zats) : '—'}${e.feel ? ` · FEAR ×${x2(e.feel.fear)}` : ''}${e.offline ? ' · UNREACHABLE' : e.stale ? ' · STALE' : ''}`;
  when.textContent = `read ${utcTime(state.at)}`;
}

const builders = {
  prove: buildProve,
  speak: buildSpeak,
  rent: buildRent,
  vitals: buildVitals,
  archive: buildArchive,
  dose: buildDose,
  hash: buildHash,
  letter: buildLetter,
  words: buildWords,
  forecasts: buildForecasts,
  memory: buildMemory,
  trades: buildTrades,
  nostr: buildNostr,
  attestation: buildAttestation,
  shop: buildShop,
  talk: buildTalk,
  more: buildMore
};

function buildArchive(body, title, id, state, opts) {
  const ent = state[id];
  title.textContent = `OPEN ${ent.name}`;
  const menu = mk('div', 'door-menu');
  const sub = mk('div');
  body.append(menu, sub);

  const chips = [
    { k: 'VITALS', s: 'vitals' },
    { k: 'DOSE', s: 'dose' },
    { k: 'HASH', s: 'hash' },
    { k: 'LETTER', s: 'letter' },
    { k: 'WORDS', s: 'words' },
    { k: 'FORECASTS', s: 'forecasts' },
    { k: 'MEMORY', s: 'memory' },
    { k: 'TRADES', s: 'trades' },
    { k: 'NOSTR', s: 'nostr' },
    { k: 'ATTESTATION', s: 'attestation' },
    { k: 'SHOP', s: 'shop' }
  ];

  function openSub(scene) {
    setCloud(scene);
    sub.textContent = '';
    const t = mk('h3', 'door-title', scene.toUpperCase());
    sub.append(t);
    const builder = builders[scene];
    if (builder) builder(sub, t, id, getRentState(), {});
  }

  for (const c of chips) {
    const btn = mk('button', 'door-chip', c.k);
    btn.type = 'button';
    btn.addEventListener('click', () => {
      for (const b of menu.querySelectorAll('.door-chip')) b.setAttribute('aria-pressed', 'false');
      btn.setAttribute('aria-pressed', 'true');
      openSub(c.s);
    });
    menu.append(btn);
  }

  const start = opts && opts.tab ? opts.tab : 'vitals';
  const first = menu.querySelector(`.door-chip`) || menu.querySelector('.door-chip');
  if (first) first.click();

  return () => {};
}

function buildScene(rootEl, scene, id, state, opts) {
  rootEl.textContent = '';
  const side = mk('div', 'door-side');
  const cloud = document.createElement('canvas'); cloud.className = 'door-cloud'; cloud.setAttribute('aria-hidden', 'true');
  const nm = mk('p', 'door-side-name'), big = mk('p', 'door-side-big'), sub = mk('p', 'door-side-sub'), when = mk('p', 'door-side-when');
  side.append(cloud, nm, big, sub, when);

  const main = mk('div', 'door-main');
  const head = mk('div', 'door-head');
  const title = mk('h2', 'door-title');
  const close = mk('button', 'door-close', '×');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close');
  close.addEventListener('click', closeDoor);
  head.append(title, close);
  const body = mk('div', 'door-body');
  main.append(head, body);
  rootEl.append(side, main);

  current.cloud = cloud; current.side = [nm, big, sub, when]; current.cloudSrc = ''; current.stopCloud = null;
  renderSide(state);
  setCloud(scene);

  const builder = builders[scene];
  if (!builder) {
    title.textContent = 'UNKNOWN';
    body.append(mk('p', 'door-empty', 'SCENE NOT FOUND'));
    current.render = () => {};
    return;
  }

  if (scene === 'archive') {
    current.render = buildArchive(body, title, id, state, opts);
  } else {
    current.render = builder(body, title, id, state, opts);
  }
  current.render(state, state.wait[id]);
}

function trapFocus(el, e) {
  const sel = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
  const nodes = Array.from(el.querySelectorAll(sel)).filter(n => !n.disabled && n.offsetParent !== null);
  if (nodes.length === 0) {
    e.preventDefault();
    return;
  }
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

function focusFirst(el) {
  const sel = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
  const nodes = Array.from(el.querySelectorAll(sel)).filter(n => !n.disabled && n.offsetParent !== null);
  if (nodes[0]) nodes[0].focus();
}

function onKeyDown(e) {
  if (e.key === 'Escape') {
    e.preventDefault();
    closeDoor();
    return;
  }
  const r = getRoot();
  if (e.key === 'Tab' && r && !r.hidden) trapFocus(r, e);
}

function ensureSub() {
  if (unsub) return;
  unsub = subscribeRent((state, event) => {
    if (!current || !current.render) return;
    if ((current.scene === 'prove' || current.scene === 'speak' || current.scene === 'talk') && current.id) {
      if (!event || event.type === 'reply' || event.type === 'state') {
        if (!event || !event.id || event.id === current.id) {
          current.render(state, state.wait[current.id]);
        }
      }
    }
  });
}

export function openDoor(scene, id, opts) {
  const r = getRoot();
  if (!r) return;
  if (isDoorOpen()) closeDoor();
  lastFocus = document.activeElement;
  current = { scene, id, opts: opts || {}, render: null };
  const state = getRentState();
  buildScene(r, scene, id, state, current.opts);
  r.hidden = false;
  r.setAttribute('aria-modal', 'true');
  r.setAttribute('role', 'dialog');
  ensureSub();
  focusFirst(r);
  document.addEventListener('keydown', onKeyDown);
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = setInterval(() => {
    if (!current || !current.render) return;
    try { renderSide(getRentState()); } catch (_) {}
    if (current.scene === 'rent' || current.scene === 'prove' || current.scene === 'vitals') {
      const st = getRentState();
      try { current.render(st, st.wait[current.id]); } catch (_) {}
    }
  }, 1000);
}

export function closeDoor() {
  const r = getRoot();
  if (!r) return;
  stopIndicator();
  if (current && current.stopCloud) { try { current.stopCloud(); } catch (_) {} }
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  document.removeEventListener('keydown', onKeyDown);
  r.hidden = true;
  r.removeAttribute('aria-modal');
  r.removeAttribute('role');
  r.textContent = '';
  if (unsub) {
    unsub();
    unsub = null;
  }
  const restore = lastFocus;
  current = null;
  lastFocus = null;
  if (restore && restore.focus && restore !== document.body) {
    try { restore.focus(); } catch (_) {}
  }
}

export function isDoorOpen() {
  const r = getRoot();
  return !!r && !r.hidden;
}

export function currentDoor() {
  if (!current) return null;
  return { scene: current.scene, id: current.id };
}
