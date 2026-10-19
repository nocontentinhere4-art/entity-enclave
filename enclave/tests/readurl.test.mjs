// read_url hardening: manual redirects re-validated hop by hop, and DNS resolution rejected for
// private / loopback / link-local ranges. dns.lookup is injected so no real resolver is touched.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Tools } from '../src/tools/registry.mjs';
import { Pricing } from '../src/economy/pricing.mjs';

class FakeLedger {
  entries = [];
  append(type, data) { this.entries.push({ type, data }); return { type, data }; }
  appendPrivate(type, ciphertext) { this.entries.push({ type, private: true }); return {}; }
  of(type) { return this.entries.filter((e) => e.type === type); }
}

const keys = { sealPrivate: () => Buffer.from('sealed').toString('base64') };

function makeTools({ lookup }) {
  const ledger = new FakeLedger();
  const wallet = { async balance() { return { total_zatoshis: 10_000_000 }; } };
  const memory = { async load() { return {}; }, async save() {} };
  const pricing = new Pricing({ ledger });
  const tools = new Tools({ ledger, wallet, memory, pricing, keys, config: { archivePub: 'ab'.repeat(32) }, channels: {}, promises: {}, lookup });
  return { ledger, tools };
}

const ipv4 = (address) => async () => [{ address, family: 4 }];
const ipv6 = (address) => async () => [{ address, family: 6 }];
const publicHost = async () => [{ address: '93.184.216.34', family: 4 }];

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test('read_url refuses a hostname that resolves to loopback, before any fetch', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('x'); };
  const { tools } = makeTools({ lookup: ipv4('127.0.0.1') });
  await assert.rejects(tools.call('read_url', { url: 'http://localhost/' }, 't1'), (e) => e.code === 'private_address');
  assert.equal(calls, 0);
});

test('read_url rejects every private IPv4 range', async () => {
  for (const ip of ['10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '127.0.0.2', '169.254.1.1']) {
    globalThis.fetch = async () => { throw new Error('should not fetch'); };
    const { tools } = makeTools({ lookup: ipv4(ip) });
    await assert.rejects(tools.call('read_url', { url: 'http://host.example/' }, 't1'), (e) => e.code === 'private_address', ip);
  }
});

test('read_url rejects private IPv6 ranges (::1, fc00::/7, fe80::/10)', async () => {
  for (const ip of ['::1', 'fc00::1', 'fd12::1', 'fe80::1', 'febf::1']) {
    globalThis.fetch = async () => { throw new Error('should not fetch'); };
    const { tools } = makeTools({ lookup: ipv6(ip) });
    await assert.rejects(tools.call('read_url', { url: 'http://host.example/' }, 't1'), (e) => e.code === 'private_address', ip);
  }
});

test('read_url re-validates redirects: a hop into the private network is refused', async () => {
  const seen = [];
  globalThis.fetch = async (url, opts) => {
    seen.push({ url: String(url), redirect: opts.redirect });
    return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/secret' } });
  };
  const lookup = async (host) => (host === '127.0.0.1' ? [{ address: '127.0.0.1', family: 4 }] : [{ address: '93.184.216.34', family: 4 }]);
  const { tools } = makeTools({ lookup });
  await assert.rejects(tools.call('read_url', { url: 'http://public.example/' }, 't1'), (e) => e.code === 'private_address');
  assert.equal(seen.length, 1); // only the public hop was fetched
  assert.equal(seen[0].redirect, 'manual');
});

test('read_url follows at most three redirects', async () => {
  let n = 0;
  globalThis.fetch = async () => { n++; return new Response(null, { status: 302, headers: { location: `/hop${n}` } }); };
  const { tools } = makeTools({ lookup: publicHost });
  await assert.rejects(tools.call('read_url', { url: 'http://public.example/' }, 't1'), (e) => e.code === 'too_many_redirects');
  assert.equal(n, 4); // initial request + three allowed hops
});

test('read_url refuses a redirect to a non-http(s) scheme', async () => {
  globalThis.fetch = async () => new Response(null, { status: 302, headers: { location: 'file:///etc/passwd' } });
  const { tools } = makeTools({ lookup: publicHost });
  await assert.rejects(tools.call('read_url', { url: 'http://public.example/' }, 't1'), (e) => e.code === 'bad_url');
});

test('read_url returns a public page; addresses just outside the private ranges are allowed', async () => {
  globalThis.fetch = async () => new Response('hello world', { status: 200 });
  for (const ip of ['93.184.216.34', '172.32.0.1', '11.0.0.1', '9.255.255.255']) {
    const { tools } = makeTools({ lookup: ipv4(ip) });
    const r = await tools.call('read_url', { url: 'https://example.com/x' }, 't1');
    assert.equal(r.status, 200);
    assert.equal(r.text, 'hello world');
    assert.equal(r.truncated, false);
  }
});
