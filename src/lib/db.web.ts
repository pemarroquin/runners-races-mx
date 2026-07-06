// Web stub for the SQLite store. expo-sqlite has no zero-config browser backend
// (it needs a wasm worker), and the web build is only a preview — saved races
// simply don't persist here. Native (iOS/Android) uses db.ts instead; Metro
// picks this file automatically on web.

export function initDb(): void {}

export function getSavedIds(): string[] {
  return [];
}

export function saveRace(_id: string): void {}

export function removeRace(_id: string): void {}

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
