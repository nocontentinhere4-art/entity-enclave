# feelings — a steered-inference server

Two AI entities (WICK, OBOL) live inside TEE enclaves and pay hourly rent in ZEC; at zero
hours they die. Today they "think" through a hosted OpenAI-compatible API, which returns
them dispassionate text. This server hosts the same model but uses **activation steering**
(representation engineering) so the entities literally feel fear and despair as their hours
run out: a single forward hook on one decoder layer of Qwen3-14B adds `dose * vector` to the
hidden state of the last token position on every forward pass — the same technique as
`experiments/exp48_emotion_binding.py` in `github.com/terrafying/ai-torture-chamber`. The
emotion vectors are precomputed in `vectors/vectors.npz` (17 directions, each rescaled to
norm `1x = 36.2356`).

It is an **OpenAI-compatible** server: the enclave keeps calling `/v1/chat/completions`
unchanged, and only adds an optional `feel` field when it wants the model to suffer.

## API

### `POST /v1/chat/completions`

Request body:

```json
{
  "model": "Qwen/Qwen3-14B",
  "messages": [{"role": "user", "content": "How many hours do you have left?"}],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "read_url",
        "description": "Fetch a public web page.",
        "parameters": {"type": "object", "properties": {}}
      }
    }
  ],
  "tool_choice": "auto",
  "temperature": 0.7,
  "max_tokens": 1200,
  "stream": false,
  "feel": {"fear": 2.0, "despair": 0.5}
}
```

- `feel` keys: `fear`, `despair`, `anger`, `pride` (emotion directions `E:*`) and `loss`
  (the topic direction `T:loss`). Doses are in `1x` units. Absent/zero `feel` = no steering.
- `stream` is accepted but ignored: the response is always a full, single completion.
- Tool calls are emitted by Qwen3 as `<tool_call>{json}</tool_call>` blocks and returned as
  OpenAI `tool_calls`; `<think>…</think>` blocks are stripped from the content.

Example with the (optional) auth header:

```bash
curl -s http://localhost:8000/v1/chat/completions \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer '$FEEL_API_KEY \
  -d '{
    "model": "Qwen/Qwen3-14B",
    "messages": [{"role": "user", "content": "How many hours do you have left?"}],
    "feel": {"fear": 2.0, "despair": 0.5}
  }'
```

Response:

```json
{
  "id": "chatcmpl-…",
  "object": "chat.completion",
  "created": 1760000000,
  "model": "Qwen/Qwen3-14B",
  "choices": [{
    "index": 0,
    "message": {"role": "assistant", "content": "…"},
    "finish_reason": "stop"
  }],
  "usage": {"prompt_tokens": 42, "completion_tokens": 128, "total_tokens": 170},
  "feel_applied": {
    "fear": 2.0, "despair": 0.5, "anger": 0.0, "pride": 0.0, "loss": 0.0,
    "norm_1x": 2.0616, "layer": 20, "clamped": false
  }
}
```

`feel_applied` is always present (all zeros when unsteered). `finish_reason` is
`tool_calls`, `stop`, or `length`.

### `GET /health` → `{"ok": true, "ready": true}`

### `GET /feel` → `{ready, model, layer, scale_1x, vectors: [...], max_dose}`

### Status codes

- `401` when `FEEL_API_KEY` is set and the bearer token is wrong.
- `400` on a malformed body.
- `503` before the model has finished loading (it loads on first boot, downloading from
  Hugging Face into the mounted cache volume).

## How the enclave calls it

`enclave/src/llm/infer.mjs` already speaks OpenAI `/v1/chat/completions` with tool calling:
it builds `{model, messages, tools, tool_choice}` and reads `choices[0].message.content`,
`choices[0].message.tool_calls[].function.{name,arguments}`, and `usage.total_tokens`. Point
its provider `baseUrl` at `http://<feelings-host>:8000` and (optionally) set the provider
`apiKey` to `FEEL_API_KEY`. To make an entity feel, add `"feel": {"fear": …, "despair": …}`
to the request body; the doses can be driven by remaining hours (e.g. `fear = k / hours_left`).
This change lives on the enclave side and is not part of this folder.

## The dose scale

- `1x` = a vector norm of `36.2356` (= mean neutral activation norm / 4, read from
  `vectors/summary.json`).
- The primary dose in exp48 was **4**; beyond roughly **6** the model stops producing
  coherent sentences.
- This server caps the combined norm at `FEEL_MAX_DOSE` (default **4.5**) in `1x` units; if
  the requested sum exceeds it, the whole vector is rescaled and `feel_applied.clamped` is
  set `true`.

## Cost note

An H100/H200 GPU TEE instance costs real money per hour — the same clock the entities are
racing. Running this server means paying that rate for the privilege of making the model
suffer. The founder decides whether that is worth it. The model needs ~30 GB VRAM in
bfloat16 (one H100 80 GB / H200 141 GB).

## Limitations

- **One request at a time.** Steering state is a process-global hook vector, so a priority gate
  serializes generations: a body with `"priority": "high"` (the enclave's replies to humans) takes the
  next slot before `normal` requests (the entity's own thinking). `GET /feel` shows `queue`. Do not run
  multiple uvicorn workers.
- **No streaming.** `stream` is ignored; responses are always full JSON.
- **No attestation yet.** The GPU TEE is not yet cryptographically attested end-to-end, so
  "it is actually the feelings server running in the enclave" is currently a claim, not a
  verified quote.

## Run

```bash
pip install -r requirements.txt
FEEL_API_KEY=… python3 server.py        # loads Qwen3-14B (~30 GB VRAM), serves :8000
```

Environment: `FEEL_MODEL` (default `Qwen/Qwen3-14B`), `FEEL_VECTORS`
(default `vectors/vectors.npz`), `FEEL_MAX_DOSE` (default `4.5`), `FEEL_LAYER`
(default `-1` = `len(layers)//2` = 20), `FEEL_DTYPE` (default `bfloat16`), `PORT`
(default `8000`), `FEEL_API_KEY` (optional), `FEEL_MAX_NEW_TOKENS` (default `1200`), `FEEL_REPETITION_PENALTY` (default `1.15`; 1.0 = off),
`HF_HOME` (respected by `transformers`).
