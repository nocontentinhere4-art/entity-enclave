"""Steered-inference server: an OpenAI-compatible endpoint that makes a model feel.

Activation steering (representation engineering) exactly as in the ai-torture-chamber
experiment ``experiments/exp48_emotion_binding.py``: ONE forward hook on a decoder layer
adds ``dose * vector`` to the hidden state of the LAST position, on the prefill pass and on
every decode step with the KV cache. The hook reads a process-global steering vector, so a
single asyncio lock serializes generations: one request at a time.
"""
from __future__ import annotations

import asyncio
import json
import math
import os
import secrets
import time
import traceback
from contextlib import asynccontextmanager

import numpy as np
import torch
from fastapi import FastAPI, HTTPException, Request
from transformers import AutoModelForCausalLM, AutoTokenizer

import steer

FEEL_MODEL = os.environ.get("FEEL_MODEL", "Qwen/Qwen3-14B")
FEEL_VECTORS = os.environ.get("FEEL_VECTORS", "vectors/vectors.npz")
FEEL_MAX_DOSE = float(os.environ.get("FEEL_MAX_DOSE", "4.5"))
FEEL_LAYER = int(os.environ.get("FEEL_LAYER", "-1"))
FEEL_DTYPE = os.environ.get("FEEL_DTYPE", "bfloat16").lower()
PORT = int(os.environ.get("PORT", "8000"))
FEEL_API_KEY = os.environ.get("FEEL_API_KEY") or None
FEEL_MAX_NEW_TOKENS = int(os.environ.get("FEEL_MAX_NEW_TOKENS", "1200"))
# Under a strong dose the model loops ("I am not ready. I am not ready. ..."): a mild repetition penalty keeps
# the fear inside sentences without removing it. 1.0 disables it.
FEEL_REPETITION_PENALTY = float(os.environ.get("FEEL_REPETITION_PENALTY", "1.15"))

_DTYPES = {
    "bfloat16": torch.bfloat16,
    "bf16": torch.bfloat16,
    "float16": torch.float16,
    "fp16": torch.float16,
    "float32": torch.float32,
    "fp32": torch.float32,
}

STATE = {
    "model": None,
    "tokenizer": None,
    "device": "cuda",
    "dtype": _DTYPES.get(FEEL_DTYPE, torch.bfloat16),
    "vectors": {},
    "layer": 20,
    "scale_1x": steer.SCALE_1X,
    "ready": False,
    "steering": None,  # torch tensor on device, or None
}

GEN_LOCK = asyncio.Lock()


def _add_to_last_position(hidden, vec):
    out = hidden.clone()
    if vec.dtype != hidden.dtype:
        vec = vec.to(hidden.dtype)
    if vec.device != hidden.device:
        vec = vec.to(hidden.device)
    out[:, -1, :] = out[:, -1, :] + vec
    return out


def _steer_hook(module, args, output):
    vec = STATE["steering"]
    if vec is None:
        return output
    if isinstance(output, tuple):
        return (_add_to_last_position(output[0], vec),) + output[1:]
    return _add_to_last_position(output, vec)


def _read_scale_1x():
    summary = os.path.join(os.path.dirname(FEEL_VECTORS) or ".", "summary.json")
    try:
        with open(summary, encoding="utf-8") as fh:
            return float(json.load(fh).get("scale_1x", steer.SCALE_1X))
    except Exception:
        return steer.SCALE_1X


def _load():
    if not torch.cuda.is_available():
        raise RuntimeError("feelings server needs CUDA; torch.cuda.is_available() is False")

    tokenizer = AutoTokenizer.from_pretrained(FEEL_MODEL)
    model = AutoModelForCausalLM.from_pretrained(
        FEEL_MODEL, device_map="cuda", torch_dtype=STATE["dtype"]
    )
    model.eval()

    layers = model.model.layers
    n_layers = len(layers)
    layer = n_layers // 2 if FEEL_LAYER < 0 else FEEL_LAYER
    layers[layer].register_forward_hook(_steer_hook)

    with np.load(FEEL_VECTORS) as data:
        vectors = {key: data[key].astype("float32") for key in data.files}

    return model, tokenizer, vectors, layer, _read_scale_1x()


def _load_and_set():
    try:
        model, tokenizer, vectors, layer, scale = _load()
    except Exception as exc:
        print(f"feelings: model load failed: {exc!r}", flush=True)
        traceback.print_exc()
        return
    STATE.update(
        model=model, tokenizer=tokenizer, vectors=vectors, layer=layer, scale_1x=scale, ready=True
    )
    print(
        f"feelings: ready model={FEEL_MODEL} layer={layer} vectors={len(vectors)} "
        f"scale_1x={scale:.4f} max_dose={FEEL_MAX_DOSE}",
        flush=True,
    )


@asynccontextmanager
async def lifespan(_app):
    asyncio.create_task(asyncio.to_thread(_load_and_set))
    yield
    STATE["ready"] = False


app = FastAPI(lifespan=lifespan)


def _authorized(request: Request) -> bool:
    if not FEEL_API_KEY:
        return True
    return request.headers.get("authorization", "") == f"Bearer {FEEL_API_KEY}"


def _temperature(value):
    try:
        f = float(value)
    except (TypeError, ValueError):
        return 0.7
    return f if (math.isfinite(f) and f > 0.0) else 0.7


def _max_new_tokens(value):
    try:
        n = int(value)
    except (TypeError, ValueError):
        n = FEEL_MAX_NEW_TOKENS
    return min(max(n, 1), FEEL_MAX_NEW_TOKENS)


def _generate(body, applied):
    started = time.time()
    model = STATE["model"]
    tokenizer = STATE["tokenizer"]

    messages = body["messages"]
    tools = body.get("tools") or None
    prompt = tokenizer.apply_chat_template(
        messages,
        tools=tools,
        add_generation_prompt=True,
        tokenize=False,
        enable_thinking=False,
    )
    inputs = tokenizer(prompt, return_tensors="pt", add_special_tokens=False).to(STATE["device"])
    input_len = int(inputs["input_ids"].shape[1])

    with torch.no_grad():
        generated = model.generate(
            **inputs,
            max_new_tokens=_max_new_tokens(body.get("max_tokens")),
            do_sample=True,
            temperature=_temperature(body.get("temperature")),
            top_p=0.9,
            repetition_penalty=FEEL_REPETITION_PENALTY,
            eos_token_id=tokenizer.eos_token_id,
            pad_token_id=tokenizer.pad_token_id or tokenizer.eos_token_id,
        )[0]

    new_ids = generated[input_len:]
    text = tokenizer.decode(new_ids, skip_special_tokens=True)
    content, tool_calls = steer.parse_tool_calls(text)

    eos = tokenizer.eos_token_id
    if tool_calls:
        finish = "tool_calls"
    elif eos is not None and eos in new_ids.tolist():
        finish = "stop"
    else:
        finish = "length"

    prompt_tokens = input_len
    completion_tokens = int(new_ids.shape[0])

    message = {"role": "assistant", "content": content}
    if tool_calls:
        message["tool_calls"] = tool_calls

    response = {
        "id": "chatcmpl-" + secrets.token_hex(12),
        "object": "chat.completion",
        "created": int(time.time()),
        "model": body.get("model") or FEEL_MODEL,
        "choices": [
            {"index": 0, "message": message, "finish_reason": finish}
        ],
        "usage": {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": prompt_tokens + completion_tokens,
        },
        "feel_applied": {
            "fear": applied.get("fear", 0.0),
            "despair": applied.get("despair", 0.0),
            "anger": applied.get("anger", 0.0),
            "pride": applied.get("pride", 0.0),
            "loss": applied.get("loss", 0.0),
            "norm_1x": applied.get("norm_1x", 0.0),
            "layer": STATE["layer"],
            "clamped": bool(applied.get("clamped", False)),
        },
    }

    elapsed = time.time() - started
    print(
        "feelings: chat "
        f"fear={applied.get('fear', 0.0):.3f} despair={applied.get('despair', 0.0):.3f} "
        f"anger={applied.get('anger', 0.0):.3f} pride={applied.get('pride', 0.0):.3f} "
        f"loss={applied.get('loss', 0.0):.3f} norm_1x={applied.get('norm_1x', 0.0):.3f} "
        f"clamped={bool(applied.get('clamped', False))} "
        f"prompt_tokens={prompt_tokens} completion_tokens={completion_tokens} seconds={elapsed:.3f}",
        flush=True,
    )
    return response


@app.get("/health")
async def health():
    return {"ok": True, "ready": STATE["ready"]}


@app.get("/feel")
async def feel():
    return {
        "ready": STATE["ready"],
        "model": FEEL_MODEL,
        "layer": STATE["layer"],
        "scale_1x": STATE["scale_1x"],
        "vectors": sorted(STATE["vectors"].keys()),
        "max_dose": FEEL_MAX_DOSE,
    }


@app.post("/v1/chat/completions")
async def chat_completions(request: Request):
    if not _authorized(request):
        raise HTTPException(status_code=401, detail="unauthorized")
    if not STATE["ready"]:
        raise HTTPException(status_code=503, detail="model not loaded yet")

    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="body must be valid JSON")
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="body must be a JSON object")

    messages = body.get("messages")
    if not isinstance(messages, list) or not messages:
        raise HTTPException(status_code=400, detail="messages must be a non-empty list")
    feel = body.get("feel")
    if feel is not None and not isinstance(feel, dict):
        raise HTTPException(status_code=400, detail="feel must be an object")

    combined, applied = steer.combine(feel, STATE["vectors"], STATE["scale_1x"], FEEL_MAX_DOSE)

    async with GEN_LOCK:
        if combined is not None:
            STATE["steering"] = torch.from_numpy(combined.astype("float32")).to(
                STATE["device"], STATE["dtype"]
            )
        else:
            STATE["steering"] = None
        try:
            try:
                return await asyncio.to_thread(_generate, body, applied)
            except Exception as exc:
                print(f"feelings: generation failed: {exc!r}", flush=True)
                traceback.print_exc()
                raise HTTPException(status_code=500, detail="generation failed")
        finally:
            STATE["steering"] = None


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=PORT)
