#!/usr/bin/env node
/**
 * paratera-allowlist.mjs — turn observed traffic into a PROXY_ALLOWLIST value.
 *
 * Reads the proxy's request log (`/_status` -> recentRequests, loopback only) and
 * prints the distinct source addresses, with a suggested allowlist.
 *
 * WHY THIS SLOWLY CONVERGES: the proxy's log holds only the last 20 requests, and
 * your own diagnostics push the client's entries out of it - so the list is
 * incomplete until the client actually generates traffic. Run this AFTER the
 * client has sent some messages.
 *
 * Usage:
 *   node paratera-allowlist.mjs                 # human-readable report
 *   node paratera-allowlist.mjs --env           # just the PROXY_ALLOWLIST=... line
 *   node paratera-allowlist.mjs --port 8798
 *
 * What to put in the list:
 *   The client's own addresses appear in `forwardedFor` when it fetches from its
 *   servers. Use the longest prefix that is stable across your samples (an IPv6
 *   /64 or an IPv4 subnet), NOT a single full address - the addresses rotate.
 *   Include 127.0.0.1 as well if you want local diagnostics to keep working in
 *   strict mode.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);function arg(name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
}
const PORT = arg('--port', process.env.PORT || '8798');
const ENV_ONLY = argv.includes('--env');

function norm(v) {
  const s = String(v || '').trim();
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(s);
  return m ? m[1] : s;
}

/** Longest common prefix of two strings, trimmed back to a sensible boundary. */
function commonPrefix(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return a.slice(0, i);
}

let status;
try {
  const headers = {};
  // paratera-hardening.bat makes /_status require an admin token; pick it up.
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const tok = fs.readFileSync(path.join(here, '..\..\.state\admin.token'), 'utf8').trim();
    if (tok) headers.Authorization = `Bearer ${tok}`;
  } catch { /* no admin token in use */ }
  const res = await fetch(`http://127.0.0.1:${PORT}/_status`, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  status = await res.json();
} catch (e) {
  console.error(`[error] cannot read /_status on port ${PORT}: ${e.message}`);
  console.error('        The proxy must be running, and this must run on the same machine');
  console.error('        (the admin endpoints are loopback-only).');
  process.exit(2);
}

const rows = Array.isArray(status.recentRequests) ? status.recentRequests : [];
const upstream = [];
const local = [];
const rejected = [];

for (const r of rows) {
  const fwd = norm(r.forwardedFor || '');
  const peer = norm(r.remoteAddress || '');
  if (r.note) { rejected.push({ peer, note: r.note, at: r.at }); continue; }
  if (fwd) upstream.push(fwd);
  else if (peer) local.push(peer);
}

const uniq = (a) => [...new Set(a)].sort();

if (!ENV_ONLY) {
  console.log(`source: http://127.0.0.1:${PORT}/_status  (${rows.length} recent entries kept)`);
  console.log(`upstream : ${status.upstream}`);
  console.log('');
  console.log('addresses seen in x-forwarded-for  (the CLIENT\'s servers):');
  for (const a of uniq(upstream)) console.log('   ' + a);
  if (upstream.length === 0) console.log('   (none captured - send some real messages first)');
  console.log('');
  console.log('local/other peers:');
  for (const a of uniq(local)) console.log('   ' + a);
  console.log('');
  if (rejected.length) {
    console.log('rejected attempts (also useful: shows who is probing):');
    for (const r of rejected) console.log(`   ${r.at}  ${r.peer || '-'}  ${r.note}`);
    console.log('');
  }
}

// Suggest prefixes, not exact addresses: these rotate.
const suggestions = new Set();
const groups = new Map();
for (const a of uniq(upstream)) {
  const key = a.includes(':') ? a.split(':').slice(0, 4).join(':') : a.split('.').slice(0, 3).join('.');
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(a);
}
for (const [prefix, members] of groups) {
  if (members.length > 1) {
    let p = members[0];
    for (const m of members.slice(1)) p = commonPrefix(p, m);
    suggestions.add(p.includes(':') ? p.replace(/:+$/, '') : p.replace(/\.+$/, ''));
  } else {
    // single sample: back off to the /64 (IPv6) or /24 (IPv4) to leave room for rotation
    const parts = members[0].includes(':') ? members[0].split(':') : members[0].split('.');
    suggestions.add(members[0].includes(':') ? parts.slice(0, 4).join(':') : parts.slice(0, 3).join('.'));
  }
}

// If every observed address shares a leading group, offer that as a coarser (and
// therefore more robust) alternative. Observed rotation is often within one such
// block, so this is usually the prefix worth using.
if (uniq(upstream).length > 1) {
  const firstGroup = uniq(upstream)[0].includes(':')
    ? uniq(upstream)[0].split(':')[0]
    : uniq(upstream)[0].split('.')[0];
  const sameGroup = uniq(upstream).every((a) =>
    (a.includes(':') ? a.split(':')[0] : a.split('.')[0]) === firstGroup);
  if (sameGroup) suggestions.add(firstGroup);
}

for (const a of uniq(local)) if (a === '127.0.0.1') suggestions.add(a);

const list = [...suggestions].filter(Boolean).sort();
console.log(ENV_ONLY ? '' : 'suggested allowlist (verify, then set strict mode):');
console.log(`PROXY_ALLOWLIST=${list.join(',')}`);
if (uniq(upstream).length === 0) {
  console.log('');
  console.log('NOTE: no upstream addresses captured yet - this list is not trustworthy.');
  console.log('      Send a few messages from the client, then run this again.');
}
