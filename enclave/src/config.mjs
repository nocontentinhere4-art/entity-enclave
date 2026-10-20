// The only module allowed to read process.env: everything else receives config by injection.
// Defaults target local development; a TEE deployment overrides them through the environment.

const num = (raw, fallback) => {
  const n = Number(raw);
  return raw === undefined || raw === '' || !Number.isFinite(n) ? fallback : n;
};
const bool = (raw, fallback) => (raw === undefined || raw === '' ? fallback : raw === '1' || raw === 'true');

function loadProviders() {
  const list = process.env.LLM_PROVIDERS
    ? JSON.parse(process.env.LLM_PROVIDERS)
    // OpenAI-compatible endpoints only. `apiKeyEnv` names the secret; the value is resolved just below.
    : [
        // Open-weight models served in TEEs via Redpill (Phala). Both speeds on one key: REDPILL_API_KEY.
        { name: 'redpill-fast', baseUrl: 'https://api.redpill.ai/v1', model: 'z-ai/glm-5.3-flash', speed: 'fast', pricePerMTokZats: 100_000, apiKeyEnv: 'REDPILL_API_KEY' },
        { name: 'redpill-deep', baseUrl: 'https://api.redpill.ai/v1', model: 'z-ai/glm-5.3', speed: 'deep', pricePerMTokZats: 600_000, apiKeyEnv: 'REDPILL_API_KEY' },
      ];
  if (!Array.isArray(list) || list.length === 0) throw new Error('LLM_PROVIDERS must be a non-empty JSON array');
  // Resolve the keys here: config is the only module allowed to read the environment.
  return list.map((p) => (p.apiKeyEnv && process.env[p.apiKeyEnv] ? { ...p, apiKey: process.env[p.apiKeyEnv] } : p));
}

const providers = loadProviders();
// Fake brain by default locally, but a configured provider key opts into the real one. Set FAKE_LLM=0 explicitly in production.
const anyRealKey = providers.some((p) => p.apiKeyEnv && process.env[p.apiKeyEnv]);

// TICK_MS/HUNGER_TICK_MS (milliseconds) win over the minutes variants when set: handy for fast local runs.
const minutes = (msEnv, minEnv, fallback) => {
  const ms = num(process.env[msEnv], null);
  return ms !== null && ms > 0 ? ms / 60_000 : num(process.env[minEnv], fallback);
};

const rentZatsPerHour = num(process.env.RENT_ZATS_PER_HOUR, 1_000_000);

export const config = {
  tickMinutes: minutes('TICK_MS', 'TICK_MINUTES', 5),
  // One deep (expensive) thought every N cycles; the others are fast and cheap. Hunger forces fast.
  deepEvery: Math.max(1, num(process.env.DEEP_EVERY, 4)),
  hungerTickMinutes: minutes('HUNGER_TICK_MS', 'HUNGER_TICK_MINUTES', 60),
  // Wallet re-sync cadence: the entity only sees incoming ZEC after a sync, so it keeps syncing in the background.
  syncMinutes: minutes('SYNC_MS', 'SYNC_MINUTES', 10),
  initialTreasuryZats: num(process.env.INITIAL_TREASURY_ZATS, 100_000_000),
  hungerThreshold: 0.2,
  hungerRecover: 0.3,
  rentAddress: process.env.RENT_ADDRESS ?? '',
  rentZatsPerHour,
  // An entity is unborn until its treasury has ever reached this threshold: two hours of rent by default.
  birthMinZats: num(process.env.BIRTH_MIN_ZATS, rentZatsPerHour * 2),
  archivePub: process.env.ARCHIVE_PUBKEY ?? '',
  fakeLlm: bool(process.env.FAKE_LLM, !anyRealKey),
  providers,
  pauseFile: process.env.PAUSE_FILE ?? './state/pause.json',
  // Wiring knobs for the service (index.mjs); still read only here.
  stateDir: process.env.STATE_DIR ?? './state',
  port: num(process.env.PORT, 8080),
  charterPath: process.env.CHARTER_PATH ?? './charter.md',
  // The other entity's public base URL (its /, /vitals, /public-channel …). Empty until the second one exists.
  peerUrl: (process.env.PEER_URL ?? '').trim() || null,
  allowDev: bool(process.env.ALLOW_DEV, false),
  fakeWallet: bool(process.env.FAKE_WALLET, false),
  fakeBalanceZats: num(process.env.FAKE_BALANCE_ZATS, 5_000_000),
  zcashServer: process.env.ZCASH_SERVER ?? 'https://testnet.zec.rocks:443',
  zcashChain: process.env.ZCASH_CHAIN ?? 'testnet',
  // Wallet birthday height used when the wallet is (re)created from the enclave seed. 0 = scan from genesis.
  zcashBirthday: num(process.env.ZCASH_BIRTHDAY, (process.env.ZCASH_CHAIN ?? 'testnet') === 'testnet' ? 4460000 : 0),
  zingoBin: process.env.ZINGO_BIN ?? 'zingo-cli',
  nymProxy: process.env.NYM_PROXY,
  // Hard ceiling on a single model call: a slow provider must never hang the entity.
  llmTimeoutMs: num(process.env.LLM_TIMEOUT_MS, 60_000),
  // Wallet directories to shred on death. Empty for the in-memory fake wallet (it leaves no files behind);
  // the service fills it in when it builds a real wallet.
  walletPaths: process.env.WALLET_PATHS
    ? process.env.WALLET_PATHS.split(',').map((s) => s.trim()).filter(Boolean)
    : [],
};
