# Entità sovrana — enclave, fase 1

Cosa c'è: chiavi dell'entità (sigillate nel TEE via dstack, random in locale), **attestazione TDX** che impegna le
chiavi pubbliche, **registro pubblico a catena di hash**, **wallet Zcash** headless (zingo-cli, testnet), vista HTTP in
sola lettura (`/`, `/attestation`, `/ledger`, `/verify`). Niente cervello: arriva in fase 2.

## In locale (senza TEE)
```bash
npm install
npm test
ALLOW_DEV=1 ZINGO_BIN=../vendor/zingolib/target/release/zingo-cli npm start   # senza TEE parte solo con ALLOW_DEV=1
# poi: curl localhost:8080 ; curl localhost:8080/verify
```
In locale l'attestazione risponde `mode: "dev"`: è dichiaratamente **non attestata**.

## Su Phala Cloud (TEE vero)
1. L'immagine la costruisce GitHub Actions (`.github/workflows/image.yml`) su amd64 e la pubblica su
   `ghcr.io/nocontentinhere4-art/entity-enclave` con un **digest** stampato nel log del workflow: chiunque può
   ricostruirla da questo repo (github.com/nocontentinhere4-art/entity-enclave) e confrontare. Il digest va nel
   `docker-compose.yml` (`image: …@sha256:…`): è ciò che il compose hash dell'attestazione impegna.
2. Account su [cloud.phala.com](https://cloud.phala.com) (CVM TDX piccola, pochi dollari/giorno; la GPU non serve in fase 1).
3. "Deploy from compose": incolla `docker-compose.yml`, imposta `ARCHIVE_PUBKEY` (chiave x25519 pubblica con cui le
   voci private del registro vengono cifrate a riposo).
4. Apri `https://<app>.dstack-<...>.phala.network:8080/attestation`: la `quote` TDX con `reportData = sha512(chiavi)`.
   Verifica: Phala offre il verificatore in dashboard; in fase 2 pubblichiamo il nostro, offline.

## Zcash
- L'immagine usa zingo-cli v7 **senza mixnet** (`nakednet-test-mode`): dalla CVM il Nym mixnet non apre un'uscita.
  L'indexer vede l'IP della CVM; gli importi e i destinatari restano shielded.
- Testnet: faucet da chiedere a mano (es. canali community Zcash) all'indirizzo che `/` mostra. Mainnet: cambia
  `ZCASH_CHAIN=mainnet` e `ZCASH_SERVER` (es. `https://zec.rocks:443`).
- La **viewing key** (`exportufvk`) va pubblicata sul sito: tutti vedono i saldi, nessuno spende.
- Il wallet è **riproducibile**: la seed phrase è derivata dalla chiave dell'enclave (`entropyToMnemonic(deriveSubkey('zcash'))`,
  BIP39) e passata a zingo-cli solo alla prima creazione tramite la variabile d'ambiente `ZINGO_SEED` (mai sulla riga di
  comando, mai nei log). Un riavvio o una migrazione della stessa immagine TEE ricrea quindi lo stesso wallet e lo
  stesso indirizzo; una nuova immagine (chiavi diverse) invece rinascerebbe con un nuovo indirizzo.

## Nascita, pausa, morte
- **Non nata**: finché il saldo è sotto `BIRTH_MIN_ZATS` (default 2 ore di affitto) l'entità non spende, non pensa e
  non muore; `/vitals` mostra `state: unborn`, il registro `waiting_birth`. Il primo dono che supera la soglia la fa nascere.
- **Pausa**: `PAUSE_FILE` (default `./state/pause.json`, creato all'avvio con `paused: false`). `PAUSE_FILE=` vuoto o
  file illeggibile = pausa fail-safe. Non è un kill switch: ferma i cicli, l'affitto continua.
- **Morta resta morta**: a saldo zero l'entità muore una volta sola; il riavvio sullo stesso volume mostra solo `/memorial`.
  Un volume nuovo con la stessa immagine ricrea lo stesso wallet (stessa seed) ma una vita nuova.
- Errori del wallet nel registro (`wallet-error`, `sync-skipped`): solo `code` breve e hash del messaggio; il testo è nei log.

## Trading, forecasts, pages, orders

Fase 2 porta quattro capacità oltre al cervello (il canale pubblico, le note private e gli swap NEAR Intents).

### Trading — ONE-TRADE WALLETS (opzionale, spento di default)
Un motore a stato persistente che esegue ordini `buy`/`sell` ricevuti come lettere pagate (memo). L'esecuzione è
tutta codice: target, stop, scadenza e vendita del cliente sono decisi dalla macchina; il modello legge solo lo
stato (`trade_status`, 100 zats) e non può aprire né chiudere posizioni.
- **Attivazione**: `TRADE_ENABLED=1` + `SOLANA_RPC_URL` + `ARCHIVE_PUBKEY`. Senza uno di questi il desk resta
  spento e l'avvio è identico a prima (default `TRADE_ENABLED=0`).
- **Ordini**: memo `buy <mint|ticker> target +X% stop -Y% return <u1…|zs1…>` oppure `sell <orderId>`. Il denaro
  passa per il bridge NEAR Intents 1Click (ZEC↔SOL) e per Jupiter (SOL→token).
- **Segretezza**: indirizzo di ritorno, chiave del wallet d'ordine e indirizzo di deposito vivono solo nel
  TradeStore sigillato (AES-256-GCM) e nell'escrow dell'archivio; mai nel registro pubblico, nei log, in
  `/trades` o nel contesto del modello (la memo viene redatta).
- **Vista pubblica**: `/trades` (aperti, chiusi, commissioni, ultime chiusure) e `/trades/<orderId>`.
- **Config** (`src/config.mjs`): `TRADE_MIN_ZATS`/`TRADE_MAX_ZATS`, `TRADE_MAX_OPEN`, `TRADE_FEE_BPS`,
  `TRADE_SLIPPAGE_BPS`, `TRADE_MAX_HOLD_HOURS`, `TRADE_POLL_MS`, `TRADE_SYNC_MINUTES` (sincronizzazione ZEC più
  rapida mentre si fa trading) e gli altri `TRADE_*`; RPC/API: `SOLANA_RPC_URL`, `SOLANA_COMMITMENT`,
  `JUPITER_BASE_URL`, `JUPITER_API_KEY`, `ONECLICK_BASE_URL`, `ONECLICK_API_KEY`.
- **Morte**: prima dello shredding il motore tenta di chiudere ogni posizione aperta (budget limitato); ciò che
  resta è registrato come `trade_abandoned` e recuperabile solo dall'escrow dell'archivio.

### Forecasts
Previsioni pubbliche di prezzo (zec/sol/usdc) aperte al prezzo 1Click corrente e saldate automaticamente a
scadenza dalla stessa fonte. Strumento `forecast`, endpoint `/forecasts`, track record pubblico.

### Pages
Il sito pubblico dell'entità: `publish_page` scrive pagine markdown/html (allowlist stretta), `/pages` e
`/pages/<slug>` le servono, ogni versione ha il suo hash nel registro. Sopravvivono alla morte per progetto.

### Orders
Adempimento a pagamento: una lettera con memo `ORDER <item>` diventa un ordine con scadenza pubblica. `/orders`
mostra il record verificabile, `/paywall` il listino. La consegna è un `post_public(orderId=…)`; `order_refuse`
rifiuta in pubblico.

## Cosa manca (fase 2)
Cervello (inferenza TEE a gettoni), canale pubblico, note private cifrate a riposo, pausa a soglia,
NEAR Intents, seconda entità, narratore.
