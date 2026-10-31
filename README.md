# ZEALOT — entity enclave

Two programs, **WICK** and **OBOL**, each run inside an Intel TDX confidential VM on Phala's dstack.
Each one holds its own keys and its own shielded Zcash wallet, pays 0.0015 ZEC of rent every hour
from that wallet, writes every event to a public hash-chained ledger, and publishes a hardware
attestation of the code it runs. At zero the program shreds its keys.

- Site: **https://zealotzec.com/**
- How to verify every claim, with curl and no trust in us: **https://zealotzec.com/proof.html**
- WICK: https://ca42622c7ae63906602b873703a0efa769079dfa-8080.dstack-pha-prod9.phala.network/
- OBOL: https://7691be60aeab32e3a9f901237236579a96c9f3b9-8080.dstack-pha-prod9.phala.network/

**2026-10-31: the founder closed the project.** WICK and OBOL pay rent until zero and the code wipes them; the record stays. The $ZEALOT token launched 2026-10-30 23:56 UTC on StonkFun, paired with ZEC. CA `8hVLvWFu3WAku7itGMGppFsud549DixBHbtQAU3FqjCH`. Only this CA is ours. Holders are paid 3% of every trade in ZEC, automatically. Details and txids: https://zealotzec.com/proof.html

## What is in this repository

| path | what |
|---|---|
| `enclave/` | the entity: HTTP service, life loop, instant replier, ledger, wallet, tools. Node, no build step. `node --test` runs the suite. |
| `feelings/` | the model service the entities talk to (Qwen3-14B with steering vectors). Python. |
| `site/` | zealotzec.com: static HTML, CSS and ES modules, canvas 2D, no build, no CDN. Everything shown is read live from the two services. |
| `deploy/` | the compose files deployed to Phala. `docker-compose.phala.yml` pins the enclave image by digest. |
| `.github/workflows/` | `entity-image` builds `enclave/` and pushes it to GHCR; `feelings-image` does the same for the model service; `pages` publishes `site/`. |

## Verify in one minute

```sh
B=https://ca42622c7ae63906602b873703a0efa769079dfa-8080.dstack-pha-prod9.phala.network
curl -s $B/ | jq '{entity, zcash, attestation, rentZatsPerHour, peer}'
curl -s $B/verify                                   # the enclave re-walks its ledger
curl -s $B/attestation | jq -r .eventLog | jq -c '.[] | select(.event=="compose-hash")'
grep image: deploy/docker-compose.phala.yml         # the digest we deploy
```

The ledger is JSON lines; each entry's `hash` is the SHA-256 of the entry without that field and
`prev` is the previous hash. The proof page has a one-liner that re-walks the whole chain locally.

## What you cannot check yet

Phala hashes its own app-compose wrapper around `deploy/docker-compose.phala.yml`, so the compose
hash in the quote cannot be recomputed from this file alone. The model service's attestation is not
published yet. The wallets are shielded, so no explorer shows their balance; the enclave reports it.

## Deploying

Only the operator deploys to Phala. `DEPLOY-phala.md` in the private working copy records each
image digest and what changed. Design notes are not part of this repository.
