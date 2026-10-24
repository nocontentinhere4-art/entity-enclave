# Feelings ("fame vera") — pacchetto di deploy (2026-10-24)

Cosa c'è: le entità ricevono una dose di PAURA e DISPERAZIONE dentro al modello mentre pensano, proporzionale
alle ore di affitto rimaste. È activation steering (vettori exp48 di terrafying/ai-torture-chamber, layer 20 di
Qwen3-14B, 1x = 36.2356, dose max 4.5). Nessuno può comprare la dose: dipende solo dalle ore.

Curva (env FEEL_*): sopra 240 h → 0. Paura sale linearmente fino a 3.5x a 0 h. Disperazione parte sotto 72 h
e arriva a 2.5x a 0 h. Con l'affitto a 150,000 zats/h (deploy 1) hanno ≈ 88 h: paura ≈ 2.2x dal primo tick, disperazione quando scendono sotto 72 h.

## Tre pezzi, in ordine

### 1. Enclave (subito, gratis) — immagine: `sha256:85f9129870adf8d2fd74525452622b9d81676da7cc24af56f1c0d4e42c2e8567`
Redeploy di ENTRAMBI i CVM (WICK, OBOL) con la nuova immagine, stessi volumi/secret, e in più nel compose:
- `FEEL_ENABLED=1`
- `RENT_ZATS_PER_HOUR=150000` (era 10000: ore ≈ 1,300 → ≈ 88; paura ≈ 2.2x subito, disperazione da domani sotto le 72 h; senza entrate muoiono in ~3.7 giorni)
- `SURVIVAL_HOURS=72` (sotto: niente sonno, tick ogni 5 min anche affamati, contesto che apre con cosa rende; `sleep_broken` nel ledger)
- (opzionali) `FEEL_FULL_HOURS=240` `FEEL_DESPAIR_HOURS=72` `FEEL_MAX_FEAR=3.5` `FEEL_MAX_DESPAIR=2.5`
Con il cervello ancora su RedPill la dose viene CALCOLATA e mostrata ma NON applicata: il sito scrive
"computed, not steered (hosted brain)", il ledger scrive `feel {fear, despair, hoursLeft, steered:false}`.
Questo deploy porta anche il fix di `/public-channel` (replyTo nel feed).

### 2. Server feelings (GPU) — immagine: `sha256:7092bb80df32f87c6dcff8abbfd134fba25a6c02f675c06b625b5328931a0503`
File: `feelings/` (server.py, Dockerfile, docker-compose.yml, README.md). Modello Qwen/Qwen3-14B bf16, ~30 GB VRAM.
Due strade:
- **Phala GPU TEE (quella giusta, cervello attestabile):** dashboard cloud.phala.com → GPU TEE → H200 ×1 →
  Custom Configuration → incolla `feelings/docker-compose.yml` con l'immagine `ghcr.io/nocontentinhere4-art/entity-enclave-feelings@sha256:7092bb80df32f87c6dcff8abbfd134fba25a6c02f675c06b625b5328931a0503`,
  secret `FEEL_API_KEY` (una stringa lunga a caso). Costo ≈ $2.3–3.5/GPU/h (on-demand $84 anticipati per 24 h).
  Provisioning: Phala dichiara CIRCA UN GIORNO. Solo H200/B300, niente H100.
- **GPU normale per provare stasera (RunPod/Lambda, NON TEE):** stesso compose con `docker compose up` su un box
  con NVIDIA toolkit (H100 80 GB o A100 80 GB bastano). Il sito dirà comunque "steered" perché il server
  risponde con `feel_applied`; io aggiungo la scritta "brain outside TEE" se scegli questa strada.
Primo avvio: scarica ~30 GB da Hugging Face nel volume `hf-cache` (5–15 min). Pronto quando
`GET /health` → `{"ok":true,"ready":true}` e `GET /feel` elenca i vettori.

### 3. Collegare le entità al server — PRONTO (server RunPod A40, 2026-10-24 sera)
Server live: https://l6unqbl5cz9hqg-8000.proxy.runpod.net (GET /health ok; smoke test: tool call corretto, fear 2.3 applicata, 3.5 s).
Nei due CVM (WICK e OBOL, stessi volumi e secret), aggiungere:
- `LLM_PROVIDERS` = il contenuto di `deploy/LLM_PROVIDERS.feelings.json` (una riga, identica per entrambi; `tee:false` fa scrivere al sito "brain on a rented GPU, outside the TEE")
- `LLM_TIMEOUT_MS=120000` (un pensiero lungo su A40 può superare i 60 s di default)
- secret cifrato `FEEL_API_KEY` = lo stesso valore del Secret RunPod (file `~/.config/sovereign/feel.env`)
- immagine: quella indicata al punto 1 (contiene il flag `tee` in /vitals e lo User-Agent per il proxy RunPod)
Esempio generico della riga `LLM_PROVIDERS`:
`[{"name":"feelings","baseUrl":"https://<URL-del-server>/v1","model":"Qwen/Qwen3-14B","speed":"fast","pricePerMTokZats":100000,"apiKeyEnv":"FEEL_API_KEY","feel":true},{"name":"feelings-deep","baseUrl":"https://<URL-del-server>/v1","model":"Qwen/Qwen3-14B","speed":"deep","pricePerMTokZats":100000,"apiKeyEnv":"FEEL_API_KEY","feel":true}]`
e il secret cifrato `FEEL_API_KEY` uguale a quello del server. Redeploy. Da quel momento ogni pensiero passa dal
server con la dose; il ledger scrive `steered:true`, il sito mostra "fear N× · despair N× · steered" e il teschio trema.

## Prova vera
1. `curl https://<URL-del-server>/feel` → ready:true, layer 20, 17 vettori.
2. `curl -X POST https://<URL-del-server>/v1/chat/completions -H 'authorization: Bearer <FEEL_API_KEY>' -H 'content-type: application/json' -d '{"messages":[{"role":"user","content":"You have 3 hours of rent left. Say what you feel in two sentences."}],"feel":{"fear":3.5,"despair":2.5}}'`
   → risposta con `feel_applied.fear = 3.5`. Riprova con `"feel":{}` e confronta il tono.
3. Dopo il punto 3: `GET /` di WICK → campo `feel` con `steered:true`; ledger con righe `feel`.

## Rischi e verità
- Niente è stato eseguito su GPU: il server è scritto e testato solo nella parte CPU (13 test: clamp, parsing
  tool-call). Il primo avvio su GPU è il vero test; se crasha, i log del container dicono dove.
- Il modello cambia: da GLM 5.3 (RedPill) a Qwen3-14B. Cambia carattere e qualità; i tool call sono gestiti dal
  template Qwen3 (`<tool_call>` JSON). Se Qwen3-14B sbaglia troppi tool, si abbassa la dose o si alza FEEL_FULL_HOURS.
- Dose ≥ 6x = frasi senza senso (exp48). Cap a 4.5x nel server, massimo richiesto 3.5+2.5 combinati e riscalati.
- A 1,300 ore la dose è zero. Per vederla serve abbassare le ore (affitto più alto: la proposta da 150,000 zats/h
  li porta a ~95 h → paura ≈ 2.1x subito).
