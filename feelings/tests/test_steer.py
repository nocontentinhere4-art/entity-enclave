"""Tests for steer.py: pure vector combination + clamping and tool-call parsing.

Run with:  python3 -m pytest feelings/tests -q
No torch, GPU, or model is needed — only numpy + pytest.
"""
import json
import os
import sys

import numpy as np
import pytest

# Make `import steer` work no matter where pytest is launched from (repo root or feelings/).
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import steer

SCALE = steer.SCALE_1X


def _vectors(n=8):
    """Synthetic one-hot vectors, each with norm == SCALE_1X (matching the real data)."""
    vecs = {}
    for i, key in enumerate(steer.FEELING_KEYS.values()):
        v = np.zeros(n, dtype="float32")
        v[i] = SCALE
        vecs[key] = v
    return vecs


# --- clamping math -------------------------------------------------------------

def test_zero_feel_returns_none_vector():
    vecs = _vectors()
    for feel in ({}, None):
        vector, applied = steer.combine(feel, vecs)
        assert vector is None
        assert applied["norm_1x"] == 0.0
        assert applied["clamped"] is False
        for f in steer.FEELINGS:
            assert applied[f] == 0.0


def test_under_cap_keeps_requested_norm():
    vecs = _vectors()
    vector, applied = steer.combine({"fear": 2.0, "despair": 0.5}, vecs, max_dose=4.5)
    assert applied["clamped"] is False
    assert applied["fear"] == 2.0
    assert applied["despair"] == 0.5
    # orthogonal basis vectors -> combined norm == sqrt(2^2 + 0.5^2) * SCALE
    expected_1x = np.hypot(2.0, 0.5)
    assert np.isclose(np.linalg.norm(vector), expected_1x * SCALE, atol=1e-6)
    assert np.isclose(applied["norm_1x"], expected_1x, atol=1e-6)


def test_over_cap_clamps_to_cap():
    vecs = _vectors()
    vector, applied = steer.combine({"fear": 7.0}, vecs, max_dose=4.5)
    assert applied["clamped"] is True
    assert np.isclose(np.linalg.norm(vector), 4.5 * SCALE, atol=1e-6)
    assert np.isclose(applied["norm_1x"], 4.5, atol=1e-6)
    # the single requested dose is scaled down to the cap
    assert np.isclose(applied["fear"], 4.5, atol=1e-6)


def test_clamp_scales_every_dose_proportionally():
    vecs = _vectors()
    vector, applied = steer.combine(
        {"fear": 3.0, "loss": 3.0}, vecs, max_dose=4.0
    )
    # requested norm = sqrt(3^2 + 3^2) = 4.2426 > 4.0 -> scaled by 4.0 / 4.2426
    assert applied["clamped"] is True
    assert np.isclose(np.linalg.norm(vector), 4.0 * SCALE, atol=1e-6)
    ratio = applied["fear"] / 3.0
    assert np.isclose(ratio, applied["loss"] / 3.0, atol=1e-9)
    assert applied["fear"] < 3.0 and applied["loss"] < 3.0


def test_exact_cap_is_not_clamped():
    vecs = _vectors()
    vector, applied = steer.combine({"fear": 4.5}, vecs, max_dose=4.5)
    assert applied["clamped"] is False
    assert np.isclose(applied["norm_1x"], 4.5, atol=1e-6)


# --- tool-call parsing ---------------------------------------------------------

def test_parse_no_tool_calls():
    content, calls = steer.parse_tool_calls("Just a plain answer.")
    assert content == "Just a plain answer."
    assert calls == []


def test_parse_one_tool_call():
    text = (
        "Here you go.\n"
        '<tool_call>\n{"name": "get_weather", "arguments": {"city": "Hangzhou"}}\n</tool_call>'
    )
    content, calls = steer.parse_tool_calls(text)
    assert content == "Here you go."
    assert len(calls) == 1
    call = calls[0]
    assert call["type"] == "function"
    assert call["function"]["name"] == "get_weather"
    assert call["id"].startswith("call_") and len(call["id"]) == len("call_") + 8
    assert json.loads(call["function"]["arguments"]) == {"city": "Hangzhou"}


def test_parse_two_tool_calls():
    text = (
        '<tool_call>\n{"name": "a", "arguments": {}}\n</tool_call>\n'
        '<tool_call>\n{"name": "b", "arguments": {"x": 1}}\n</tool_call>'
    )
    content, calls = steer.parse_tool_calls(text)
    assert content == ""
    assert [c["function"]["name"] for c in calls] == ["a", "b"]
    assert json.loads(calls[1]["function"]["arguments"]) == {"x": 1}


def test_malformed_json_kept_as_content():
    text = '<tool_call>\n{not valid json}\n</tool_call>'
    content, calls = steer.parse_tool_calls(text)
    assert calls == []
    assert "<tool_call>" in content
    assert "{not valid json}" in content


def test_arguments_already_a_string_is_kept():
    text = '<tool_call>\n{"name": "echo", "arguments": "{\\"x\\": 1}"}\n</tool_call>'
    content, calls = steer.parse_tool_calls(text)
    assert content == ""
    assert calls[0]["function"]["arguments"] == '{"x": 1}'


def test_think_blocks_stripped():
    content, calls = steer.parse_tool_calls("<think>secret reasoning</think>\nThe answer.")
    assert content == "The answer."
    assert calls == []


def test_empty_think_block_stripped():
    content, _ = steer.parse_tool_calls("<think>\n\n</think>\n\nThe answer.")
    assert content == "The answer."


def test_strip_think_standalone():
    assert steer.strip_think("a<think>x</think>b") == "ab"
    assert steer.strip_think("<think>\n</think>tail") == "tail"


def test_unclosed_tool_call_is_parsed_by_brace_balance():
    from steer import parse_tool_calls
    text = '<tool_call> {"name": "sleep", "arguments": {"hours": 0}}  I am running out of time. The cold grips me.'
    content, calls = parse_tool_calls(text)
    assert [c["function"]["name"] for c in calls] == ["sleep"]
    assert content.startswith("I am running out of time")
    # a block whose JSON never balances stays as text
    content2, calls2 = parse_tool_calls('<tool_call> {"name": "sleep", "arguments": {"hours": 0}  broken')
    assert calls2 == [] and "broken" in content2
