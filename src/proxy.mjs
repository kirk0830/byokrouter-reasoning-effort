#!/usr/bin/env node
/**
 * proxy.mjs — an OpenAI-compatible reverse proxy that injects a
 * `reasoning_effort` value per model, for clients that give you no way to set
 * thinking effort on a BYOK / custom model.
 *
 * WHY THIS EXISTS
 *   Some AI clients support "bring your own key" but expose no setting for
 *   reasoning effort, and some of them store their per-model request config in a
 *   place a script cannot safely write (an embedded SQLite database, a signed
 *   bundle). Instead of moving the client's storage, move the network endpoint:
 *   point the custom model at this proxy and let it decide whether to send
 *   `reasoning_effort` upstream. See docs/why-a-proxy.md.
 *
 * WHAT IT GIVES YOU
 *   * a tier per model (none | low | medium | high | xhigh | max) added as
 *     `reasoning_effort` on the way out;
 *   * "provider default" = send NOTHING, which is the only honest way to express
 *     that, and is what `null` / "" / "default" mean in the config;
 *   * change the tier WITHOUT restarting: edit the config file (re-read on
 *     change) or POST /_control.
 *
 * QUICK START
 *   cp .env.example .env          # fill in upstream + key
 *   node bin/start.mjs
 *
 * CONFIGURATION
 *   Everything lives in `byokrouter.json` + `.env` + environment variables; see
 *   src/config.mjs for the precedence and for `${VAR}` expansion (which is what
 *   lets the JSON config be committed without containing secrets).
 *
 * CONTROL
 *   GET  /_status                 -> tiers in effect, counters, recent requests
 *   POST /_control {"model":"<id>","effort":"max"}
 *   POST /_control {"model":"<id>","effort":null}   (provider default)
 *   POST /_control {"default":"max"}                (unlisted models)
 *
 * The admin endpoints are loopback-only by default and can be removed entirely
 * with BYOKROUTER_NO_ADMIN=1.
 */

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadConfig, normaliseTier, ALLOWED_TIERS } from './config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// The repo root is one level up from src/.
const ROOT = path.resolve(HERE, '..');

// Configuration is resolved once here: env > .env > byokrouter.json > defaults.
// Legacy variable names are handled inside config.mjs, so launchers written for
// the older layout keep working unchanged.
const CFG = loadConfig({ dir: ROOT });

let PORT = CFG.port;
const UPSTREAM = CFG.upstream;
const QUIET = CFG.quiet;
const BIND = CFG.bind;
const CLIENT_TOKEN = CFG.clientToken;
const ADMIN_TOKEN = CFG.adminToken;
const NO_ADMIN = CFG.noAdmin;
const ALLOWLIST = CFG.allowlist;
const ALLOWLIST_STRICT = CFG.allowlistStrict;
const TRUST_FORWARDED = CFG.trustForwarded;

/** Normalise an IPv4-mapped IPv6 address (::ffff:1.2.3.4) down to IPv4. */
function normalizeIp(value) {
  const s = String(value || '').trim();
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(s);
  return m ? m[1] : s;
}

/** True when `value` equals an allowlist entry or starts with one (prefix match). */
function ipAllowed(value) {
  if (ALLOWLIST.length === 0) return true;
  const v = normalizeIp(value);
  if (!v) return false;
  return ALLOWLIST.some((entry) => v === entry || v.startsWith(entry));
}

/**
 * The address the allowlist should be judged against.
 *
 * Behind NAT the TCP peer is the router, so when PROXY_TRUST_FORWARDED=1 the
 * original client address is taken from x-forwarded-for (first hop). Otherwise
 * the socket peer is authoritative.
 */
function sourceForPolicy(req, peer) {
  if (TRUST_FORWARDED) {
    const first = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (first) return normalizeIp(first);
  }
  return normalizeIp(peer);
}

/**
 * Constant-time string compare. `a !== b` short-circuits on the first differing
 * byte, which leaks a timing signal; comparing over a fixed-length digest removes
 * that. Cheap to do, so there is no reason not to.
 */
function tokenMatches(offered, expected) {
  if (!expected) return true;
  const a = crypto.createHash('sha256').update(String(offered)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

const KEYS_FILE = CFG.keysFile;
// Reasoning tiers come from the JSON config (byokrouter.json) and keep being
// re-read while running, so a tier change needs no restart.
const TIERS_FILE = CFG.configFile;
// Runtime overrides made through /_control land here (state dir, gitignored).
const STATE_DIR = path.join(ROOT, '.state');
const TIERS_STATE_FILE = path.join(STATE_DIR, 'tiers.json');

// ---------------------------------------------------------------------------
// reasoning-effort configuration
// ---------------------------------------------------------------------------

function readJson(file) {
  if (!file) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** {"default": tier|null, "models": {"<model>": tier|null}} */
let effortConfig = { default: null, models: {} };

function loadEffortConfig() {
  // Environment first: a launcher that exports a tier must win over the file.
  const fromEnvDefault = normaliseTier(process.env.BYOKROUTER_DEFAULT_TIER);
  let fromFile = null;
  const raw = readJson(TIERS_FILE);
  if (raw && typeof raw === 'object') fromFile = raw.reasoning || raw;
  if (!raw) {
    // no config file yet: keep whatever came from the environment
    effortConfig = {
      default: fromEnvDefault ?? CFG.reasoning.default ?? null,
      models: { ...CFG.reasoning.models },
    };
    return;
  }
  const models = {};
  const src = { ...(CFG.reasoning.models || {}), ...((fromFile && (fromFile.models || fromFile.tiers)) || {}) };
  for (const [k, v] of Object.entries(src)) {
    if (k.startsWith('_')) continue;
    const val = normaliseTier(v);
    if (val !== undefined) models[k] = val;
  }
  const fileDefault = fromFile ? normaliseTier(fromFile.default) : undefined;
  effortConfig = {
    default: fromEnvDefault ?? fileDefault ?? null,
    models,
  };
  // Runtime overrides (from /_control) win over the file, so an operator's last
  // change survives both a config edit and a restart.
  const state = readJson(TIERS_STATE_FILE);
  if (state && typeof state === 'object') {
    if (state.default !== undefined) {
      const d = normaliseTier(state.default);
      if (d !== undefined) effortConfig.default = d;
    }
    for (const [k, v] of Object.entries(state.models || {})) {
      const t = normaliseTier(v);
      if (t !== undefined) effortConfig.models[k] = t;
    }
  }
}

function effortFor(model) {
  if (model) {
    if (Object.prototype.hasOwnProperty.call(effortConfig.models, model)) {
      return effortConfig.models[model];
    }
    // Case-insensitive fallback: upstream model ids are case-sensitive
    // ("DeepSeek-V4.1-Flash" != "Deepseek-V4.1-Flash"), and a client typing the
    // wrong case would otherwise silently get the fallback tier. Note this only
    // fixes the TIER lookup - the model id itself is still forwarded verbatim,
    // so a wrongly-cased id still fails upstream.
    const lower = String(model).toLowerCase();
    for (const [name, tier] of Object.entries(effortConfig.models)) {
      if (name.toLowerCase() === lower) return tier;
    }
  }
  return effortConfig.default;
}

/** Upstream keys. Resolved from config (never from a committed file literal). */
function loadKeys() {
  const cfg = CFG.keys || {};
  const keys = { default: (cfg.default || '').trim() || null, models: {} };
  for (const [k, v] of Object.entries(cfg.models || {})) {
    if (typeof v === 'string' && v.trim()) keys.models[k] = v.trim();
  }
  return keys;
}

function keyFor(model) {
  const keys = loadKeys();
  if (model) {
    if (keys.models[model]) return keys.models[model];
    const lower = String(model).toLowerCase();
    for (const [name, key] of Object.entries(keys.models)) {
      if (name.toLowerCase() === lower) return key;
    }
  }
  return keys.default;
}

// ---------------------------------------------------------------------------
// logging
// ---------------------------------------------------------------------------

function log(line) {
  // stdout only: in a sandboxed environment a child process may be denied file
  // writes, and a silently-missing log file is worse than none.
  if (!QUIET) console.log(`${new Date().toISOString()} ${line}`);
}

// ---------------------------------------------------------------------------
// upstream call
// ---------------------------------------------------------------------------

function upstreamRequest(targetPath, method, headers, bodyBuffer) {
  const url = new URL(UPSTREAM + targetPath);
  const isHttps = url.protocol === 'https:';
  const lib = isHttps ? https : http;
  const options = {
    hostname: url.hostname,
    port: url.port || (isHttps ? 443 : 80),
    path: url.pathname + url.search,
    method,
    headers,
  };
  return new Promise((resolve, reject) => {
    const req = lib.request(options, resolve);
    req.on('error', reject);
    if (bodyBuffer) req.write(bodyBuffer);
    req.end();
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// control endpoints
// ---------------------------------------------------------------------------

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

async function handleControl(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/_status') {
    return sendJson(res, 200, {
      upstream: UPSTREAM,
      configFile: TIERS_FILE,
      hasKey: Boolean(keyFor(null)),
      effort: effortConfig,
      counters: counters,
      // newest first, so a failing probe is the first thing you see
      recentRequests: [...recent].reverse(),
      hint: 'If a client reports a 500 but counters.requests did not increase, the request never reached this proxy.',
    });
  }
  if (req.method === 'POST' && url.pathname === '/_control') {
    let patch = {};
    try { patch = JSON.parse((await readBody(req)).toString('utf8') || '{}'); }
    catch { return sendJson(res, 400, { error: 'invalid JSON body' }); }

    const next = { default: effortConfig.default, models: { ...effortConfig.models } };
    if ('default' in patch) {
      const v = normaliseTier(patch.default);
      if (v === undefined) return sendJson(res, 400, { error: `invalid tier; allowed: ${ALLOWED_TIERS.join(', ')} or null` });
      next.default = v;
    }
    if (typeof patch.model === 'string' && patch.model) {
      const v = normaliseTier(patch.effort);
      if (v === undefined) return sendJson(res, 400, { error: `invalid tier; allowed: ${ALLOWED_TIERS.join(', ')} or null` });
      if (patch.model === '*') next.default = v;
      else next.models[patch.model] = v;
    }
    effortConfig = next;
    // Runtime overrides are kept in the state directory so a restart does not lose
    // them, and so the committed config file is never rewritten by the process.
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.writeFileSync(TIERS_STATE_FILE, JSON.stringify(effortConfig, null, 2));
    } catch { /* not fatal: the override just will not survive a restart */ }
    log(`[control] default=${JSON.stringify(effortConfig.default)} models=${JSON.stringify(effortConfig.models)}`);
    return sendJson(res, 200, { ok: true, effort: effortConfig });
  }
  return false;
}

// ---------------------------------------------------------------------------
// proxy
// ---------------------------------------------------------------------------

const counters = { requests: 0, injected: 0, defaulted: 0, errors: 0 };

// Ring buffer of recent requests. Diagnostics matter here because the proxy is
// normally launched windowless (its stdout goes nowhere), so a client-side
// "HTTP 500" would otherwise be unattributable. Read it from GET /_status.
const RECENT_LIMIT = 20;
const recent = [];
function recordRequest(entry) {
  recent.push({ at: new Date().toISOString(), ...entry });
  if (recent.length > RECENT_LIMIT) recent.shift();
}

// pick up external edits to the JSON config without a restart
let lastEffortMtime = 0;
function maybeReloadEffort() {
  try {
    const watch = TIERS_FILE || TIERS_STATE_FILE;
    const st = fs.statSync(watch);
    if (st.mtimeMs !== lastEffortMtime) { lastEffortMtime = st.mtimeMs; loadEffortConfig(); log(`[config] effort reloaded: ${JSON.stringify(effortConfig)}`); }
  } catch { /* file absent: keep current config */ }
}

const server = http.createServer(async (req, res) => {  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const peer = req.socket?.remoteAddress || '';
  const isLoopback = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';

  try {
    // Source-address policy, applied to every path. In strict mode a violation is
    // refused; otherwise it is only recorded, so the list can be validated against
    // real traffic before it is trusted.
    const policySource = sourceForPolicy(req, peer);
    const peerAllowed = ipAllowed(policySource);
    if (!peerAllowed && ALLOWLIST_STRICT) {
      counters.errors++;
      recordRequest({ method: req.method, path: url.pathname, peer, policySource, note: 'rejected: source not in the allowlist' });
      log(`[allow] rejected ${req.method} ${url.pathname} from ${policySource} (not in allowlist)`);
      return sendJson(res, 403, { error: { message: 'byokrouter: source address not allowed', type: 'forbidden' } });
    }

    if (url.pathname === '/_status' || url.pathname === '/_control') {
      if (NO_ADMIN) {
        recordRequest({ method: req.method, path: url.pathname, peer, note: 'rejected: admin API disabled (BYOKROUTER_NO_ADMIN)' });
        return sendJson(res, 404, { error: 'not found' });
      }
      // Admin surface. It reveals the request log (paths, models, bodies) and, on
      // /_control, lets the caller change which tier is sent upstream - so it must
      // never be reachable from off-box. Loopback only, plus an optional token.
      if (!isLoopback) {
        recordRequest({ method: req.method, path: url.pathname, peer, note: 'rejected: admin endpoint is loopback-only' });
        log(`[admin] rejected ${req.method} ${url.pathname} from ${peer} (loopback only)`);
        return sendJson(res, 403, { error: { message: 'byokrouter: admin endpoints are loopback-only', type: 'forbidden' } });
      }
      if (ADMIN_TOKEN && !tokenMatches(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''), ADMIN_TOKEN)) {
        log(`[admin] rejected ${req.method} ${url.pathname} (admin token mismatch)`);
        return sendJson(res, 401, { error: { message: 'byokrouter: invalid admin token', type: 'invalid_request_error' } });
      }
      const handled = await handleControl(req, res, url);
      if (handled === false) return sendJson(res, 404, { error: 'not found' });
      return;
    }

    maybeReloadEffort();
    counters.requests++;

    // Optional client-side gate. Only active when a client token is configured,
    // which you want as soon as the proxy is reachable beyond loopback.
    if (CLIENT_TOKEN) {
      const offered = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (!tokenMatches(offered, CLIENT_TOKEN)) {
        recordRequest({ method: req.method, path: url.pathname, note: 'rejected: bad or missing client token', peer });
        log(`[auth] rejected ${req.method} ${url.pathname} from ${peer} (client token mismatch)`);
        res.setHeader('www-authenticate', 'Bearer realm="byokrouter"');
        return sendJson(res, 401, { error: { message: 'byokrouter: invalid client token', type: 'invalid_request_error' } });
      }
    }

    // Some clients probe with OPTIONS/HEAD first. Answer locally so the probe
    // never looks like a failure.
    if (req.method === 'OPTIONS') {
      recordRequest({ method: req.method, path: url.pathname, note: 'CORS preflight answered locally' });
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'POST, GET, OPTIONS',
        'access-control-allow-headers': req.headers['access-control-request-headers'] || '*',
        'access-control-max-age': '600',
      });
      return res.end();
    }
    if (req.method !== 'POST') {
      recordRequest({ method: req.method, path: url.pathname, note: 'non-POST probe' });
      log(`[req] ${req.method} ${url.pathname} -> 405 (only POST is proxied)`);
      return sendJson(res, 405, { error: { message: `byokrouter: use POST ${url.pathname}`, type: 'method_not_allowed' } });
    }

    const bodyBuffer = await readBody(req);
    let parsed = null;
    const isChat = url.pathname.endsWith('/chat/completions');
    if (isChat && bodyBuffer.length) {
      try { parsed = JSON.parse(bodyBuffer.toString('utf8')); } catch { parsed = null; }
    }

    const model = parsed && typeof parsed.model === 'string' ? parsed.model : null;
    const effort = model ? effortFor(model) : effortConfig.default;

    let outgoing = bodyBuffer;
    let injected = null;
    if (parsed && effort) {
      parsed.reasoning_effort = effort;
      injected = effort;
      counters.injected++;
      outgoing = Buffer.from(JSON.stringify(parsed), 'utf8');
    } else if (parsed) {
      // make sure a provider default really is the default: drop any stale value
      if ('reasoning_effort' in parsed) delete parsed.reasoning_effort;
      counters.defaulted++;
      outgoing = Buffer.from(JSON.stringify(parsed), 'utf8');
    }

    const headers = { ...req.headers };
    delete headers.host;
    delete headers['content-length'];
    delete headers.connection;
    // Do not tell the gateway who called us: the client's topology is not its business.
    delete headers['x-forwarded-for'];
    delete headers['x-real-ip'];
    delete headers['forwarded'];
    const key = keyFor(model);
    if (key) headers.authorization = `Bearer ${key}`;
    if (outgoing.length) headers['content-length'] = String(outgoing.length);

    recordRequest({
      method: req.method,
      path: url.pathname + url.search,
      model,
      effort: injected,
      jsonParsed: parsed !== null,
      bodyBytes: bodyBuffer.length,
      bodyHead: bodyBuffer.length ? bodyBuffer.toString('utf8').slice(0, 400) : '',
      contentType: req.headers['content-type'] || '',
      userAgent: String(req.headers['user-agent'] || '').slice(0, 120),
      // Where the request actually came from. If a client's own SERVER is doing
      // the fetching (which is what Trae does for custom models), this shows a
      // non-loopback address - the quickest way to tell the two cases apart.
      remoteAddress: req.socket?.remoteAddress || '',
      forwardedFor: String(req.headers['x-forwarded-for'] || ''),
    });

    log(`[req] ${req.method} ${url.pathname} model=${model ?? '-'} effort=${injected ?? '(provider default)'} key=${key ? 'set' : 'MISSING'}`);

    const upstream = await upstreamRequest(url.pathname + url.search, req.method, headers, outgoing.length ? outgoing : null);
    const outHeaders = { ...upstream.headers };
    delete outHeaders['content-encoding'];   // body passes through untouched but may be re-chunked
    delete outHeaders['transfer-encoding'];
    if ((upstream.statusCode || 0) >= 400) {
      // remember the upstream failure next to the request that caused it
      recordRequest({
        method: req.method,
        path: url.pathname,
        model,
        upstreamStatus: upstream.statusCode,
        note: 'upstream returned an error',
      });
    }
    res.writeHead(upstream.statusCode || 502, outHeaders);

    let firstChunk = true;
    upstream.on('data', (chunk) => {
      if (firstChunk) {
        firstChunk = false;
        if ((upstream.statusCode || 0) >= 400) log(`[err ] upstream ${upstream.statusCode}: ${chunk.toString('utf8').slice(0, 300)}`);
      }
      res.write(chunk);
    });
    upstream.on('end', () => res.end());
    upstream.on('error', (e) => { counters.errors++; log(`[err ] upstream stream: ${e.message}`); res.end(); });
  } catch (e) {
    counters.errors++;
    log(`[err ] ${e.message}`);
    if (!res.headersSent) sendJson(res, 502, { error: { message: `byokrouter: ${e.message}`, type: 'proxy_error' } });
    else res.end();
  }
});

loadEffortConfig();

// If the configured port is taken, fall back to a free one rather than dying - the
// launcher prints the URL it actually bound, and the client just needs that URL.
async function listenOn(port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => { server.removeListener('listening', onListen); reject(err); };
    const onListen = () => { server.removeListener('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListen);
    server.listen(port, BIND);
  });
}

function randomPort() {
  return 20000 + crypto.randomInt(0, 40000);
}

(async () => {
  try {
    await listenOn(PORT);
  } catch (e) {
    if (e && e.code === 'EADDRINUSE') {
      const fallback = randomPort();
      console.error(`[warn] port ${PORT} is in use; trying ${fallback}`);
      PORT = fallback;
      await listenOn(PORT);
    } else {
      throw e;
    }
  }

  const keys = loadKeys();
  const shown = BIND === '0.0.0.0' ? '<this-machine-lan-ip>' : BIND;
  log('==============================================================');
  log(`byokrouter-reasoning-effort listening on ${BIND}:${PORT}`);
  log(`upstream   : ${UPSTREAM || 'MISSING (set BYOKROUTER_UPSTREAM)'}`);
  log(`tiers      : ${JSON.stringify(effortConfig)}`);
  log(`api key    : ${keys.default ? 'loaded' : 'MISSING (set BYOKROUTER_API_KEY or keys file)'}`);
  log(`client auth: ${CLIENT_TOKEN ? 'required' : 'NONE - do not expose this beyond loopback'}`);
  log(`admin api  : ${NO_ADMIN ? 'DISABLED' : 'loopback only' + (ADMIN_TOKEN ? ' + token' : '')}`);
  log(`allowlist  : ${ALLOWLIST.length ? ALLOWLIST.join(', ') + (ALLOWLIST_STRICT ? ' [strict]' : ' [log-only]') : 'none (any source accepted)'}`);
  if (TRUST_FORWARDED) log('policy src : x-forwarded-for (BYOKROUTER_TRUST_FORWARDED=1)');
  log('==============================================================');

  // Configuration problems are reported up front: a missing upstream or key
  // otherwise shows up as a confusing error from the far end.
  const problems = [];
  if (!UPSTREAM) problems.push('BYOKROUTER_UPSTREAM is not set (the gateway to forward to)');
  if (!keys.default && Object.keys(keys.models).length === 0) {
    problems.push('no upstream API key: set BYOKROUTER_API_KEY, or BYOKROUTER_KEYS_FILE=<json>');
  }
  if (CFG.missingEnvRefs.length) {
    problems.push(`unresolved config reference(s): ${CFG.missingEnvRefs.join(', ')}`);
  }
  if (BIND !== '127.0.0.1' && !CLIENT_TOKEN) {
    problems.push('listening beyond loopback with no client token - anyone who can reach the port can spend your credits');
  }
  if (problems.length) {
    console.log('\nconfiguration warnings:');
    for (const p of problems) console.log(`  - ${p}`);
  }

  console.log(`\nBase URL for the client:  http://${shown}:${PORT}/chat/completions`);
  console.log(`Status:                   http://127.0.0.1:${PORT}/_status`);
  console.log(`config: ${CFG.configFile || '(none)'}${CFG.envFileExists ? ` + ${path.basename(CFG.envFile)}` : ''}`);
})();