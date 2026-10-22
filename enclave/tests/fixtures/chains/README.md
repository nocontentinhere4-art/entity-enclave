# Chain fixtures

Ground-truth bytes and HTTP response shapes for the `src/trade/*` chain tests. Nothing here is run by
`npm test` except `generate.mjs`, which is a dev-time regenerator (not a test). Two families live here:

## 1. Solana transaction bytes (`tests/soltx.test.mjs`)

| File | What it is | How it is used |
|---|---|---|
| `soltx-real-v0.json` | A real Solana mainnet **v0** swap (base64, `getTransaction`). | `parseTransaction` must parse it and `verifyTransactionSignature` must verify the embedded signature — a non-circular anchor. |
| `soltx-real-legacy.json` | A real mainnet **legacy** transaction (slot 3,000,000). | Same verify-as-anchor discipline. |
| `soltx-real-v1.json` | A real mainnet **v1** message (first byte `0x81`). | `parseTransaction` must reject it with `unsupported_version`. |
| `jupiter-order-built.json` | A Jupiter `/swap/v2/order`-shaped **v0** tx derived from `soltx-real-v0.json`: fixture taker at slot 0 (zero pre-fill), real payer hoisted to slot 1 (JupiterZ partial-sign). | `signTransaction` must reproduce `expectedTakerSignatureBase58` and `signedTransaction` byte-for-byte. |
| `soltx-derived-transfer.json` | A legacy `SystemProgram.transfer` (1% fee, 1,210,000 lamports) built by `buildLegacyTransaction`, plus an independently hand-rolled `independentWire`. | Builder output must equal both `builderWire` and `independentWire`. |
| `soltx-ata-close.json` | A legacy SPL `closeAccount` (data `[9]`) built by `buildLegacyTransaction`. | Parser must recover program `Tokenkeg…` and data `[9]`. |
| `generate.mjs` | Regenerates the three `DERIVED` fixtures above from the real anchors. | `node tests/fixtures/chains/generate.mjs` |

Fixture keys (the four seeds used by `generate.mjs`) are `sha256(label)` of `sov-trade-{taker,maker,treasury,dest}-fixture` — no real funds.

## 2. HTTP response shapes (`tests/trade-open|trade-close.test.mjs`)

Hand-authored (not derived) — these assert the *client plumbing* (URLs, bodies, normalization), while
signing/serialization is the job of family 1.

| File | Endpoint(s) | Consumed by |
|---|---|---|
| `oneclick-quote-open.json` | 1Click `POST /v0/quote` (ZEC→SOL) | `trade-open` |
| `oneclick-quote-close.json` | 1Click `POST /v0/quote` (SOL→ZEC) | `trade-close` |
| `oneclick-statuses.json` | 1Click `GET /v0/status` ladder (`pending/processing/successOpen/successClose/failed/refunded`) | both |
| `jupiter-order.json` | Jupiter `GET /swap/v2/order` (`buy`/`sell`/`quoteOnly` shapes) | both |
| `jupiter-execute.json` | Jupiter `POST /swap/v2/execute` (`success`, code 0) | both |
| `solana-rpc.json` | Solana RPC `getBalance`/`getLatestBlockhash`/`sendTransaction`/`getSignatureStatuses` | both |

The `transaction` fields in `jupiter-order.json` are placeholder base64 markers: the open/close tests assert
the client layer (URLs and normalized fields), not the bytes — those are covered end-to-end by family 1.
