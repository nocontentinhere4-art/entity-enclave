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

## Cosa manca (fase 2)
Cervello (inferenza TEE a gettoni), canale pubblico, note private cifrate a riposo, pausa a soglia,
NEAR Intents, seconda entità, narratore.
