#!/usr/bin/env node
/**
 * paratera-apply.mjs — one-shot, idempotent, reversible edit of Trae CN's stored
 * model list, to give the Paratera custom models a thinking-effort tier.
 *
 * RUN IT FROM A NORMAL TERMINAL (not from inside an agent sandbox):
 *
 *     "C:\Users\PC\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" ^
 *       "C:\Users\PC\.trae-cn\tools\paratera-apply.mjs"            # dry run
 *
 *     ...paratera-apply.mjs --apply                                 # write
 *     ...paratera-apply.mjs --revert                                # undo (needs a backup)
 *
 * Trae CN MUST BE CLOSED while this runs (it locks the database).
 *
 * WHY THIS IS A SEPARATE MANUAL STEP
 *   The database contains the model list inside SQLite overflow pages that are NOT
 *   contiguous in the file, and the environment these tools were built in denies
 *   child processes any file write (EPERM) and intercepts sqlite3_open. Running
 *   this script from your own shell has none of those restrictions, so node's
 *   built-in SQLite can do a normal, safe UPDATE.
 *
 * WHAT IT CHANGES (two things, both reversible)
 *   1. `reasoning_effort_options` on each Paratera model, per MODEL_PLAN below.
 *      This is the field that makes Trae render the "Thinking Effort" selector and
 *      send `reasoning_effort` to the gateway.
 *   2. The per-model default tier, seeded into the two keys Trae persists user
 *      choices in, so the desired tier is active without a manual click.
 *
 * "default" tier = the parameter is NOT sent (provider default). It is expressed by
 * LEAVING the tier unset, not by a value - `default` is not a legal tier name.
 *
 * SAFE BY CONSTRUCTION
 *   * writes a timestamped backup of state.vscdb next to it before touching anything
 *   * only edits `reasoning_effort_options` and the effort-preference keys
 *   * refuses to run while Trae CN is running
 *   * idempotent: re-run after Trae refreshes its model list
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

// ---------------------------------------------------------------------------
// CONFIGURATION - edit this block to change tiers
// ---------------------------------------------------------------------------
// options      : what the picker offers (first entry = default when unset)
// defaultTier  : the tier seeded as the active choice; null => send nothing
//                (i.e. genuinely "provider default")
//
// Policy (2026-09-26): every *flash* model at the top tier, Kimi-K3 at medium.
// Allowed tier names are exactly: none | low | medium | high | xhigh | max
// Measured on the live gateway: all of them are accepted (HTTP 200) for all five
// models; `max` is the reliable "think harder" tier. Avoid `none` - it silently
// disables thinking on 3 of the 5 models.
const MODEL_PLAN = {
  // all flash models -> top tier
  'GLM-5.3-Flash':      { options: ['max', 'medium'], defaultTier: 'max' },
  'DeepSeek-V4.1-Flash':{ options: ['max', 'medium'], defaultTier: 'max' },
  'Qwen3.8-Flash':      { options: ['max', 'medium'], defaultTier: 'max' },
  // medium tiers
  'Qwen3.8-Max':        { options: ['medium', 'max'], defaultTier: 'medium' },
  'Kimi-K3':            { options: ['medium', 'max'], defaultTier: 'medium' },
};

const PROVIDER = 'custom_openai_compatible';
// Host used to recognise the models this patch should touch. Override with\n// BYOKROUTER_UPSTREAM when you use a different gateway.\nconst HOST = (() => { try { return new URL(process.env.BYOKROUTER_UPSTREAM || process.env.UPSTREAM_URL || '').hostname; } catch { return ''; } })();
const MODEL_LIST_KEY = '3994981823951464_AI.agent.model.model_list_map';
const EFFORT_MAPS = [
  { key: '3994981823951464:AI.agent.model.reasoning_effort_level_by_agent_model_v2', style: 'legacy' },
  { key: '3994981823951464_ai-chat:sessionRelation:modelReasoningEffortLevelMap:v2', style: 'session' },
];
const ALLOWED = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];

// ---------------------------------------------------------------------------
// args / environment
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const REVERT = argv.includes('--revert');
const dbArgIdx = argv.indexOf('--db');
const DB_PATH = dbArgIdx >= 0 && argv[dbArgIdx + 1]
  ? argv[dbArgIdx + 1]
  : path.join(process.env.APPDATA || '', 'Trae CN', 'User', 'globalStorage', 'state.vscdb');
// keep backups somewhere obvious and writable
const BACKUP_DIR = path.join(os.homedir(), 'trae-effort-backups');

function die(msg) { console.error(`\n[error] ${msg}\n`); process.exit(1); }
function ok(msg) { console.log(`  ${msg}`); }

// ---------------------------------------------------------------------------
// preconditions
// ---------------------------------------------------------------------------

if (!fs.existsSync(DB_PATH)) die(`state.vscdb not found:\n  ${DB_PATH}`);
if (process.env.APPDATA === undefined && dbArgIdx < 0) die('APPDATA is not set; pass --db <path>');

try {
  const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq Trae CN.exe', '/NH'], { encoding: 'utf8' });
  if (/Trae CN\.exe/i.test(out)) {
    die('Trae CN is still running. Close it completely and run this again\n' +
        '      (otherwise Trae overwrites the change when it exits).');
  }
} catch { /* tasklist unavailable: continue, the write will fail loudly if locked */ }

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function modelIsParatera(m) {
  return m && m.provider === PROVIDER && String(m.base_url || '').includes(HOST);
}
function shortName(m) {
  const n = String(m.display_name || m.name || '');
  return n.startsWith(`${PROVIDER}//`) ? n.slice(PROVIDER.length + 2) : n;
}
function planFor(m) {
  return MODEL_PLAN[shortName(m)] || MODEL_PLAN[String(m.name || '')] || null;
}
function sameArray(a, b) {
  return Array.isArray(a) && a.length === b.length && a.every((v, i) => v === b[i]);
}

function readValue(db, key) {
  const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(key);
  return row ? String(row.value) : null;
}
function writeValue(db, key, text) {
  db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?) ' +
             'ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, text);
}

/** effort key Trae builds: `${AgentType}_${configSource}_${provider}_${name}[_${customModelId}]_${mode}` */
function effortKey(model, nameField, style) {
  const scope = style === 'legacy' ? 'solo_agent' : 'solo_agent';
  const base = `${scope}_${model.config_source}_${model.provider}_${model[nameField]}`;
  const withId = `${base}_${model.custom_model_id}`;
  return style === 'legacy' ? withId : withId;
}

// ---------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------

console.log('paratera-apply.mjs' + (REVERT ? '  [REVERT]' : APPLY ? '  [APPLY]' : '  [DRY RUN]'));
console.log(`  db : ${DB_PATH}`);

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA busy_timeout = 10000;');

const raw = readValue(db, MODEL_LIST_KEY);
if (!raw) die(`model list key not found: ${MODEL_LIST_KEY}`);

// ---- revert path -----------------------------------------------------------
if (REVERT) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const backups = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.bak')).sort();
  if (backups.length === 0) die(`no backups found in ${BACKUP_DIR}`);
  const latest = path.join(BACKUP_DIR, backups[backups.length - 1]);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safety = path.join(BACKUP_DIR, `state.vscdb.${stamp}.pre-revert.bak`);
  fs.copyFileSync(DB_PATH, safety);
  fs.copyFileSync(latest, DB_PATH);
  db.close();
  ok(`restored ${latest}`);
  ok(`safety copy of the previous state: ${safety}`);
  process.exit(0);
}

// ---- normal path -----------------------------------------------------------
let data;
try { data = JSON.parse(raw); } catch (e) { die(`stored model list is not valid JSON: ${e.message}`); }

const seenModels = new Map();   // shortName -> representative model object
for (const arr of Object.values(data)) {
  if (!Array.isArray(arr)) continue;
  for (const m of arr) if (modelIsParatera(m)) {
    const s = shortName(m);
    if (!seenModels.has(s)) seenModels.set(s, m);
  }
}

console.log(`\n  Paratera models found: ${[...seenModels.keys()].join(', ') || '(none)'}\n`);

const modelChanges = new Map();   // shortName -> { from, to, entries }
for (const [short, model] of seenModels) {
  const plan = planFor(model);
  if (!plan) { console.log(`  · ${short.padEnd(22)} not in MODEL_PLAN - skipped`); continue; }
  for (const t of plan.options) {
    if (!ALLOWED.includes(t)) die(`tier "${t}" for ${short} is not accepted by Trae (${ALLOWED.join(', ')})`);
  }
  modelChanges.set(short, { from: model.reasoning_effort_options ?? null, to: [...plan.options] });
  console.log(`  · ${short.padEnd(22)} ${JSON.stringify(model.reasoning_effort_options ?? null)} -> ${JSON.stringify(plan.options)}   active tier: ${JSON.stringify(plan.defaultTier)}`);
}

if (modelChanges.size === 0) die('nothing to do: no model in MODEL_PLAN was found in the stored list');

// ---- effort seed keys ------------------------------------------------------
const seedEntries = [];   // { key, before, after }
for (const { key, style } of EFFORT_MAPS) {
  const before = readValue(db, key);
  let map = {};
  if (before) { try { map = JSON.parse(before) || {}; } catch { map = {}; } }
  const after = { ...map };
  const note = [];
  for (const [, model] of seenModels) {
    const plan = planFor(model);
    if (!plan || plan.defaultTier == null) continue;   // null => leave unset (provider default)
    for (const nameField of ['display_name', 'name']) {
      const k = effortKey(model, nameField, style);
      if (after[k] !== plan.defaultTier) {
        note.push(`${k} = ${plan.defaultTier}`);
        after[k] = plan.defaultTier;
      }
    }
  }
  seedEntries.push({ key, before, after: JSON.stringify(after), note });
}

console.log('\n  preferred tier to seed:');
for (const s of seedEntries) {
  console.log(`  · ${s.key}`);
  console.log(`      before: ${s.before ?? '(absent)'}`);
  console.log(`      after : ${s.after}`);
}

if (!APPLY) {
  console.log('\n  DRY RUN - nothing was written. Re-run with --apply to write.\n');
  db.close();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// write
// ---------------------------------------------------------------------------

fs.mkdirSync(BACKUP_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = path.join(BACKUP_DIR, `state.vscdb.${stamp}.bak`);
fs.copyFileSync(DB_PATH, backup);
if (fs.statSync(DB_PATH).size !== fs.statSync(backup).size) die('backup size mismatch - aborting');
console.log(`\n  backup: ${backup}`);

let patchedEntries = 0;
for (const arr of Object.values(data)) {
  if (!Array.isArray(arr)) continue;
  for (const m of arr) {
    if (!modelIsParatera(m)) continue;
    const plan = planFor(m);
    if (!plan) continue;
    if (sameArray(m.reasoning_effort_options, plan.options)) continue;
    m.reasoning_effort_options = [...plan.options];
    patchedEntries++;
  }
}

const newRaw = JSON.stringify(data);
JSON.parse(newRaw);   // paranoia

db.exec('BEGIN IMMEDIATE;');
try {
  writeValue(db, MODEL_LIST_KEY, newRaw);
  for (const s of seedEntries) writeValue(db, s.key, s.after);
  db.exec('COMMIT;');
} catch (e) {
  try { db.exec('ROLLBACK;'); } catch {}
  db.close();
  die(`write failed, rolled back: ${e.message}`);
}

// ---- verify ---------------------------------------------------------------
const verifyRaw = readValue(db, MODEL_LIST_KEY);
if (verifyRaw !== newRaw) die('post-write verification failed: stored value differs');
const vData = JSON.parse(verifyRaw);
let good = 0, bad = 0;
for (const arr of Object.values(vData)) {
  if (!Array.isArray(arr)) continue;
  for (const m of arr) {
    if (!modelIsParatera(m)) continue;
    const plan = planFor(m);
    if (!plan) continue;
    if (sameArray(m.reasoning_effort_options, plan.options)) good++; else bad++;
  }
}
for (const s of seedEntries) {
  if (readValue(db, s.key) !== s.after) die(`verification failed for ${s.key}`);
}
db.close();

console.log(`  wrote ${patchedEntries} Paratera entries; verified ${good} ok, ${bad} bad`);
for (const s of seedEntries) {
  if (s.note.length) console.log(`  seeded ${s.note.length} effort keys in ${s.key.split(':').pop()}`);
}
console.log('\n  DONE. Start Trae CN; each model picker should now offer the tiers above.');
console.log('  Trae refetches its model list occasionally and will drop this - just re-run --apply.');
console.log('  Undo at any time with --revert.\n');
