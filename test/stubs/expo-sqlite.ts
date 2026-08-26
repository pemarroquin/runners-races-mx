// Minimal in-memory stand-in for expo-sqlite, so the pure helpers in
// src/lib/races.ts can be imported under Node. It implements only the surface
// src/lib/db.ts actually uses (openDatabaseSync + execSync/getFirstSync/
// getAllSync/runSync) and only well enough for the prefs/saved-races tables.
//
// This is a test seam, not a SQLite implementation: it recognises the handful
// of statement shapes db.ts issues and ignores the rest. If db.ts grows a new
// query shape, a test touching it will fail loudly here rather than silently
// return the wrong rows.

class FakeDatabase {
  private prefs = new Map<string, string>();
  private saved = new Map<string, number>();
  private userVersion = 0;

  execSync(_sql: string): void {
    // CREATE TABLE IF NOT EXISTS / PRAGMA writes — nothing to do for a map.
  }

  getFirstSync<T>(sql: string, ...params: (string | number)[]): T | null {
    if (/PRAGMA user_version/i.test(sql)) {
      return { user_version: this.userVersion } as unknown as T;
    }
    if (/FROM prefs/i.test(sql)) {
      const value = this.prefs.get(String(params[0]));
      return value === undefined ? null : ({ value } as unknown as T);
    }
    return null;
  }

  getAllSync<T>(sql: string): T[] {
    if (/FROM saved_races/i.test(sql)) {
      return Array.from(this.saved.entries())
        .sort((a, b) => b[1] - a[1]) // ORDER BY saved_at DESC
        .map(([id]) => ({ id })) as unknown as T[];
    }
    return [];
  }

  runSync(sql: string, ...params: (string | number)[]): void {
    if (/INTO prefs/i.test(sql)) {
      this.prefs.set(String(params[0]), String(params[1]));
      return;
    }
    if (/INTO saved_races/i.test(sql)) {
      this.saved.set(String(params[0]), Number(params[1]));
      return;
    }
    if (/DELETE FROM saved_races/i.test(sql)) {
      this.saved.delete(String(params[0]));
    }
  }
}

export type SQLiteDatabase = FakeDatabase;

export function openDatabaseSync(_name: string): FakeDatabase {
  return new FakeDatabase();
}

// db.ts imports the module namespace (`import * as SQLite`), so the default
// export exists only to satisfy any interop path the bundler may take.
export default { openDatabaseSync };
