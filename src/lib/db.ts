// Local persistence for saved races (SQLite, no cloud sync — MVP is local-first).
// Only race IDs are stored; full race data comes from the static seed.
import * as SQLite from 'expo-sqlite';

const db = SQLite.openDatabaseSync('carrera.db');

export function initDb(): void {
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
}

export function getPref(key: string): string | null {
  const row = db.getFirstSync<{ value: string }>('SELECT value FROM prefs WHERE key = ?', key);
  return row?.value ?? null;
}

export function setPref(key: string, value: string): void {
  db.runSync('INSERT OR REPLACE INTO prefs (key, value) VALUES (?, ?)', key, value);
}

export function getSavedIds(): string[] {
  const rows = db.getAllSync<{ id: string }>(
    'SELECT id FROM saved_races ORDER BY saved_at DESC',
  );
  return rows.map((r) => r.id);
}

export function saveRace(id: string): void {
  db.runSync('INSERT OR REPLACE INTO saved_races (id, saved_at) VALUES (?, ?)', id, Date.now());
}

export function removeRace(id: string): void {
  db.runSync('DELETE FROM saved_races WHERE id = ?', id);
}
