/**
 * config.mjs — configuration loading for byokrouter-reasoning-effort.
 *
 * Layering, highest priority last (later wins when a value is non-empty):
 *
 *   1. built-in defaults
 *   2. the JSON config file (`byokrouter.json`) — committable, because any
 *      string may use a `${VAR}` reference instead of a literal secret
 *   3. a `.env` file next to it (KEY=VALUE, gitignored)
 *   4. process environment variables
 *
 * `${VAR}` expansion
 *   A string in the JSON config may contain `${NAME}`; it is replaced with the
 *   value of that environment variable (or the same name from `.env`). This is
 *   what lets the JSON config be committed while the secret stays out of the
 *   repository:
 *
 *       { "keys": { "default": "${BYOKROUTER_API_KEY}" } }
 *
 *   Unresolvable references become an empty string and are reported in
 *   `missingEnvRefs`, so a missing secret fails with a clear message instead of
 *   a confusing 401 from the far end.
 *
 * Legacy names
 *   The variable names used by earlier, provider-specific launchers are accepted
 *   as fallbacks, so existing scripts keep working unchanged. Canonical names are
 *   `BYOKROUTER_*`.
 */

import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_CONFIG_FILE = 'byokrouter.json';
export const DEFAULT_ENV_FILE = '.env';

export const ALLOWED_TIERS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];

// --- tiny .env parser --------------------------------------------------------

/** Parse KEY=VALUE lines: `#` comments, blank lines, optional `export`, quotes. */
export function parseEnv(text) {
  const out = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    let key = line.slice(0, eq).trim();
    if (key.startsWith('export ')) key = key.slice(7).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

export function loadEnvFile(file) {
  try {
    if (!file || !fs.existsSync(file)) return {};
    return parseEnv(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

// --- helpers -----------------------------------------------------------------

/** Later non-empty values win; supports number 0 and boolean false. */
function firstNonEmpty(...values) {
  for (const v of values) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'string' && v.trim() === '') continue;
    return v;
  }
  return undefined;
}

export function truthy(v) {
  if (v === true) return true;
  if (v === false || v === undefined || v === null) return false;
  const s = String(v).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

function splitList(v) {
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
  if (v === undefined || v === null) return [];
  return String(v).split(',').map((s) => s.trim()).filter(Boolean);
}

function resolvePath(dir, p) {
  if (!p || typeof p !== 'string') return null;
  return path.isAbsolute(p) ? p : path.join(dir, p);
}

function readJsonSafe(file) {
  try {
    if (!file || !fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8')) || null;
  } catch {
    return null;
  }
}

/**
 * Replace `${NAME}` in every string of a JSON-ish value.
 * `lookup` is a plain name -> value function (no alias magic here: it expands
 * against the real environment, not against a canonical/legacy table).
 */
export function expandEnv(value, lookup, missing = new Set(), seen = new Set()) {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_whole, name) => {
      const v = lookup(name);
      if (v === undefined || v === null || v === '') { missing.add(name); return ''; }
      return String(v);
    });
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return value;
    seen.add(value);
    return value.map((v) => expandEnv(v, lookup, missing, seen));
  }
  if (value && typeof value === 'object') {
    if (seen.has(value)) return value;
    seen.add(value);
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      // Keys starting with `_` are documentation comments: expanding them would
      // report phantom "unresolved reference" errors for text like `${VAR}`.
      if (k.startsWith('_')) { out[k] = v; continue; }
      out[k] = expandEnv(v, lookup, missing, seen);
    }
    return out;
  }
  return value;
}

/** Canonical name -> accepted legacy aliases. */
export const LEGACY_ALIASES = {
  BYOKROUTER_UPSTREAM: ['UPSTREAM_URL', 'UPSTREAM', 'PARATERA_UPSTREAM'],
  BYOKROUTER_API_KEY: ['UPSTREAM_API_KEY', 'PARATERA_API_KEY', 'PROXY_API_KEY'],
  BYOKROUTER_BIND: ['REASONING_PROXY_BIND', 'BIND'],
  BYOKROUTER_PORT: ['REASONING_PROXY_PORT', 'PORT'],
  BYOKROUTER_CLIENT_TOKEN: ['REASONING_PROXY_CLIENT_TOKEN', 'PROXY_CLIENT_TOKEN'],
  BYOKROUTER_ADMIN_TOKEN: ['REASONING_PROXY_ADMIN_TOKEN', 'PROXY_ADMIN_TOKEN'],
  BYOKROUTER_KEYS_FILE: ['REASONING_PROXY_KEYS', 'PROXY_KEYS_FILE'],
  BYOKROUTER_ALLOWLIST: ['REASONING_PROXY_ALLOWLIST', 'PROXY_ALLOWLIST'],
  BYOKROUTER_ALLOWLIST_STRICT: ['REASONING_PROXY_ALLOWLIST_STRICT', 'PROXY_ALLOWLIST_STRICT'],
  BYOKROUTER_TRUST_FORWARDED: ['REASONING_PROXY_TRUST_FORWARDED', 'PROXY_TRUST_FORWARDED'],
  BYOKROUTER_NO_ADMIN: ['REASONING_PROXY_NO_ADMIN', 'PROXY_NO_ADMIN'],
  BYOKROUTER_QUIET: ['REASONING_PROXY_QUIET', 'PROXY_QUIET'],
  BYOKROUTER_DEFAULT_TIER: ['REASONING_PROXY_TIER', 'PROXY_DEFAULT_TIER'],
  BYOKROUTER_CONFIG: ['REASONING_PROXY_CONFIG', 'PROXY_CONFIG'],
};

/**
 * Build the two lookups used from here on:
 *   expandName(name)  -> for `${VAR}` inside the JSON config (exact name only)
 *   envValue(canonical)-> for the env/.env layer, canonical name then aliases
 */
export function makeLookups(envFileValues = {}, extraAliases = {}) {
  const aliases = { ...LEGACY_ALIASES };
  for (const [k, v] of Object.entries(extraAliases)) {
    aliases[k] = [...(aliases[k] || []), ...(Array.isArray(v) ? v : [v])];
  }
  const fromEnv = (name) => {
    const v = process.env[name];
    if (v !== undefined && v !== '') return v;
    const f = envFileValues[name];
    if (f !== undefined && f !== '') return f;
    return undefined;
  };
  const envValue = (canonical) => {
    const v = fromEnv(canonical);
    if (v !== undefined) return v;
    for (const alias of (aliases[canonical] || [])) {
      const a = fromEnv(alias);
      if (a !== undefined) return a;
    }
    return undefined;
  };
  return { expandName: fromEnv, envValue };
}

// --- tier normalisation ------------------------------------------------------

/** null / "" / "default" / "auto" -> null (send nothing). Invalid -> undefined. */
export function normaliseTier(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().toLowerCase();
  if (s === '' || s === 'default' || s === 'auto') return null;
  if (!ALLOWED_TIERS.includes(s)) return undefined;
  return s;
}

/**
 * Accepts either shape inside `reasoning`:
 *   { "default": "max", "models": { "<id>": "max" } }
 *   { "default": "max", "tiers":  { "<id>": "max" } }
 */
export function normaliseReasoning(reasoning) {
  const r = reasoning && typeof reasoning === 'object' ? reasoning : {};
  const src = { ...(r.models || {}), ...(r.tiers || {}) };
  const models = {};
  for (const [k, v] of Object.entries(src)) {
    if (k.startsWith('_')) continue;
    const t = normaliseTier(v);
    if (t !== undefined) models[k] = t;
  }
  const def = normaliseTier(r.default);
  return { default: def === undefined ? null : def, models };
}

// --- main entry --------------------------------------------------------------

/**
 * Read a single-value state file written by the launchers (a token, a port).
 * These live in `.state/` (gitignored) and are the launcher's own storage, so a
 * rotation there must win over a stale value lazily left in `.env`.
 */
function readStateValue(dir, name) {
  try {
    const v = fs.readFileSync(path.join(dir, '.state', name), 'utf8').trim();
    return v || undefined;
  } catch {
    return undefined;
  }
}

/**
 * @param {object} [opts]
 * @param {string} [opts.dir]            directory holding the config/env files
 * @param {string} [opts.configFile]     explicit JSON config path
 * @param {string} [opts.envFile]        explicit .env path
 * @param {object} [opts.extraAliases]   extra legacy names per canonical name
 */
export function loadConfig(opts = {}) {
  const dir = opts.dir || process.cwd();
  const envFile = opts.envFile || process.env.BYOKROUTER_ENV_FILE || path.join(dir, DEFAULT_ENV_FILE);
  const envFileValues = loadEnvFile(envFile);
  const { expandName } = makeLookups(envFileValues, opts.extraAliases || {});

  // Ordering rule, stated once: the launcher's own state beats `.env`, because
  // rotating a token must actually take effect. Everything else: env > .env >
  // config file > defaults.
  const stateToken = readStateValue(dir, 'client.token');
  const stateAdminToken = readStateValue(dir, 'admin.token');
  const envValue = (canonical) => {
    const direct = process.env[canonical];
    if (direct !== undefined && direct !== '') return direct;
    if (canonical === 'BYOKROUTER_CLIENT_TOKEN' && stateToken) return stateToken;
    if (canonical === 'BYOKROUTER_ADMIN_TOKEN' && stateAdminToken) return stateAdminToken;
    const fromEnvFile = envFileValues[canonical];
    if (fromEnvFile !== undefined && fromEnvFile !== '') return fromEnvFile;
    for (const alias of (LEGACY_ALIASES[canonical] || [])) {
      const a = process.env[alias] ?? envFileValues[alias];
      if (a !== undefined && a !== '') return a;
    }
    return undefined;
  };

  const configFile = opts.configFile || envValue('BYOKROUTER_CONFIG') || path.join(dir, DEFAULT_CONFIG_FILE);
  const raw = readJsonSafe(configFile);
  if (raw === null && fs.existsSync(configFile)) {
    throw new Error(`config file ${configFile} exists but is not valid JSON`);
  }

  // 1. literal config file, with ${VAR} expanded against the real environment
  const missing = new Set();
  const file = expandEnv(raw || {}, expandName, missing);

  const listen = file.listen || {};
  const auth = file.auth || {};
  const keysCfg = file.keys || {};
  const allow = file.allowlist || {};

  const upstream = String(firstNonEmpty(envValue('BYOKROUTER_UPSTREAM'), file.upstream) || '').replace(/\/+$/, '');
  const bind = String(firstNonEmpty(envValue('BYOKROUTER_BIND'), listen.bind) || '127.0.0.1');
  const portRaw = firstNonEmpty(envValue('BYOKROUTER_PORT'), listen.port);
  const port = Number(firstNonEmpty(portRaw, 8798));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid port: ${portRaw}`);
  }

  const clientToken = String(firstNonEmpty(envValue('BYOKROUTER_CLIENT_TOKEN'), auth.clientToken) || '').trim();
  const adminToken = String(firstNonEmpty(envValue('BYOKROUTER_ADMIN_TOKEN'), auth.adminToken) || '').trim();
  const noAdmin = truthy(firstNonEmpty(envValue('BYOKROUTER_NO_ADMIN'), auth.noAdmin));

  // keys: env > config > keys file. A dedicated file is handy for multiple keys.
  const keysFile = opts.keysFile
    || envValue('BYOKROUTER_KEYS_FILE')
    || resolvePath(dir, file.keysFile)
    || path.join(dir, 'keys.json');
  const keysFromFile = readJsonSafe(keysFile);
  const modelKeys = {};
  for (const [k, v] of Object.entries(keysFromFile?.models || {})) {
    if (typeof v === 'string' && v.trim() && !k.startsWith('_')) modelKeys[k] = v.trim();
  }
  for (const [k, v] of Object.entries(keysCfg.models || {})) {
    if (typeof v === 'string' && v.trim() && !k.startsWith('_')) modelKeys[k] = v.trim();
  }
  const defaultKey = String(firstNonEmpty(
    envValue('BYOKROUTER_API_KEY'),
    keysCfg.default,
    keysFromFile?.default,
  ) || '').trim();

  const allowlist = splitList(firstNonEmpty(envValue('BYOKROUTER_ALLOWLIST'), allow.prefixes));
  const allowlistStrict = truthy(firstNonEmpty(envValue('BYOKROUTER_ALLOWLIST_STRICT'), allow.strict));
  const trustForwarded = truthy(firstNonEmpty(envValue('BYOKROUTER_TRUST_FORWARDED'), allow.trustForwarded));

  const reasoning = normaliseReasoning(file.reasoning);

  const quiet = truthy(firstNonEmpty(envValue('BYOKROUTER_QUIET'), file.quiet));

  return {
    dir,
    envFile,
    envFileExists: fs.existsSync(envFile),
    configFile: fs.existsSync(configFile) ? configFile : null,
    upstream,
    bind,
    port,
    clientToken,
    adminToken,
    noAdmin,
    keysFile: fs.existsSync(keysFile) ? keysFile : null,
    keys: { default: defaultKey || null, models: modelKeys },
    allowlist,
    allowlistStrict,
    trustForwarded,
    reasoning,
    quiet,
    missingEnvRefs: [...missing],
  };
}
