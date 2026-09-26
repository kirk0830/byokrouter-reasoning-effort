# proxy-tests — verify the Paratera reasoning-effort proxy

Tests the live proxy (`..\paratera-proxy.mjs`, started by `..\paratera-proxy.bat`)
using the real `openai` Python SDK, because that is the same client shape Trae-like
tools use. A pass here means a real OpenAI-compatible client works through the proxy.

## Two modes

**Startup self-check** — `..\paratera-proxy.bat` runs `selfcheck.py` automatically after
starting the proxy: a fast pytest smoke pass, then the orientation banner (why the
proxy exists, current tiers, how to change them, how to use it in Trae, how to stop it).

```powershell
..\paratera-proxy.bat                # start + smoke self-check + banner   (~8 s)
..\paratera-proxy.bat --full-check   # also run the complete suite
..\paratera-proxy.bat --no-check     # fast restart, banner skipped too
```

**Full suite** — the deeper checks, also runnable on demand:

```powershell
.\run-tests.bat
pixi run python test_proxy.py
pixi run python test_proxy.py --samples 3 --direct
```

| flag | meaning |
|---|---|
| `--base-url` | proxy root, default `http://127.0.0.1:8798` |
| `--samples N` | samples per effort tier in the reasoning-token comparison (default 2) |
| `--skip-streaming` | skip the streaming checks |
| `--direct` | also talk to the gateway **directly** (uses the key from `..\keys.json`) and compare |

Exit code `0` = every required check passed. Under pytest, configuration comes from the
environment instead of flags (`PARATERA_PROXY_URL`, `PARATERA_TEST_SAMPLES`,
`PARATERA_TEST_DIRECT`), because pytest would reject this project's own argparse flags.

## What is covered

**`test_smoke.py`** (startup check — 2 upstream calls, all must pass)

| check | why it matters |
|---|---|
| proxy listening, upstream set | the proxy is actually usable |
| upstream API key present | auth can be injected |
| effort map matches `effort.json` | the running proxy serves the tiers you configured |
| one model answers non-streaming | base transport works |
| streaming works | SSE passthrough works |
| unknown model → clean 4xx | errors are not masked or hung |

**`test_proxy.py`** (full suite)

| # | check | why it matters |
|---|---|---|
| 1 | `/_status` reachable, upstream set, API key present | the proxy is actually usable |
| 2 | configured tiers match `effort.json` (`max` for the three flash models, `medium` for `Qwen3.8-Max` / `Kimi-K3`) | your intended configuration is live |
| 3 | all 5 models answer a non-streaming request | base transport + auth injection |
| 4 | all 5 models stream and terminate | SSE passthrough works |
| 5 | proxy injects `max` vs omits the parameter, verified through its own counters | the core behaviour |
| 5b | fallback semantics: `default` settable/clearable; `null` / `""` / `"default"` all normalise to "omit" | the "provider default" state |
| 6 | `extra_body` (e.g. `thinking`) passes through | the proxy does not swallow unknown fields |
| 7 | an unknown model yields a clean HTTP 4xx | errors are not masked or hung |
| 8 | `POST /_control` round-trips and the config is restored | live tuning is safe |
| 9 | optional: direct gateway vs proxy on the same prompt | shows the proxy side by side |

## Notes / known noise

* **`reasoning_tokens` is not monotonic across tiers.** Measured repeatedly, `max`
  sometimes uses fewer reasoning tokens than "no parameter" (e.g. 893 vs 1078 mean in
  one run). How much a model chooses to think varies run to run, and the gateway does
  not guarantee a strict ordering. The suite therefore asserts the *plumbing*
  (which decision the proxy made, that calls succeed) and only *reports* the token
  comparison.
* **Empty answer with a full reasoning budget** is reported as a pass with a note: some
  models, at `max`, spend all of `max_tokens` thinking. Raise `max_tokens` if you want
  the final answer too.
* **`trust_env=False` is set on the httpx client on purpose.** This machine's
  `no_proxy`/`NO_PROXY` contains `[::1]`, which httpx refuses to parse
  (`InvalidURL: Invalid port: ':1]'`), and it also guarantees loopback traffic is not
  sent through a system proxy.

## Files

| file | purpose |
|---|---|
| `selfcheck.py` | startup self-check + orientation banner (called by `..\paratera-proxy.bat`) |
| `test_smoke.py` | the fast startup checks (pytest) |
| `test_proxy.py` | the full suite (also importable as a pytest target for the smoke module) |
| `run-tests.bat` | convenience wrapper for the full suite (checks pixi, forwards args) |
| `pixi.toml`, `pixi.lock` | environment: python 3.12 + openai + httpx + pytest |
| `.pixi/` | the pixi environment itself (created on first run) |
