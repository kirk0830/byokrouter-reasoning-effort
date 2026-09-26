#!/usr/bin/env python
"""
test_smoke.py -- the fast startup self-check for paratera-proxy.bat.

Run by paratera-proxy.bat right after the proxy is started, so the console shows
whether the proxy is actually healthy. Kept deliberately short: it makes only two
real upstream calls (one non-streaming, one streaming), so the whole thing lands
in roughly ten seconds.

The full suite (all five models, effort injection, control API, direct comparison)
lives in test_proxy.py -- run it with run-tests.bat.

    pixi run pytest -q -s test_smoke.py
"""

from __future__ import annotations

import json
import os
import urllib.request

import pytest

from test_proxy import EXPECTED_EFFORT, PROBE_EXPECT, PROBE_PROMPT, make_client, proxy_status

BASE_URL = os.environ.get("PARATERA_PROXY_URL", "http://127.0.0.1:8798").rstrip("/")

# tests that make no upstream call; everything else is dispatched after those
FAST_TESTS = {"test_proxy_is_listening", "test_upstream_key_present", "test_effort_map_matches_effort_json"}


# ---------------------------------------------------------------------------
# 1. the proxy itself (no upstream traffic)
# ---------------------------------------------------------------------------

def test_proxy_is_listening():
    st = proxy_status(BASE_URL)
    assert st.get("upstream"), "proxy did not report an upstream"
    assert "effort" in st, "proxy did not report its effort configuration"


def test_upstream_key_present():
    st = proxy_status(BASE_URL)
    assert st.get("hasKey"), (
        "no upstream API key: put it in keys.json next to paratera-proxy.mjs, "
        "or set PARATERA_API_KEY"
    )


def test_effort_map_matches_effort_json():
    """The running proxy must serve the same tiers as effort.json on disk."""
    here = os.path.dirname(os.path.abspath(__file__))
    cfg_path = os.path.join(here, "..", "effort.json")
    with open(cfg_path, encoding="utf-8") as fh:
        cfg = json.load(fh)

    live = (proxy_status(BASE_URL).get("effort") or {})
    want_models = {k: v for k, v in (cfg.get("models") or {}).items() if not k.startswith("_")}
    got_models = live.get("models") or {}

    assert want_models, f"effort.json has no model entries ({cfg_path})"
    assert got_models == want_models, f"effort map mismatch:\n  file: {want_models}\n  live: {got_models}"
    assert live.get("default") == cfg.get("default"), (
        f"fallback tier mismatch: file={cfg.get('default')!r} live={live.get('default')!r}"
    )


# ---------------------------------------------------------------------------
# 2. one real round trip (this is the part that can be slow / fail offline)
# ---------------------------------------------------------------------------

def test_one_model_answers_non_streaming():
    client = make_client(BASE_URL)
    resp = client.chat.completions.create(
        model="DeepSeek-V4.1-Flash",
        messages=[{"role": "user", "content": PROBE_PROMPT}],
        max_tokens=2048,
        temperature=0,
    )
    choice = resp.choices[0].message
    text = (choice.content or "").strip()
    reasoning = (getattr(choice, "reasoning_content", None) or "").strip()
    details = getattr(resp.usage, "completion_tokens_details", None)
    rtok = getattr(details, "reasoning_tokens", None) if details else None

    # Either the answer, or a budget fully consumed by thinking, is acceptable:
    # at `max` some models spend all of max_tokens on reasoning.
    assert PROBE_EXPECT in text or reasoning, (
        f"no answer and no reasoning (content={text[:40]!r}, reasoning_tokens={rtok})"
    )


def test_streaming_works():
    client = make_client(BASE_URL)
    chunks = 0
    saw_payload = False
    stream = client.chat.completions.create(
        model="DeepSeek-V4.1-Flash",
        messages=[{"role": "user", "content": "Count from 1 to 3."}],
        max_tokens=256,
        stream=True,
    )
    for chunk in stream:
        chunks += 1
        if not chunk.choices:
            continue
        delta = chunk.choices[0].delta
        if delta and (getattr(delta, "content", None) or getattr(delta, "reasoning_content", None)):
            saw_payload = True
    assert chunks > 0, "no SSE chunks received"
    assert saw_payload, f"{chunks} chunks received but none carried content"


def test_unknown_model_is_rejected_cleanly():
    client = make_client(BASE_URL)
    with pytest.raises(Exception) as excinfo:
        client.chat.completions.create(
            model="definitely-not-a-real-model-xyz",
            messages=[{"role": "user", "content": "hi"}],
            max_tokens=8,
        )
    status = getattr(excinfo.value, "status_code", None)
    assert status and 400 <= status < 500, f"expected a 4xx, got {status!r}: {excinfo.value}"
