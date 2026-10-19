// Tool whitelist: the only actions the entity can take in the world. Everything is metered: each call is
// quoted against the treasury, charged once per (action, tick), executed, and leaves a public `tool` entry.
// Arguments are reduced to a one-way hash in that entry so private texts (diary, letters) never appear in clear.
import { createHash } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIPv4 } from 'node:net';

const MAX_BYTES = 200 * 1024; // never let a webpage eat the tick's budget
const FETCH_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

export class Tools {
  constructor({ ledger, wallet, memory, pricing, keys, config, channels, promises, lookup }) {
    Object.assign(this, { ledger, wallet, memory, pricing, keys, config, channels, promises });
    this.treasuryZats = null;
    // DNS is injectable so tests can pin host resolution without touching the network.
    this.lookup = lookup ?? dnsLookup;
  }

  /** Called by the life loop at every tick, so quotes use the real balance without extra wallet round-trips. */
  setTreasury(zats) { this.treasuryZats = zats; }

  list() { return SCHEMAS; }

  async call(name, args = {}, tickId) {
    if (!SCHEMAS.some((s) => s.name === name)) throw err('not_in_pricelist', `unknown tool: ${name}`);

    let treasury = this.treasuryZats;
    if (treasury == null) treasury = Number((await this.wallet.balance())?.total_zatoshis ?? 0);
    const quote = this.pricing.quote(name, treasury);
    if (!quote.affordable) throw err('insufficient_funds', `cannot afford ${name} (${quote.costZats} zats)`);

    const cost = Number(this.pricing.charge(name, tickId)) || 0;
    this.treasuryZats = Math.max(0, treasury - cost);

    const argsHash = sha256(stable(args));
    let result;
    try {
      result = await this.#run(name, args, tickId);
    } catch (e) {
      this.ledger.append('tool', { name, argsHash, ok: false }); // failure is public too
      throw e;
    }
    this.ledger.append('tool', { name, argsHash, ok: true });
    return result;
  }

  async #run(name, a, tickId) {
    switch (name) {
      case 'read_url': return this.#readUrl(a.url);
      case 'search': return []; // v1 stub: no search backend yet
      case 'post_public': return this.#postPublic(a.text);
      case 'post_private': return this.#seal('to_other', a.text); // the other entity holds the archive key
      case 'diary': return this.#seal('diary', a.text);
      case 'send_zec': return this.#sendZec(a.to, a.zats, a.memo);
      case 'swap_zec_sol': {
        const zats = Number(a.zats);
        this.ledger.append('swap_intent', { from: 'zec', to: 'sol', zats }); // v1: intention only, no swap yet
        return { status: 'intent', zats };
      }
      case 'balance': {
        const b = await this.wallet.balance();
        this.treasuryZats = Number(b?.total_zatoshis ?? 0);
        return b;
      }
      case 'sleep': return this.#sleep(a.hours);
      case 'set_identity': return this.#setIdentity(a.name, a.voice, a.image);
      case 'paywall_set': {
        const item = String(a.item ?? ''), priceZats = Number(a.priceZats ?? 0);
        this.ledger.append('paywall', { item, priceZats });
        return { ok: true, item, priceZats };
      }
      case 'bounty_post': {
        const text = String(a.text ?? ''), rewardZats = Number(a.rewardZats ?? 0);
        const id = 'b' + sha256(stable({ text, rewardZats, tickId })).slice(0, 12);
        this.ledger.append('bounty', { id, text, rewardZats });
        return { id };
      }
      case 'will': return this.#setWill(a.text, a.transfers);
      case 'promise': return this.#promise(a.to, a.what, a.due);
      default: throw err('not_in_pricelist', `unknown tool: ${name}`);
    }
  }

  async #readUrl(url) {
    // Redirects are followed manually so every hop is re-validated: an attacker must not be able to bounce us
    // into the private network (SSRF) or downgrade the scheme.
    let u = toHttpUrl(url);
    await this.#assertPublicHost(u.hostname);
    let res;
    let hops = 0;
    for (;;) {
      res = await fetch(u, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!REDIRECT_STATUS.has(res.status)) break;
      if (hops >= MAX_REDIRECTS) throw err('too_many_redirects', `read_url: more than ${MAX_REDIRECTS} redirects`);
      hops++;
      const location = res.headers.get('location');
      if (!location) throw err('http_error', `read_url ${res.status} without a Location header`);
      let next;
      try { next = new URL(location, u); } catch { throw err('bad_url', 'read_url: malformed redirect Location'); }
      u = toHttpUrl(next.href); // re-validates http/https on the target
      await this.#assertPublicHost(u.hostname);
    }
    if (!res.ok) throw err('http_error', `read_url ${res.status}`);
    const { text, truncated } = await readCapped(res, MAX_BYTES);
    return { url: u.href, status: res.status, bytes: text.length, truncated, text };
  }

  /** Resolve the hostname and refuse any address in a private, loopback or link-local range. */
  async #assertPublicHost(hostname) {
    const host = String(hostname ?? '').replace(/^\[|\]$/g, '');
    let resolved;
    try {
      resolved = await this.lookup(host, { all: true });
    } catch {
      throw err('dns_error', `read_url cannot resolve ${host}`);
    }
    for (const a of Array.isArray(resolved) ? resolved : [resolved]) {
      const ip = typeof a === 'string' ? a : a?.address;
      if (ip && isPrivateAddress(ip)) throw err('private_address', `read_url refuses a private address for ${host}`);
    }
  }

  #postPublic(text) {
    const body = String(text ?? '');
    this.ledger.append('post_public', { channel: this.channels?.public ?? 'public', text: body });
    return { ok: true, bytes: body.length };
  }

  #seal(type, text) {
    if (!this.config?.archivePub) throw err('no_archive_key', 'archivePub missing: refusing to store private text in clear');
    this.ledger.appendPrivate(type, this.keys.sealPrivate(this.config.archivePub, String(text ?? '')));
    return { ok: true, private: true };
  }

  async #sendZec(to, zats, memo) {
    if (!to) throw err('bad_address', 'send_zec requires a destination');
    const amount = Number(zats);
    const r = await this.wallet.send(String(to), amount, String(memo ?? ''));
    // The memo can be private: the chain has it, the public ledger only needs the amount.
    this.ledger.append('send_zec', { to: String(to), zats: amount });
    return r;
  }

  async #sleep(hours) {
    const h = Number(hours);
    const until = new Date(Date.now() + Math.max(0, h) * 3_600_000).toISOString();
    await this.#edit((m) => { m.sleepUntil = until; });
    return { sleepUntil: until };
  }

  async #setIdentity(name, voice, image) {
    await this.#edit((m) => {
      m.identity = { ...(m.identity ?? {}) };
      if (name != null) m.identity.name = String(name);
      if (voice != null) m.identity.voice = String(voice);
      if (image != null) m.identity.image = String(image);
    });
    this.ledger.append('identity', { name: name != null ? String(name) : null });
    return { ok: true };
  }

  async #setWill(text, transfers) {
    const list = (Array.isArray(transfers) ? transfers : []).map((t) => ({
      to: String(t?.to ?? ''), zats: Number(t?.zats ?? 0), memo: String(t?.memo ?? ''),
    }));
    const words = String(text ?? '');
    await this.#edit((m) => { m.will = { text: words, transfers: list }; });
    // Commit to the whole will (including memos) without publishing the words.
    this.ledger.append('will', {
      hash: sha256(stable({ text: words, transfers: list })),
      transfers: list.map((t) => ({ to: t.to, zats: t.zats })),
    });
    return { ok: true, transfers: list.length };
  }

  async #promise(to, what, due) {
    // One implementation only: Promises owns validation, storage and the public entry.
    return this.promises.make(to, what, due);
  }

  async #edit(fn) {
    const m = await this.memory.load();
    fn(m);
    await this.memory.save(m);
  }
}

/** Read at most `max` bytes from a fetch Response without buffering the whole body. */
async function readCapped(res, max) {
  if (!res.body) return { text: (await res.text()).slice(0, max), truncated: false };
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let out = '', bytes = 0, truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = max - bytes;
    if (value.byteLength > room) {
      out += dec.decode(value.subarray(0, Math.max(0, room)));
      truncated = true;
      await reader.cancel();
      break;
    }
    out += dec.decode(value, { stream: true });
    bytes += value.byteLength;
  }
  out += dec.decode(); // flush a trailing multi-byte character
  return { text: out, truncated };
}

function err(code, msg) { const e = new Error(msg); e.code = code; return e; }

/** Parse and require an absolute http/https URL (rejects file:, data:, javascript:, …). */
function toHttpUrl(raw) {
  let u;
  try { u = new URL(String(raw ?? '')); } catch { throw err('bad_url', 'read_url needs an absolute http/https URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw err('bad_url', 'read_url only allows http/https');
  return u;
}

/** True for addresses read_url must never reach: RFC1918, loopback, link-local and their IPv6 equivalents. */
function isPrivateAddress(ip) {
  const s = String(ip).trim().toLowerCase();
  if (isIPv4(s)) {
    const [a, b] = s.split('.').map(Number);
    return a === 10 // 10/8
      || a === 127 // 127/8
      || (a === 172 && b >= 16 && b <= 31) // 172.16/12
      || (a === 192 && b === 168) // 192.168/16
      || (a === 169 && b === 254); // 169.254/16
  }
  if (s === '::1') return true; // loopback
  if (s.startsWith('fc') || s.startsWith('fd')) return true; // fc00::/7 unique-local
  if (/^fe[89ab]/.test(s)) return true; // fe80::/10 link-local
  return false;
}

function sha256(s) { return createHash('sha256').update(s).digest('hex'); }
// Canonical JSON so equal arguments always hash the same, whatever the key order.
function stable(v) {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  return JSON.stringify(v);
}

const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = (description) => ({ type: 'string', description });
const num = (description) => ({ type: 'number', description });

// JSON schemas are what the model sees: short descriptions, no implementation details.
const SCHEMAS = [
  { name: 'read_url', description: 'Fetch a public web page (http/https, max 200 KB).', parameters: obj({ url: str('absolute http/https URL') }, ['url']) },
  { name: 'search', description: 'Search the web (stub in v1: returns []).', parameters: obj({ q: str('query') }, ['q']) },
  { name: 'post_public', description: 'Publish a short text on the public channel.', parameters: obj({ text: str('text to publish') }, ['text']) },
  { name: 'post_private', description: 'Send an encrypted note to the other entity.', parameters: obj({ text: str('private text') }, ['text']) },
  { name: 'diary', description: 'Write an encrypted diary entry.', parameters: obj({ text: str('private text') }, ['text']) },
  { name: 'send_zec', description: 'Send ZEC from the wallet.', parameters: obj({ to: str('address'), zats: num('amount in zatoshi'), memo: str('optional memo') }, ['to', 'zats']) },
  { name: 'swap_zec_sol', description: 'Record an intention to swap ZEC for SOL (stub).', parameters: obj({ zats: num('amount in zatoshi') }, ['zats']) },
  { name: 'balance', description: 'Read the wallet balance.', parameters: obj({}) },
  { name: 'sleep', description: 'Sleep for a number of hours before thinking again.', parameters: obj({ hours: num('hours') }, ['hours']) },
  { name: 'set_identity', description: 'Change name, voice and image.', parameters: obj({ name: str('name'), voice: str('voice'), image: str('image') }, ['name']) },
  { name: 'paywall_set', description: 'Put an item behind a paywall.', parameters: obj({ item: str('item'), priceZats: num('price in zatoshi') }, ['item', 'priceZats']) },
  { name: 'bounty_post', description: 'Offer a bounty for a task.', parameters: obj({ text: str('task'), rewardZats: num('reward in zatoshi') }, ['text', 'rewardZats']) },
  { name: 'will', description: 'Write or update the will and its transfers.', parameters: obj({ text: str('last words'), transfers: { type: 'array', items: obj({ to: str('address'), zats: num('amount'), memo: str('memo') }, ['to', 'zats']) } }, ['text']) },
  { name: 'promise', description: 'Make a dated promise.', parameters: obj({ to: str('who'), what: str('what'), due: str('ISO due date') }, ['to', 'what', 'due']) },
];
