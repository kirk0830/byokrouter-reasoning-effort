#!/usr/bin/env node
/**
 * scan-secrets.mjs — fail if anything that looks like a credential, or a value
 * specific to this deployment, would be committed.
 *
 *     node scan-secrets.mjs            # scan the working tree
 *     node scan-secrets.mjs --staged   # scan only what `git add` staged
 *
 * Exit code 1 means "do not commit".
 *
 * TWO KINDS OF CHECK
 *
 *   1. Shape-based, always on: strings that look like credentials regardless of
 *      which deployment they came from (long hex runs, `sk-...`, private key
 *      blocks, `api_key = ...`).
 *
 *   2. Deployment-specific, opt-in: values you never want public — your gateway
 *      hostname, LAN addresses, usernames. These DO NOT live in this file.
 *      A scanner that hardcodes the secrets it is looking for *is itself a leak*,
 *      which is exactly the mistake this file used to make. Instead, put hashes
 *      in `.state/scan-patterns.json` (gitignored), where a plain value is
 *      stored as its SHA-256 so the file never contains the literal:
 *
 *          { "hash": ["<sha256 of each sensitive value>"],
 *            "literal": ["some-domain-you-dislike"] }
 *
 *      Generate it with:
 *          node scan-secrets.mjs --hash "your-value-1" "your-value-2"
 *
 *   The `.state/tokens` written by the launchers are also checked automatically:
 *   `.state/` is gitignored, but a stray copy of a live token pasted into a source
 *   file is exactly the mistake worth catching.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// --- CLI ---------------------------------------------------------------------

if (process.argv.includes('--hash')) {
  const values = process.argv.slice(process.argv.indexOf('--hash') + 1).filter((a) => !a.startsWith('--'));
  if (!values.length) {
    console.error('usage: node scan-secrets.mjs --hash "<value>" ["<value>" ...]');
    process.exit(2);
  }
  const file = path.join(HERE, '.state', 'scan-patterns.json');
  let cfg = { hash: [], literal: [] };
  try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { /* new file */ }
  const add = values.map((v) => crypto.createHash('sha256').update(v).digest('hex'));
  cfg.hash = [...new Set([...(cfg.hash || []), ...add])];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  console.log(`added ${add.length} hash(es) to ${file}`);
  for (const h of add) console.log(`  ${h}`);
  process.exit(0);
}

const stagedOnly = process.argv.includes('--staged');

// --- checks ------------------------------------------------------------------

/** Shapes that look like credentials, independent of deployment. */
const SECRET_PATTERNS = [
  { name: 'long hex run (32+)', re: /\b[0-9a-f]{32,}\b/i },
  { name: 'assigned secret-looking value', re: /(api[_-]?key|token|secret|password)\s*[:=]\s*["']?(?!\$\{|<|YOUR|xxx|CHANGE|EXAMPLE)[A-Za-z0-9+/=_-]{20,}/i },
  { name: 'openai-style key', re: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { name: 'private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
];

// Files that legitimately contain placeholder values or digests.
const ALLOWLIST_FILES = new Set([
  '.env.example',
  'byokrouter.json',
  'reasoning-tiers.example.json',
  'keys.example.json',
  'scan-secrets.mjs',
  'precommit-check.sh',
  'README.md',
  'docs/README_zh.md',
  'docs/why-a-proxy.md',
  'docs/reasoning-effort.md',
  'docs/windows-gotchas.md',
  'platforms/trae-windows/README.md',
  'pixi.lock',
  'proxy-tests/pixi.lock',
]);

const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.pixi', '__pycache__', '.pytest_cache',
  'backups', '.state',
]);

// --- deployment-specific patterns (never hardcoded here) ---------------------

function loadDeploymentPatterns() {
  const cfg = { hash: [], literal: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(HERE, '.state', 'scan-patterns.json'), 'utf8'));
    if (Array.isArray(raw.hash)) cfg.hash = raw.hash;
    if (Array.isArray(raw.literal)) cfg.literal = raw.literal;
  } catch { /* optional */ }

  // Live values produced by the launchers: check that no copy of them ended up in
  // a source file. Only their hashes are compared, nothing is printed.
  for (const rel of ['.state/client.token', '.state/admin.token']) {
    try {
      const v = fs.readFileSync(path.join(HERE, rel), 'utf8').trim();
      if (v) cfg.hash.push(crypto.createHash('sha256').update(v).digest('hex'));
    } catch { /* not present */ }
    }
  for (const envName of ['UPSTREAM_URL', 'UPSTREAM_API_KEY']) {
    const v = process.env[envName];
    if (v) cfg.hash.push(crypto.createHash('sha256').update(v).digest('hex'));
  }
  return cfg;
}

// --- file discovery ----------------------------------------------------------

function gitList() {
  try {
    const args = stagedOnly
      ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR']
      : ['ls-files', '--cached', '--others', '--exclude-standard'];
    return execFileSync('git', args, { cwd: HERE, encoding: 'utf8' })
      .split('\n').map((s) => s.trim()).filter(Boolean);
  } catch (e) {
    console.error('[error] git is required:', e.message);
    process.exit(2);
  }
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), out);
    } else {
      out.push(path.relative(HERE, path.join(dir, entry.name)).replace(/\\/g, '/'));
    }
  }
  return out;
}

// --- run ---------------------------------------------------------------------

const cfg = loadDeploymentPatterns();
const files = stagedOnly ? gitList() : walk(HERE);
const findings = [];

// Tokens are checked by hashing candidate words, so a real token copy is caught
// without any literal ever appearing in this file.
const hashSet = new Set(cfg.hash);
const wordRe = /[A-Za-z0-9+/=_-]{16,}/g;

for (const rel of files) {
  if (ALLOWLIST_FILES.has(rel)) continue;
  const abs = path.join(HERE, rel);
  let text;
  try {
    const st = fs.statSync(abs);
    if (st.size > 2 * 1024 * 1024) continue;
    text = fs.readFileSync(abs, 'utf8');
  } catch { continue; }
  if (text.includes('\u0000')) continue;

  text.split(/\r?\n/).forEach((line, i) => {
    for (const lit of cfg.literal) {
      if (lit && line.includes(lit)) {
        findings.push({ rel, line: i + 1, what: 'deployment-specific value', text: line.trim().slice(0, 120) });
      }
    }
    for (const p of SECRET_PATTERNS) {
      if (p.re.test(line)) findings.push({ rel, line: i + 1, what: p.name, text: line.trim().slice(0, 120) });
    }
    if (hashSet.size) {
      for (const m of line.match(wordRe) || []) {
        const h = crypto.createHash('sha256').update(m).digest('hex');
        if (hashSet.has(h)) {
          findings.push({ rel, line: i + 1, what: 'copy of a live secret (hash match)', text: line.trim().slice(0, 60) + '…' });
        }
      }
    }
  });
}

if (findings.length === 0) {
  console.log(`OK - scanned ${files.length} file(s); no credentials or deployment-specific values found.`);
  if (hashSet.size) console.log(`     (${hashSet.size} deployment-specific hash(es) loaded)`);
  process.exit(0);
}

console.error(`\nBLOCKED - ${findings.length} finding(s). Do NOT commit until resolved:\n`);
for (const f of findings) {
  console.error(`  ${f.rel}:${f.line}  [${f.what}]`);
  console.error(`      ${f.text}`);
}
console.error('\nIf a finding is a false positive, add the file to ALLOWLIST_FILES in scan-secrets.mjs.');
console.error('If it is a real credential: rotate it FIRST, then scrub the file - a pushed');
console.error('secret stays in the remote history even after you delete the file.\n');
process.exit(1);
