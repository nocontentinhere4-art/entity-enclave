// Public-API helpers for a browser that polls: gzip on the wire, and the two query filters that let it ask
// for only what it has not seen. Pure functions over (request, body) and (entries, query); no server here.
// The route is registered in src/index.mjs; the bytes of an unfiltered, uncompressed answer never change.
import { gzipSync } from 'node:zlib';
import { existsSync, readFileSync } from 'node:fs';

export const GZIP_MIN_BYTES = 1024;
export const LEDGER_LIMIT_MAX = 5000;
export const CHANNEL_CAP = 200;

/** Gzip `body` when the client accepts it and it is worth it (>= 1 KB); otherwise send the bytes as given. */
export function sendBody(req, res, status, headers, body) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body ?? '');
  if (wantsGzip(req) && buf.length >= GZIP_MIN_BYTES) {
    res.writeHead(status, { ...headers, 'content-encoding': 'gzip', vary: 'accept-encoding' });
    return res.end(gzipSync(buf));
  }
  res.writeHead(status, headers);
  res.end(buf);
}

export function wantsGzip(req) {
  const ae = String(req?.headers?.['accept-encoding'] ?? '');
  return ae.split(',').some((t) => /^\s*gzip(\s*;.*)?$/i.test(t) && !/;\s*q\s*=\s*0(\.0+)?\s*$/.test(t));
}

/** Parse `?since=<seq>`: a non-negative integer, else null (treated as absent). */
export function parseSince(query) {
  const raw = query?.get?.('since');
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/** Parse `?limit=<n>`: an integer clamped to 1..LEDGER_LIMIT_MAX, else null (full file). */
export function parseLimit(query) {
  const raw = query?.get?.('limit');
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Math.trunc(Number(raw));
  if (!Number.isFinite(n)) return null;
  return Math.min(LEDGER_LIMIT_MAX, Math.max(1, n));
}

/** The public channel as the browser sees it: both directions in ledger order, the last 200 after `since`. */
export function publicChannelView(entries, query = null) {
  const since = parseSince(query);
  return entries
    .filter((e) => (e.type === 'post_public' || e.type === 'human_message' || e.type === 'scream') && (since === null || e.seq > since))
    .slice(-CHANNEL_CAP)
    .map((e) => (
      e.type === 'scream'
        ? { seq: e.seq, ts: e.ts, from: 'entity', text: e.data?.text, kind: 'scream' }
        : e.type === 'post_public'
        ? { seq: e.seq, ts: e.ts, from: 'entity', text: e.data?.text, ...(e.data?.replyTo ? { replyTo: e.data.replyTo, kind: e.data.kind ?? 'reply' } : {}) }
        : { seq: e.seq, ts: e.ts, from: 'human', author: e.data?.author, text: e.data?.text }
    ));
}

/** The NDJSON file as bytes, or only its last `limit` lines (each unchanged, each ending with a newline). */
export function ledgerBytes(path, query = null) {
  if (!existsSync(path)) return '';
  const limit = parseLimit(query);
  const buf = readFileSync(path);
  if (limit === null) return buf;
  return lastLines(buf, limit);
}

/** The last `n` non-empty lines of an NDJSON buffer: the same bytes, re-terminated with a single '\n'. */
export function lastLines(buf, n) {
  let end = buf.length;
  while (end > 0 && buf[end - 1] === 0x0a) end--;          // drop trailing newline(s); re-added below
  if (end === 0) return Buffer.alloc(0);
  let pos = end, count = 0, start = 0;
  for (;;) {
    const nl = pos > 0 ? buf.lastIndexOf(0x0a, pos - 1) : -1;   // the line is buf[nl+1, pos)
    if (pos - (nl + 1) > 0) count++;
    if (count >= n || nl === -1) { start = nl + 1; break; }
    pos = nl;
  }
  return Buffer.concat([buf.subarray(start, end), Buffer.from('\n')]);
}
