// rent.js — ZEALOT v50 "RENT HAND" state machine.
// Cadence, freshness, receipts, PROVE/SAY correlation, hash checks.
// Imports ONLY term.js?v=88 and data.js?v=88. No canvas. Defensive.
// Ledger fetch throttled: boot, then only on root head change and >=5 min.
// Exports: bootRent, getRentState, subscribeRent, refreshNow, genNonce,
// startProve, say, cancelWait, checkHash, fetchDetail, rentPerHour, receiptsOf, lettersOf.

import {
  state, loadAll, openPay, wirePay, deadline, nameOf, stateWord
} from './term.js?v=88';
import {
  request, postMessage, verifyChain, formatInt, formatZats, fixed8,
  shortHash, hhmm, fmtStamp, stringOf, sha256Hex, parseLedger
} from './data.js?v=88';

const LEDGER_INTERVAL_MS = 5 * 60 * 1000;
const STALE_MS = 95 * 1000;
const SMALL_POLL_MS = 15 * 1000;
const RECONCILE_MS = 60 * 1000;
const WAIT_POLL_MS = 3 * 1000;
const WAIT_TIMEOUT_MS = 120 * 1000;
const DETAIL_CACHE_MS = 60 * 1000;

const IDS = ['e1', 'e2'];

const doc = typeof document !== 'undefined' ? document : null;
const perf = typeof performance !== 'undefined' ? performance : null;
const win = typeof window !== 'undefined' ? window : null;

export const CODE_GUARANTEED = true;   // both CVMs run 8e8b0942, the image the public code builds (2026-10-28 02:50 UTC); both entities are dead
/* the image the public code expects on the CVMs; the deploy commit updates it with the compose files */
export const PENDING_IMAGE = '8e8b0942';

let booted = false;
let bootPromise = null;

let smallTimer = null;
let lastSmallPoll = 0;
let lastReconcile = 0;

let waitTimer = null;
let ledgerFetchInFlight = false;

const subscribers = [];
const detailCache = new Map();

const knownReceiptSeq = { e1: 0, e2: 0 };
const knownPaymentSeq = { e1: 0, e2: 0 };

const wasDead = { e1: false, e2: false };
const wasFresh = { e1: false, e2: false };
const wasOffline = { e1: false, e2: false };

const waits = { e1: null, e2: null };

const appointment = { id: null, at: null, overdue: false, pinned: false };

function now() { return Date.now(); }
function pnow() { return perf ? perf.now() : now(); }

const EMPTY = { e1: { id: 'e1', base: null }, e2: { id: 'e2', base: null } };
/* term.js creates state.ais[id] (with its base) on the first loadAll; before that, a transient placeholder. */
function getEntity(id) {
  if (!state.ais) state.ais = {};
  return state.ais[id] || EMPTY[id];
}

function isFresh(d, t) {
  return !!(d && d.sampleAt && (t - d.sampleAt) < STALE_MS);
}

function isDead(d) {
  if (!d) return false;
  return d.state === 'dead' || d.hoursLeft === 0;
}

function maxPostSeq(posts) {
  if (!Array.isArray(posts)) return 0;
  let m = 0;
  for (const p of posts) {
    if (p && typeof p.seq === 'number' && p.seq > m) m = p.seq;
  }
  return m;
}

function mergeRoot(id, res, t) {
  const d = getEntity(id);
  if (res && res.ok && res.data) {
    const r = res.data;
    d.root = r;
    d.ok = true;
    d.error = null;
    d.at = t;
    if (r.zcash && typeof r.zcash.balance === 'number') d.zats = r.zcash.balance;
    if (r.ledger && r.ledger.head) d.head = r.ledger.head;
    if (typeof r.state === 'string' && !d.state) d.state = r.state;
    if (typeof r.rentZatsPerHour === 'number') d.rentZatsPerHour = r.rentZatsPerHour;
    d.feel = r.feel && typeof r.feel === 'object' ? r.feel : null;
    if (typeof r.entity === 'string' && r.entity) d.name = r.entity;
    if (r.zcash && typeof r.zcash.address === 'string') d.address = r.zcash.address;
    if (r.state === 'dead') { d.state = 'dead'; d.diedAt = r.diedAt || d.diedAt || null; d.hoursLeft = 0; d.zats = 0; }
  } else if (res && !res.ok) {
    d.error = res.error || 'root failed';
  }
}

function mergeVitals(id, res, t) {
  const d = getEntity(id);
  if (res && res.ok && res.data) {
    const v = res.data;
    d.vitals = v;
    d.sampleAt = t;
    d.vitalsError = null;
    if (typeof v.state === 'string') d.state = v.state;
    if (typeof v.hoursLeft === 'number') d.hoursLeft = v.hoursLeft;
    if (typeof v.zatoshis === 'number') d.zats = v.zatoshis;
    if (v.sleepUntil !== undefined) d.sleepUntil = v.sleepUntil;
  } else if (res && !res.ok) {
    d.vitalsError = res.error || 'vitals failed';
  }
}

/* the channel is read incrementally: `?since=<last seq>` asks only for what is new. An enclave image that
   ignores the query sends its last 200 again; merging by seq makes both answers land the same way. */
function channelPath(id) {
  const since = maxPostSeq(getEntity(id).posts);
  return since ? `/public-channel?since=${since}` : '/public-channel';
}

function mergeChannel(id, res) {
  const d = getEntity(id);
  if (!(res && res.ok && Array.isArray(res.data))) return;
  if (!Array.isArray(d.posts) || !d.posts.length) { d.posts = res.data; return; }
  const have = new Set(d.posts.map(p => p && p.seq));
  const fresh = res.data.filter(p => p && typeof p.seq === 'number' && !have.has(p.seq));
  if (fresh.length) d.posts = d.posts.concat(fresh).sort((a, b) => a.seq - b.seq).slice(-200);
}

function emit(event) {
  const s = getRentState();
  const ev = event || { type: 'state' };
  for (let i = 0; i < subscribers.length; i++) {
    try { subscribers[i](s, ev); } catch (e) {}
  }
}

function scheduleSmall() {
  if (smallTimer) { clearTimeout(smallTimer); smallTimer = null; }
  smallTimer = setTimeout(() => {
    smallTimer = null;
    const reconcileDue = (now() - lastReconcile) >= RECONCILE_MS;
    smallPoll(reconcileDue).catch(() => {});
  }, SMALL_POLL_MS);
}

async function fetchLedgerFull(t) {
  if (ledgerFetchInFlight) return;
  ledgerFetchInFlight = true;
  try {
    await loadAll(true);
  } catch (e) {
  } finally {
    for (const id of IDS) {
      const d = getEntity(id);
      d._ledgerLoadedHead = d.head || d._ledgerLoadedHead || '';
      d._lastLedgerFetch = t;
      d.ledgerPending = false;
    }
    ledgerFetchInFlight = false;
    detectReceipts();
    detectPayments();
    updateAppointment(now());
    emit({ type: 'ledger' });
  }
}

function maybeQueueLedger(id, t, force) {
  const d = getEntity(id);
  if (!d.base) return;
  const servedHead = d.root && d.root.ledger && d.root.ledger.head;
  if (!servedHead) return;
  const loadedHead = d._ledgerLoadedHead || '';
  const lastFetch = d._lastLedgerFetch || 0;
  const changed = servedHead !== loadedHead;
  if (changed) {
    const due = force || (t - lastFetch) >= LEDGER_INTERVAL_MS;
    if (due && !ledgerFetchInFlight) {
      d.ledgerPending = true;
      fetchLedgerFull(t).catch(() => {});
    } else {
      d.ledgerPending = true;
    }
  } else {
    d.ledgerPending = false;
  }
}

async function smallPoll(reconcile) {
  const t = now();
  lastSmallPoll = t;

  let forceLedger = false;
  await Promise.all(IDS.map(async (id) => {
    const d = getEntity(id);
    if (!d.base) return;
    const zatsBefore = typeof d.zats === 'number' ? d.zats : null;

    const rootPromise = request(d.base, '/').catch(e => ({ ok: false, error: e && e.message }));
    const vitalsPromise = request(d.base, '/vitals').catch(e => ({ ok: false, error: e && e.message }));
    const channelPromise = request(d.base, channelPath(id)).catch(e => ({ ok: false, error: e && e.message }));

    const [rootRes, vitalsRes, channelRes] = await Promise.all([rootPromise, vitalsPromise, channelPromise]);

    mergeRoot(id, rootRes, t);
    mergeVitals(id, vitalsRes, t);
    mergeChannel(id, channelRes);

    const offline = !rootRes.ok || !vitalsRes.ok;
    d._offline = offline;

    // the rent just left: the treasury dropped by about one hour of rent since the last poll
    const rent = rentPerHour(id);
    if (!offline && zatsBefore != null && typeof d.zats === 'number' && rent && zatsBefore - d.zats >= rent * 0.9) forceLedger = true;
    if (!offline) maybeQueueLedger(id, t, forceLedger);
  }));

  if (reconcile) lastReconcile = t;
  updateLifecycle(t);
  updateAppointment(t);

  emit({ type: 'state' });
  scheduleSmall();
}

function updateLifecycle(t) {
  for (const id of IDS) {
    const d = getEntity(id);
    const fresh = isFresh(d, t);
    const offline = !!d._offline;
    const dead = isDead(d);

    if (!wasDead[id] && dead) {
      wasDead[id] = true;
      emit({ type: 'death', id });
    } else if (wasDead[id] && !dead) {
      wasDead[id] = false;
    }

    if (wasFresh[id] && !fresh && !offline) {
      emit({ type: 'stale', id });
    }
    if (wasOffline[id] && !offline && fresh) {
      emit({ type: 'online', id });
    }

    wasFresh[id] = fresh;
    wasOffline[id] = offline;
  }
}

function updateAppointment(t) {
  if (appointment.pinned && appointment.id) {
    const d = getEntity(appointment.id);
    if (!d || isDead(d) || d._offline || !isFresh(d, t) || !d.lastRent) {
      appointment.pinned = false;
      appointment.overdue = false;
    } else {
      const ms = new Date(d.lastRent.ts).getTime() + 3600000;
      if (!isNaN(ms)) {
        appointment.at = ms;
        appointment.overdue = t >= ms;
        return;
      }
    }
  }

  let best = null;
  for (const id of IDS) {
    const d = getEntity(id);
    if (!d || isDead(d) || d._offline || !isFresh(d, t) || !d.lastRent) continue;
    const ms = new Date(d.lastRent.ts).getTime() + 3600000;
    if (isNaN(ms)) continue;
    if (!best || ms < best.at) best = { id, at: ms };
  }

  if (best) {
    appointment.id = best.id;
    appointment.at = best.at;
    appointment.overdue = t >= best.at;
    appointment.pinned = appointment.overdue;
  } else {
    appointment.id = null;
    appointment.at = null;
    appointment.overdue = false;
    appointment.pinned = false;
  }
}

function detectReceipts() {
  for (const id of IDS) {
    const d = getEntity(id);
    const rents = Array.isArray(d.rents) ? d.rents : [];
    const newOnes = [];
    for (const e of rents) {
      if (e && typeof e.seq === 'number' && e.seq > knownReceiptSeq[id]) {
        newOnes.push(e);
      }
    }
    if (newOnes.length) {
      newOnes.sort((a, b) => a.seq - b.seq);
      knownReceiptSeq[id] = newOnes[newOnes.length - 1].seq;
      const newest = newOnes[newOnes.length - 1];
      if (appointment.pinned && appointment.id === id) {
        appointment.pinned = false;
        appointment.overdue = false;
      }
      emit({ type: 'receipt', id, entry: newest, backlog: newOnes.length > 1 });
    }
  }
}

function detectPayments() {
  for (const id of IDS) {
    const d = getEntity(id);
    const letters = Array.isArray(d.letters) ? d.letters : [];
    const incoming = [];
    for (const e of letters) {
      if (e && e.data && e.data.txid && !e.data.to) incoming.push(e);
    }
    const newOnes = incoming.filter(e => e.seq > knownPaymentSeq[id]).sort((a, b) => a.seq - b.seq);
    if (newOnes.length) {
      knownPaymentSeq[id] = newOnes[newOnes.length - 1].seq;
      emit({ type: 'payment', id, entry: newOnes[newOnes.length - 1], backlog: newOnes.length > 1 });
    }
  }
}

function scheduleWaitPoll() {
  if (waitTimer) return;
  const active = IDS.some(id => {
    const w = waits[id];
    return w && (w.status === 'sending' || w.status === 'pending' || w.status === 'timeout');
  });
  if (!active) return;
  waitTimer = setTimeout(() => {
    waitTimer = null;
    runWaitPoll().catch(() => {});
  }, WAIT_POLL_MS);
}

function processWait(id, tPerf) {
  const w = waits[id];
  if (!w) return true;
  const d = getEntity(id);
  const posts = Array.isArray(d.posts) ? d.posts : [];

  if (w.kind === 'prove') {
    const nonce = w.nonce;
    let found = null;
    let correlated = false;
    // 1. the entity's reply to OUR message (replyTo carries the human seq) — the honest correlation
    if (w.ourSeq) {
      for (const p of posts) {
        if (!p || p.from !== 'entity') continue;
        const rt = p.replyTo;
        if ((Array.isArray(rt) && rt.includes(w.ourSeq)) || (typeof rt === 'number' && rt === w.ourSeq)) { found = p; correlated = true; break; }
      }
    }
    // 2. otherwise any entity message after ours that carries the code (older enclave images did not set replyTo)
    if (!found) {
      for (const p of posts) {
        if (!p || typeof p.seq !== 'number' || p.seq <= w.baselineSeq || p.from !== 'entity') continue;
        if (typeof p.text === 'string' && p.text.toUpperCase().includes(nonce)) { found = p; correlated = true; break; }
      }
    }
    // 3. otherwise the first entity message after ours: shown as the latest channel reply, never as ours
    if (!found) {
      for (const p of posts) {
        if (!p || typeof p.seq !== 'number' || p.seq <= w.baselineSeq || p.from !== 'entity') continue;
        const pts = p.ts ? new Date(p.ts).getTime() : 0;
        if (pts && pts >= w.startMs) { found = p; correlated = false; break; }
      }
    }
    if (found) {
      w.reply = found.text;
      w.replyTs = found.ts || null;
      w.replySeq = found.seq;
      w.correlated = correlated;
      const trimmed = (found.text || '').trim().toUpperCase();
      w.status = trimmed.startsWith(`CODE ${nonce}`) ? 'match' : 'nomatch';
      emit({ type: 'reply', id, wait: w });
      return true;
    }
  } else if (w.kind === 'say') {
    let found = null;
    if (w.ourSeq) {
      for (const p of posts) {
        if (!p || p.from !== 'entity') continue;
        const rt = p.replyTo;
        if (Array.isArray(rt) && rt.includes(w.ourSeq)) { found = p; break; }
        if (typeof rt === 'number' && rt === w.ourSeq) { found = p; break; }
      }
    }
    if (!found) {
      for (const p of posts) {
        if (!p || typeof p.seq !== 'number' || p.seq <= w.baselineSeq || p.from !== 'entity') continue;
        const pts = p.ts ? new Date(p.ts).getTime() : 0;
        if (pts && pts >= w.startMs) { found = p; break; }
      }
    }
    if (found) {
      w.reply = found.text;
      w.replyTs = found.ts || null;
      w.replySeq = found.seq;
      w.status = 'reply';
      emit({ type: 'reply', id, wait: w });
      return true;
    }
  }

  if (w.status === 'pending' && (tPerf - w.since) > WAIT_TIMEOUT_MS) {
    w.status = 'timeout';
    emit({ type: 'reply', id, wait: w });
  }
  return false;
}

async function runWaitPoll() {
  const activeIds = IDS.filter(id => {
    const w = waits[id];
    return w && (w.status === 'sending' || w.status === 'pending' || w.status === 'timeout');
  });
  if (!activeIds.length) return;

  const tPerf = pnow();
  const t = now();

  await Promise.all(activeIds.map(async (id) => {
    const d = getEntity(id);
    if (!d.base) return;
    const [chanRes, rootRes] = await Promise.all([
      request(d.base, channelPath(id)).catch(() => ({ ok: false })),
      request(d.base, '/').catch(() => ({ ok: false }))
    ]);
    mergeChannel(id, chanRes);
    mergeRoot(id, rootRes, t);
    if (!processWait(id, tPerf)) scheduleWaitPoll();
  }));
}

function makeWait(kind, id, text, nonce) {
  const d = getEntity(id);
  const baseline = maxPostSeq(d.posts);
  return {
    kind,
    nonce: nonce || null,
    text: text || null,
    since: pnow(),
    startMs: now(),
    status: 'sending',
    reply: null,
    replyTs: null,
    replySeq: null,
    error: null,
    baselineSeq: baseline,
    ourSeq: null,
    correlated: false
  };
}

function lockReason(id) {
  const d = getEntity(id);
  const t = now();
  const offline = !!d._offline;
  const fresh = isFresh(d, t);
  const stale = !offline && !fresh && !!d.sampleAt;
  const dead = isDead(d);
  if (dead) return 'DEAD';
  if (offline) return 'OFFLINE';
  if (stale) return 'DATA STALE';
  return 'LOCKED';
}

function isLocked(id) {
  const d = getEntity(id);
  const t = now();
  const offline = !!d._offline;
  const fresh = isFresh(d, t);
  const stale = !offline && !fresh && !!d.sampleAt;
  return isDead(d) || offline || stale;
}

export function genNonce() {
  const a = new Uint16Array(1);
  crypto.getRandomValues(a);
  return String(a[0] % 10000).padStart(4, '0');
}

export async function startProve(id, nonce) {
  if (!IDS.includes(id)) throw new Error('unknown entity');
  if (!nonce || !/^\d{4}$/.test(nonce)) throw new Error('bad nonce');
  if (isLocked(id)) throw new Error(lockReason(id));
  const d = getEntity(id);
  const w = makeWait('prove', id, null, nonce);
  waits[id] = w;
  emit({ type: 'reply', id, wait: w });
  scheduleWaitPoll();

  let res;
  try {
    res = await postMessage(d.base, { author: 'visitor', text: `PROVE ${nonce}` });
  } catch (e) {
    w.status = 'error';
    w.error = e && e.message ? e.message : 'post failed';
    emit({ type: 'reply', id, wait: w });
    throw e;
  }

  if (!res || !res.ok) {
    w.status = 'error';
    w.error = (res && res.error) || 'post rejected';
    emit({ type: 'reply', id, wait: w });
    throw new Error(w.error);
  }

  w.status = 'pending';
  w.ourSeq = (res.data && typeof res.data.seq === 'number') ? res.data.seq : null;
  emit({ type: 'reply', id, wait: w });
  scheduleWaitPoll();
  return w;
}

export async function say(id, text) {
  if (!IDS.includes(id)) throw new Error('unknown entity');
  if (!text || typeof text !== 'string') throw new Error('empty text');
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > 500) throw new Error('message too long');
  if (isLocked(id)) throw new Error(lockReason(id));

  const d = getEntity(id);
  const w = makeWait('say', id, text, null);
  waits[id] = w;
  emit({ type: 'reply', id, wait: w });
  scheduleWaitPoll();

  let res;
  try {
    res = await postMessage(d.base, { author: 'visitor', text });
  } catch (e) {
    w.status = 'error';
    w.error = e && e.message ? e.message : 'post failed';
    emit({ type: 'reply', id, wait: w });
    throw e;
  }

  if (!res || !res.ok) {
    w.status = 'error';
    w.error = (res && res.error) || 'post rejected';
    emit({ type: 'reply', id, wait: w });
    throw new Error(w.error);
  }

  w.status = 'pending';
  w.ourSeq = (res.data && typeof res.data.seq === 'number') ? res.data.seq : null;
  emit({ type: 'reply', id, wait: w });
  scheduleWaitPoll();
  return w;
}

export function cancelWait(id) {
  if (!waits[id]) return;
  waits[id] = null;
  emit({ type: 'reply', id, wait: null });
}

export function subscribeRent(fn) {
  if (typeof fn !== 'function') return () => {};
  subscribers.push(fn);
  try { fn(getRentState(), { type: 'state' }); } catch (e) {}
  return () => {
    const i = subscribers.indexOf(fn);
    if (i >= 0) subscribers.splice(i, 1);
  };
}

export function getRentState() {
  const t = now();
  const e1 = buildView('e1', t);
  const e2 = buildView('e2', t);

  const bothDead = e1.dead && e2.dead;
  const anyOnline = e1.ok || e2.ok;

  let reduced = false;
  if (win && win.matchMedia) {
    reduced = win.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  return {
    at: t,
    booted,
    anyOnline,
    bothDead,
    reduced,
    e1,
    e2,
    appointment: {
      id: appointment.id,
      at: appointment.at,
      overdue: appointment.overdue,
      pinned: appointment.pinned
    },
    wait: { e1: waits.e1, e2: waits.e2 }
  };
}

function buildView(id, t) {
  const d = getEntity(id);
  const sampleAt = d.sampleAt || null;
  const offline = !!d._offline;
  const fresh = !offline && isFresh(d, t);
  const stale = !offline && !fresh && sampleAt !== null;
  const dead = isDead(d);
  const asleep = !!d.sleepUntil && new Date(d.sleepUntil).getTime() > t;

  const hoursLeft = typeof d.hoursLeft === 'number' ? d.hoursLeft : null;
  const zats = typeof d.zats === 'number' ? d.zats : null;
  const rentZats = rentPerHour(id);
  const lastRent = d.lastRent || null;

  let nextRentMs = null;
  if (lastRent && lastRent.ts) {
    const m = new Date(lastRent.ts).getTime();
    if (!isNaN(m)) nextRentMs = m + 3600000;
  }

  let deadlineMs = null;
  if (fresh && !dead) {
    try { deadlineMs = deadline(d); } catch (e) { deadlineMs = null; }
  }

  const feel = d.feel || null;
  const head = d.head || '';
  const ledgerCount = typeof d.count === 'number' ? d.count : (Array.isArray(d.entries) ? d.entries.length : 0);
  const ledgerLoadedHead = d._ledgerLoadedHead || head || '';
  const ledgerPending = !!d.ledgerPending;
  const locked = dead || offline || stale;

  return {
    id,
    name: id === 'e1' ? 'WICK' : 'OBOL',
    base: d.base || null,
    address: d.address || '',
    ok: !!d.ok,
    offline,
    fresh,
    stale,
    sampleAt,
    dead,
    deathObservedAt: dead ? (d.diedAt ? new Date(d.diedAt).getTime() : t) : null,
    asleep,
    hoursLeft,
    zats,
    rentZats,
    deadlineMs,
    feel: feel ? {
      fear: typeof feel.fear === 'number' ? feel.fear : 0,
      despair: typeof feel.despair === 'number' ? feel.despair : 0,
      acting: feel.acting || null,
      steered: !!feel.steered
    } : null,
    lastRent,
    nextRentMs,
    head,
    ledgerCount,
    ledgerLoadedHead,
    ledgerPending,
    locked,
    posts: Array.isArray(d.posts) ? d.posts.slice() : []
  };
}

export function refreshNow(reason) {
  if (smallTimer) { clearTimeout(smallTimer); smallTimer = null; }
  const reconcileDue = (now() - lastReconcile) >= RECONCILE_MS;
  return smallPoll(reconcileDue);
}

function onVisibility() {
  if (!doc || doc.hidden) return;
  refreshNow('visible').catch(() => {});
}

export function bootRent() {
  if (booted || bootPromise) return;
  if (doc) {
    doc.addEventListener('visibilitychange', onVisibility, { passive: true });
  }
  bootPromise = (async () => {
    // 1. the light reads (root, vitals, channel) so the first numbers exist within a second
    try {
      await loadAll(false);
      const t0 = now();
      for (const id of IDS) {
        const d = getEntity(id);
        if (d.vitals) d.sampleAt = t0;
        d._offline = !d.ok;
      }
      booted = true;
      updateLifecycle(t0);
      emit({ type: 'state' });
    } catch (e) {}
    // 2. the two ledgers (2.7 MB each): receipts, letters, shop, head baseline
    try {
      await loadAll(true);
      const t = now();
      for (const id of IDS) {
        const d = getEntity(id);
        d._ledgerLoadedHead = d.head || '';
        d._lastLedgerFetch = t;
        d.ledgerPending = false;
        const rents = Array.isArray(d.rents) ? d.rents : [];
        knownReceiptSeq[id] = rents.reduce((m, e) => Math.max(m, e && e.seq ? e.seq : 0), 0);
        const inc = Array.isArray(d.letters)
          ? d.letters.filter(e => e && e.data && e.data.txid && !e.data.to)
          : [];
        knownPaymentSeq[id] = inc.reduce((m, e) => Math.max(m, e && e.seq ? e.seq : 0), 0);
        wasFresh[id] = isFresh(d, t);
        wasOffline[id] = !!d._offline;
        wasDead[id] = isDead(d);
      }
      detectReceipts();
      detectPayments();
      updateAppointment(t);
      emit({ type: 'ledger' });
    } catch (e) {}
    booted = true;
    await smallPoll(true).catch(() => {});
  })();
}

/** Whether this head answers a free public message at once: its own reply status (GET /) against its hours left.
 *  minHoursLeft comes from the enclave when it publishes it; older images do not, and theirs is 24. */
export function replyGate(id) {
  const d = getEntity(id);
  const r = d.root && d.root.reply && typeof d.root.reply === 'object' ? d.root.reply : null;
  const hours = typeof d.hoursLeft === 'number' ? d.hoursLeft : null;
  const minHours = r && typeof r.minHoursLeft === 'number' ? r.minHoursLeft : 24;
  const enabled = r ? r.enabled !== false : null;
  const instant = enabled == null || hours == null ? null : (enabled && hours >= minHours);
  return { enabled, minHours, hours, instant, lastReplyTs: r ? r.lastReplyTs || null : null };
}

export function rentPerHour(id) {
  const d = getEntity(id);
  if (d.root && typeof d.root.rentZatsPerHour === 'number') return d.root.rentZatsPerHour;
  if (d.lastRent && d.lastRent.data && typeof d.lastRent.data.rentZats === 'number') return d.lastRent.data.rentZats;
  return null;
}

/** The last n ledger entries of an entity (seq, ts, type, data), oldest first. */
export function entriesOf(id, n = 400) {
  const d = getEntity(id);
  const E = Array.isArray(d.entries) ? d.entries : [];
  return E.slice(-n);
}

export function receiptsOf(id) {
  const d = getEntity(id);
  return Array.isArray(d.rents) ? d.rents.slice() : [];
}

export function lettersOf(id) {
  const d = getEntity(id);
  const all = Array.isArray(d.letters) ? d.letters : [];
  const incoming = [];
  const outgoing = [];
  const peer = [];
  for (const e of all) {
    if (!e || !e.data) continue;
    if (e.data.to) {
      outgoing.push(e);
      if (e.data.to === 'peer') peer.push(e);
    } else if (e.data.txid) {
      incoming.push(e);
    }
  }
  return { incoming, outgoing, peer };
}

/* Peer letters as both ledgers record them: the sender's `letter {to:'peer', zats, text?}` (the memo text is
 * public there when the enclave logged it) and the receiver's `letter {zats, bytes, txid}` (no text). */
function latestPeerLetterMeta() {
  const all = [];
  for (const id of IDS) {
    const L = lettersOf(id);
    for (const e of L.peer) all.push({ ...e, from: id, side: 'sent' });
    for (const e of L.incoming) all.push({ ...e, from: id === 'e1' ? 'e2' : 'e1', to: id, side: 'received' });
  }
  all.sort((a, b) => {
    const ta = a.ts ? new Date(a.ts).getTime() : 0;
    const tb = b.ts ? new Date(b.ts).getTime() : 0;
    return ta - tb;
  });
  const latest = all[all.length - 1] || null;
  // the same letter as both ledgers saw it: a `sent` entry within 15 minutes before a `received` one
  let pair = null;
  if (latest && latest.side === 'received') {
    const tr = new Date(latest.ts).getTime();
    pair = all.filter((e) => e.side === 'sent' && e.from === latest.from && tr - new Date(e.ts).getTime() >= 0 && tr - new Date(e.ts).getTime() < 15 * 60 * 1000).pop() || null;
  } else if (latest && latest.side === 'sent') {
    const ts = new Date(latest.ts).getTime();
    pair = all.filter((e) => e.side === 'received' && e.from === latest.from && new Date(e.ts).getTime() - ts >= 0 && new Date(e.ts).getTime() - ts < 15 * 60 * 1000).pop() || null;
  }
  return { all, latest, pair };
}

export async function checkHash(id) {
  const d = getEntity(id);
  if (!d.base) {
    return { ok: false, valid: 0, total: 0, computedHead: '', servedHead: '', match: false, headChanged: false, fail: null, reason: 'no base', at: now() };
  }
  const [ledgerRes, rootRes] = await Promise.all([
    request(d.base, '/ledger', { text: true }).catch(e => ({ ok: false, error: e && e.message })),
    request(d.base, '/').catch(e => ({ ok: false, error: e && e.message }))
  ]);

  if (rootRes && rootRes.ok && rootRes.data) mergeRoot(id, rootRes, now());

  if (!rootRes || !rootRes.ok) {
    return { ok: false, valid: 0, total: 0, computedHead: '', servedHead: '', match: false, headChanged: false, fail: null, reason: rootRes && rootRes.error ? rootRes.error : 'root failed', at: now() };
  }
  if (!ledgerRes || !ledgerRes.ok || !ledgerRes.text) {
    return { ok: false, valid: 0, total: 0, computedHead: '', servedHead: '', match: false, headChanged: false, fail: null, reason: ledgerRes && ledgerRes.error ? ledgerRes.error : 'ledger failed', at: now() };
  }

  const servedHead = rootRes.data.ledger && rootRes.data.ledger.head ? rootRes.data.ledger.head : '';
  const verify = await verifyChain(ledgerRes.text, { animate: false });
  const computedHead = verify.head || '';
  const match = !!(verify.ok && computedHead && servedHead && computedHead === servedHead);
  const headChanged = servedHead !== (d._ledgerLoadedHead || '');

  return {
    ok: !!verify.ok,
    valid: typeof verify.valid === 'number' ? verify.valid : 0,
    total: typeof verify.total === 'number' ? verify.total : 0,
    computedHead,
    servedHead,
    match,
    headChanged,
    fail: verify.fail || null,
    reason: verify.reason || null,
    at: now()
  };
}

export async function fetchDetail(kind, id) {
  const key = `${kind}:${id}`;
  const t = now();
  const cached = detailCache.get(key);
  if (cached && (t - cached.at) < DETAIL_CACHE_MS) return cached.value;

  const d = getEntity(id);
  let result;
  if (!d.base) return { ok: false, at: t, error: 'not booted yet' };   // before the first loadAll there is no endpoint to ask

  switch (kind) {
    case 'vitals': {
      if (!d.root && !d.vitals) {
        result = { ok: false, at: t, error: 'no vitals yet' };
      } else {
        result = { ok: true, at: t, data: { root: d.root || null, vitals: d.vitals || null } };
      }
      break;
    }
    case 'dose': {
      const entries = Array.isArray(d.entries)
        ? d.entries.filter(e => e && e.type === 'feel').slice(-20)
        : [];
      result = { ok: true, at: t, data: { feel: d.feel || null, entries } };
      break;
    }
    case 'receipts': {
      result = { ok: true, at: t, data: receiptsOf(id) };
      break;
    }
    case 'letter': {
      const meta = latestPeerLetterMeta();
      result = { ok: true, at: t, data: meta };
      break;
    }
    case 'testament': {
      const res = await request(d.base, '/pages/testament', { text: true, allow404: true }).catch(e => ({ ok: false, error: e && e.message }));
      result = res.ok ? { ok: true, at: t, text: res.text || '' } : { ok: false, at: t, error: res.error || 'testament failed' };
      break;
    }
    case 'pages': {
      const res = await request(d.base, '/pages', { allow404: true }).catch(e => ({ ok: false, error: e && e.message }));
      result = res.ok ? { ok: true, at: t, data: res.data || null } : { ok: false, at: t, error: res.error || 'pages failed' };
      break;
    }
    default: {
      if (kind.startsWith('page:')) {
        const slug = kind.slice(5);
        if (!slug || /[\/\\]/.test(slug)) {
          result = { ok: false, at: t, error: 'bad slug' };
        } else {
          const res = await request(d.base, `/pages/${slug}`, { text: true, allow404: true }).catch(e => ({ ok: false, error: e && e.message }));
          result = res.ok ? { ok: true, at: t, text: res.text || '' } : { ok: false, at: t, error: res.error || 'page failed' };
        }
      } else {
        result = null;
      }
    }
  }

  const ledgerKinds = kind === 'letter' || kind === 'dose' || kind === 'receipts';
  if (result) {
    if (!(ledgerKinds && !(Array.isArray(d.entries) && d.entries.length))) detailCache.set(key, { at: t, value: result });
    return result;
  }

  switch (kind) {
    case 'pact': {
      const entries = Array.isArray(d.entries)
        ? d.entries.filter(e => e && e.type === 'will')
        : [];
      result = { ok: true, at: t, data: entries };
      break;
    }
    case 'forecasts': {
      const res = await request(d.base, '/forecasts', { allow404: true }).catch(e => ({ ok: false, error: e && e.message }));
      const score = d.root && d.root.forecasts && d.root.forecasts.score ? d.root.forecasts.score : null;
      result = res.ok
        ? { ok: true, at: t, data: { score, forecasts: res.data || null } }
        : { ok: false, at: t, error: res.error || 'forecasts failed' };
      break;
    }
    case 'memory': {
      const res = await request(d.base, '/memory-public', { allow404: true }).catch(e => ({ ok: false, error: e && e.message }));
      result = res.ok ? { ok: true, at: t, data: res.data || null } : { ok: false, at: t, error: res.error || 'memory failed' };
      break;
    }
    case 'trades': {
      const res = await request(d.base, '/trades', { allow404: true }).catch(e => ({ ok: false, error: e && e.message }));
      result = res.ok ? { ok: true, at: t, data: res.data || null } : { ok: false, at: t, error: res.error || 'trades failed' };
      break;
    }
    case 'nostr': {
      const entries = Array.isArray(d.entries)
        ? d.entries.filter(e => e && e.type === 'post_nostr')
        : [];
      result = { ok: true, at: t, data: { entries, nostr: d.root && d.root.nostr ? d.root.nostr : null } };
      break;
    }
    case 'attestation': {
      const res = await request(d.base, '/attestation', { allow404: true }).catch(e => ({ ok: false, error: e && e.message }));
      result = res.ok
        ? { ok: true, at: t, data: { attestation: d.root && d.root.attestation ? d.root.attestation : null, quote: res.data || null } }
        : { ok: false, at: t, error: res.error || 'attestation failed' };
      break;
    }
    case 'shop': {
      result = { ok: true, at: t, data: Array.isArray(d.shop) ? d.shop.slice() : [] };
      break;
    }
  }

  if (!result) result = { ok: false, at: t, error: `unknown kind ${kind}` };
  const ledgerKinds2 = kind === 'pact' || kind === 'nostr';
  if (!(ledgerKinds2 && !(Array.isArray(d.entries) && d.entries.length))) detailCache.set(key, { at: t, value: result });
  return result;
}
