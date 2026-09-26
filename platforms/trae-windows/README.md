# platforms/trae-windows

Optional adapter for **Trae CN on Windows**. The core proxy in `src/` and
`bin/start.mjs` is client-agnostic and does not use anything here.

These scripts exist because Trae needs three extra things that the generic
launcher does not do:

1. **A windowless launcher** (`.vbs`) plus `.bat` wrappers, because Trae is
   started from Explorer and there is no console to keep open.
2. **A remembered port and client token**, because Trae cannot change a custom
   model's base URL or API key in place - the model has to be deleted and
   re-added. Regenerating either value on every start would force re-adding every
   model, so both are persisted and reused.
3. **Windows Firewall handling**, because Trae validates and calls custom models
   from its own servers, so the port must be reachable and therefore explicitly
   allowed.

## Files

| file | purpose |
|---|---|
| `paratera-proxy-lan.bat` | start (LAN bind, admin), prints the Base URL + API key to paste into Trae |
| `paratera-status.bat` | show state, tiers, Base URL, API key |
| `paratera-proxy-stop.bat` | stop |
| `paratera-proxy-lan-cleanup.bat` | undo everything (stop, firewall rule, tokens) |
| `paratera-hardening.bat` | `--collect` then `--enforce`: source allowlist + strict mode |
| `paratera-proxy.bat` | loopback-only start (Trae cannot use this - see below) |
| `lan-info.mjs` | picks/remembers the port, finds the LAN address, manages the token |
| `paratera-allowlist.mjs` | turns observed traffic into an allowlist suggestion |
| `paratera-proxy-ctl.ps1` | process control / status |
| `paratera-apply.mjs` | patches Trae's SQLite model list for its *native* selector - **Trae overwrites this**; see below |

## Why loopback does not work with Trae

Trae validates a custom model's origin **from its own servers** (its error code
`4028 CUSTOM_MODEL_ORIGIN_ERROR` is emitted server-side). `127.0.0.1` therefore
can never work. Confirm it in one step: run a connection test and watch
`/_status` - if `counters.requests` stays at 0, the request never arrived.

See `../../docs/why-a-proxy.md`.

## Why the database patch does not last

`paratera-apply.mjs` writes `reasoning_effort_options` into Trae's stored model
list, which makes Trae render its own effort selector. Measured behaviour: Trae
reloads that list from its server with `forceRefresh` at startup **and then every
1-7 minutes**, so the edit is reverted within minutes. The patch is kept for
experimentation only; the proxy is the durable path.

## Running these scripts

They call `node` and `powershell`. Both are located automatically; override with
`set NODE_EXE=<path>` if needed. `paratera-proxy-lan.bat`,
`paratera-hardening.bat` and the cleanup script need **Administrator** for the
firewall rule.

The `.bat`/`.vbs` files must stay **ASCII-only** - see
`../../docs/windows-gotchas.md`.