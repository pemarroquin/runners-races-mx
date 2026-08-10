// Local persistence for saved races (SQLite, no cloud sync — MVP is local-first).
// Only race IDs are stored; full race data comes from the static seed.
import * as SQLite from 'expo-sqlite';

// The schema version this build of the app expects. Bump this — and add a
// new `if (version < N) { ... version = N }` step below — every time the
// table shape changes. Never renumber or edit a step once it has shipped:
// devices in the wild have already run it and PRAGMA user_version records
// how far they got, so an edited-in-place step will not re-run for them and
// a renumbered one can run twice or be skipped entirely.
const SCHEMA_VERSION = 1;

// Opened lazily by initDb() so a failure to open (corrupt db file, no
// writable directory, etc.) throws from inside a caller's try/catch instead
// of at module-import time. Opening at import time — as this used to do —
// means a throw prevents the whole JS bundle from finishing evaluation,
// which is a blank screen instead of a degraded-but-working app.
let db: SQLite.SQLiteDatabase | null = null;

// Why storage is unavailable/degraded, for diagnostics. Every failure path
// below records here AND logs, because the previous version swallowed every
// error into a bare `catch {}` — which is why a completely dead saved-races
// feature looked identical to an empty one, on device, with nothing in the
// logs to go on.
let lastError: string | null = null;

const describe = (e: unknown): string =>
  e instanceof Error ? `${e.name}: ${e.message}` : String(e);

function fail(stage: string, e: unknown): void {
  lastError = `${stage}: ${describe(e)}`;
  console.warn(`[db] ${lastError}`);
}

export function initDb(): void {
  if (db) return; // already open; a previous failure left db null, so we retry

  try {
    db = SQLite.openDatabaseSync('carrera.db');
  } catch (e) {
    db = null;
    fail('openDatabaseSync failed', e);
    return;
  }

  // Baseline schema, created on every open. `CREATE TABLE IF NOT EXISTS` is
  // idempotent and cheap, so it deliberately does NOT sit behind the version
  // read: this used to run only when `PRAGMA user_version` came back < 1, so
  // if that read threw, the catch nulled the handle and the app was left with
  // no tables, no storage, and no error — the save button toggled nothing and
  // My Races stayed empty forever. Table creation must not depend on
  // bookkeeping succeeding.
  try {
    db.execSync(
      `CREATE TABLE IF NOT EXISTS saved_races (
         id TEXT PRIMARY KEY NOT NULL,
         saved_at INTEGER NOT NULL
       );
       CREATE TABLE IF NOT EXISTS prefs (
         key TEXT PRIMARY KEY NOT NULL,
         value TEXT NOT NULL
       );`,
    );
  } catch (e) {
    // No tables means genuinely unusable — this one does justify dropping it.
    db = null;
    fail('schema creation failed', e);
    return;
  }

  // Version bookkeeping is BEST-EFFORT and must never null the handle: the
  // tables above already exist, so reads and writes work regardless of whether
  // we can read or stamp PRAGMA user_version.
  try {
    const versionRow = db.getFirstSync<{ user_version: number }>('PRAGMA user_version');
    let version = versionRow?.user_version ?? 0;

    // Forward-only migration ladder. Add new steps here, in order, each
    // bumping `version` by exactly one. A future column addition must use
    // ALTER TABLE — CREATE TABLE IF NOT EXISTS is a no-op against a table
    // that already exists, so it will NOT retrofit existing installs.
    //
    // if (version < 2) {
    //   db.execSync('ALTER TABLE saved_races ADD COLUMN note TEXT;');
    //   version = 2;
    // }

    if (version !== SCHEMA_VERSION) {
      db.execSync(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      version = SCHEMA_VERSION;
    }
    lastError = null;
  } catch (e) {
    // Non-fatal: saving still works. The cost is that a FUTURE migration step
    // can't sequence itself off user_version on this device, so if this ever
    // starts appearing in logs it must be fixed before shipping migration 2.
    fail('version bookkeeping failed (non-fatal, storage still works)', e);
  }
}

/** Why storage is unavailable or degraded, or null when healthy. */
export function getStorageError(): string | null {
  return lastError;
}

/** True when the store is open and writable — used to surface save failures. */
export function isStorageReady(): boolean {
  return db !== null;
}

export function getPref(key: string): string | null {
  if (!db) return null;
  try {
    const row = db.getFirstSync<{ value: string }>('SELECT value FROM prefs WHERE key = ?', key);
    return row?.value ?? null;
  } catch (e) {
    fail('getPref failed', e);
    return null;
  }
}

export function setPref(key: string, value: string): boolean {
  if (!db) return false;
  try {
    db.runSync('INSERT OR REPLACE INTO prefs (key, value) VALUES (?, ?)', key, value);
    return true;
  } catch (e) {
    fail('setPref failed', e);
    return false;
  }
}

export function getSavedIds(): string[] {
  if (!db) return [];
  try {
    const rows = db.getAllSync<{ id: string }>(
      'SELECT id FROM saved_races ORDER BY saved_at DESC',
    );
    return rows.map((r) => r.id);
  } catch (e) {
    fail('getSavedIds failed', e);
    return [];
  }
}

export function saveRace(id: string): boolean {
  if (!db) return false;
  try {
    db.runSync('INSERT OR REPLACE INTO saved_races (id, saved_at) VALUES (?, ?)', id, Date.now());
    return true;
  } catch (e) {
    fail('saveRace failed', e);
    return false;
  }
}

export function removeRace(id: string): boolean {
  if (!db) return false;
  try {
    db.runSync('DELETE FROM saved_races WHERE id = ?', id);
    return true;
  } catch (e) {
    fail('removeRace failed', e);
    return false;
  }
}
