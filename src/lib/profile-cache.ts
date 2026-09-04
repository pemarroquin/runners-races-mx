// The runner's leaderboard display name, cached locally so a screen that
// shows it can render the real value on its FIRST paint.
//
// The problem this exists for (Pedro, 2026-09-04): opening Settings > Profile
// showed an empty name field, then filled it in ~30 seconds later. Every
// value on that screen came from `fetchMyProfile()`, a Supabase round trip
// started on focus — so the first paint had nothing to show and the screen
// visibly changed under the runner once the network answered.
//
// Caching it is what actually fixes that, and NOT preloading the screen:
// the sub-pages are already in the main web bundle (the export produces no
// per-route chunk for them), so there is no module load to get ahead of.
// What was slow was the data, and the data is worth persisting anyway — the
// runner's own name does not change between sessions, so re-asking the
// server for it before showing anything is the wrong default.
//
// Same prefs store as the theme, locale and privacy zone (db.ts /
// db.web.ts), so it inherits that store's behaviour: it survives restarts,
// it is wiped by deleting the app or clearing site data, and a browser that
// blocks storage degrades to "no cached name" — i.e. exactly the old
// blank-then-fill behaviour, never an error.
//
// This is a CACHE, never the source of truth. The server row still is: every
// screen that seeds from here also refetches and reconciles (see
// settings/profile.tsx), because the name can be changed from another device
// or from NamePrompt while a screen sits mounted.
import { getPref, initDb, setPref } from '@/lib/db';

const PREF_DISPLAY_NAME = 'profileDisplayName';
// A real stored value meaning "the server says this runner has no name",
// which must be distinguishable from "nothing cached yet" — the first should
// render the anonymous fallback immediately, the second should wait.
const NO_NAME = '';

/**
 * The last known display name: a string (possibly empty, meaning the runner
 * genuinely has none), or null when nothing has ever been cached.
 *
 * initDb() defensively, the same way home-point.ts and races.ts do — getPref
 * returns null until the store is open, and this is read during the first
 * render of a screen, which has no ordering guarantee against the providers
 * that would otherwise have opened it. It is idempotent.
 */
export function getCachedDisplayName(): string | null {
  initDb();
  return getPref(PREF_DISPLAY_NAME);
}

/** Records what the server last confirmed. `null` (no name set) is stored as
 *  an empty string rather than removing the key, so it stays distinct from
 *  "never fetched". */
export function setCachedDisplayName(name: string | null): void {
  initDb();
  setPref(PREF_DISPLAY_NAME, name ?? NO_NAME);
}
