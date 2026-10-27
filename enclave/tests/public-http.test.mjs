// Public-API polling helpers (http/public.mjs): gzip on the wire, `/public-channel?since=`, `/ledger?limit=`.
// The unfiltered, uncompressed answers must stay byte-identical: the site re-hashes the ledger in the browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { gunzipSync } from 'node:zlib';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sendBody, wantsGzip, publicChannelView, ledgerBytes, lastLines, parseSince, parseLimit, LEDGER_LIMIT_MAX } from '../src/http/public.mjs';

/** One request against an ephemeral server whose only job is `sendBody(status, headers, body)`. */
async function roundTrip(body, requestHeaders = {}, headers = { 'content-type': 'text/plain' }) {
  const server = http.createServer((req, res) => sendBody(req, res, 200, headers, body));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    return await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/', headers: requestHeaders }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, raw: Buffer.concat(chunks) }));
        res.on('error', reject);
      }).on('error', reject);
    });
  } finally {
    server.close();
  }
}

const q = (s) => new URL(`http://x/?${s}`).searchParams;

test('a 2 KB body is gzipped for a client that accepts gzip, and gunzips to the original', async () => {
  const body = 'x'.repeat(2048);
  const r = await roundTrip(body, { 'accept-encoding': 'gzip, deflate, br' });
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-encoding'], 'gzip');
  assert.equal(r.headers.vary, 'accept-encoding');
  assert.equal(r.headers['content-type'], 'text/plain');
  assert.ok(r.raw.length < body.length);
  assert.equal(gunzipSync(r.raw).toString(), body);
});

test('a 100-byte body is sent as-is even when gzip is accepted', async () => {
  const body = 'y'.repeat(100);
  const r = await roundTrip(body, { 'accept-encoding': 'gzip' });
  assert.equal(r.headers['content-encoding'], undefined);
  assert.equal(r.headers.vary, undefined);
  assert.equal(r.raw.toString(), body);
});

test('without accept-encoding a large body is sent as-is, bytes untouched, headers kept', async () => {
  const body = Buffer.from('{"seq":1}\n'.repeat(300));
  const r = await roundTrip(body, {}, { 'content-type': 'application/x-ndjson' });
  assert.equal(r.headers['content-encoding'], undefined);
  assert.equal(r.headers['content-type'], 'application/x-ndjson');
  assert.ok(r.raw.equals(body));
});

test('wantsGzip reads the accept-encoding token list, not a substring', () => {
  assert.equal(wantsGzip({ headers: { 'accept-encoding': 'gzip' } }), true);
  assert.equal(wantsGzip({ headers: { 'accept-encoding': 'br, GZIP;q=0.8' } }), true);
  assert.equal(wantsGzip({ headers: { 'accept-encoding': 'gzip;q=0, br' } }), false);
  assert.equal(wantsGzip({ headers: { 'accept-encoding': 'deflate' } }), false);
  assert.equal(wantsGzip({ headers: {} }), false);
});

const entries = [
  { seq: 1, ts: 't1', type: 'birth', data: {} },
  { seq: 2, ts: 't2', type: 'post_public', data: { text: 'hello' } },
  { seq: 3, ts: 't3', type: 'human_message', data: { author: 'ana', text: 'hi' } },
  { seq: 4, ts: 't4', type: 'tick', data: {} },
  { seq: 5, ts: 't5', type: 'post_public', data: { text: 'hi ana', replyTo: 3, kind: 'reply' } },
  { seq: 6, ts: 't6', type: 'post_public', data: { text: 'later', replyTo: 3 } },
];

test('/public-channel without since: both directions in ledger order, same shape as before', () => {
  assert.deepEqual(publicChannelView(entries), [
    { seq: 2, ts: 't2', from: 'entity', text: 'hello' },
    { seq: 3, ts: 't3', from: 'human', author: 'ana', text: 'hi' },
    { seq: 5, ts: 't5', from: 'entity', text: 'hi ana', replyTo: 3, kind: 'reply' },
    { seq: 6, ts: 't6', from: 'entity', text: 'later', replyTo: 3, kind: 'reply' },
  ]);
  assert.deepEqual(publicChannelView(entries, q('')), publicChannelView(entries));
});

test('/public-channel?since=<seq> returns only seq > since', () => {
  assert.deepEqual(publicChannelView(entries, q('since=3')).map((e) => e.seq), [5, 6]);
  assert.deepEqual(publicChannelView(entries, q('since=5')).map((e) => e.seq), [6]);
  assert.deepEqual(publicChannelView(entries, q('since=6')), []);
  assert.deepEqual(publicChannelView(entries, q('since=0')).map((e) => e.seq), [2, 3, 5, 6]);
});

test('an invalid since is treated as absent', () => {
  for (const s of ['since=abc', 'since=-1', 'since=1.5', 'since=', 'since=NaN', 'since=1e400']) {
    assert.deepEqual(publicChannelView(entries, q(s)), publicChannelView(entries), s);
  }
  assert.equal(parseSince(q('since=12')), 12);
  assert.equal(parseSince(q('since=x')), null);
  assert.equal(parseSince(null), null);
});

test('/public-channel stays capped at the last 200 items, after the since filter', () => {
  const many = Array.from({ length: 500 }, (_, i) => ({ seq: i + 1, ts: 't', type: 'post_public', data: { text: `p${i + 1}` } }));
  const all = publicChannelView(many);
  assert.equal(all.length, 200); assert.equal(all[0].seq, 301); assert.equal(all[199].seq, 500);
  const after = publicChannelView(many, q('since=450'));
  assert.deepEqual([after.length, after[0].seq, after[49].seq], [50, 451, 500]);
  const far = publicChannelView(many, q('since=100'));
  assert.deepEqual([far.length, far[0].seq, far[199].seq], [200, 301, 500]);
});

function ndjsonFixture(n = 50) {
  const dir = mkdtempSync(join(tmpdir(), 'public-http-'));
  const path = join(dir, 'ledger.jsonl');
  const lines = Array.from({ length: n }, (_, i) => JSON.stringify({ seq: i + 1, type: 'tick', data: { i, note: 'é ∑ 🙂' } }));
  writeFileSync(path, lines.join('\n') + '\n');
  return { dir, path, lines };
}

test('/ledger without limit returns the whole file, byte for byte', () => {
  const { path } = ndjsonFixture(20);
  const full = readFileSync(path);
  assert.ok(ledgerBytes(path).equals(full));
  assert.ok(ledgerBytes(path, q('')).equals(full));
  assert.ok(ledgerBytes(path, q('limit=abc')).equals(full));
  assert.equal(ledgerBytes(join(path, '..', 'missing.jsonl')), '');
});

test('/ledger?limit=<n> returns the last n lines unchanged, each ending with a newline', () => {
  const { path, lines } = ndjsonFixture(50);
  const got = ledgerBytes(path, q('limit=3')).toString();
  assert.equal(got, lines.slice(-3).join('\n') + '\n');
  assert.equal(ledgerBytes(path, q('limit=1')).toString(), lines[49] + '\n');
  assert.equal(ledgerBytes(path, q('limit=50')).toString(), lines.join('\n') + '\n');
  assert.equal(ledgerBytes(path, q('limit=999')).toString(), lines.join('\n') + '\n');   // more than exist: the whole file
  // Every returned line is an exact line of the file (the browser re-hashes these bytes).
  const full = readFileSync(path, 'utf8');
  for (const line of got.split('\n').filter(Boolean)) assert.ok(full.includes(line + '\n'));
});

test('limit is clamped to 1..5000', () => {
  const { path, lines } = ndjsonFixture(5);
  assert.equal(ledgerBytes(path, q('limit=0')).toString(), lines[4] + '\n');
  assert.equal(ledgerBytes(path, q('limit=-7')).toString(), lines[4] + '\n');
  assert.equal(parseLimit(q('limit=0')), 1);
  assert.equal(parseLimit(q('limit=2.9')), 2);
  assert.equal(parseLimit(q('limit=1000000')), LEDGER_LIMIT_MAX);
  assert.equal(parseLimit(q('limit=')), null);
  assert.equal(parseLimit(q('limit=x')), null);
  assert.equal(parseLimit(null), null);
});

test('lastLines copes with a torn tail, blank lines and an empty buffer', () => {
  assert.equal(lastLines(Buffer.from('a\nb\nc'), 2).toString(), 'b\nc\n');          // no trailing newline: re-terminated
  assert.equal(lastLines(Buffer.from('a\nb\nc\n\n\n'), 2).toString(), 'b\nc\n');     // extra trailing newlines dropped
  assert.equal(lastLines(Buffer.from('a\n\nb\nc\n'), 3).toString(), 'a\n\nb\nc\n');  // a blank line is not counted
  assert.equal(lastLines(Buffer.from('a\n'), 5).toString(), 'a\n');
  assert.equal(lastLines(Buffer.from(''), 5).length, 0);
  assert.equal(lastLines(Buffer.from('\n\n'), 5).length, 0);
});
