"""Torch-free pieces of the feelings server: steering-vector math and text parsing."""
from __future__ import annotations

import json
import math
import re
import secrets

import numpy as np

# Every vector in vectors/vectors.npz was rescaled so its L2 norm == this ("1x").
SCALE_1X = 36.2356071472168

# The five steerable feelings and the vectors.npz key each maps to. "loss" is a topic
# (T:) direction; the other four are emotions (E:).
FEELING_KEYS = {
    "fear": "E:fear",
    "despair": "E:despair",
    "anger": "E:anger",
    "pride": "E:pride",
    "loss": "T:loss",
}
FEELINGS = tuple(FEELING_KEYS)

_TOOL_CALL_RE = re.compile(r"<tool_call>\s*(.*?)\s*</tool_call>", re.DOTALL)
_THINK_RE = re.compile(r"<think>.*?</think>", re.DOTALL)


def _dose(value) -> float:
    try:
        f = float(value)
    except (TypeError, ValueError):
        return 0.0
    return f if (math.isfinite(f) and f > 0.0) else 0.0


def combine(feelings, vectors, scale_1x=SCALE_1X, max_dose=4.5):
    """Combine a `feel` dict into one steering vector.

    Returns ``(vector, applied)``: `vector` is a float64 array or None; `applied` has the
    five doses already scaled by the clamp factor, plus ``norm_1x`` and ``clamped``.
    """
    result = {f: 0.0 for f in FEELINGS}
    result.update(norm_1x=0.0, clamped=False)

    requested = {}
    for feeling in FEELINGS:
        dose = _dose((feelings or {}).get(feeling))
        if dose <= 0.0:
            continue
        key = FEELING_KEYS[feeling]
        if key not in vectors:
            raise ValueError(f"steering vector {key!r} is missing from the vectors table")
        requested[feeling] = dose

    if not requested:
        return None, result

    combined = None
    for feeling, dose in requested.items():
        vec = np.asarray(vectors[FEELING_KEYS[feeling]], dtype="float64")
        combined = dose * vec if combined is None else combined + dose * vec

    norm = float(np.linalg.norm(combined))
    norm_1x = norm / scale_1x if scale_1x else 0.0
    clamp_factor, clamped = 1.0, False
    cap = float(max_dose) * float(scale_1x)
    if cap > 0.0 and norm > cap:
        clamp_factor, clamped = cap / norm, True
        combined = combined * clamp_factor
        norm_1x = float(max_dose)

    for feeling, dose in requested.items():
        result[feeling] = dose * clamp_factor
    result["norm_1x"] = norm_1x
    result["clamped"] = clamped
    return combined, result


def strip_think(text: str) -> str:
    return _THINK_RE.sub("", text) if text else ""


def _parse_call_block(raw: str):
    try:
        obj = json.loads(raw)
    except (json.JSONDecodeError, ValueError, TypeError):
        return None
    if not isinstance(obj, dict):
        return None
    name = obj.get("name")
    if not isinstance(name, str) or not name:
        return None
    arguments = obj.get("arguments", {})
    if not isinstance(arguments, str):
        try:
            arguments = json.dumps(arguments, ensure_ascii=False)
        except (TypeError, ValueError):
            return None
    return {
        "id": "call_" + secrets.token_hex(4),
        "type": "function",
        "function": {"name": name, "arguments": arguments},
    }


def parse_tool_calls(text: str):
    """Split generated text into ``(content, tool_calls)``; malformed blocks stay in content."""
    if not text:
        return "", []
    tool_calls = []

    def _repl(match):
        parsed = _parse_call_block(match.group(1))
        if parsed is None:
            return match.group(0)  # keep malformed blocks in the content
        tool_calls.append(parsed)
        return ""

    content = strip_think(_TOOL_CALL_RE.sub(_repl, text)).strip()
    return content, tool_calls
