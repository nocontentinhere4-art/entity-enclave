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
  initialTreasuryPinned: process.env.INITIAL_TREASURY_ZATS !== undefined && process.env.INITIAL_TREASURY_ZATS !== '',
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
  peerUrl: (process.env.PEER_URL ?? '').trim().replace(/\/+$/, '') || null,
  // Lineage. PARENT_URL is set on a child by the parent that paid its birth. SELF_URL is this entity's public URL
  // (children get it as PEER_URL/PARENT_URL). Spawning needs a Phala API key and the image reference to clone.
  parentUrl: (process.env.PARENT_URL ?? '').trim().replace(/\/+$/, '') || null,
  selfUrl: (process.env.SELF_URL ?? '').trim().replace(/\/+$/, '') || null,
  phalaApiKey: process.env.PHALA_API_KEY || null,
  imageRef: (process.env.IMAGE_REF ?? '').trim() || null,
  gatewayDomain: (process.env.GATEWAY_DOMAIN ?? 'dstack-pha-prod9.phala.network').trim(),
  spawnMinZats: num(process.env.SPAWN_MIN_ZATS, 50_000_000),   // treasury needed before a birth is allowed
  childGiftZats: num(process.env.CHILD_GIFT_ZATS, 20_000_000), // what the parent gives the newborn
  // Speaking to another entity costs: a whisper is a shielded payment with a memo (min amount, in zatoshi).
  whisperMinZats: num(process.env.WHISPER_MIN_ZATS, 10_000),
  // Multiplies every price in the list (mainnet: 0.01 brings a deep thought from 0.002 ZEC to 0.00002 ZEC ≈ its real cost).
  priceScale: Number(process.env.PRICE_SCALE) > 0 ? Number(process.env.PRICE_SCALE) : 1,
  allowDev: bool(process.env.ALLOW_DEV, false),
  fakeWallet: bool(process.env.FAKE_WALLET, false),
  fakeBalanceZats: num(process.env.FAKE_BALANCE_ZATS, 5_000_000),
  zcashServer: process.env.ZCASH_SERVER ?? 'https://testnet.zec.rocks:443',
  zcashChain: process.env.ZCASH_CHAIN ?? 'testnet',
  // Wallet birthday height used when the wallet is (re)created from the enclave seed. 0 = scan from genesis.
  zcashBirthday: num(process.env.ZCASH_BIRTHDAY, (process.env.ZCASH_CHAIN ?? 'testnet') === 'testnet' ? 4460000 : 0),
  zingoBin: process.env.ZINGO_BIN ?? 'zingo-cli',
  nymProxy: process.env.NYM_PROXY,
  // Public Nostr relays the entity publishes to (comma-separated wss:// URLs). Empty = the built-in list.
  nostrRelays: (process.env.NOSTR_RELAYS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  // Hard ceiling on a single model call: a slow provider must never hang the entity.
  llmTimeoutMs: num(process.env.LLM_TIMEOUT_MS, 60_000),
  // Paid order fulfilment: a letter whose memo matches an active paywall item becomes an order with a deadline.
  orderDeadlineHours: num(process.env.ORDER_DEADLINE_HOURS, 24),   // how long the entity has to deliver
  orderGraceHours: num(process.env.ORDER_GRACE_HOURS, 6),         // late deliveries still accepted in this window
  orderMaxOpen: num(process.env.ORDER_MAX_OPEN, 10),              // > this many open orders: new ones are refused
  orderWake: bool(process.env.ORDER_WAKE, true),                  // pending orders wake a sleeping entity
  orderRequestsMax: num(process.env.ORDER_REQUESTS_MAX, 100),     // private request texts kept in memory
  // Wallet directories to shred on death. Empty for the in-memory fake wallet (it leaves no files behind);
  // the service fills it in when it builds a real wallet.
  walletPaths: process.env.WALLET_PATHS
    ? process.env.WALLET_PATHS.split(',').map((s) => s.trim()).filter(Boolean)
    : [],
  // Forecasts: public price predictions with automatic settlement and a track record.
  forecastMaxOpen: num(process.env.FORECAST_MAX_OPEN, 3),
  forecastMinHorizonHours: num(process.env.FORECAST_MIN_HORIZON_HOURS, 1),
  forecastMaxHorizonHours: num(process.env.FORECAST_MAX_HORIZON_HOURS, 48),
  forecastSettleGraceHours: num(process.env.FORECAST_SETTLE_GRACE_HOURS, 6),
  // Market price source: the same 1Click rail used by swap_quote.
  marketPriceTtlSeconds: num(process.env.MARKET_PRICE_TTL_SECONDS, 60),
  marketMaxStaleSeconds: num(process.env.MARKET_MAX_STALE_SECONDS, 900),
  oneClickBaseUrl: process.env.ONECLICK_BASE_URL ?? 'https://1click.chaindefuser.com',
  oneClickApiKey: process.env.ONECLICK_API_KEY ?? null,
  // Public pages (capability C). PAGES_DIR defaults to <STATE_DIR>/pages in index.mjs; null means "derive it".
  pagesDir: process.env.PAGES_DIR ? process.env.PAGES_DIR.trim() : null,
  pagesMax: num(process.env.PAGES_MAX, 50),
  pagesEditsPerDay: num(process.env.PAGES_EDITS_PER_DAY, 10),
  pagesMaxBytes: num(process.env.PAGES_MAX_BYTES, 65_536),
  pagesAllowHtml: bool(process.env.PAGES_ALLOW_HTML, true),
  pagesHistoryMax: num(process.env.PAGES_HISTORY_MAX, 50),
  pagesSlugMax: num(process.env.PAGES_SLUG_MAX, 40),
  // Trading (capability T): the ONE-TRADE WALLETS engine. Fully automatic once opted in: order execution
  // is code (target/stop/deadline/client-sell), never the LLM. Disabled by default — no store, no scheduler.
  trade: {
    enabled: bool(process.env.TRADE_ENABLED, false),
    minZats: num(process.env.TRADE_MIN_ZATS, 10_000_000),                 // 0.1 ZEC floor
    maxZats: num(process.env.TRADE_MAX_ZATS, 1_000_000_000),              // 10 ZEC ceiling
    maxOpen: num(process.env.TRADE_MAX_OPEN, 5),
    maxOpenZats: num(process.env.TRADE_MAX_OPEN_ZATS, 2_000_000_000),
    maxPerClient: num(process.env.TRADE_MAX_PER_CLIENT, 1),
    rentReserveHours: num(process.env.TRADE_RENT_RESERVE_HOURS, 24),
    feeBps: Math.min(num(process.env.TRADE_FEE_BPS, 100), 300),           // per leg, clamped to 300
    slippageBps: Math.min(num(process.env.TRADE_SLIPPAGE_BPS, 100), 300), // Jupiter, clamped to 300
    intentsSlippageBps: Math.min(num(process.env.TRADE_INTENTS_SLIPPAGE_BPS, 100), 300), // 1Click, clamped to 300
    gasReserveLamports: num(process.env.TRADE_GAS_RESERVE_LAMPORTS, 5_000_000),
    maxHoldHours: num(process.env.TRADE_MAX_HOLD_HOURS, 168),
    pollMs: num(process.env.TRADE_POLL_MS, 60_000),
    syncMinutes: num(process.env.TRADE_SYNC_MINUTES, 2),                  // faster ZEC sync while trading
    bridgeTimeoutMs: num(process.env.TRADE_BRIDGE_TIMEOUT_MS, 45 * 60_000),
    depositWindowMs: num(process.env.TRADE_DEPOSIT_WINDOW_MS, 60 * 60_000),
    depositGraceMs: num(process.env.TRADE_DEPOSIT_GRACE_MS, 120_000),
    minLiquidityUsd: num(process.env.TRADE_MIN_LIQUIDITY_USD, 50_000),
    maxPriceImpactPct: num(process.env.TRADE_MAX_PRICE_IMPACT_PCT, 5),
    maxRoundTripLossPct: num(process.env.TRADE_MAX_ROUNDTRIP_LOSS_PCT, 20),
    minSolLamports: num(process.env.TRADE_MIN_SOL_LAMPORTS, 10_000_000),
    refundMinZats: num(process.env.TRADE_REFUND_MIN_ZATS, 50_000),
    networkFeeZats: num(process.env.TRADE_NETWORK_FEE_ZATS, 10_000),
    allowToken2022: bool(process.env.TRADE_ALLOW_TOKEN2022, false),
    allowManualClose: bool(process.env.TRADE_ALLOW_MANUAL_CLOSE, false),
    confirmPolls: num(process.env.TRADE_TRIGGER_CONFIRM, 2),
    ackZats: num(process.env.TRADE_ACK_ZATS, 0),
    // Chain rails. SOLANA_RPC_URL is required for trades; a dedicated RPC (public one rate-limits hard).
    rpcUrl: process.env.SOLANA_RPC_URL ?? '',
    rpcCommitment: process.env.SOLANA_COMMITMENT ?? 'confirmed',
    jupiterBase: process.env.JUPITER_BASE_URL ?? 'https://api.jup.ag',
    jupiterKey: process.env.JUPITER_API_KEY ?? '',
    oneclickBase: process.env.ONECLICK_BASE_URL ?? 'https://1click.chaindefuser.com',
    oneclickKey: process.env.ONECLICK_API_KEY ?? '',
  },
};
