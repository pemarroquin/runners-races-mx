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

export function initDb(): void {
  if (db) return; // already open (or already attempted+failed this call — see below)

  try {
    db = SQLite.openDatabaseSync('carrera.db');

    const versionRow = db.getFirstSync<{ user_version: number }>('PRAGMA user_version');
    let version = versionRow?.user_version ?? 0;

    if (version < 1) {
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
      version = 1;
    }

    // Forward-only migration ladder. Add new steps here, in order, each
    // bumping `version` by exactly one. A future column addition must use
    // ALTER TABLE — CREATE TABLE IF NOT EXISTS is a no-op against a table
    // that already exists, so it will NOT retrofit existing installs.
    //
    // if (version < 2) {
    //   db.execSync('ALTER TABLE saved_races ADD COLUMN note TEXT;');
    //   version = 2;
    // }

    db.execSync(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  } catch {
    // Open or migration failed — leave db null so every other function
    // below degrades to a safe empty/no-op result instead of throwing.
    db = null;
  }
}

export function getPref(key: string): string | null {
  if (!db) return null;
  try {
    const row = db.getFirstSync<{ value: string }>('SELECT value FROM prefs WHERE key = ?', key);
    return row?.value ?? null;
  } catch {
    return null;
  }
}

export function setPref(key: string, value: string): boolean {
  if (!db) return false;
  try {
    db.runSync('INSERT OR REPLACE INTO prefs (key, value) VALUES (?, ?)', key, value);
    return true;
  } catch {
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
  } catch {
    return [];
  }
}

export function saveRace(id: string): boolean {
  if (!db) return false;
  try {
    db.runSync('INSERT OR REPLACE INTO saved_races (id, saved_at) VALUES (?, ?)', id, Date.now());
    return true;
  } catch {
    return false;
  }
}

export function removeRace(id: string): boolean {
  if (!db) return false;
  try {
    db.runSync('DELETE FROM saved_races WHERE id = ?', id);
    return true;
  } catch {
    return false;
  }
}
