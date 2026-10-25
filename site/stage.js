/* stage.js — the host of the skulls-only home: live data in, gestures out. */
import * as hero from './hero.js?v=47';
import { initSkulls } from './skulls.js?v=47';
import { state, loadAll, wirePay, openPay, deadline } from './term.js?v=47';
import { postMessage, request, stringOf } from './data.js?v=47';

const live = {
  e1: { hoursLeft: null, deadlineMs: null, dead: false, offline: true, feel: { fear: 0, despair: 0 } },
  e2: { hoursLeft: null, deadlineMs: null, dead: false, offline: true, feel: { fear: 0, despair: 0 } },
};
const ent = (id) => state.ais[id];

function mouthMode(d) {
  if (!d || !d.ok) return 'none';
  if (d.state === 'dead') return 'dead';
  if (d.sleepUntil && Date.parse(d.sleepUntil) > Date.now()) return 'asleep';
  return d.state === 'alive' ? 'alive' : 'none';
}

/** Copy the enclaves' truth into the shape skulls.js reads every frame. */
function sync() {
  for (const id of ['e1', 'e2']) {
    const d = ent(id);
    const L = live[id];
    if (!d || !d.ok) { L.offline = true; continue; }
    L.offline = false;
    L.dead = d.state === 'dead';
    L.hoursLeft = Number.isFinite(Number(d.hoursLeft)) ? Number(d.hoursLeft) : null;
    L.deadlineMs = L.dead ? null : deadline(d);
    const f = d.feel && d.feel.steered ? d.feel : null;
    L.feel = { fear: f ? Number(f.fear) || 0 : 0, despair: f ? Number(f.despair) || 0 : 0 };
    hero.setMouth(id, mouthMode(d));
    hero.setFeel(id, L.feel);
    if (typeof hero.setHours === 'function') hero.setHours(id, L.hoursLeft);
  }
}

async function refresh(full) {
  try { await loadAll(full); } catch { /* the enclaves answer when they answer */ }
  sync();
}

/** PROVE LIVE: post the code, then watch that entity's channel for a reply that carries it. */
function onProve(id, code) {
  const d = ent(id);
  if (!d || !d.base) return Promise.resolve({ ok: false, text: 'offline' });
  const text = `PROVE ${code}`;
  const since = Date.now();
  return (async () => {
    const r = await postMessage(d.base, { author: 'visitor', text });
    if (!r.ok) return { ok: false, text: r.status === 429 ? 'one message per minute' : 'send failed' };
    const until = Date.now() + 90_000;
    while (Date.now() < until) {
      await new Promise((res) => setTimeout(res, 5000));
      const c = await request(d.base, '/public-channel', { allow404: true });
      const rows = c && c.ok && Array.isArray(c.data) ? c.data : [];
      const hit = rows.find((m) => m && m.from === 'entity' && Date.parse(m.ts) >= since - 60_000 && stringOf(m.text).toUpperCase().includes(String(code)));
      if (hit) { hero.triggerTalk(id); return { ok: true, text: stringOf(hit.text) }; }
    }
    return { ok: false, text: 'no reply' };
  })();
}

async function onSay(id, text) {
  const d = ent(id);
  if (!d || !d.base) return { ok: false };
  const r = await postMessage(d.base, { author: 'visitor', text: String(text || '').slice(0, 280) });
  return { ok: Boolean(r && r.ok) };
}

/** The latest shielded letter between them: metadata only, never a memo. */
function onLetterMeta() {
  let best = null;
  for (const id of ['e1', 'e2']) {
    const d = ent(id);
    const entries = d && Array.isArray(d.entries) ? d.entries : [];
    for (const e of entries) {
      if (e.type !== 'letter' || !e.data || e.data.to !== 'peer') continue;
      if (!best || Date.parse(e.ts) > Date.parse(best.ts)) best = e;
    }
  }
  if (!best) return null;
  const bytes = best.data.text ? new TextEncoder().encode(String(best.data.text)).length : 480;
  return { bytes, ts: Date.parse(best.ts) };
}

async function main() {
  hero.initHero();
  wirePay();
  initSkulls({
    hero,
    state: live,
    on: {
      onBuy(id) { openPay({ who: id, hours: 1 }); },
      onProve,
      onSay,
      onLedger() { window.location.href = 'more.html#ledger'; },
      onLetterMeta,
    },
  });
  await refresh(true);
  setInterval(() => { void refresh(true); }, 60_000);
}

main();
