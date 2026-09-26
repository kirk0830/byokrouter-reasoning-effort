# Why a proxy at all?

Because the client can't be configured, and — more surprisingly — **because the
client may not even be the thing making the request.**

This document explains both, with the diagnostic method, so you can decide in a
few minutes whether this tool can help you.

---

## 1. The client has no setting for thinking effort

Many clients support "bring your own key" (BYOK) and let you add an
OpenAI-compatible custom model, but expose no control for `reasoning_effort`.
Some gate it behind an internal-user flag, some only show it for built-in models,
some have no concept of it at all.

What makes it worse: in several of these clients the request configuration is
**not something you can patch**:

* it lives in an embedded SQLite database whose writes race the app (the app
  reloads the model list from its server and overwrites your edit) — see
  [docs/reasoning-effort.md](reasoning-effort.md#when-the-database-is-the-only-place);
* or it is compiled into a signed bundle.

Moving the **network endpoint** instead of the client's storage sidesteps all of
it: the client sends what it always sends, and the proxy adds the field.

```
before:  client ──────────────────────────────► gateway      (no reasoning_effort)
after:   client ──► proxy (adds the field) ───► gateway
```

---

## 2. The client's *servers* may be the ones calling your model

This is the trap that wastes an afternoon. Some clients do not call a custom
model from your machine. They:

1. read the base URL you entered,
2. send it to **their own backend**, and
3. have *that* backend validate and call it.

If the URL is `http://127.0.0.1:…`, their backend is trying to reach *its own*
localhost. It will fail, and it will fail in a way that blames your URL:

```
error sending request for url (http://127.0.0.1:8798/chat/completions) (HTTP Status: 500)
```

with a vendor error code such as `CUSTOM_MODEL_ORIGIN_ERROR` — that code is
emitted by the vendor's server, not by your machine.

### How to tell in one step

**Watch the proxy's own counters while the client runs its connection test.**

```bash
curl -s http://127.0.0.1:<port>/_status -H "authorization: Bearer <admin token>"
```

* `counters.requests` **does not move** → the request never reached your machine.
  The client's backend is doing the fetching. Loopback can never work.
* `counters.requests` moves → the request came from somewhere real; look at
  `recentRequests[].remoteAddress` / `.forwardedFor` to see from where.

Supporting evidence, all cheap to collect:

| signal | meaning |
|---|---|
| the failure takes ~1–2 s | a remote round trip, not a refused local connection (that is ~1 ms) |
| `x-forwarded-for` holds a public address | the caller is a datacentre, not your machine |
| a client-server `User-Agent` (e.g. an internal Go client) | confirms it is backend traffic |
| the client's own logs show the failure in a *connectivity check* event | it never even got to the chat path |

### What you can do about it

| option | when it works | cost |
|---|---|---|
| **Bind to the LAN / use your public address** | you have a routable address (many home ISPs give a public IPv6 prefix) | the port is exposed; a client token and a source allowlist are mandatory |
| **Put the proxy behind a tunnel** (Cloudflare Tunnel, ngrok, …) | always, for any client | one more dependency; the tunnel URL changes unless you own a hostname; you are exposing a port that spends your credits |
| **Skip the client integration** | you have any other local tool that talks to the gateway | you lose the integration |

There is no fourth option: if the vendor's servers must reach the proxy, they
must be able to reach it, and only you can decide whether that exposure is
acceptable.

### If you go the exposed route

Do all of these:

* require a client token (`REASONING_PROXY_CLIENT_TOKEN`) — 128-bit random;
* add an `authorization` check *and* remember the proxy replaces that header with
  the real upstream key, so the token never reaches the gateway;
* restrict by source prefix once you have observed real traffic
  (`REASONING_PROXY_ALLOWLIST` + `..._STRICT`), and enable
  `..._TRUST_FORWARDED` when NAT hides the caller;
* keep the admin API loopback-only (it already is) or remove it
  (`REASONING_PROXY_NO_ADMIN=1`);
* prefer a non-default port.

---

## 3. What the proxy deliberately does NOT do

* It does not rewrite your prompt, tools, or conversation — it only adds one
  optional field.
* It does not retry, cache, or log bodies anywhere persistent. The recent-request
  ring buffer keeps a short body preview in memory for debugging only.
* It does not store the upstream key anywhere except where you put it
  (`.env` / a keys file), and never writes it to logs.
* It does not require a package install. If you can run Node, you can run it.
