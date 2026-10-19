# Fase 2 — contratto tra moduli (ESM `.mjs`, Node 22, zero nuove dipendenze salvo quelle già in package.json)

Convenzioni: niente TypeScript, niente framework, niente `exec`/shell. Ogni modulo esporta funzioni pure o una classe
con dipendenze passate al costruttore (`{ ledger, wallet, keys, memory, pricing, log }`). Nessun modulo legge
`process.env` tranne `src/config.mjs`. Errori: lanciare `Error` con `code` (`insufficient_funds`, `paused`,
`attestation_rejected`, `not_in_pricelist`). Tutto ciò che è pubblico va nel registro con `ledger.append(type, data)`;
tutto ciò che è privato con `ledger.appendPrivate(type, ciphertext)` dove `ciphertext = keys.sealPrivate(archivePub, text)`.

## Già esistenti (non toccare)
- `src/ledger.mjs`: `new Ledger(path)`, `append(type, data)`, `appendPrivate(type, ciphertextB64)`, `Ledger.verify(path)`, `.seq`, `.head`.
- `src/keys.mjs`: `loadKeys({dstack, statePath})` → `{ mode, signPublicKey, boxPublicKey, sign(msg), sealPrivate(archivePubHex, text) }`.
- `src/zcash.mjs`: `new ZcashWallet({bin, dataDir, server, chain, nymProxy})` → `init()`, `balance()` (oggetto con `total_zatoshis`), `sync()`, `send(to, zatoshis, memo)`, `viewingKey()`, `birthday()`.
- `src/attestation.mjs`: `connectDstack()`, `attest(dstack, keys)`.

## Da scrivere
### `src/config.mjs`
`export const config = { tickMinutes, hungerTickMinutes, initialTreasuryZats, hungerThreshold (0.2), hungerRecover (0.3), rentAddress, rentZatsPerHour, archivePub, fakeLlm (bool), providers: [{name, baseUrl, model, speed:'fast'|'deep', pricePerMTokZats}], pauseFile }` letto da `process.env` con default sensati per il test locale.

### `src/memory/store.mjs`
`export class MemoryStore { constructor({ path, key /* Uint8Array 32 */ }); load(): Memory; save(m: Memory); appendEvent(e); wipe() }`.
AES-256-GCM via WebCrypto, file atomico (scrivi `.tmp` poi rename), backup `.bak` dell'ultima versione valida.
`Memory = { identity: {name, voice, image}, plan: string, personalRules: string[], promises: [], will: {text, transfers: []}, relationships: {}, events: [ultimi 50 {ts, type, summary}], daily: [{date, summary}] }`.

### `src/life/promises.mjs`
`export class Promises { constructor({ ledger, memory }); make(to, what, dueIso): id; keep(id); break(id, reason); open(): [] }`. Ogni azione è una voce pubblica `promise`, `promise_kept`, `promise_broken`. Promessa senza scadenza → errore.

### `src/life/signals.mjs`
`export function signals(history /* [{ts, zatoshis}] */ , rentZatsPerHour): { daysLeft, lifeSlopePerDay, incomeRhythmPerDay }` puro.

### `src/economy/pricing.mjs`
`export const PRICES = { read_url: 1000, search: 2000, post_public: 500, post_private: 500, diary: 100, send_zec: 1000, swap_zec_sol: 5000, balance: 0, sleep: 0, set_identity: 2000, paywall_set: 500, bounty_post: 1000, will: 100, think_fast: 20000, think_deep: 200000 }` (zatoshi).
`export class Pricing { constructor({ ledger }); quote(action, treasuryZats): {costZats, affordable}; charge(action, tickId): costZats }`: addebito idempotente per `(action, tickId)`, voce pubblica `charge`. Azione non in listino → `not_in_pricelist`.

### `src/economy/rent.mjs`
`export class Rent { constructor({ ledger, wallet, config }); hoursLeft(treasuryZats): number; hunger(treasuryZats): 'ok'|'hungry' (isteresi 20%/30% sul tesoro iniziale); isLastHour(treasuryZats): bool; payHour(): Promise<{txid}> }` (voce pubblica `rent_paid`).

### `src/economy/death.mjs`
`export async function die({ ledger, memory, wallet, keys, reason }): Promise<void>`: esegue `memory.will.transfers` (ogni transfer = `{to, zats, memo}`) via `wallet.send`, pubblica `last_words` (pubblico) e `death` (pubblico, con hash finale della memoria), poi `memory.wipe()` e cancella i file del wallet. Non torna mai all'esecuzione normale: chi la chiama fa `process.exit(0)`.

### `src/safety/pause.mjs`
`export async function paused(config): Promise<{paused: boolean, reason?: string}>`: v1 legge `config.pauseFile` (JSON `{paused, since}`); se il file non è leggibile → `{paused: true, reason: 'fail-safe'}`.

### `src/llm/infer.mjs`
`export class Inference { constructor({ config, ledger, pricing }); async think({ context, speed, tools, tickId }): Promise<{ text, toolCalls: [{name, args}], provider, model, tokens, costZats, attestation }> }`.
Provider `fake` quando `config.fakeLlm`: deterministico dal `sha256(context)`: restituisce una sequenza fissa di tool call per i test (`read_url` → `diary` → `post_public` → `balance`), 500 token finti.
Provider HTTP OpenAI-compatibile (`/v1/chat/completions`, tool calling) per NEAR AI/Phala: header Authorization dal `config.providers[i].apiKeyEnv` (mai loggata), e se la risposta porta un campo di attestazione lo salva; `verifyAttestation` v1 = presenza + formato, con TODO esplicito per la verifica della firma.
Ogni chiamata: `pricing.charge('think_fast'|'think_deep', tickId)` e voce pubblica `tick_llm {provider, model, tokens, costZats, respHash}`.

### `src/tools/registry.mjs`
`export class Tools { constructor({ ledger, wallet, memory, pricing, keys, config, channels }); list(): [{name, description, parameters(JSON schema)}]; async call(name, args, tickId): Promise<any> }`.
Whitelist: `read_url(url)` (fetch GET, max 200 KB, timeout 10 s, solo http/https), `search(q)` (stub: ritorna []), `post_public(text)`, `post_private(text)` (per l'altra entità: v1 = voce privata `to_other`), `diary(text)` (privata), `send_zec(to, zats, memo)`, `swap_zec_sol(zats)` (stub che registra l'intenzione), `balance()`, `sleep(hours)` (imposta `memory.sleepUntil`), `set_identity(name, voice, image)`, `paywall_set(item, priceZats)`, `bounty_post(text, rewardZats)`, `will(text, transfers)`, `promise(to, what, due)`.
Ogni call: `pricing.quote` → se non affordable lancia `insufficient_funds`; poi `pricing.charge`; poi esegue; voce pubblica `tool {name, argsHash, ok}` (gli argomenti dei tool privati non vanno in chiaro).

### `src/life/loop.mjs`
`export class Life { constructor({ config, ledger, wallet, memory, pricing, rent, inference, tools, promises, charter /* string */ }); async tick(trigger='timer'): Promise<void>; buildContext(): string; start() }`.
`tick`: 1) `paused` → voce `paused`, return; 2) saldo → `rent.isLastHour` → `die`; 3) fame → velocità/intervallo; 4) contesto = carta + numeri vitali + segnali + memoria + eventi; 5) `inference.think`; 6) esegue i tool call in ordine (max 8 per tick); 7) `rent.payHour` se è passata un'ora; 8) salva memoria; 9) consolidamento notturno una volta al giorno (`dailyReview`: chiede al modello di riscrivere `plan` e `personalRules`, mai la carta).
`start()`: loop auto-schedulato (`setTimeout` dopo `await tick()`), intervallo da `config` e fame.

### Test minimi (`tests/*.test.mjs`, node:test)
pricing (idempotenza, not_in_pricelist), memory (roundtrip cifrato + backup), promises (senza scadenza → errore), signals (puro), loop con `fakeLlm` e wallet finto: 6 tick riproducibili, ogni azione addebitata, fame sotto soglia, pausa ferma senza wipe, ultima ora → `death` nel registro.
