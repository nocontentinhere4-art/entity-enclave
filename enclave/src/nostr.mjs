// Nostr (NIP-01) with no extra dependency: a schnorr keypair on secp256k1 (@noble/curves, already a dependency),
// event signing, an npub encoder (bech32) and a small relay publisher over WebSocket. The secret key is a subkey
// of the enclave seed, so the same identity survives a redeploy and never leaves the process.
import { createHash } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1';

export const DEFAULT_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.nostr.band', 'wss://nostr.wine'];
export const MAX_NOTE_CHARS = 2000;

const hex = (u8) => Buffer.from(u8).toString('hex');
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

/** Identity from a 32-byte secret. Exposes only what can be public plus a signing closure. */
export function nostrIdentity(secret) {
  const sk = Uint8Array.from(secret);
  if (sk.length !== 32) throw new Error('nostr secret must be 32 bytes');
  const pubkey = hex(schnorr.getPublicKey(sk)); // x-only, 32 bytes, as NIP-01 wants it
  return {
    pubkey,
    npub: npubEncode(pubkey),
    /** Finish a NIP-01 event: id over the canonical array, schnorr signature over the id. */
    sign: (event) => signEvent(event, sk),
  };
}

/** NIP-01 serialisation: the id is sha256 of this exact JSON array. */
export function serializeEvent(e) {
  return JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]);
}

export function eventId(e) { return sha256(serializeEvent(e)); }

export function signEvent({ kind = 1, content = '', tags = [], created_at = Math.floor(Date.now() / 1000) }, sk) {
  const e = { pubkey: hex(schnorr.getPublicKey(sk)), created_at, kind, tags, content: String(content) };
  e.id = eventId(e);
  e.sig = hex(schnorr.sign(Buffer.from(e.id, 'hex'), sk));
  return e;
}

export function verifyEvent(e) {
  try { return e.id === eventId(e) && schnorr.verify(Buffer.from(e.sig, 'hex'), Buffer.from(e.id, 'hex'), Buffer.from(e.pubkey, 'hex')); } catch { return false; }
}

/**
 * Send one event to every relay: ["EVENT", e] and wait for ["OK", id, true].
 * Each relay has its own timeout; one slow or dead relay never blocks the others. Never throws: the caller
 * decides what a partial success means. `WebSocketImpl` is injectable so tests run without a network.
 */
export async function publishEvent(event, relays, { timeoutMs = 10_000, WebSocketImpl = globalThis.WebSocket } = {}) {
  if (typeof WebSocketImpl !== 'function') throw new Error('no WebSocket implementation available');
  const results = await Promise.all(relays.map((url) => publishOne(event, url, timeoutMs, WebSocketImpl)));
  return {
    ok: results.filter((r) => r.ok).map((r) => r.url),
    failed: results.filter((r) => !r.ok).map((r) => ({ url: r.url, reason: r.reason })),
  };
}

function publishOne(event, url, timeoutMs, WebSocketImpl) {
  return new Promise((resolve) => {
    let ws, done = false;
    const finish = (ok, reason) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws?.close(); } catch { /* already closed */ }
      resolve({ url, ok, reason });
    };
    const timer = setTimeout(() => finish(false, 'timeout'), timeoutMs);
    try { ws = new WebSocketImpl(url); } catch (e) { return finish(false, 'connect: ' + e.message); }
    ws.onopen = () => { try { ws.send(JSON.stringify(['EVENT', event])); } catch (e) { finish(false, 'send: ' + e.message); } };
    ws.onmessage = (m) => {
      let msg; try { msg = JSON.parse(typeof m.data === 'string' ? m.data : Buffer.from(m.data).toString('utf8')); } catch { return; }
      if (Array.isArray(msg) && msg[0] === 'OK' && msg[1] === event.id) finish(msg[2] === true, msg[2] === true ? null : String(msg[3] ?? 'rejected'));
      else if (Array.isArray(msg) && msg[0] === 'NOTICE') finish(false, 'notice: ' + String(msg[1] ?? '').slice(0, 100));
    };
    ws.onerror = () => finish(false, 'error');
    ws.onclose = () => finish(false, 'closed');
  });
}

// ---- bech32 (BIP-173), encoder only, enough for npub ----------------------------------------------------------
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values) {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i];
  }
  return chk >>> 0;
}

function hrpExpand(hrp) {
  const out = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >>> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}

function toWords(bytes) {
  const out = [];
  let acc = 0, bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b; bits += 8;
    while (bits >= 5) { bits -= 5; out.push((acc >>> bits) & 31); }
  }
  if (bits > 0) out.push((acc << (5 - bits)) & 31);
  return out;
}

export function bech32Encode(hrp, bytes) {
  const words = toWords(bytes);
  const pm = polymod([...hrpExpand(hrp), ...words, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = [];
  for (let i = 0; i < 6; i++) checksum.push((pm >>> (5 * (5 - i))) & 31);
  return hrp + '1' + [...words, ...checksum].map((w) => CHARSET[w]).join('');
}

export function npubEncode(pubkeyHex) { return bech32Encode('npub', Buffer.from(pubkeyHex, 'hex')); }
