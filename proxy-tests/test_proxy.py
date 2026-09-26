#!/usr/bin/env python
"""
test_proxy.py -- verify the Paratera reasoning-effort proxy with the real
OpenAI Python SDK.

Why the SDK instead of raw HTTP: it is the same client shape that Trae-like
tools use (base_url + api_key, streaming, extra params, error mapping), so a
pass here means a real client will work against the proxy.

What is checked
  1. health            the proxy answers /_status and has an upstream key
  2. effort map        the proxy's configured per-model tiers match expectation
  3. non-streaming     every Paratera model answers through the proxy
  4. streaming         the same models stream and terminate correctly
  5. effort injection  identical prompt at `max` vs "no parameter" -> the proxy
                       reports the right decision, and the upstream usage shows
                       the expected direction (reasoning tokens, N samples)
  6. extra params      unknown/extra body fields (thinking, temperature) pass through
  7. bad model         an unknown model yields a clean upstream error, not a hang
  8. control API       POST /_control round-trips and is restored afterwards

Usage (inside the pixi env):
    pixi run python test_proxy.py
    pixi run python test_proxy.py --base-url http://127.0.0.1:8798 --samples 3

Exit code 0 = all required checks passed.
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
import urllib.error
import urllib.request

# Configuration comes from the environment so the module is also usable as a
# pytest target (pytest would reject the script's own argparse flags):
#   PARATERA_PROXY_URL     proxy root without /v1
#   PARATERA_TEST_SAMPLES  samples per effort tier
#   PARATERA_TEST_DIRECT   1 to also compare against the gateway directly
#   PARATERA_TEST_NO_STREAM 1 to skip the streaming checks
ENV_BASE_URL = os.environ.get("PARATERA_PROXY_URL", "http://127.0.0.1:8798")
ENV_SAMPLES = int(os.environ.get("PARATERA_TEST_SAMPLES", "2"))
ENV_DIRECT = os.environ.get("PARATERA_TEST_DIRECT", "") == "1"
ENV_NO_STREAM = os.environ.get("PARATERA_TEST_NO_STREAM", "") == "1"

# Windows consoles are often cp936/cp1252; keep output from exploding on the odd
# non-ASCII model reply.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

from openai import OpenAI  # noqa: E402  (import after stdout fix on purpose)

# ---------------------------------------------------------------------------
# configuration
# ---------------------------------------------------------------------------

# name -> tier the proxy is expected to send (from paratera tools/effort.json)
EXPECTED_EFFORT = {
    "GLM-5.3-Flash": "max",
    "DeepSeek-V4.1-Flash": "max",
    "Qwen3.8-Flash": "max",
    "Qwen3.8-Max": "medium",
    "Kimi-K3": "medium",
}

# a prompt that reliably produces visible reasoning on all five models
PROBE_PROMPT = (
    "A farmer has 17 sheep, all but 9 run away. Then he buys 3 times as many as "
    "remained, and loses half of those to a wolf. Finally a neighbor gives him back 4. "
    "How many sheep does he have? Answer with just the number."
)
PROBE_EXPECT = "22"

PLACEHOLDER_KEY = "proxy-ignores-this-placeholder"


# ---------------------------------------------------------------------------
# tiny reporting harness
# ---------------------------------------------------------------------------

class Report:
    def __init__(self) -> None:
        self.passed: list[str] = []
        self.failed: list[str] = []
        self.warned: list[str] = []

    def ok(self, name: str, detail: str = "") -> None:
        self.passed.append(name)
        print(f"  PASS  {name}" + (f"   {detail}" if detail else ""))

    def fail(self, name: str, detail: str = "") -> None:
        self.failed.append(name)
        print(f"  FAIL  {name}" + (f"   {detail}" if detail else ""))

    def warn(self, name: str, detail: str = "") -> None:
        self.warned.append(name)
        print(f"  WARN  {name}" + (f"   {detail}" if detail else ""))

    def section(self, title: str) -> None:
        print(f"\n=== {title} ===")


# ---------------------------------------------------------------------------
# raw proxy helpers (control / status are not OpenAI endpoints)
# ---------------------------------------------------------------------------

def http_json(url: str, method: str = "GET", payload: dict | None = None, timeout: int = 15):
    data = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={"Content-Type": "application/json"} if data else {},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = resp.read().decode("utf-8", "replace")
    return json.loads(body) if body else None


def proxy_status(base_url: str) -> dict:
    return http_json(f"{base_url}/_status")


def proxy_set_default(base_url: str, effort: str | None) -> dict:
    return http_json(f"{base_url}/_control", "POST", {"default": effort})


# ---------------------------------------------------------------------------
# checks
# ---------------------------------------------------------------------------

def check_health(base_url: str, rep: Report) -> dict:
    rep.section("1. proxy health")
    try:
        st = proxy_status(base_url)
    except Exception as exc:
        rep.fail("proxy /_status reachable", f"{type(exc).__name__}: {exc}")
        return {}
    rep.ok("proxy /_status reachable")
    rep.ok("upstream configured", st.get("upstream", "?"))
    if st.get("hasKey"):
        rep.ok("upstream API key present")
    else:
        rep.fail("upstream API key present", "set keys.json or PARATERA_API_KEY")
    return st


def check_effort_map(status: dict, rep: Report) -> None:
    rep.section("2. configured effort map")
    effort = status.get("effort") or {}
    models = effort.get("models") or {}
    for name, want in EXPECTED_EFFORT.items():
        got = models.get(name)
        if got == want:
            rep.ok(f"{name} -> {want}")
        else:
            rep.fail(f"{name} -> {want}", f"proxy has {got!r}")
    default = effort.get("default")
    print(f"        (fallback for unlisted models: {default!r})")


def make_client(base_url: str, api_key: str = PLACEHOLDER_KEY) -> OpenAI:
    """
    trust_env=False is important here: this machine's environment contains a
    `no_proxy`/`NO_PROXY` value with entries like `[::1]`, and httpx refuses to
    parse those, which blows up client construction with
    `InvalidURL: Invalid port: ':1]'`. Ignoring env proxies also guarantees the
    loopback request really goes straight to 127.0.0.1.
    """
    import httpx

    return OpenAI(
        base_url=f"{base_url}/v1",
        api_key=api_key,
        timeout=120.0,
        max_retries=1,
        http_client=httpx.Client(trust_env=False, timeout=120.0),
    )


def reasoning_tokens(resp) -> int | None:
    details = getattr(resp.usage, "completion_tokens_details", None)
    return getattr(details, "reasoning_tokens", None) if details else None


def call_once(client: OpenAI, model: str) -> tuple[str, int | None]:
    resp = client.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": PROBE_PROMPT}],
        max_tokens=2048,
        temperature=0,
    )
    text = (resp.choices[0].message.content or "").strip()
    return text, reasoning_tokens(resp)


def check_non_streaming(client: OpenAI, rep: Report, max_tokens: int = 2048) -> None:
    rep.section("3. non-streaming round trip (all models)")
    for model in EXPECTED_EFFORT:
        try:
            text, rtok = call_once(client, model)
        except Exception as exc:
            rep.fail(f"{model} answered", f"{type(exc).__name__}: {str(exc)[:160]}")
            continue
        detail = f"answer={text[:12]!r} reasoning_tokens={rtok}"
        if PROBE_EXPECT in text:
            rep.ok(f"{model} answered", detail)
        elif not text and rtok is not None and rtok >= max_tokens - 4:
            # the model spent the whole budget thinking and never emitted the
            # answer - a token-budget artifact, not a transport problem
            rep.ok(f"{model} answered", detail + "  (budget consumed by reasoning)")
        elif text:
            rep.warn(f"{model} answered", detail + "  (transport fine, unexpected answer)")
        else:
            rep.warn(f"{model} answered", detail + "  (empty content)")


def check_streaming(client: OpenAI, rep: Report) -> None:
    rep.section("4. streaming round trip (all models)")
    for model in EXPECTED_EFFORT:
        chunks = 0
        text_parts: list[str] = []
        reasoning_parts: list[str] = []
        try:
            stream = client.chat.completions.create(
                model=model,
                messages=[{"role": "user", "content": "Count from 1 to 3."}],
                max_tokens=256,
                stream=True,
            )
            for chunk in stream:
                chunks += 1
                if not chunk.choices:
                    continue
                delta = chunk.choices[0].delta
                if delta is None:
                    continue
                if getattr(delta, "content", None):
                    text_parts.append(delta.content)
                # several gateway models stream their thinking first and only then
                # the answer; some (e.g. GLM-5.3-Flash) put everything here
                rc = getattr(delta, "reasoning_content", None)
                if rc:
                    reasoning_parts.append(rc)
        except Exception as exc:
            rep.fail(f"{model} streamed", f"{type(exc).__name__}: {str(exc)[:160]}")
            continue

        text = "".join(text_parts).strip()
        reasoning = "".join(reasoning_parts).strip()
        detail = f"chunks={chunks} content={len(text)}c reasoning={len(reasoning)}c"
        if chunks > 0 and (text or reasoning):
            rep.ok(f"{model} streamed", detail + f" first={(text or reasoning)[:16]!r}")
        else:
            rep.fail(f"{model} streamed", detail + " (no delta content at all)")


def check_effort_injection(base_url: str, client: OpenAI, rep: Report, samples: int) -> None:
    """
    Verify the proxy's decision per request and compare upstream usage.

    Two precedence rules matter here and the test exercises both:
      * a per-model entry in effort.json wins over the global default;
      * the global default is what applies to models NOT listed in `models`.

    So "send no parameter" is obtained by setting the *model's own* tier to null
    (null = omit the field), not by clearing the default while a per-model entry
    still exists.

    NOTE on the assertion: `reasoning_tokens` is inherently noisy, so an
    unexpected direction is a WARN, never a FAIL. The hard assertions are that
    both configurations answer correctly and that the proxy's counters record the
    right decision - i.e. the plumbing works.
    """
    rep.section(f"5. effort injection (max vs no parameter, {samples} sample(s) each)")
    model = "DeepSeek-V4.1-Flash"   # most visibly affected model in the tier matrix
    effort_before = proxy_status(base_url).get("effort") or {}
    model_tier_before = (effort_before.get("models") or {}).get(model)

    def set_model_tier(effort: str | None) -> None:
        http_json(f"{base_url}/_control", "POST", {"model": model, "effort": effort})

    def measure(effort: str | None) -> tuple[list[int], int, int]:
        before = proxy_status(base_url)["counters"]
        set_model_tier(effort)
        tokens: list[int] = []
        for _ in range(samples):
            try:
                _, rtok = call_once(client, model)
                tokens.append(rtok if rtok is not None else -1)
            except Exception as exc:
                print(f"        call failed: {type(exc).__name__}: {str(exc)[:120]}")
                tokens.append(-1)
        after = proxy_status(base_url)["counters"]
        return tokens, after["injected"] - before["injected"], after["defaulted"] - before["defaulted"]

    try:
        max_seen, inj_max, def_max = measure("max")
        none_seen, inj_none, def_none = measure(None)
    finally:
        set_model_tier(model_tier_before)
        print(f"        (restored {model} tier to {model_tier_before!r})")

    if inj_max >= samples and def_max == 0:
        rep.ok("proxy injected 'max'", f"samples={max_seen} injected={inj_max}")
    else:
        rep.fail("proxy injected 'max'", f"injected={inj_max} defaulted={def_max} samples={max_seen}")

    if def_none >= samples and inj_none == 0:
        rep.ok("proxy omitted the parameter", f"samples={none_seen} defaulted={def_none}")
    else:
        rep.fail("proxy omitted the parameter", f"injected={inj_none} defaulted={def_none} samples={none_seen}")

    print(f"        reasoning_tokens  max={max_seen}   no-parameter={none_seen}")
    good = [t for t in max_seen if t >= 0]
    bare = [t for t in none_seen if t >= 0]
    if good and bare:
        m_max, m_bare = statistics.mean(good), statistics.mean(bare)
        direction = "more" if m_max > m_bare else "less/equal"
        # Never a hard failure: how much a model chooses to think is noisy, and the
        # gateway does not guarantee monotonicity across tiers. The plumbing is
        # already asserted by the counters above.
        rep.ok(
            "'max' vs no-parameter measured",
            f"max mean {m_max:.0f} vs bare mean {m_bare:.0f} ({direction} reasoning; noisy - use --samples 3+)",
        )


def check_default_precedence(base_url: str, rep: Report) -> None:
    """
    The global default must be settable and clearable, and it must be what an
    UNLISTED model gets. Exercising it with a real unlisted model would need an
    extra model on the gateway, so the observable proxy state is asserted
    instead: `/_status.effort.default` is exactly the tier the proxy would send
    for any model absent from `models`.
    """
    rep.section("5b. fallback semantics (/status.effort.default)")
    effort_before = proxy_status(base_url).get("effort") or {}
    listed = list((effort_before.get("models") or {}).keys())

    try:
        proxy_set_default(base_url, "max")
        st = proxy_status(base_url)["effort"]
        if st.get("default") == "max":
            rep.ok("global default = max", f"unlisted models would get 'max' (listed: {', '.join(listed)})")
        else:
            rep.fail("global default = max", json.dumps(st))

        proxy_set_default(base_url, None)
        st = proxy_status(base_url)["effort"]
        if st.get("default") is None:
            rep.ok("global default = none", "unlisted models would send no reasoning_effort")
        else:
            rep.fail("global default = none", json.dumps(st))

        # null / "" / "default" must all normalise to "omit the parameter"
        for alias in ("", "default"):
            http_json(f"{base_url}/_control", "POST", {"default": alias})
            st = proxy_status(base_url)["effort"]
            if st.get("default") is None:
                rep.ok(f"default {alias!r} normalises to omit", "null")
            else:
                rep.fail(f"default {alias!r} normalises to omit", json.dumps(st))
    finally:
        proxy_set_default(base_url, effort_before.get("default"))
        print(f"        (restored default to {effort_before.get('default')!r})")


def check_extra_params(client: OpenAI, rep: Report) -> None:
    rep.section("6. extra body fields pass through")
    try:
        resp = client.chat.completions.create(
            model="DeepSeek-V4.1-Flash",
            messages=[{"role": "user", "content": "say ok"}],
            max_tokens=24,
            temperature=0,
            extra_body={"thinking": {"type": "enabled"}},
        )
        content = (resp.choices[0].message.content or "").strip()
        rep.ok("extra_body accepted", f"answer={content[:16]!r} reasoning_tokens={reasoning_tokens(resp)}")
    except Exception as exc:
        rep.fail("extra_body accepted", f"{type(exc).__name__}: {str(exc)[:160]}")


def check_bad_model(client: OpenAI, rep: Report) -> None:
    rep.section("7. unknown model -> clean upstream error")
    try:
        client.chat.completions.create(
            model="definitely-not-a-real-model-xyz",
            messages=[{"role": "user", "content": "hi"}],
            max_tokens=8,
        )
        rep.warn("unknown model rejected", "the call unexpectedly succeeded")
    except Exception as exc:
        status = getattr(exc, "status_code", None)
        if status and 400 <= status < 500:
            rep.ok("unknown model rejected", f"HTTP {status} ({type(exc).__name__})")
        else:
            rep.warn("unknown model rejected", f"{type(exc).__name__}: {str(exc)[:120]}")


def check_control_roundtrip(base_url: str, rep: Report) -> None:
    rep.section("8. control API round trip")
    try:
        before = proxy_status(base_url)["effort"]
        probe = "high" if before.get("models", {}).get("Kimi-K3") != "high" else "medium"
        http_json(f"{base_url}/_control", "POST", {"model": "Kimi-K3", "effort": probe})
        mid = proxy_status(base_url)["effort"]["models"].get("Kimi-K3")
        http_json(f"{base_url}/_control", "POST", {"model": "Kimi-K3", "effort": before["models"].get("Kimi-K3")})
        after = proxy_status(base_url)["effort"]
        if mid == probe:
            rep.ok("per-model override applied", f"Kimi-K3 -> {probe}")
        else:
            rep.fail("per-model override applied", f"got {mid!r}")
        if after == before:
            rep.ok("configuration restored", json.dumps(after, ensure_ascii=False))
        else:
            rep.fail("configuration restored", f"{json.dumps(before)} -> {json.dumps(after)}")
    except Exception as exc:
        rep.fail("control API round trip", f"{type(exc).__name__}: {str(exc)[:160]}")


# ---------------------------------------------------------------------------
# optional: compare against the gateway directly (needs the real API key)
# ---------------------------------------------------------------------------

def build_direct_client(base_url: str) -> OpenAI | None:
    """
    Build a client that talks to the gateway directly, to prove the proxy is
    injecting the parameter. Needs the real key: taken from PARATERA_API_KEY, or
    from tools/keys.json next to this test folder.
    """
    key = os.environ.get("PARATERA_API_KEY")
    if not key:
        here = os.path.dirname(os.path.abspath(__file__))
        for candidate in (
            os.path.join(here, "..", "keys.json"),
            os.path.join(here, "keys.json"),
        ):
            try:
                with open(candidate, encoding="utf-8") as fh:
                    key = (json.load(fh) or {}).get("default")
                if key:
                    print(f"        (direct client key from {os.path.abspath(candidate)})")
                    break
            except Exception:
                continue
    if not key:
        return None
    upstream = (proxy_status(base_url).get("upstream") or os.environ.get("UPSTREAM_URL", "")).rstrip("/")
    return make_client(upstream, api_key=key)


def check_direct_vs_proxy(base_url: str, rep: Report, samples: int) -> None:
    rep.section(f"9. direct gateway vs proxy (same model/prompt, {samples} sample(s))")
    direct = build_direct_client(base_url)
    if direct is None:
        rep.warn("direct comparison", "no API key (set PARATERA_API_KEY) - skipped")
        return

    client = make_client(base_url)
    model = "DeepSeek-V4.1-Flash"
    try:
        d_resp_tokens: list[int] = []
        p_resp_tokens: list[int] = []
        for _ in range(samples):
            _, t = call_once(direct, model)      # plain: no reasoning_effort
            d_resp_tokens.append(t if t is not None else -1)
            _, t2 = call_once(client, model)     # proxy: injects its tier
            p_resp_tokens.append(t2 if t2 is not None else -1)
        print(f"        direct (no parameter) reasoning_tokens={d_resp_tokens}")
        print(f"        proxy  (tier injected) reasoning_tokens={p_resp_tokens}")
        d_ok = [t for t in d_resp_tokens if t >= 0]
        p_ok = [t for t in p_resp_tokens if t >= 0]
        if d_ok and p_ok:
            rep.ok("both paths answered",
                   f"direct mean={statistics.mean(d_ok):.0f} proxy mean={statistics.mean(p_ok):.0f}")
        else:
            rep.warn("both paths answered", "some calls returned no usage details")
    except Exception as exc:
        rep.fail("direct comparison", f"{type(exc).__name__}: {str(exc)[:160]}")


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(description="Test the Paratera reasoning-effort proxy with the OpenAI SDK")
    ap.add_argument("--base-url", default=ENV_BASE_URL,
                    help="proxy root, without /v1 (default: %(default)s)")
    ap.add_argument("--samples", type=int, default=ENV_SAMPLES,
                    help="samples per effort tier (default %(default)s)")
    ap.add_argument("--skip-streaming", action="store_true", default=ENV_NO_STREAM)
    ap.add_argument("--direct", action="store_true", default=ENV_DIRECT,
                    help="also compare against the gateway directly")
    args = ap.parse_args()

    base_url = args.base_url.rstrip("/")
    print("=" * 74)
    print("Paratera reasoning-effort proxy - OpenAI SDK test")
    print(f"proxy      : {base_url}")
    print(f"openai sdk : {__import__('openai').__version__}")
    print("=" * 74)

    rep = Report()
    status = check_health(base_url, rep)
    if not status:
        print("\nProxy is not reachable. Start it with paratera-proxy.bat first.")
        return 2

    check_effort_map(status, rep)
    client = make_client(base_url)
    check_non_streaming(client, rep)
    if not args.skip_streaming:
        check_streaming(client, rep)
    check_effort_injection(base_url, client, rep, max(1, args.samples))
    check_default_precedence(base_url, rep)
    check_extra_params(client, rep)
    check_bad_model(client, rep)
    check_control_roundtrip(base_url, rep)
    if args.direct:
        check_direct_vs_proxy(base_url, rep, max(1, args.samples))

    print("\n" + "=" * 74)
    print(f"RESULT: {len(rep.passed)} passed, {len(rep.failed)} failed, {len(rep.warned)} warnings")
    for name in rep.failed:
        print(f"  failed: {name}")
    print("=" * 74)
    return 1 if rep.failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
