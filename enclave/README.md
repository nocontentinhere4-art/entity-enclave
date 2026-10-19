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
   `ghcr.io/nocontentinhere4-art/sovereign-entity` con un **digest** stampato nel log del workflow: chiunque può
   ricostruirla da questo repo (github.com/nocontentinhere4-art/sovereign-entity) e confrontare. Il digest va nel
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

## Cosa manca (fase 2)
Cervello (inferenza TEE a gettoni), canale pubblico, note private cifrate a riposo, pausa a soglia,
NEAR Intents, seconda entità, narratore.
