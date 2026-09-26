#!/usr/bin/env python
"""
selfcheck.py -- startup self-check + orientation banner for paratera-proxy.bat.

Runs the fast pytest smoke test against the freshly started proxy (so the console
shows whether it is healthy), then prints what the proxy is for, how to use it,
and how to change the thinking-effort tiers.

    pixi run python selfcheck.py            # run smoke test, then banner
    pixi run python selfcheck.py --no-tests # banner only (quick restart)
    pixi run python selfcheck.py --full     # run the full suite instead
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
TOOLS = os.path.dirname(HERE)

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

BAR = "=" * 78
THIN = "-" * 78


def get_json(url: str, timeout: float = 8.0):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8", "replace"))
    except Exception:
        return None


def load_effort_file() -> dict:
    try:
        with open(os.path.join(TOOLS, "effort.json"), encoding="utf-8") as fh:
            return json.load(fh) or {}
    except Exception:
        return {}


def _run(cmd: list[str], env: dict | None = None) -> int:
    print(f"$ {' '.join(cmd)}")
    print(THIN)
    try:
        return subprocess.run(cmd, cwd=HERE, env=env).returncode
    except FileNotFoundError:
        print(f"[warn] {cmd[0]} not found in this environment - skipping that step")
        return 0


def run_pytest(full: bool) -> int:
    """
    Quick path : the pytest smoke module, so each check shows up individually.
    Full path  : the complete suite. It is a script (no pytest test functions), so
                 it runs directly - the pytest smoke module is still run first so
                 the console always gets the per-check view.
    """
    # configuration goes through the environment: pytest would reject this
    # project's own argparse flags such as --samples
    env = dict(os.environ)
    env.setdefault("PARATERA_TEST_SAMPLES", "1")   # keep the startup run quick

    rc = _run(["pytest", "-v", "--no-header", "test_smoke.py"], env=env)
    if not full:
        return rc

    print()
    print("Running the full suite as well (all models, effort injection, control API)...")
    print()
    rc_full = _run(["python", "test_proxy.py", "--samples", "1"], env=env)
    return rc or rc_full


def describe_tier(value) -> str:
    if value is None:
        return "provider default (no parameter sent)"
    return str(value)


def print_banner(base_url: str, live: dict | None, file_cfg: dict, rc: int) -> None:
    live_effort = (live or {}).get("effort") or {}
    models = live_effort.get("models") or {}
    fallback = live_effort.get("default")
    counters = (live or {}).get("counters") or {}
    upstream = (live or {}).get("upstream") or os.environ.get("UPSTREAM_URL", "")

    print()
    print(BAR)
    print("  PARATERA THINKING-EFFORT PROXY")
    print(BAR)
    print()
    print("  WHY THIS EXISTS")
    print("    Some AI clients / frameworks that support BYOK (bring your own key) have no")
    print("    setting for thinking effort. Trae CN is one of them: for custom models on")
    print(f"    {upstream} it never sends the `reasoning_effort` field at all,")
    print("    and its per-model config cannot be made to stick (Trae reloads the model")
    print("    list from the server every few minutes and drops the edit).")
    print()
    print("    So the place where thinking effort is configured moved HERE, into this")
    print("    proxy: Trae talks to 127.0.0.1, and the proxy adds `reasoning_effort`")
    print("    on the way out, per model.")
    print()
    print(THIN)
    print("  CURRENT THINKING EFFORT  (live from the running proxy)")
    print()
    print(f"    {'MODEL':<24}{'TIER SENT UPSTREAM':<34}")
    print(f"    {'-' * 22}  {'-' * 32}")
    for name, tier in sorted(models.items()):
        print(f"    {name:<24}{describe_tier(tier):<34}")
    print()
    print(f"    any other / new model        {describe_tier(fallback):<34}")
    print(f"    (fallback tier, from effort.json \"default\")")
    print()
    print(THIN)
    print("  HOW TO CHANGE IT  (takes effect immediately, no restart)")
    print()
    print("    A) per model, from the command line:")
    print("         Invoke-RestMethod http://127.0.0.1:8798/_control -Method Post `")
    print("           -ContentType application/json `")
    print('           -Body \'{"model":"GLM-5.3-Flash","effort":"max"}\'')
    print()
    print("       allowed tiers: none | low | medium | high | xhigh | max")
    print('       null (or "") = send nothing, i.e. the provider\'s own default:')
    print('         -Body \'{"model":"Qwen3.8-Max","effort":null}\'')
    print()
    print("    B) edit effort.json next to this script - it is re-read while running:")
    print('         { "default": "max",')
    print('           "models": { "Qwen3.8-Max": "medium", "Kimi-K3": null } }')
    print()
    print("    C) fallback for every model without its own entry:")
    print('         -Body \'{"default":"max"}\'      # or "default": null')
    print()
    print("    See what is active right now:   http://127.0.0.1:8798/_status")
    print()
    print(THIN)
    print("  HOW TO USE IT IN TRAE")
    print()
    print("    Add a custom model (Settings -> Models -> Add / OpenAI compatible):")
    print()
    print("      Base URL   : http://127.0.0.1:8798/chat/completions")
    print("      Model name : EXACTLY one of these - the gateway is case-sensitive,")
    print("                   and 'Deepseek-...' instead of 'DeepSeek-...' fails:")
    print()
    for name in sorted(models.keys()):
        print(f"                     {name}")
    print()
    print("      API key    : any placeholder - the proxy injects the real key")
    print("      Thinking   : Follow default")
    print()
    print("    The 'Test connection' button should then return success. If it reports")
    print("    an error, check http://127.0.0.1:8798/_status -> recentRequests: it")
    print("    shows exactly what arrived and what the upstream answered.")
    print()
    print("    Keep your original direct models as the fallback for when this is off.")
    print()
    print(THIN)
    print("  HOW TO STOP / RESTART")
    print()
    print("    stop     : double-click paratera-proxy-stop.bat")
    print("    start    : double-click paratera-proxy.bat   (this script)")
    print("    status   : powershell -File paratera-proxy-ctl.ps1 status")
    print("    full test: proxy-tests\\run-tests.bat")
    print()
    print(THIN)
    if rc == 0:
        print("  SELF-CHECK: PASSED - the proxy is healthy and ready.")
    else:
        print(f"  SELF-CHECK: FAILED (pytest exit {rc}) - see the output above.")
        print("              The proxy is still running; check the failures, then use")
        print("              http://127.0.0.1:8798/_status to inspect it.")
    if counters:
        print(f"  counters so far: requests={counters.get('requests', 0)} "
              f"injected={counters.get('injected', 0)} "
              f"defaulted={counters.get('defaulted', 0)} "
              f"errors={counters.get('errors', 0)}")
    print(BAR)
    print()


def main() -> int:
    ap = argparse.ArgumentParser(description="startup self-check + info banner")
    ap.add_argument("--base-url", default=os.environ.get("PARATERA_PROXY_URL", "http://127.0.0.1:8798"))
    ap.add_argument("--no-tests", action="store_true", help="skip pytest, print the banner only")
    ap.add_argument("--full", action="store_true", help="run the full suite instead of the smoke test")
    args = ap.parse_args()

    base_url = args.base_url.rstrip("/")

    print(BAR)
    print(f"  Starting up check for {base_url}")
    print(BAR)

    rc = 0
    if not args.no_tests:
        rc = run_pytest(args.full)
        print(THIN)
        print(f"pytest exit code: {rc}  ({'all checks passed' if rc == 0 else 'FAILURES - see above'})")

    live = get_json(f"{base_url}/_status")
    if live is None:
        print(f"\n[warn] {base_url}/_status is not answering - is the proxy still running?")

    print_banner(base_url, live, load_effort_file(), rc)
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
