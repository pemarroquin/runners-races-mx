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

const SAVED_KEY = 'carrera:saved_races';

interface SavedRow {
  id: string;
  saved_at: number;
}

let lastError: string | null = null;

const describe = (e: unknown): string =>
  e instanceof Error ? `${e.name}: ${e.message}` : String(e);

function fail(stage: string, e: unknown): void {
  lastError = `${stage}: ${describe(e)}`;
  console.warn(`[db.web] ${lastError}`);
}

/**
 * The backing store, or null when the environment has none.
 *
 * `globalThis.localStorage?.setItem(...)` followed by `return true` is a trap
 * this file fell into: optional chaining silently no-ops when localStorage is
 * absent (static render, sandboxed iframe, some privacy modes) and the
 * unconditional `return true` then reports a successful write that never
 * happened — the exact "the button says Saved but nothing persists" symptom
 * this file already exists to prevent. Resolve the store explicitly instead.
 */
function store(): Storage | null {
  try {
    const s = globalThis.localStorage;
    return s ?? null;
  } catch (e) {
    // Accessing localStorage itself throws when cookies/site data are blocked.
    fail('localStorage unavailable', e);
    return null;
  }
}

function readSaved(): SavedRow[] {
  const s = store();
  if (!s) return [];
  try {
    const raw = s.getItem(SAVED_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is SavedRow =>
        typeof r === 'object' && r !== null &&
        typeof (r as SavedRow).id === 'string' &&
        typeof (r as SavedRow).saved_at === 'number',
    );
  } catch (e) {
    fail('readSaved failed', e);
    return [];
  }
}

function writeSaved(rows: SavedRow[]): boolean {
  const s = store();
  if (!s) {
    lastError = 'no localStorage in this environment — saves cannot persist';
    console.warn(`[db.web] ${lastError}`);
    return false;
  }
  try {
    s.setItem(SAVED_KEY, JSON.stringify(rows));
    lastError = null;
    return true;
  } catch (e) {
    // Storage threw (Safari private browsing, quota exceeded, etc). Report the
    // failure so the caller does NOT flip in-memory state — otherwise the UI
    // shows "Saved" for a write that silently vanished on reload, which is
    // exactly the symptom chased down before on the live web deploy.
    fail('writeSaved failed', e);
    return false;
  }
}

export function initDb(): void {
  // Nothing to open, but probe once so a broken environment is reported the
  // same way the native path reports a failed SQLite open.
  if (!store()) {
    lastError = 'no localStorage in this environment — saves cannot persist';
  }
}

/** Why storage is unavailable or degraded, or null when healthy. */
export function getStorageError(): string | null {
  return lastError;
}

/** True when the store is present and writable — used to surface save failures. */
export function isStorageReady(): boolean {
  return store() !== null;
}

export function getSavedIds(): string[] {
  return readSaved()
    .sort((a, b) => b.saved_at - a.saved_at)
    .map((r) => r.id);
}

export function saveRace(id: string): boolean {
  const rows = readSaved().filter((r) => r.id !== id);
  rows.push({ id, saved_at: Date.now() });
  return writeSaved(rows);
}

export function removeRace(id: string): boolean {
  return writeSaved(readSaved().filter((r) => r.id !== id));
}

// Prefs persist via localStorage on web (available in every browser target).
export function getPref(key: string): string | null {
  const s = store();
  if (!s) return null;
  try {
    return s.getItem(`carrera:${key}`);
  } catch (e) {
    fail('getPref failed', e);
    return null;
  }
}

export function setPref(key: string, value: string): boolean {
  const s = store();
  if (!s) return false;
  try {
    s.setItem(`carrera:${key}`, value);
    return true;
  } catch (e) {
    // non-fatal to the app (caller still gets a definitive result back),
    // but the preference itself will not persist
    fail('setPref failed', e);
    return false;
  }
}
