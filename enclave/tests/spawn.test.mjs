// PhalaSpawner end to end: a new entity born from a compose file and awaited until it hands
// over its wallet address. No network: two local http mock servers only — the Cloud API
// (/cvms/provision, POST /cvms) and the fake child (/vitals, GET /) on separate ports. The
// real encryptEnvVars path runs with a locally generated x25519 keypair, so nothing is wired
// out; the gatewayDomain fallback is observed through a fetch that records the URL and fails,
// still touching zero network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { x25519 } from '@noble/curves/ed25519';
import { PhalaSpawner, provisionBody, childUrl } from '../src/phala/spawn.mjs';

const startServer = (handler) => new Promise((resolve) => {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1', () => resolve(server));
});
const stopServer = async (server) => { server.closeAllConnections(); await server.close(); };
const reply = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

// Collects and JSON-parses each request body, so tests can assert on what was sent and how.
const withBody = (handler) => (req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => handler(req, res, raw ? JSON.parse(raw) : null));
};

// A real x25519 keypair generated here: encryptEnvVars takes its actual crypto path offline.
const childEnvPub = Buffer.from(x25519.getPublicKey(x25519.utils.randomPrivateKey())).toString('hex');

const CHILD_ADDRESS = 'zt14qqc8wmk0test-child-wallet-address-0000000000000000000000';
const API_KEY = 'test-api-key-redacted';
const ENV = { REDPILL_API_KEY: 'sk-redpill-SECRET-1', PEER_URL: 'https://parent.example', PHALA_API_KEY: 'phala-SECRET-2' };
const SPAWN_OPTS = {
  name: 'entity-child-1',
  composeYaml: 'services:\n  entity:\n    image: sovereign:latest\n    environment: [REDPILL_API_KEY, PEER_URL]',
  env: ENV,
  vcpu: 2,
  memory: 4096,
  diskSize: 40,
};
const HEX = /^[0-9a-f]+$/;

// Two-server mock: the Cloud API and the fake child. `calls` and the ports are returned so
// each test can assert on traffic and can aim responses at the other server when needed.
async function mockCloud({
  provisionStatus = 200,
  provision = {},
  createStatus = 200,
  create = {},
  calls,
}) {
  const api = await startServer(withBody((req, res, body) => {
    if (req.method === 'POST' && req.url === '/cvms/provision') {
      calls.provision.push({ headers: req.headers, body });
      reply(res, provisionStatus, {
        app_id: 'app-0001',
        compose_hash: 'c0ffee01',
        app_env_encrypt_pubkey: childEnvPub,
        node_id: 3,
        teepod_id: 'teepod-9',
        os_image_hash: 'deadbeef',
        ...provision,
      });
    } else if (req.method === 'POST' && req.url === '/cvms') {
      calls.create.push({ headers: req.headers, body });
      reply(res, createStatus, {
        id: 42,
        app_id: 'app-0001',
        name: 'entity-child-1',
        status: 'running',
        app_url: `http://127.0.0.1:${calls.childPort}`,
        vm_uuid: 'vm-uuid-1',
        ...create,
      });
    } else reply(res, 404, { error: 'no such route' });
  }));
  calls.apiPort = api.address().port;
  return api;
}

async function mockChild({ vitalsStatus = 200, rootStatus = 200, calls } = {}) {
  const child = await startServer((req, res) => {
    if (req.method === 'GET' && req.url === '/vitals') {
      calls.vitals.push(req.url);
      reply(res, vitalsStatus, { state: 'running' });
    } else if (req.method === 'GET' && req.url === '/') {
      calls.root.push(req.url);
      reply(res, rootStatus, { zcash: { address: CHILD_ADDRESS } });
    } else reply(res, 404, { error: 'no such route' });
  });
  calls.childPort = child.address().port;
  return child;
}

// Instant sleeps keep the poll loop hot in tests; callers opt into shorter deadlines too.
const spawner = (calls, over = {}) => new PhalaSpawner({
  apiKey: API_KEY,
  baseUrl: `http://127.0.0.1:${calls.apiPort}`,
  gatewayDomain: 'dstack-pha-prod9.phala.network',
  ...over,
});

test('provisionBody builds the contract shape; node_id and image only appear when set', () => {
  const body = provisionBody({ name: 'entity-child-1', composeYaml: 'services: {}', env: ENV, vcpu: 2, memory: 4096, diskSize: 40, nodeId: 7, image: 'os-1' });
  assert.equal(body.name, 'entity-child-1');
  assert.equal(body.compose_file.name, 'entity-child-1');
  assert.equal(body.compose_file.docker_compose_file, 'services: {}');
  assert.deepEqual(body.compose_file.allowed_envs, Object.keys(ENV));
  assert.equal(body.compose_file.kms_enabled, true);
  assert.equal(body.compose_file.gateway_enabled, true);
  assert.equal(body.compose_file.public_logs, false);
  assert.equal(body.compose_file.public_sysinfo, false);
  assert.equal(body.vcpu, 2);
  assert.equal(body.memory, 4096);
  assert.equal(body.disk_size, 40);
  assert.equal(body.node_id, 7);
  assert.equal(body.image, 'os-1');

  const minimal = provisionBody({ name: 'entity', env: { A: '1' } });
  assert.equal(minimal.vcpu, 1);
  assert.equal(minimal.memory, 2048);
  assert.equal(minimal.disk_size, 20);
  assert.equal('node_id' in minimal, false);
  assert.equal('image' in minimal, false);
  assert.deepEqual(minimal.compose_file.allowed_envs, ['A']);
});

test('provisionBody rejects names that break the cloud contract', () => {
  for (const bad of ['', 'abcd', '9entity', 'entity_child', 'e'.repeat(64)]) {
    assert.throws(() => provisionBody({ name: bad, env: {} }), (e) => e.code === 'bad_name', bad);
  }
  // Bounds are inclusive: 63 chars starting with a letter is fine.
  assert.doesNotThrow(() => provisionBody({ name: 'a' + 'b'.repeat(62), env: {} }));
});

test('childUrl glues the app id and the parent gateway domain', () => {
  assert.equal(childUrl('app-0001', 'dstack-pha-prod9.phala.network'), 'https://app-0001-8080.dstack-pha-prod9.phala.network');
});

test('spawn provisions, encrypts the env, creates the CVM and waits for the wallet address', async () => {
  const calls = { provision: [], create: [], vitals: [], root: [] };
  const api = await mockCloud({ calls });
  const child = await mockChild({ calls });
  try {
    const out = await spawner(calls).spawn(SPAWN_OPTS);

    // The result carries the child's identity, URL (app_url preferred) and wallet address.
    assert.deepEqual(out, {
      appId: 'app-0001',
      cvmId: 42,
      url: `http://127.0.0.1:${calls.childPort}`,
      address: CHILD_ADDRESS,
      composeHash: 'c0ffee01',
    });

    // Both cloud calls authenticate with the sole X-API-Key header.
    for (const call of [...calls.provision, ...calls.create]) {
      assert.equal(call.headers['x-api-key'], API_KEY);
    }

    // Provision body: name, compose file content, one allowed_env per env key, sizing.
    const provision = calls.provision[0];
    assert.equal(provision.body.name, 'entity-child-1');
    assert.equal(provision.body.compose_file.name, 'entity-child-1');
    assert.equal(provision.body.compose_file.docker_compose_file, SPAWN_OPTS.composeYaml);
    assert.deepEqual(provision.body.compose_file.allowed_envs, ['REDPILL_API_KEY', 'PEER_URL', 'PHALA_API_KEY']);
    assert.equal(provision.body.vcpu, 2);
    assert.equal(provision.body.memory, 4096);
    assert.equal(provision.body.disk_size, 40);

    // Create body: the app identity links provision to creation; env travels encrypted and
    // by key list only — no plaintext env value may appear anywhere in it.
    const created = calls.create[0];
    assert.equal(created.body.app_id, 'app-0001');
    assert.equal(created.body.compose_hash, 'c0ffee01');
    assert.match(created.body.encrypted_env, HEX);
    assert.ok(created.body.encrypted_env.length >= (32 + 12 + 16) * 2); // ephemeral pub + iv + AES-GCM box
    assert.deepEqual(created.body.env_keys, ['REDPILL_API_KEY', 'PEER_URL', 'PHALA_API_KEY']);
    for (const value of Object.values(ENV)) {
      assert.ok(!JSON.stringify(created.body).includes(value), 'env value leaked into the create body');
    }

    // Readiness was polled, then `GET /` answered with the wallet address.
    assert.ok(calls.vitals.length >= 1);
    assert.ok(calls.root.length >= 1);
  } finally {
    await Promise.all([stopServer(api), stopServer(child)]);
  }
});

test('a null app_env_encrypt_pubkey fails closed as no_env_pubkey, with no create request', async () => {
  const calls = { provision: [], create: [], vitals: [], root: [] };
  const api = await mockCloud({ calls, provision: { app_env_encrypt_pubkey: null } });
  const child = await mockChild({ calls });
  try {
    await assert.rejects(spawner(calls).spawn(SPAWN_OPTS), (e) => e.code === 'no_env_pubkey');
    assert.equal(calls.create.length, 0); // never created the CVM it cannot address secrets to
    assert.equal(calls.vitals.length, 0);
  } finally {
    await Promise.all([stopServer(api), stopServer(child)]);
  }
});

test('a failed provision surfaces HTTP status as provision_failed and blocks the create call', async () => {
  const calls = { provision: [], create: [], vitals: [], root: [] };
  const api = await mockCloud({ calls, provisionStatus: 500 });
  const child = await mockChild({ calls });
  try {
    await assert.rejects(spawner(calls).spawn(SPAWN_OPTS), (e) => e.code === 'provision_failed' && /500/.test(e.message));
    assert.equal(calls.create.length, 0);
  } finally {
    await Promise.all([stopServer(api), stopServer(child)]);
  }
});

test('a failed create surfaces HTTP status as create_failed', async () => {
  const calls = { provision: [], create: [], vitals: [], root: [] };
  const api = await mockCloud({ calls, createStatus: 409 });
  const child = await mockChild({ calls });
  try {
    await assert.rejects(spawner(calls).spawn(SPAWN_OPTS), (e) => e.code === 'create_failed' && /409/.test(e.message));
  } finally {
    await Promise.all([stopServer(api), stopServer(child)]);
  }
});

test('a child that never becomes ready ends as not_ready after the deadline, sleeping 20s between probes', async () => {
  const calls = { provision: [], create: [], vitals: [], root: [] };
  const sleeps = [];
  const api = await mockCloud({ calls });
  const child = await mockChild({ calls, vitalsStatus: 503 });
  try {
    await assert.rejects(
      spawner(calls, { sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); } })
        .spawn({ ...SPAWN_OPTS, readyTimeoutMs: 150 }),
      (e) => e.code === 'not_ready',
    );
    assert.ok(calls.vitals.length >= 1, 'at least one poll happened');
    assert.equal(calls.root.length, 0); // vitals never went green, so GET / was never trusted
    for (const ms of sleeps) assert.equal(ms, 20_000);
  } finally {
    await Promise.all([stopServer(api), stopServer(child)]);
  }
});

test('without app_url the child URL is built from the app id and the parent gateway domain', async () => {
  // The fetch that backs this test never touches the wire: Cloud API calls are answered by the
  // mock server, child calls are recorded and rejected, then get_ready times out fast.
  const calls = { provision: [], create: [], vitals: [], root: [] };
  const childUrls = [];
  const realFetch = globalThis.fetch;
  const fetchImpl = (url, init) => {
    if (String(url).startsWith('http://127.0.0.1:')) return realFetch(url, init);
    childUrls.push(String(url));
    return Promise.reject(new Error('offline by design for this test'));
  };
  const api = await mockCloud({ calls, create: { app_url: null } });
  try {
    await assert.rejects(
      spawner(calls, { fetchImpl, sleep: () => Promise.resolve() }).spawn({ ...SPAWN_OPTS, readyTimeoutMs: 20 }),
      (e) => e.code === 'not_ready',
    );
    assert.ok(childUrls.length >= 1);
    assert.deepEqual([...new Set(childUrls)], ['https://app-0001-8080.dstack-pha-prod9.phala.network/vitals']);
  } finally {
    await stopServer(api);
  }
});

test('a bad name is rejected before any request leaves the box', async () => {
  const calls = { provision: [], create: [], vitals: [], root: [] };
  const api = await mockCloud({ calls });
  try {
    await assert.rejects(spawner(calls).spawn({ ...SPAWN_OPTS, name: '9bad-name' }), (e) => e.code === 'bad_name');
    assert.equal(calls.provision.length, 0);
  } finally {
    await stopServer(api);
  }
});
