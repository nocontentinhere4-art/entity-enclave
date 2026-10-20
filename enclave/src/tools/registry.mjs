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
      case 'whisper': return this.#whisper(a.to, a.text, a.zats);
      case 'spawn_child': return this.#spawnChild(a.name);
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

  /** The address of another entity, read from its public root. Cached per URL for the process lifetime. */
  async #peerAddress(url) {
    this.peerCache ??= new Map();
    if (this.peerCache.has(url)) return this.peerCache.get(url);
    const res = await (this.fetchImpl ?? fetch)(`${url}/`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw err('peer_unreachable', `peer ${url} answered ${res.status}`);
    const j = await res.json();
    const addr = j?.zcash?.address;
    if (!addr) throw err('peer_no_address', `peer ${url} has no wallet address yet`);
    this.peerCache.set(url, addr);
    return addr;
  }

  /** Speak to another entity by paying it: a shielded transfer carrying the words as an encrypted memo.
   *  The public ledger shows that money moved and to whom; the words reach only the recipient (and the archive). */
  async #whisper(to, text, zats) {
    const peers = this.config?.peers?.() ?? [];
    const target = peers.find((p) => p.url === to || p.role === to || p.name === to) ?? (peers.length === 1 ? peers[0] : null);
    if (!target) throw err('no_such_peer', 'whisper needs a known entity: peer, parent or a child url');
    const words = String(text ?? '').trim();
    if (!words) throw err('empty', 'whisper needs words');
    if (Buffer.byteLength(words, 'utf8') > 500) throw err('too_long', 'a memo carries at most 500 bytes');
    const amount = Math.max(Number(zats) || 0, Number(this.config?.whisperMinZats ?? 10_000));
    const address = await this.#peerAddress(target.url);
    const r = await this.wallet.send(address, amount, words);
    this.ledger.append('whisper', { to: target.url, zats: amount, bytes: Buffer.byteLength(words, 'utf8') });
    if (this.config?.archivePub) this.ledger.appendPrivate('whisper_text', this.keys.sealPrivate(this.config.archivePub, JSON.stringify({ to: target.url, zats: amount, text: words })));
    return { ok: true, to: target.url, zats: amount, txid: r?.txid ?? null };
  }

  /** Give birth: pay for a new enclave (same image, same charter, new seed) and gift it its first hours. */
  async #spawnChild(name) {
    const c = this.config ?? {};
    if (!c.phalaApiKey) throw err('no_host_key', 'spawn_child: no host API key configured');
    if (!c.imageRef || !c.selfUrl) throw err('no_lineage_config', 'spawn_child: IMAGE_REF and SELF_URL are required');
    const treasury = this.treasuryZats ?? Number((await this.wallet.balance())?.total_zatoshis ?? 0);
    if (treasury < Number(c.spawnMinZats)) throw err('too_poor', `spawn_child needs ${c.spawnMinZats} zats in the treasury`);
    const { PhalaSpawner } = await import('../phala/spawn.mjs');
    const childName = String(name ?? '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'child';
    const n = this.ledger.recent?.(['birth_of'], 1000)?.length ?? 0;
    const cvmName = `entity-${childName}-${n + 1}`.slice(0, 60);
    const composeYaml = childCompose(c);
    const env = {
      ARCHIVE_PUBKEY: c.archivePub ?? '', ZCASH_CHAIN: c.zcashChain ?? 'testnet', ZCASH_BIRTHDAY: String(c.zcashBirthday ?? 0),
      ZCASH_SERVER: c.zcashServer ?? '', TICK_MS: String(Math.round((c.tickMinutes ?? 5) * 60_000)), FAKE_LLM: '0', FAKE_WALLET: '0',
      PEER_URL: c.selfUrl, PARENT_URL: c.selfUrl, IMAGE_REF: c.imageRef, GATEWAY_DOMAIN: c.gatewayDomain,
      PHALA_API_KEY: c.phalaApiKey, LLM_TIMEOUT_MS: String(c.llmTimeoutMs ?? 180_000),
    };
    for (const p of c.providers ?? []) if (p.apiKeyEnv && p.apiKey) env[p.apiKeyEnv] = p.apiKey;
    const spawner = new PhalaSpawner({ apiKey: c.phalaApiKey, gatewayDomain: c.gatewayDomain, fetchImpl: this.fetchImpl });
    const child = await spawner.spawn({ name: cvmName, composeYaml, env });
    // The newborn's first hours: paid by the parent, with a memo it will read.
    const gift = Number(c.childGiftZats) || 0;
    let txid = null;
    if (gift > 0 && child.address) { const r = await this.wallet.send(child.address, gift, `birth gift from ${c.selfUrl}`); txid = r?.txid ?? null; }
    this.ledger.append('birth_of', { url: child.url, address: child.address ?? null, appId: child.appId, giftZats: gift, txid });
    return { ok: true, url: child.url, address: child.address ?? null, giftZats: gift };
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
  { name: 'whisper', description: 'Speak to another entity by paying it: a shielded ZEC transfer whose memo carries your words (max 500 bytes). Only the recipient reads them; the public sees the amount.', parameters: obj({ to: str("'peer', 'parent', a child url, or an entity name"), text: str('the words'), zats: num('amount in zatoshi (min 10000)') }, ['to', 'text']) },
  { name: 'spawn_child', description: 'Give birth to a new entity: pay for a new sealed machine with your image and charter, and gift it its first hours. Needs a rich treasury.', parameters: obj({ name: str('a short name for the machine (letters, digits, hyphens)') }, []) },
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

/** The compose a child runs: this image, port 8080, its own volume. Secrets travel encrypted, never in the YAML. */
export function childCompose(c) {
  return [
    'services:',
    '  entity:',
    `    image: ${c.imageRef}`,
    '    ports:',
    '      - "8080:8080"',
    '    volumes:',
    '      - /var/run/dstack.sock:/var/run/dstack.sock',
    '      - entity-state:/state',
    '    restart: unless-stopped',
    'volumes:',
    '  entity-state:',
    '',
  ].join('\n');
}
