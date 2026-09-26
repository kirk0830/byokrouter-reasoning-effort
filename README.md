# byokrouter-reasoning-effort

**English** | [中文](docs/README_zh.md)

An OpenAI-compatible reverse proxy that **adds a thinking-effort tier
(`reasoning_effort`) to requests**, so you can control how hard a model thinks
even when your client gives you no way to set it.

## The two problems this solves

**Problem 1 — the client has no setting for thinking effort.**
You brought your own key, your gateway supports `reasoning_effort`, but the IDE
you are using exposes no control for it — and its per-model config often cannot be
patched either, because it lives in an embedded database the app keeps
overwriting, or inside a signed bundle. The setting has nowhere to live, so move
it to the network layer: point the custom model at this proxy, and the proxy
decides, per model, whether to send `reasoning_effort`. Everything else passes
through untouched.

**Problem 2 — the client may not be the one talking to your model.**
Some AI-IDEs do something genuinely puzzling: instead of calling the model from
your machine, they hand the base URL to **their vendor's servers** and let those
servers make the request on your behalf. A proxy that fixes problem 1 therefore
has to be reachable by *that* server too — which rules out `127.0.0.1` entirely,
however correct your local setup is.

```
problem 1 only:   client ──► proxy ──► gateway ──► model
                  bind loopback; done

problem 1 + 2:    client ──► vendor server ──► proxy ──► gateway ──► model
                  the proxy must be reachable FROM THE INTERNET, which means
                  a client token, a source allowlist, and a deliberate decision
                  about exposure — see docs/why-a-proxy.md
```

This repo covers both: a portable core for problem 1, and
[docs/why-a-proxy.md](docs/why-a-proxy.md) for recognising, diagnosing and
deciding about problem 2.

---

## Quick start

```bash
git clone <this repo> && cd byokrouter-reasoning-effort

cp .env.example .env          # then edit .env
node bin/start.mjs            # no dependencies, uses only Node's stdlib
```

`.env` needs at least two values:

```ini
UPSTREAM_URL=https://your-openai-compatible-gateway.example.com
UPSTREAM_API_KEY=<your key>
```

`bin/start.mjs` prints exactly what to paste into your client:

```
------------------------------------------------------------------------
 paste these into the client
------------------------------------------------------------------------
  Base URL : http://127.0.0.1:8798/chat/completions
  API key  : <generated client token>
  Models   : any model id the upstream accepts, e.g.
               GLM-5.3-Flash
               DeepSeek-V4.1-Flash
  Tiers    : none | low | medium | high | xhigh | max   (null = send nothing)
  Status   : http://127.0.0.1:8798/_status   (loopback only)
------------------------------------------------------------------------
```

Requirements: **Node 18+** (uses the built-in `fetch` in tooling only; the proxy
itself uses `node:http`/`node:https`). No package install, no build step.

---

## Configuring thinking effort

`byokrouter.json` (committed — it contains no secrets):

```json
{
  "reasoning": {
    "default": "max",
    "models": {
      "GLM-5.3-Flash": "max",
      "DeepSeek-V4.1-Flash": "max",
      "Qwen3.8-Max": "medium",
      "Kimi-K3": "medium"
    }
  }
}
```

* `default` applies to any model not listed.
* `null`, `""` or `"default"` means **send no `reasoning_effort` at all** — the
  provider's own default. This is the honest way to express "default": it is a
  state, not a value.
* Valid tiers: `none | low | medium | high | xhigh | max`.

Changes to the file are picked up **while running** — no restart. You can also
change tiers live:

```bash
curl -X POST http://127.0.0.1:8798/_control \
     -H 'content-type: application/json' \
     -d '{"model":"Kimi-K3","effort":"max"}'
```

Runtime overrides are stored in `.state/tiers.json` and survive a restart.

> **Tier names are provider-relative, not universal.** `max` is "ask for the
> most", but what that means depends on the upstream. Some models even default
> *above* their `max` tier. Measure before you trust: see
> [docs/reasoning-effort.md](docs/reasoning-effort.md) for a method and a worked
> example, including the trap that `none` can silently disable thinking and
> produce wrong answers.

---

## Configuration reference

Precedence, highest first: **environment → `.env` → `byokrouter.json` → defaults.**

| variable | purpose |
|---|---|
| `UPSTREAM_URL` | the gateway to forward to (**required**) |
| `UPSTREAM_API_KEY` | upstream key (**required** unless a keys file is used) |
| `REASONING_PROXY_BIND` | `127.0.0.1` (default) or `0.0.0.0` |
| `REASONING_PROXY_PORT` | listen port (default 8798) |
| `REASONING_PROXY_CLIENT_TOKEN` | token clients must present; **required off-loopback** |
| `REASONING_PROXY_ADMIN_TOKEN` | extra token for the loopback-only admin API |
| `REASONING_PROXY_ALLOWLIST` | comma-separated source prefixes allowed to use the proxy |
| `REASONING_PROXY_ALLOWLIST_STRICT` | `1` = reject other sources with 403 |
| `REASONING_PROXY_TRUST_FORWARDED` | `1` = judge the allowlist on `x-forwarded-for` |
| `REASONING_PROXY_NO_ADMIN` | `1` = remove `/_status` and `/_control` entirely |

Any `BYOKROUTER_*` alias works too, and the JSON config accepts `${VAR}`
references:

```json
{ "keys": { "default": "${UPSTREAM_API_KEY}" } }
```

That is what keeps secrets out of the committed file. Unresolved references are
reported at startup instead of failing later with a confusing 401.

---

## Admin API

Loopback-only by default. `/control` requires `REASONING_PROXY_ADMIN_TOKEN` if set.

| endpoint | purpose |
|---|---|
| `GET /_status` | tiers in effect, counters, and the last 20 requests (model, tier, source address) |
| `POST /_control` | `{"model":"<id>","effort":"<tier>\|null"}`, or `{"default":"<tier>"}` |

The recent-request log is the fastest way to answer "what did my client actually
send, and from where?" — it records the source address and `x-forwarded-for`.

---

## Security

The proxy holds an upstream API key, so treat the port as sensitive.

* **Off-loopback requires a client token.** Without one, anyone who can reach the
  port can spend your credits — the proxy warns at startup if you do this.
* **`/_status` and `/_control` are loopback-only**, always. `/_control` can change
  what gets sent upstream, so it must never be reachable from off-box.
* **Tokens are compared in constant time** and the incoming `authorization`
  header is **replaced** by the real upstream key, so your client token is never
  forwarded to the gateway.
* **`x-forwarded-for` is stripped** before forwarding; your network topology is
  not the gateway's business.
* **Allowlist by source prefix** when the client is reached from known addresses.
  Behind NAT, enable `REASONING_PROXY_TRUST_FORWARDED` so the allowlist is judged
  on the forwarded address rather than the router's.
* Run `node scan-secrets.mjs` before pushing. It fails on credential-shaped
  strings and on site-specific values you would not want public.

Nothing secret needs to be committed: `.env`, `keys.json`, `*.token` and
`.state/` are all gitignored.

---

## The one thing that surprises everyone

**A client may not be able to reach your proxy at all.**

Some clients validate a custom model — and then call it — **from their own
servers**, not from your machine. In that case `http://127.0.0.1:…` can never
work, and the failure looks like a generic `500` or a vendor-specific
"origin error" while your proxy logs show *zero* requests.

Diagnose it in one step: watch the counters while the client runs its test. If
they stay at `0`, the request never arrived.

Fixes, in order of preference:

1. bind to the LAN (`--lan`) and use an address the vendor's servers can reach
   (works if you have a public IPv4/IPv6 address);
2. put the proxy behind a tunnel (Cloudflare Tunnel, ngrok…) with its own auth;
3. give up on the client-side integration and use the proxy from a tool that
   runs locally.

Read [docs/why-a-proxy.md](docs/why-a-proxy.md) for the full reasoning and the
evidence-gathering method.

---

## Repository layout

```
src/proxy.mjs          the proxy (portable, stdlib only)
src/config.mjs         config loading: env / .env / JSON, ${VAR} expansion
bin/start.mjs          cross-platform launcher (prints the client settings)
byokrouter.json        committable runtime config (tiers, allowlist, refs)
.env.example           template for the gitignored .env
scan-secrets.mjs       pre-push secret scanner
docs/                  why-a-proxy, reasoning-effort, windows-gotchas
platforms/trae-windows/  optional adapter: one-click launcher for Trae CN on Windows
```

The core is client-agnostic. `platforms/` exists because individual clients need
individual workarounds; see [platforms/trae-windows/README.md](platforms/trae-windows/README.md).

---

## License

MIT — see [LICENSE](LICENSE).
