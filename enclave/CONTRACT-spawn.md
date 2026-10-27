# Contract: `src/phala/spawn.mjs` — give birth to a new entity (a new CVM on Phala Cloud)

Write ONE module, `src/phala/spawn.mjs` (ES module, Node 22, no new dependencies beyond what is in package.json:
`@phala/dstack-sdk` is already there and exposes `encryptEnvVars` at `@phala/dstack-sdk/encrypt-env-vars`), plus its
test `tests/spawn.test.mjs` (node:test, no network: a local `http.createServer` mock). Do not touch any other file.

## Phala Cloud API (verified against the official SDK @phala/cloud 0.4.0 and docs)
Base URL `https://cloud-api.phala.com/api/v1`. Auth header: `X-API-Key: <apiKey>`. JSON in and out.

1. `POST /cvms/provision` body:
```json
{ "name": "<5-63 chars, letters/digits/hyphens, starts with a letter>",
  "compose_file": { "name": "<same name>", "docker_compose_file": "<the docker-compose YAML as a string>",
                    "allowed_envs": ["REDPILL_API_KEY", "PHALA_API_KEY", "PEER_URL", "PARENT_URL", "ARCHIVE_PUBKEY", "..."],
                    "kms_enabled": true, "gateway_enabled": true, "public_logs": false, "public_sysinfo": false },
  "vcpu": 1, "memory": 2048, "disk_size": 20, "node_id": <optional integer> , "image": "<optional os image name>" }
```
   Response (fields we use): `app_id` (string), `compose_hash` (string), `app_env_encrypt_pubkey` (hex string, may be
   `null`), `node_id`/`teepod_id`, `os_image_hash`. Provision data is cached server-side ~14 days.
2. Encrypt the env for the new CVM: `encryptEnvVars([{key, value}, ...], app_env_encrypt_pubkey)` from
   `@phala/dstack-sdk/encrypt-env-vars` → hex string. If the pubkey is null, call `GET /kms/<kms_id>/pubkey?app_id=<app_id>`
   is NOT available to us: throw `err('no_env_pubkey')` instead (do not guess).
3. `POST /cvms` body: `{ "app_id", "compose_hash", "encrypted_env": "<hex>", "env_keys": ["REDPILL_API_KEY", ...] }`
   Response (fields we use): `id` (number), `app_id`, `name`, `status`, `app_url` (string or null), `vm_uuid`.
4. The public URL of a CVM port 8080 on Phala follows `https://<app_id>-8080.<gateway domain>`; the gateway domain is the
   one of the parent (pass it in: `gatewayDomain`, e.g. `dstack-pha-prod9.phala.network`). If the response has
   `app_url`, prefer it; otherwise build `https://${app_id}-8080.${gatewayDomain}`.
5. Poll readiness: `GET <url>/vitals` until HTTP 200 and JSON with `state` (max `readyTimeoutMs`, default 15 min,
   poll every 20 s). Return as soon as `/` answers with `zcash.address` (the child's wallet address).

## API of the module
```js
export class PhalaSpawner {
  constructor({ apiKey, baseUrl = 'https://cloud-api.phala.com/api/v1', gatewayDomain, fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) })
  /** Provision + create + wait. Returns { appId, cvmId, url, address, composeHash }.
   *  opts: { name, composeYaml, env: { KEY: value, ... }, vcpu = 1, memory = 2048, diskSize = 20, nodeId = null, image = null, readyTimeoutMs = 900000 } */
  async spawn(opts)
}
/** Pure helper, exported for tests: builds the provision body from opts (allowed_envs = Object.keys(env)). */
export function provisionBody(opts)
/** Pure helper: child URL from app id + gateway domain. */
export function childUrl(appId, gatewayDomain)
```
Errors: throw `Error` objects with a short `code` property: `provision_failed` (with HTTP status in the message),
`no_env_pubkey`, `create_failed`, `not_ready` (timeout), `bad_name`. Never log or include the apiKey or env values in
messages or errors; redact them if they could appear.

## Test (tests/spawn.test.mjs)
Spin a local http server that implements `/cvms/provision`, `/cvms`, and a fake child `/vitals` and `/` on another
local port; use `fetchImpl` = global fetch pointed at `baseUrl = http://127.0.0.1:<port>` and `gatewayDomain` such that
`childUrl` resolves to the fake child (simplest: make the fake server also answer `app_url` in the create response and
have `spawn` prefer it). Assert: headers carry `X-API-Key`; the provision body has `name`, `compose_file.docker_compose_file`,
`compose_file.allowed_envs` = env keys, `vcpu/memory/disk_size`; the create body has `app_id`, `compose_hash`,
`encrypted_env` (hex, non-empty, decryptable is NOT required) and `env_keys`; the result has `address` from the fake
child. Also test `provisionBody` rejects a bad name (`bad_name`) and that a `null` pubkey throws `no_env_pubkey`.
Run `node --test tests/spawn.test.mjs` and `node --check src/phala/spawn.mjs`; both must pass.
