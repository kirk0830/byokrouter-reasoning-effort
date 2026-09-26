#!/usr/bin/env node
/**
 * bin/start.mjs — start the proxy, from any OS, with no shell scripts needed.
 *
 *     node bin/start.mjs                      # loopback, using .env / byokrouter.json
 *     node bin/start.mjs --lan                # bind 0.0.0.0 and print a client URL
 *     node bin/start.mjs --port 47823
 *     node bin/start.mjs --lan --random-port
 *     node bin/start.mjs --rotate-token       # issue a new client token
 *     node bin/start.mjs --no-check           # skip the preflight self-check
 *
 * Everything it prints is meant to be pasted into the client (Trae, or anything
 * else that speaks the OpenAI API): the Base URL, the client token, and the
 * model ids it knows about.
 *
 * State it keeps next to the repo (all gitignored):
 *     .state/client.token   the token clients authenticate with - REUSED, not
 *                           regenerated, because some clients can only change a
 *                           model's API key by deleting and re-adding the model
 *     .state/port           the chosen port, so the client URL stays stable
 */

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig, ALLOWED_TIERS } from '../src/config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// State lives next to the repo so the client URL and API key stay stable across
// restarts. Creating it is best-effort: on a restricted filesystem we simply keep
// the values in memory for this run rather than refusing to start.
let STATE = path.join(ROOT, '.state');
let stateUsable = true;
try {
  fs.mkdirSync(STATE, { recursive: true });
  fs.accessSync(STATE, fs.constants.W_OK);
} catch {
  const fallback = path.join(os.tmpdir(), 'byokrouter-reasoning-effort');
  try {
    fs.mkdirSync(fallback, { recursive: true });
    STATE = fallback;
  } catch {
    stateUsable = false;    // no writable directory: token/port will not persist
  }
}
const TOKEN_FILE = path.join(STATE, 'client.token');
const PORT_FILE = path.join(STATE, 'port');

const argv = process.argv.slice(2);
const has = (n) => argv.includes(n);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };

const wantLan = has('--lan') || has('--bind-all');
const wantRandomPort = has('--random-port');
const rotateToken = has('--rotate-token');
const skipCheck = has('--no-check');
const explicitPort = arg('--port', null);

// --- helpers -----------------------------------------------------------------

function readIfExists(file) {
  try { return fs.readFileSync(file, 'utf8').trim() || null; } catch { return null; }
}

function lanAddress() {
  const candidates = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces() || {})) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal || a.address.startsWith('127.') || a.address.startsWith('169.254.')) continue;
      candidates.push({ name, address: a.address });
    }
  }
  // Prefer a real LAN adapter over virtual ones (WSL, Hyper-V, VPN).
  const score = (c) => (/vEthernet|WSL|Hyper-V|VMware|VirtualBox|Docker|Loopback/i.test(c.name) ? 2
    : /^192\.168\./.test(c.address) ? 0 : /^10\./.test(c.address) ? 1 : 3);
  candidates.sort((a, b) => score(a) - score(b));
  return candidates.length ? candidates[0].address : null;
}

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(0, '127.0.0.1');
  });
}

async function choosePort() {
  if (explicitPort) return Number(explicitPort);
  if (wantRandomPort) {
    for (let i = 0; i < 40; i++) {
      const p = 20000 + crypto.randomInt(0, 40000);
      if (await freePort(p)) { try { fs.writeFileSync(PORT_FILE, String(p)); } catch {} return p; }
    }
  }
  const saved = Number(readIfExists(PORT_FILE));
  if (Number.isInteger(saved) && saved >= 1 && saved <= 65535) return saved;
  const cfgDefault = loadConfig({ dir: ROOT }).port || 8798;
  try { fs.writeFileSync(PORT_FILE, String(cfgDefault)); } catch {}
  return cfgDefault;
}

function chooseToken() {
  if (!rotateToken) {
    const existing = readIfExists(TOKEN_FILE);
    if (existing) return existing;
  }
  const token = crypto.randomBytes(16).toString('hex');
  try { fs.writeFileSync(TOKEN_FILE, token + '\n'); } catch {}
  return token;
}

// --- resolve configuration ---------------------------------------------------

const cfg = loadConfig({ dir: ROOT });
const port = await choosePort();
const token = cfg.clientToken || chooseToken();
const bind = wantLan ? '0.0.0.0' : (cfg.bind || '127.0.0.1');
const lanIp = bind === '127.0.0.1' ? '127.0.0.1' : (lanAddress() || '<this-machine-lan-ip>');
const baseUrl = `http://${lanIp}:${port}/chat/completions`;

console.log('='.repeat(72));
console.log(' byokrouter-reasoning-effort');
console.log('='.repeat(72));
console.log(`  upstream : ${cfg.upstream || 'MISSING - set BYOKROUTER_UPSTREAM'}`);
console.log(`  bind     : ${bind}:${port}`);
console.log(`  tiers    : ${JSON.stringify(cfg.reasoning.default)} default, ${Object.keys(cfg.reasoning.models).length} model override(s)`);
console.log(`  key      : ${cfg.keys.default ? 'loaded' : 'MISSING - set BYOKROUTER_API_KEY'}`);
console.log(`  allowlist: ${cfg.allowlist.length ? cfg.allowlist.join(', ') + (cfg.allowlistStrict ? ' [strict]' : ' [log-only]') : 'none'}`);
console.log('='.repeat(72));

if (!cfg.upstream || cfg.keys.default === null) {
  console.error('\nCannot start without an upstream and a key. Copy .env.example to .env and fill it in.\n');
  process.exit(2);
}

// --- optional preflight ------------------------------------------------------

if (!skipCheck) {
  console.log('preflight: checking that the client can actually reach this machine...');
  if (bind === '127.0.0.1') {
    console.log('  bind is loopback. If your CLIENT validates custom models from ITS OWN');
    console.log('  servers (some do), loopback will never work - see docs/why-a-proxy.md.');
    console.log('  Re-run with --lan once you know your machine is reachable.\n');
  } else {
    console.log(`  client base URL will be ${baseUrl}`);
    console.log('  the client\'s servers must be able to reach that address;');
    console.log('  if that is not the case, put the proxy behind a tunnel (docs/why-a-proxy.md).\n');
  }
}

// --- launch ------------------------------------------------------------------

const child = spawn(process.execPath, [path.join(ROOT, 'src', 'proxy.mjs')], {
  cwd: ROOT,
  stdio: 'inherit',
  env: {
    ...process.env,
    BYOKROUTER_BIND: bind,
    BYOKROUTER_PORT: String(port),
    BYOKROUTER_CLIENT_TOKEN: token,
  },
});

child.on('exit', (code) => process.exit(code ?? 0));
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));

// Print the client-facing details shortly after the listener is up.
setTimeout(() => {
  console.log('\n' + '-'.repeat(72));
  console.log(' paste these into the client');
  console.log('-'.repeat(72));
  console.log(`  Base URL : ${baseUrl}`);
  console.log(`  API key  : ${token}`);
  console.log('  Models   : any model id the upstream accepts, e.g.');
  for (const m of Object.keys(cfg.reasoning.models)) console.log(`               ${m}`);
  console.log(`  Tiers    : ${ALLOWED_TIERS.join(' | ')}   (null = send nothing)`);
  console.log(`  Status   : http://127.0.0.1:${port}/_status   (loopback only)`);
  console.log('-'.repeat(72) + '\n');
}, 600);
