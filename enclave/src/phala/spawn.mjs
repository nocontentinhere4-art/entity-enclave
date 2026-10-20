// Give birth to a new entity: a fresh CVM on Phala Cloud.
// Contract: CONTRACT-spawn.md. Cloud API https://cloud-api.phala.com/api/v1, JSON in and out,
// auth is a single X-API-Key header. Flow: POST /cvms/provision (shape cached server-side ~14
// days) -> x25519-encrypt the env vars for the child's own key -> POST /cvms -> poll the child
// until /vitals answers 200 with a `state` and `GET /` answers with its `zcash.address`.
// No secrets cross an error path: names and app ids only, never the apiKey or env values.
import { encryptEnvVars } from '@phala/dstack-sdk/encrypt-env-vars';

function err(code, msg) { const e = new Error(msg); e.code = code; return e; }

// <name>: 5-63 chars, letters/digits/hyphens, starts with a letter.
const NAME_RE = /^[A-Za-z][A-Za-z0-9-]{4,62}$/;
const POLL_MS = 20_000;
const READY_TIMEOUT_MS = 900_000; // 15 min

/**
 * Pure: build the POST /cvms/provision body from spawn opts.
 * `allowed_envs` is exactly Object.keys(opts.env), in insertion order.
 * Throws code `bad_name` for a name outside the cloud's contract.
 */
export function provisionBody(opts = {}) {
  const name = opts.name ?? '';
  if (!NAME_RE.test(name)) {
    throw err('bad_name', `invalid CVM name: needs 5-63 chars, letters/digits/hyphens, starting with a letter`);
  }
  const env = opts.env ?? {};
  const body = {
    name,
    compose_file: {
      name,
      docker_compose_file: opts.composeYaml ?? '',
      allowed_envs: Object.keys(env),
      kms_enabled: true,
      gateway_enabled: true,
      public_logs: false,
      public_sysinfo: false,
    },
    vcpu: opts.vcpu ?? 1,
    memory: opts.memory ?? 2048,
    disk_size: opts.diskSize ?? 20,
  };
  // Optional per the API: only present when the caller pinned them.
  if (opts.nodeId != null) body.node_id = opts.nodeId;
  if (opts.image != null) body.image = opts.image;
  return body;
}

/** Pure: public URL of the child's port 8080, under the parent's gateway domain. */
export function childUrl(appId, gatewayDomain) {
  return `https://${appId}-8080.${gatewayDomain}`;
}

export class PhalaSpawner {
  #apiKey; #baseUrl; #gatewayDomain; #fetchImpl; #sleep;

  constructor({
    apiKey,
    baseUrl = 'https://cloud-api.phala.com/api/v1',
    gatewayDomain,
    fetchImpl = globalThis.fetch,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = {}) {
    this.#apiKey = apiKey;
    this.#baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.#gatewayDomain = gatewayDomain;
    this.#fetchImpl = fetchImpl;
    this.#sleep = sleep;
  }

  /**
   * Provision + create + wait. Returns { appId, cvmId, url, address, composeHash }.
   * opts: { name, composeYaml, env, vcpu = 1, memory = 2048, diskSize = 20,
   *         nodeId = null, image = null, readyTimeoutMs = 900000 }
   */
  async spawn(opts = {}) {
    const body = provisionBody(opts); // pure; throws bad_name before anything leaves the box
    const env = opts.env ?? {};
    const readyTimeoutMs = opts.readyTimeoutMs ?? READY_TIMEOUT_MS;

    // 1. Provision: pin the compose shape server-side, learn the app id and the env pubkey.
    const provision = await this.#cloud('/cvms/provision', body, 'provision_failed');
    const appId = provision.app_id;
    const composeHash = provision.compose_hash;

    // 2. Encrypt the env for the child. No pubkey to us => fail closed rather than guess
    //    (GET /kms/<id>/pubkey is not reachable from this role).
    if (!provision.app_env_encrypt_pubkey) {
      throw err('no_env_pubkey', 'provision returned no app_env_encrypt_pubkey');
    }
    const encryptedEnv = await encryptEnvVars(
      Object.entries(env).map(([key, value]) => ({ key, value })),
      provision.app_env_encrypt_pubkey,
    ).catch(() => { throw err('no_env_pubkey', 'env encryption for the child failed to complete'); });

    // 3. Create the CVM out of the cached provision data.
    const created = await this.#cloud('/cvms', {
      app_id: appId,
      compose_hash: composeHash,
      encrypted_env: encryptedEnv,
      env_keys: Object.keys(env),
    }, 'create_failed');

    // 4. Public URL: the API's app_url is authoritative; otherwise the child lives on the
    //    parent's gateway at <app_id>-8080.<gatewayDomain>.
    const url = created.app_url
      ? String(created.app_url).replace(/\/+$/, '')
      : childUrl(created.app_id ?? appId, this.#gatewayDomain);

    // 5. Wait until the child answers with the wallet address it was born with.
    const address = await this.#awaitWalletAddress(url, readyTimeoutMs);
    return { appId, cvmId: created.id, url, address, composeHash };
  }

  async #cloud(path, payload, code) {
    let res;
    try {
      res = await this.#fetchImpl(`${this.#baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': this.#apiKey },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      throw err(code, `POST ${path} failed before an answer arrived: ${e?.name ?? 'network error'}`);
    }
    if (!res.ok) throw err(code, `POST ${path} failed: HTTP ${res.status}`);
    try { return await res.json(); } catch { return {}; }
  }

  async #awaitWalletAddress(url, readyTimeoutMs) {
    const deadline = Date.now() + readyTimeoutMs;
    for (;;) {
      const address = await this.#walletAddress(url);
      if (typeof address === 'string' && address) return address;
      if (Date.now() >= deadline) {
        throw err('not_ready', `child reported no wallet address within ${readyTimeoutMs}ms: ${url}`);
      }
      await this.#sleep(POLL_MS);
    }
  }

  // One readiness probe: /vitals must answer 200 with a `state`; only then is `GET /` trusted
  // to carry the child's zcash.address. Anything short of that (HTTP error, bad JSON, network
  // hiccup) counts as "not yet", never as a fatal error.
  async #walletAddress(url) {
    try {
      const vitalsRes = await this.#fetchImpl(`${url}/vitals`);
      if (!vitalsRes.ok) return null;
      const vitals = await vitalsRes.json();
      if (!vitals || typeof vitals !== 'object' || !vitals.state) return null;
      const rootRes = await this.#fetchImpl(`${url}/`);
      if (!rootRes.ok) return null;
      const root = await rootRes.json();
      const address = root?.zcash?.address;
      return typeof address === 'string' && address ? address : null;
    } catch { return null; } // unreachable yet: keep polling
  }
}
