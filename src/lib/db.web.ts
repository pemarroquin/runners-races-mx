// Web store for saved races + prefs, backed by localStorage. Native
// (iOS/Android) uses db.ts (real SQLite) instead; Metro picks this file
// automatically on web.
//
// This used to be a no-op stub for saved races: expo-sqlite's web backend
// needs a cross-origin-isolated page (COOP/COEP headers) for real
// OPFS-backed persistence, and without that (confirmed — this build has
// neither the headers nor any OPFS/IndexedDB writes happening) it silently
// runs in-memory only, so saves looked like they worked but vanished on
// reload. Prefs already used localStorage here and it works fine; saved
// races now do the same instead of being a deliberate no-op.

interface SavedRow {
  id: string;
  saved_at: number;
}

function readSaved(): SavedRow[] {
  try {
    const raw = globalThis.localStorage?.getItem('carrera:saved_races');
    return raw ? (JSON.parse(raw) as SavedRow[]) : [];
  } catch {
    return [];
  }
}

function writeSaved(rows: SavedRow[]): void {
  try {
    globalThis.localStorage?.setItem('carrera:saved_races', JSON.stringify(rows));
  } catch {
    // non-fatal: save won't persist this session
  }
}

export function initDb(): void {}

export function getSavedIds(): string[] {
  return readSaved()
    .sort((a, b) => b.saved_at - a.saved_at)
    .map((r) => r.id);
}

export function saveRace(id: string): void {
  const rows = readSaved().filter((r) => r.id !== id);
  rows.push({ id, saved_at: Date.now() });
  writeSaved(rows);
}

export function removeRace(id: string): void {
  writeSaved(readSaved().filter((r) => r.id !== id));
}

// Prefs persist via localStorage on web (available in every browser target).
export function getPref(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(`carrera:${key}`) ?? null;
  } catch {
    return null;
  }
}

export function setPref(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(`carrera:${key}`, value);
  } catch {
    // non-fatal: preference just won't persist
  }
}
