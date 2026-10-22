// FROZEN TRADE INTERFACE (plan §13, phase 0).
//
// This module is deliberately executable-free: it exports constants and JSDoc typedefs only, so every worker can
// import it without pulling in network code. W1 (core) owns the engine that consumes these shapes; W2 (chains)
// implements the clients; W3 (wiring) composes them.
//
// Two rules that are not negotiable anywhere below:
//   1. The client's return address, the memo text, the order wallet key, the 1Click deposit address/memo and the
//      order Solana pubkey are SECRETS. They live only in the sealed TradeStore (and the archive escrow entry).
//      They must never appear in a public ledger entry, a log line, /trades, or the LLM context.
//   2. Every external action is preceded by a persisted intent. On restart the engine resumes from the store;
//      it never repeats an irreversible step just because the process died.

/** Solana wrapped-SOL mint (9 decimals). */
export const SOL_MINT = 'So11111111111111111111111111111111111111112';

/** Classic SPL Token program. */
export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

/** Token-2022 program. Rejected unless TRADE_ALLOW_TOKEN2022=1. */
export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

/** 1Click asset ids used by the bridge. */
export const ZEC_ASSET_ID = 'nep141:zec.omft.near';
export const SOL_ASSET_ID = 'nep141:sol.omft.near';

/** AAD for the sealed trade store. Changing it makes every existing store unreadable, by design. */
export const TRADE_STORE_AAD = 'sov-trade-v1';

/** Every persisted order state (plan §7.1). */
export const ORDER_STATES = Object.freeze([
  'received',    // memo parsed, pure limits passed, archive escrow written
  'screening',   // token resolved; round-trip probe in progress
  'quoted',      // 1Click deposit address obtained, not yet funded
  'depositing',  // ZEC send persisted before the action; reconciled after a crash
  'bridging',    // ZEC deposited, polling 1Click
  'buying',      // SOL arrived, Jupiter buy in flight
  'holding',     // token held, price polled
  'closing',     // sell + fee + bridge in progress
  'paying',      // close bridge submitted, waiting for ZEC payout
  'closed',      // payout confirmed, secret wiped
  'refunding',   // failure path, refund in progress
  'refunded',    // terminal: client made whole
  'failed',      // terminal (or long retry): value may remain; secret kept
  'abandoned',   // terminal: death budget exhausted; archive escrow is the recovery path
]);

/** States after which nothing is scheduled. `failed` may still hold value; the secret is kept on purpose. */
export const TERMINAL_STATES = Object.freeze(['closed', 'refunded', 'failed', 'abandoned']);

/** States that reserve ZEC out of the spendable balance (plan §7.3.2). */
export const EXPOSED_STATES = Object.freeze([
  'received', 'screening', 'quoted', 'depositing', 'bridging', 'buying', 'holding', 'closing', 'paying', 'refunding',
]);

/** Allowed close reasons (plan §5). `manual` is opt-in and not produced by v1 wiring. */
export const CLOSE_REASONS = Object.freeze(['client', 'target', 'stop', 'deadline', 'death', 'manual']);

/** Allowed failure stages (plan §5). */
export const FAILURE_STAGES = Object.freeze([
  'screen', 'quote', 'deposit', 'bridge', 'buy', 'sell', 'bridge_close', 'payout', 'holding',
]);

/** Public ledger entry types emitted by the trade engine. */
export const TRADE_LEDGER_TYPES = Object.freeze([
  'order_received', 'trade_open', 'trade_close', 'payout', 'fee', 'refund', 'refund_skipped',
  'trade_failed', 'trade_abandoned', 'trade_price_jump',
]);

/**
 * @typedef {'received'|'screening'|'quoted'|'depositing'|'bridging'|'buying'|'holding'|'closing'|'paying'|'closed'|'refunding'|'refunded'|'failed'|'abandoned'} OrderState
 * @typedef {'client'|'target'|'stop'|'deadline'|'death'|'manual'} CloseReason
 */

// ---------------------------------------------------------------------------------------------------------------
// Trade configuration (the object W3 builds in config.mjs; the engine applies the same defaults if fields are
// missing, so core tests never depend on config.mjs).
// ---------------------------------------------------------------------------------------------------------------

/**
 * @typedef {object} TradeConfig
 * @property {boolean} [enabled=false]
 * @property {number} [minZats=10_000_000]            0.1 ZEC floor
 * @property {number} [maxZats=1_000_000_000]          10 ZEC ceiling
 * @property {number} [maxOpen=5]
 * @property {number} [maxOpenZats=2_000_000_000]
 * @property {number} [maxPerClient=1]
 * @property {number} [rentReserveHours=24]
 * @property {number} [feeBps=100]                    per leg, clamped to 300
 * @property {number} [slippageBps=100]               Jupiter, clamped to 300
 * @property {number} [intentsSlippageBps=100]        1Click, clamped to 300
 * @property {number} [gasReserveLamports=5_000_000]
 * @property {number} [maxHoldHours=168]
 * @property {number} [pollMs=60_000]
 * @property {number} [bridgeTimeoutMs=2_700_000]
 * @property {number} [depositWindowMs=3_600_000]
 * @property {number} [depositGraceMs=120_000]        recovery: wait this long for a sync before re-sending ZEC
 * @property {number} [minLiquidityUsd=50_000]
 * @property {number} [maxPriceImpactPct=5]
 * @property {number} [maxRoundTripLossPct=20]
 * @property {number} [minSolLamports=10_000_000]
 * @property {number} [refundMinZats=50_000]
 * @property {number} [networkFeeZats=10_000]         ZEC network cost deducted from a refund (plan §7.7)
 * @property {boolean} [allowToken2022=false]
 * @property {number} [confirmPolls=2]
 * @property {number} [ackZats=0]
 * @property {string} [entityZcashAddress]            refundTo for the open bridge; also the fallback from ledger
 * @property {string} [entitySolanaAddress]           treasury pubkey (refundTo for the close bridge)
 */

// ---------------------------------------------------------------------------------------------------------------
// Persisted order (plan §4.1). The whole object lives AES-256-GCM-sealed; `secret` is wiped at close.
// ---------------------------------------------------------------------------------------------------------------

/**
 * @typedef {object} OrderSecret
 * @property {string} returnAddress   client shielded address (u1… or zs1…); NEVER public
 * @property {string} auth6           sha256('auth|'+returnAddress).slice(0,6)
 * @property {string} solPublicKey    base58 order wallet pubkey; NEVER public
 * @property {string} solSecretKey    base64 64-byte ed25519 secret key; NEVER public
 */

/**
 * @typedef {object} BridgeOpen
 * @property {string|null} depositAddress  1Click deposit address (secret-ish; never public)
 * @property {string|null} depositMemo     optional 1Click deposit memo
 * @property {string|null} quoteOutLamports expected SOL out, integer string
 * @property {string|null} amountIn         ZEC to send, integer string
 * @property {string|null} deadline         1Click quote deadline, ISO
 * @property {string|null} zecTxid          funding txid once sent
 * @property {number|null} attemptAt        epoch ms of the persisted send intent
 * @property {number} [sendAttempts=0]
 * @property {number} [quoteRetries=0]
 * @property {number|null} sentAt
 */

/**
 * @typedef {object} OrderEntry
 * @property {string|null} solIn      lamports spent
 * @property {string|null} tokenOut   raw token amount received
 * @property {string|null} price      SOL per whole token, decimal string
 * @property {string|null} txid
 * @property {string|null} at         ISO
 */

/**
 * @typedef {object} OrderPoll
 * @property {string|null} lastPrice
 * @property {string|null} lastAt
 * @property {number} triggerCount
 * @property {'target'|'stop'|null} triggerSide
 * @property {string|null} peak
 */

/**
 * @typedef {object} CloseBridge
 * @property {string|null} depositAddress
 * @property {string|null} depositMemo
 * @property {string|null} amountIn       lamports
 * @property {string|null} expectedZats   amountOut from the quote
 * @property {string|null} deadline
 * @property {number|null} attemptAt
 * @property {string|null} txid            origin-chain (Solana) txid
 */

/**
 * @typedef {object} OrderClose
 * @property {CloseReason|null} reason
 * @property {string|null} startedAt
 * @property {string|null} tokenAmount      raw balance read at close time
 * @property {string|null} sellRequestId
 * @property {string|null} sellTransaction  base64 Jupiter tx (secret until executed)
 * @property {string|null} sellQuoteOut
 * @property {string|null} sellSignature
 * @property {number} [sellRequotes=0]
 * @property {string|null} solOut
 * @property {string|null} price
 * @property {string|null} txid
 * @property {number|null} feeLamports
 * @property {string|null} feeSignature
 * @property {boolean} feeRecorded
 * @property {boolean} ataClosed
 * @property {CloseBridge|null} bridge
 * @property {number} bridgeRetries
 * @property {string|null} payoutZats
 * @property {string|null} payoutTxid
 * @property {number} [payAttempts]
 * @property {number|null} [payRetryAt]
 */

/**
 * @typedef {object} Order
 * @property {string} orderId                 'o' + 16 hex
 * @property {OrderState} state
 * @property {string} createdAt               ISO
 * @property {string} updatedAt               ISO
 * @property {string|null} mint
 * @property {string|null} mintQuery          literal mint or ticker from the memo (secret-ish until resolved)
 * @property {string|null} symbol
 * @property {number|null} decimals
 * @property {number|null} targetPct
 * @property {number|null} stopPct
 * @property {number} maxHoldHours
 * @property {number} zatsIn
 * @property {number} feeOpenZats
 * @property {number} swapZats
 * @property {string} clientRef               sha256('client|'+returnAddress).slice(0,16); the only public client value
 * @property {string|null} txid               funding txid
 * @property {string|null} openedAt
 * @property {string|null} closedAt
 * @property {OrderSecret|null} secret        null after close; never serialised to any public surface
 * @property {BridgeOpen|null} bridgeOpen
 * @property {OrderEntry} entry
 * @property {OrderPoll} poll
 * @property {OrderClose} close
 * @property {{requestId:string|null, transaction:string|null, amountIn:string|null, requotes:number, attempts:number}|null} buy
 * @property {{lossPct:number|null, priceImpactPct:number|null, at:string}|null} [probe]
 * @property {{leg:'zec'|'sol', reason:string, stage:string, attempts:number, bridge:CloseBridge|null, txid:string|null}|null} [refund]
 * @property {{stage:string|null, code:string|null, at:string|null}} error
 */

// ---------------------------------------------------------------------------------------------------------------
// Memo grammar (plan §3.1). Parsed by src/trade/orders.mjs.
// ---------------------------------------------------------------------------------------------------------------

/**
 * @typedef {object} MemoBuy
 * @property {'buy'} kind
 * @property {string} mintOrTicker   literal mint if it validates, else the ticker (without '$')
 * @property {string|null} mint      set when the memo carried a literal mint
 * @property {number|null} targetPct 0 < target ≤ 1000
 * @property {number|null} stopPct   0 < stop ≤ 90
 * @property {string} returnAddress  shielded address only
 */

/**
 * @typedef {object} MemoSell
 * @property {'sell'} kind
 * @property {string} orderId        ^o[0-9a-f]{16}$
 * @property {string|null} auth6     optional ^[0-9a-f]{6}$
 */

// ---------------------------------------------------------------------------------------------------------------
// Client interfaces (the frozen part of plan §13). All amounts crossing these boundaries are integer strings
// in the chain's smallest unit (zats or lamports) unless the field name says otherwise.
// ---------------------------------------------------------------------------------------------------------------

/**
 * @typedef {object} IntentsQuoteRequest
 * @property {'zec-to-sol'|'sol-to-zec'} direction
 * @property {string} amount              integer string in the origin asset's smallest unit
 * @property {string} [recipient]         destination-chain recipient
 * @property {string} [refundTo]          origin-chain refund address
 * @property {number} [slippageBps]       clamped by the client to ≤ 300
 * @property {string} [deadline]          ISO
 * @property {boolean} [dry]              pricing only: no depositAddress/deadline
 */

/**
 * @typedef {object} IntentsQuote
 * @property {string} depositAddress
 * @property {string|null} depositMemo
 * @property {string} amountIn
 * @property {string} amountOut
 * @property {string} [minAmountOut]
 * @property {string} deadline
 */

/**
 * @typedef {object} IntentsStatus
 * @property {'PENDING_DEPOSIT'|'KNOWN_DEPOSIT_TX'|'PROCESSING'|'SUCCESS'|'INCOMPLETE_DEPOSIT'|'REFUNDED'|'FAILED'|string} status
 * @property {{amountIn?:string, amountOut?:string, destinationChainTxHashes?:Array<{hash:string}>, originChainTxHashes?:Array<{hash:string}>, refundedAmount?:string, refundReason?:string}|null} [swapDetails]
 */

/**
 * @typedef {object} IntentsClient
 * @property {(req: IntentsQuoteRequest) => Promise<IntentsQuote>} quote
 * @property {(req: {depositAddress:string, depositMemo?:string|null}) => Promise<IntentsStatus>} [status]
 * @property {(req: {depositAddress:string, txHash:string}) => Promise<unknown>} [submitDeposit]
 */

/**
 * @typedef {object} JupiterOrderRequest
 * @property {string} inputMint
 * @property {string} outputMint
 * @property {string} amount          raw integer string
 * @property {string} [taker]         omit for a quote-only price probe (transaction === null)
 * @property {number} [slippageBps]
 */

/**
 * @typedef {object} JupiterOrder
 * @property {string|null} transaction  base64 v0 tx; null = quote-only; "" = quoted but unbuildable
 * @property {string|null} requestId
 * @property {string} outAmount
 * @property {string|null} router
 * @property {number|null} [priceImpactPct]
 * @property {string|null} [errorCode]
 * @property {string|null} [errorMessage]
 */

/**
 * @typedef {object} JupiterExecuteRequest
 * @property {string} transaction     base64 unsigned tx from jupiter.order
 * @property {string} requestId
 * @property {Uint8Array} [secretKey] 64-byte order-wallet key used to sign before /execute
 */

/**
 * @typedef {object} JupiterExecuteResult
 * @property {'Success'|'Failed'|string} status
 * @property {string|null} signature
 * @property {number|null} code        0 = success; -1005 blockhash expired; -2003 RFQ expired
 * @property {string} [totalInputAmount]
 * @property {string} [inputAmountResult]
 * @property {string} [totalOutputAmount]
 * @property {string} [outputAmountResult]
 * @property {string|null} [error]
 */

/**
 * @typedef {object} JupiterClient
 * @property {(req: JupiterOrderRequest) => Promise<JupiterOrder>} order
 * @property {(req: JupiterExecuteRequest) => Promise<JupiterExecuteResult>} execute
 * @property {(req: {query:string, minLiquidityUsd?:number, allowToken2022?:boolean}) => Promise<JupiterToken>} [resolveToken]
 */

/**
 * @typedef {object} JupiterToken
 * @property {string} id
 * @property {string} symbol
 * @property {number} decimals
 * @property {boolean} [isVerified]
 * @property {number} [liquidity]
 * @property {number} [holderCount]
 * @property {string} [tokenProgram]
 * @property {{mintAuthorityDisabled?:boolean, freezeAuthorityDisabled?:boolean, topHoldersPercentage?:number, isSus?:boolean}} [audit]
 */

/**
 * @typedef {object} TokenAccount
 * @property {string} mint
 * @property {string} amount     raw integer string
 * @property {number} decimals
 * @property {string} [ata]
 * @property {string} [programId]
 */

/**
 * @typedef {object} SolanaClient
 * @property {(pubkey:string) => Promise<number|string>} balance                    lamports
 * @property {(owner:string) => Promise<TokenAccount[]>} getTokenAccounts
 * @property {(signedTransaction:string) => Promise<string>} send                   base64 → signature
 * @property {(signature:string, opts?:{timeoutMs?:number}) => Promise<{confirmed:boolean, err?:unknown}>} confirm
 * @property {(req:{secretKey:Uint8Array, to:string, lamports:number|string, orderId:string}) => Promise<{signature:string}>} [transferSol]
 * @property {(req:{secretKey:Uint8Array, mint:string}) => Promise<{signature:string}>} [closeTokenAccount]
 */

/**
 * @typedef {object} TreasuryClient
 * @property {string} [pubkey]                                                        entity Solana treasury
 * @property {(req:{secretKey:Uint8Array, lamports:number|string, orderId:string}) => Promise<{signature:string, lamports?:number|string}>} payFee
 * @property {(req:{to:string, lamports:number|string, orderId:string}) => Promise<{signature:string}>} [send]  from the treasury
 */

/**
 * @typedef {object} ZcashClient
 * @property {() => Promise<{total_zatoshis?:number}>} balance
 * @property {(to:string, zats:number, memo?:string) => Promise<{txid:string}>} send
 * @property {() => Promise<Array<{txid:string, kind:string, status?:string, value:number, recipient?:string|null, datetime?:string, memos?:string[]}>>} [valueTransfers]
 */

/**
 * @typedef {object} LedgerClient
 * @property {(type:string, data:object) => unknown} append
 * @property {(type:string, ciphertext:string) => unknown} appendPrivate
 * @property {(types:string[], limit?:number) => Array<{type:string,data:object,ts:string}>} [recent]
 * @property {() => Array<{type:string,data:object,ts:string}>} [all]
 */

/**
 * Frozen store surface. `save`/`load` operate on the whole state document; `forget` wipes one order's secret
 * from BOTH the primary file and `.bak`.
 *
 * @typedef {object} TradeStoreLike
 * @property {() => Promise<TradeState>} load
 * @property {(state:TradeState) => Promise<void>} save
 * @property {(orderId:string) => Promise<Order|null>} forget
 */

/**
 * @typedef {object} TradeState
 * @property {1} v
 * @property {string|null} updatedAt
 * @property {Record<string, Order>} orders
 * @property {Array<{at:string, op:string, orderId?:string, [k:string]:unknown}>} journal
 */

// ---------------------------------------------------------------------------------------------------------------
// Public ledger payloads (plan §5). The engine emits EXACTLY these keys — no extras, no free-form text.
// ---------------------------------------------------------------------------------------------------------------

/**
 * @typedef {object} OrderReceivedData
 * @property {string} orderId
 * @property {number} zats
 * @property {string} mint
 * @property {string} symbol
 * @property {number|null} targetPct
 * @property {number|null} stopPct
 * @property {number} maxHoldHours
 * @property {string} clientRef
 * @property {string} txid
 */

/**
 * @typedef {object} TradeOpenData
 * @property {string} orderId
 * @property {string} mint
 * @property {string} solIn
 * @property {string} tokenOut
 * @property {number} decimals
 * @property {string} price
 * @property {string} txid
 * @property {string} at
 */

/**
 * @typedef {object} TradeCloseData
 * @property {string} orderId
 * @property {CloseReason} reason
 * @property {string} solOut
 * @property {string} price
 * @property {string} txid
 * @property {number} heldMs
 * @property {'discarded'} wallet
 */

/**
 * @typedef {object} PayoutData
 * @property {string} orderId
 * @property {number} zats
 * @property {string|null} txid
 */

/**
 * @typedef {object} FeeData
 * @property {string} orderId
 * @property {number} zats
 * @property {'open'|'close'} leg
 * @property {number} [sol]  only on the close leg
 */

/**
 * @typedef {object} RefundData
 * @property {string} orderId
 * @property {number} zats
 * @property {string|null} txid
 * @property {string} reason
 */

/**
 * @typedef {object} TradeFailedData
 * @property {string} orderId
 * @property {string} stage
 * @property {string|null} code
 */

/**
 * @typedef {object} TradeAbandonedData
 * @property {string} orderId
 * @property {string} stage
 * @property {'archive'} escrow
 */

// ---------------------------------------------------------------------------------------------------------------
// Engine-facing helpers exported as types only; implementations live in W1 modules.
// ---------------------------------------------------------------------------------------------------------------

/**
 * @typedef {object} IngestInput
 * @property {string} txid    funding txid
 * @property {number} zats
 * @property {string} text    raw memo text (the first line is the trade instruction)
 * @property {string} [at]    ISO
 */

/**
 * @typedef {object} IngestResult
 * @property {'accepted'|'duplicate'|'ignored'|'rejected'|'refunded'} status
 * @property {string} [orderId]
 * @property {string} [code]
 */
