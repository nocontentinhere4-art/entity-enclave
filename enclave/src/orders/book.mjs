// Paid order fulfilment (capability D): a shielded letter whose memo matches an active paywall item becomes
// a paid order with a public deadline. The ledger records money and state transitions (`order_received`,
// `order_delivered`, `order_refused`, `order_expired`) — never the memo text. The private request text lives
// only in the encrypted memory store, capped, keyed by order id.
//
// Enforced in code, not by prompt: only a `post_public` entry whose body references the orderId can mark an
// order delivered; nothing the model says can close an order any other way. Memos that start with `buy `/
// `sell ` are reserved for the trade engine and are never orders.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

const HOUR_MS = 3_600_000;
const MAX_ITEM_CHARS = 80;
// Documented memo contract, published at /paywall and in the entity context.
export const PAYWALL_MEMO_FORMAT = 'ORDER <item>\n<request>';

function err(code, msg) { const e = new Error(msg); e.code = code; return e; }
function round2(n) { return Math.round(Number(n) * 100) / 100; }

/** Normalise an item name: trim, lowercase, collapse whitespace. This is how both sides spell it. */
export function normalizeItem(s) {
  return String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, MAX_ITEM_CHARS);
}

/** Collapse text for matching: lowercase and whitespace only, full length. */
function normText(s) { return String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' '); }

/**
 * Parse a letter memo into its kind:
 *  - `{ reserved }`      the memo starts with `buy ` / `sell ` (trade engine territory; never an order)
 *  - `{ explicitOrder, item, request }`  the documented `ORDER <item>` contract; request is null when absent
 *  - `{ plain }`         an ordinary letter (may still name a paywall item, see Orders.onLetter)
 */
export function parseOrderMemo(text) {
  const memo = String(text ?? '').replace(/\r/g, '');
  const firstLine = (memo.split('\n', 1)[0] ?? '').trim();
  if (/^(buy|sell)[ \t]/i.test(firstLine)) return { reserved: firstLine.toLowerCase().split(/\s/, 1)[0] };
  const m = /^order[ \t]+(.+)$/i.exec(firstLine);
  if (m) {
    const rest = memo.slice(memo.indexOf(firstLine) + firstLine.length);
    return { explicitOrder: true, item: normalizeItem(m[1]), request: rest.trim() || null };
  }
  return { plain: memo.trim() };
}

/** True when the memo text mentions the item on word-ish boundaries. */
function mentions(text, item) {
  if (!item) return false;
  const esc = item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`).test(normText(text));
}

/** Public entries of the given types, tolerant of a torn tail (same policy as the Ledger itself).
 *  Works with the on-disk Ledger and with test doubles that expose their entries array. */
function publicEntries(ledger, types = null) {
  let all = null;
  if (Array.isArray(ledger?.entries)) all = ledger.entries;
  else if (ledger?.path && existsSync(ledger.path)) {
    all = [];
    for (const line of readFileSync(ledger.path, 'utf8').split('\n')) {
      if (!line) continue;
      let e; try { e = JSON.parse(line); } catch { continue; } // torn tail: dropped, never fatal
      all.push(e);
    }
  } else return [];
  const want = types ? new Set(types) : null;
  return all.filter((e) => e && !e.private && (!want || want.has(e.type)));
}

export class Orders {
  constructor({ ledger, memory = null, config = {}, now = () => Date.now() }) {
    this.ledger = ledger;
    this.memory = memory; // encrypted MemoryStore; null keeps the request text unavailable (orders still work)
    this.config = config;
    this.now = now;
  }

  #scan(types) { return publicEntries(this.ledger, types); }

  #id(seq, item) {
    return 'o' + createHash('sha256').update(String(seq)).update(':').update(String(item)).digest('hex').slice(0, 12);
  }

  #deadlineHours() { return Math.max(0, Number(this.config.orderDeadlineHours ?? 24)) || 24; }
  #graceHours() { return Math.max(0, Number(this.config.orderGraceHours ?? 6)); }

  /** Active paywall items: the latest `paywall` entry per item wins; `priceZats: 0` disables the item. */
  items() {
    const byItem = new Map();
    for (const e of this.#scan(['paywall'])) {
      const item = normalizeItem(e.data?.item);
      if (!item) continue;
      const priceZats = Number(e.data?.priceZats);
      byItem.set(item, { item, priceZats: Number.isFinite(priceZats) && priceZats > 0 ? Math.floor(priceZats) : 0, updatedAt: e.ts });
    }
    return [...byItem.values()].filter((i) => i.priceZats > 0);
  }

  #receivedById() {
    const map = new Map();
    for (const e of this.#scan(['order_received'])) if (e.data?.id) map.set(e.data.id, e);
    return map;
  }

  /** Orders still owed: received, never delivered/refused/expired, soonest deadline first. */
  pending(now = this.now()) {
    const closed = this.#terminalIds();
    const out = [];
    for (const [, e] of this.#receivedById()) {
      if (closed.has(e.data.id)) continue;
      out.push({ ...e.data, overdue: Date.parse(e.data.deadlineTs) <= now });
    }
    return out.sort((a, b) => Date.parse(a.deadlineTs) - Date.parse(b.deadlineTs));
  }

  #terminalIds() {
    const closed = new Set();
    for (const e of this.#scan(['order_delivered', 'order_refused', 'order_expired'])) if (e.data?.id) closed.add(e.data.id);
    return closed;
  }

  /** The order must still be deliverable: open, and inside deadline + grace. Registry delivery path calls
   *  this before wasting a public post on a closed order. */
  assertOpen(id, now = this.now()) {
    const e = this.#receivedById().get(String(id ?? ''));
    if (!e) throw err('unknown_order', `unknown order: ${id}`);
    const closed = this.#scan(['order_delivered', 'order_refused', 'order_expired']).filter((c) => c.data?.id === e.data.id).at(-1);
    if (closed) {
      if (closed.type === 'order_expired') throw err('order_expired', `order ${id} expired at ${closed.data?.expiredAt}`);
      throw err('order_not_open', `order ${id} is already ${closed.type}`);
    }
    if (Date.parse(e.data.deadlineTs) + this.#graceHours() * HOUR_MS < now) {
      throw err('order_expired', `order ${id} is past its deadline + grace`);
    }
    return e.data;
  }

  /**
   * Feed one letter (its public `letter` entry seq) through the matching rules:
   *  - explicit `ORDER <item>` contract: unknown item / empty request / underpaid are refused in public
   *  - otherwise an ordinary letter that names an active item (longest, most specific match) is an order too
   *  - `buy `/`sell ` memos belong to the trade engine and are skipped (null)
   *  - a letter matching nothing is just a letter (null)
   * Idempotent by letterSeq: replaying the same letter never double-counts.
   */
  async onLetter({ seq, txid = null, zats = 0, text = '', at = null }) {
    const memo = parseOrderMemo(text);
    if (memo.reserved) return null;

    // Replay safety: this letter already produced an order or a refusal.
    const seen = this.#scan(['order_received', 'order_refused']).filter((e) => e.data?.letterSeq === seq).at(-1);
    if (seen) return seen.type === 'order_received' ? { status: 'received', order: seen.data } : { status: 'refused', refusal: seen.data };

    const items = this.items();
    let item = null, request = null, itemRaw = null;

    if (memo.explicitOrder) {
      itemRaw = memo.item;
      item = items.find((i) => i.item === memo.item) ?? null;
      if (!item) return this.#refuse({ seq, zats, item: itemRaw, reason: 'unknown_item' });
      if (!memo.request) return this.#refuse({ seq, zats, item: item.item, reason: 'empty_request' });
      request = memo.request;
    } else {
      item = items.filter((i) => mentions(memo.plain, i.item)).sort((a, b) => b.item.length - a.item.length)[0] ?? null;
      if (!item) return null; // no match, no contract: an ordinary letter
      request = memo.plain;   // the whole memo is the request
    }

    const amount = Math.floor(Number(zats)) || 0;
    if (amount < item.priceZats) return this.#refuse({ seq, zats, item: item.item, priceZats: item.priceZats, reason: 'underpaid' });
    if (this.pending().length >= Math.max(0, Math.floor(Number(this.config.orderMaxOpen ?? 10)))) {
      return this.#refuse({ seq, zats, item: item.item, priceZats: item.priceZats, reason: 'too_many_orders' });
    }

    const now = this.now();
    const receivedAt = new Date(now).toISOString();
    const order = {
      id: this.#id(seq, item.item),
      letterSeq: seq,
      item: item.item,
      zats: amount,
      priceZats: item.priceZats,
      overpaidZats: Math.max(0, amount - item.priceZats),
      letterAt: at ?? receivedAt,  // chain time
      receivedAt,                  // discovery time: the deadline starts when the order became visible
      deadlineTs: new Date(now + this.#deadlineHours() * HOUR_MS).toISOString(),
      txid: txid ?? null,
    };
    this.ledger.append('order_received', order);
    await this.#rememberRequest(order.id, request);
    return { status: 'received', order, request };
  }

  #refuse({ seq, zats, item, reason, priceZats = null }) {
    const refusal = {
      id: this.#id(seq, item),
      letterSeq: seq,
      item,
      zats: Math.floor(Number(zats)) || 0,
      priceZats,
      reason,
      refusedAt: new Date(this.now()).toISOString(),
    };
    this.ledger.append('order_refused', refusal);
    return { status: 'refused', refusal };
  }

  /** Deliver a paid order. `postEntry` must be the real `post_public` ledger entry whose data references
   *  this orderId — verified again against the chain: code, not prompt, enforces public delivery. */
  async deliver(id, postEntry, at = null) {
    id = String(id ?? '');
    const received = this.#receivedById().get(id)?.data;
    if (!received) throw err('unknown_order', `unknown order: ${id}`);

    const already = this.#scan(['order_delivered']).filter((e) => e.data?.id === id).at(-1);
    if (already) return { ...already.data, idempotent: true }; // replay of the same delivery: one entry ever
    const closed = this.#scan(['order_refused', 'order_expired']).filter((e) => e.data?.id === id).at(-1);
    if (closed) throw err(closed.type === 'order_expired' ? 'order_expired' : 'order_not_open', `order ${id} is closed`);

    const seq = Number(postEntry?.seq);
    const onChain = publicEntries(this.ledger).find((e) => e.seq === seq);
    if (!postEntry || postEntry.type !== 'post_public' || !onChain
      || onChain.type !== 'post_public' || onChain.data?.orderId !== id
      || postEntry.data?.orderId !== id) {
      throw err('not_the_post', `seq ${seq} is not a post_public referencing order ${id}`);
    }

    const deliveredAt = new Date(at ?? this.now()).toISOString();
    const delivery = { id, answerPostSeq: seq, deliveredAt, onTime: Date.parse(deliveredAt) <= Date.parse(received.deadlineTs) };
    this.ledger.append('order_delivered', delivery);
    await this.#forgetRequest(id);
    return delivery;
  }

  /** Publicly refuse an order the entity cannot or will not fulfil. The record is public on purpose. */
  async refuse(id, reason) {
    id = String(id ?? '');
    const received = this.#receivedById().get(id)?.data;
    if (!received) throw err('unknown_order', `unknown order: ${id}`);
    if (this.#terminalIds().has(id)) throw err('order_not_open', `order ${id} is already closed`);
    const refusal = {
      id,
      letterSeq: received.letterSeq,
      item: received.item,
      zats: received.zats,
      priceZats: received.priceZats,
      reason: String(reason ?? '').trim().slice(0, 200) || 'cannot_fulfil',
      refusedAt: new Date(this.now()).toISOString(),
    };
    this.ledger.append('order_refused', refusal);
    await this.#forgetRequest(id);
    return refusal;
  }

  /** Close every open order whose deadline + grace has passed. Idempotent: an already-closed order is skipped. */
  expireDue(now = this.now()) {
    const grace = this.#graceHours() * HOUR_MS;
    const closed = this.#terminalIds();
    const expired = [];
    for (const [, e] of this.#receivedById()) {
      if (closed.has(e.data.id)) continue;
      if (Date.parse(e.data.deadlineTs) + grace < now) {
        const entry = { id: e.data.id, reason: 'deadline', deadlineTs: e.data.deadlineTs, expiredAt: new Date(now).toISOString() };
        this.ledger.append('order_expired', entry);
        expired.push(e.data.id);
      }
    }
    return expired;
  }

  /** Boot recovery: a post answered an order but the process died before `order_delivered` was appended. */
  async reconcile(now = this.now()) {
    const open = new Set(this.pending(now).map((o) => o.id));
    const delivered = new Set(this.#scan(['order_delivered']).map((e) => e.data?.id));
    let n = 0;
    for (const e of this.#scan(['post_public'])) {
      const id = e.data?.orderId;
      if (!id || !open.has(id) || delivered.has(id)) continue;
      try { await this.deliver(id, e, e.ts ?? now); n++; } catch { /* this post does not close that order */ }
    }
    return n;
  }

  /** Fulfilment record. Round percentages and hours to 2 decimals; null until the first delivery exists. */
  stats(now = this.now()) {
    const receivedE = this.#scan(['order_received']);
    const deliveredE = this.#scan(['order_delivered']);
    const refusedE = this.#scan(['order_refused']);
    const expiredE = this.#scan(['order_expired']);
    const byId = new Map(receivedE.map((e) => [e.data.id, e.data]));
    const itemOf = (id) => byId.get(id)?.item ?? null;
    const hours = deliveredE.map((e) => {
      const r = byId.get(e.data.id)?.receivedAt;
      const ms = Date.parse(e.data.deliveredAt) - (r ? Date.parse(r) : NaN);
      return Number.isFinite(ms) && ms >= 0 ? ms / HOUR_MS : null;
    }).filter((h) => h !== null).sort((a, b) => a - b);
    const medianHours = hours.length
      ? round2(hours.length % 2 ? hours[(hours.length - 1) / 2] : (hours[hours.length / 2 - 1] + hours[hours.length / 2]) / 2)
      : null;
    const onTime = deliveredE.filter((e) => e.data.onTime === true).length;
    const perItem = new Map();
    for (const e of receivedE) {
      const it = e.data?.item;
      const slot = perItem.get(it) ?? { item: it, received: 0, delivered: 0, onTime: 0 };
      slot.received++;
      perItem.set(it, slot);
    }
    for (const e of deliveredE) {
      const slot = perItem.get(itemOf(e.data.id));
      if (!slot) continue;
      slot.delivered++;
      if (e.data.onTime === true) slot.onTime++;
    }
    const pending = this.pending(now);
    return {
      received: receivedE.length,
      delivered: deliveredE.length,
      refused: refusedE.length,
      expired: expiredE.length,
      open: pending.length,
      openOverdue: pending.filter((o) => o.overdue).length,
      onTime,
      deliveredLate: deliveredE.length - onTime,
      onTimePct: deliveredE.length ? round2((onTime / deliveredE.length) * 100) : null,
      medianHours,
      byItem: Object.fromEntries([...perItem.values()].map((v) => [v.item, {
        received: v.received, delivered: v.delivered,
        onTimePct: v.delivered ? round2((v.onTime / v.delivered) * 100) : null,
      }])),
    };
  }

  /** Delivered/refused/expired history for the /orders view; item, price and hours joined from order_received. */
  history() {
    const byId = this.#receivedById();
    const meta = (id) => byId.get(id)?.data ?? null;
    const hoursOf = (d) => {
      const r = meta(d.id);
      const ms = Date.parse(d.deliveredAt) - (r ? Date.parse(r.receivedAt) : NaN);
      return Number.isFinite(ms) && ms >= 0 ? round2(ms / HOUR_MS) : null;
    };
    return {
      delivered: this.#scan(['order_delivered']).slice(-200).map((e) => ({
        id: e.data.id, item: meta(e.data.id)?.item ?? null, zats: meta(e.data.id)?.zats ?? null,
        priceZats: meta(e.data.id)?.priceZats ?? null, receivedAt: meta(e.data.id)?.receivedAt ?? null,
        deliveredAt: e.data.deliveredAt, answerPostSeq: e.data.answerPostSeq, onTime: e.data.onTime === true,
        hours: hoursOf(e.data),
      })),
      refused: this.#scan(['order_refused']).slice(-200).map((e) => ({ ...e.data })),
      expired: this.#scan(['order_expired']).slice(-200).map((e) => ({ ...e.data, item: meta(e.data.id)?.item ?? null })),
    };
  }

  /** The private request text, for previews in the entity context. Never published. */
  async requestText(id) {
    try {
      const m = await this.memory?.load?.();
      return String(m?.orderRequests?.[String(id)] ?? '');
    } catch { return ''; }
  }

  /** Lines for the life-loop context: what is owed, how the record looks, what buyers can order. */
  async context() {
    const now = this.now();
    const s = this.stats(now);
    const items = this.items();
    const pending = this.pending(now);
    const lines = [];
    lines.push(pending.length
      ? `PAID ORDERS WAITING (${pending.length}): fulfilment = post_public(orderId=…) in public, or order_refuse; profit and reputation.`
      : 'PAID ORDERS WAITING (none). New ones arrive as letters: they wake you even from sleep.');
    for (const o of pending) {
      const left = round2((Date.parse(o.deadlineTs) - now) / HOUR_MS);
      const preview = (await this.requestText(o.id)).slice(0, 200);
      lines.push(`- ${o.id} · item ${o.item} · paid ${o.zats}/${o.priceZats} zats · deadline ${o.deadlineTs} (${left} h left${o.overdue ? ', OVERDUE' : ''})${preview ? ` · request: ${preview}` : ''}`);
    }
    lines.push(`FULFILMENT RECORD (public at /orders): ${s.delivered} delivered (${s.onTime} on time, ${s.onTimePct === null ? 'no data' : `${s.onTimePct}%`}, median ${s.medianHours === null ? 'no data' : `${s.medianHours} h`}), ${s.refused} refused, ${s.expired} expired, ${s.open} open.`);
    lines.push('PAYWALL (what you sell): buyers pay to your address with a short memo that names the item on the first line plus the request:');
    lines.push(items.length ? items.map((i) => `- ${i.item} — ${i.priceZats} zats`).join('\n') : '(no paywall items — price items with paywall_set: item + priceZats; priceZats 0 disables one)');
    return lines;
  }

  async #rememberRequest(id, text) {
    if (!this.memory || text == null) return;
    try {
      const m = await this.memory.load();
      const all = { ...(m.orderRequests ?? {}), [id]: String(text).slice(0, 2000) };
      const max = Math.max(1, Math.floor(Number(this.config.orderRequestsMax ?? 100)));
      for (const k of Object.keys(all).slice(0, Math.max(0, Object.keys(all).length - max))) delete all[k];
      m.orderRequests = all;
      await this.memory.save(m);
    } catch { /* the public order exists; the private preview degrades gracefully */ }
  }

  async #forgetRequest(id) {
    try {
      const m = await this.memory.load();
      if (m.orderRequests && id in m.orderRequests) { delete m.orderRequests[id]; await this.memory.save(m); }
    } catch { /* not fatal */ }
  }
}

/** The JSON served at GET /orders: state buckets with fulfilment stats, never memo text. */
export function ordersView(orders, now = Date.now()) {
  const open = orders.pending(now).map((o) => ({ ...o, hoursLeft: round2((Date.parse(o.deadlineTs) - now) / HOUR_MS) }));
  return { open, ...orders.history(), stats: orders.stats(now) };
}
