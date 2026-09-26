#!/usr/bin/env node
/**
 * lan-info.mjs — the three values paratera-proxy-lan.bat needs, one per line:
 *
 *     line 1: PORT     the port to bind (existing/config/random)
 *     line 2: LANIP    this machine's LAN IPv4 address
 *     line 3: TOKEN    the client token (reused if one exists)
 *
 * WHY THE TOKEN IS REUSED, NOT REGENERATED
 *   A client like Trae cannot change a custom model's API key in place - the model
 *   has to be deleted and re-added. So a token that changed on every start would
 *   force re-adding every model on every start. Instead the token is created once
 *   and kept in ..\..\.state\client.token; delete that file to rotate it.
 *
 * Arguments:
 *   --token-length <n>     token length, default 32
 *   --fix-token <value>    use this token instead
 *   --rotate-token         generate a NEW token even if one exists
 *   --port <n>             use this port
 *   --random-port          pick a free port (probed) and remember it
 *
 * The chosen port is remembered in ..\..\.state\port so the client URL
 * stays stable across restarts.
 */

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// State lives in the repo's .state/ directory (gitignored by the root .gitignore).
const STATE_DIR = path.resolve(HERE, '..', '..', '.state');
const TOKEN_FILE = path.join(STATE_DIR, 'client.token');
const PORT_FILE = path.join(STATE_DIR, 'port');
const DEFAULT_PORT = 8798;

const argv = process.argv.slice(2);
function arg(name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
}
const has = (name) => argv.includes(name);

const tokenLength = Number(arg('--token-length', '32')) || 32;

/** Best-effort "the address other machines would use to reach us". */
function lanAddress() {
  const candidates = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces() || {})) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal) continue;
      if (a.address.startsWith('127.') || a.address.startsWith('169.254.')) continue;
      candidates.push({ name, address: a.address });
    }
  }
  const score = (c) => {
    if (/vEthernet|WSL|Hyper-V|VMware|VirtualBox|Docker|Loopback|Virtual Adapter/i.test(c.name)) return 2;
    if (/^192\.168\./.test(c.address)) return 0;
    if (/^10\./.test(c.address)) return 1;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(c.address)) return 3;
    return 4;
  };
  candidates.sort((a, b) => score(a) - score(b));
  return candidates.length ? candidates[0].address : '';
}

function portIsFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '0.0.0.0');
  });
}

async function randomFreePort() {
  for (let i = 0; i < 40; i++) {
    const p = 20000 + crypto.randomInt(0, 40000);   // 20000-59999
    if (await portIsFree(p)) return p;
  }
  return DEFAULT_PORT;
}

async function choosePort() {
  const explicit = arg('--port', null);
  if (explicit) {
    const p = Number(explicit);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      console.error(`[error] invalid port: ${explicit}`);
      process.exit(2);
    }
    // remember it, so later runs without --port reuse the same URL
    try { fs.writeFileSync(PORT_FILE, String(p)); } catch { /* ignore */ }
    return p;
  }

  if (has('--random-port')) {
    const p = await randomFreePort();
    try { fs.writeFileSync(PORT_FILE, String(p)); } catch { /* ignore */ }
    return p;
  }

  // remember the port across restarts so the client URL does not change
  try {
    const saved = Number(fs.readFileSync(PORT_FILE, 'utf8').trim());
    if (saved >= 1 && saved <= 65535) return saved;
  } catch { /* no saved port */ }

  try { fs.writeFileSync(PORT_FILE, String(DEFAULT_PORT)); } catch { /* ignore */ }
  return DEFAULT_PORT;
}

function chooseToken() {
  const fixed = arg('--fix-token', null);
  if (fixed) return fixed;

  if (!has('--rotate-token')) {
    try {
      const existing = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
      if (existing) return existing;      // reuse: stable API key for the client
    } catch { /* no token yet */ }
  }

  const token = crypto.randomBytes(Math.ceil(tokenLength / 2)).toString('hex').slice(0, tokenLength);
  try { fs.writeFileSync(TOKEN_FILE, token + '\n'); } catch { /* ignore */ }
  return token;
}

const ip = lanAddress();
if (!ip) {
  console.error('[error] no usable non-loopback IPv4 address found');
  process.exit(2);
}

const port = await choosePort();
const token = chooseToken();

process.stdout.write(`${port}\n${ip}\n${token}\n`);
