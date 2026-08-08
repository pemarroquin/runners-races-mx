// Race data layer — bundled seed (assets/data/races.json) + optional remote
// refresh on launch. The weekly race-watch agent commits verified data to
// GitHub; the app fetches it on open ("update fresh on app open", per PRD) and
// falls back to the bundled copy offline.
import racesJson from '@/assets/data/races.json';
import { getPref, initDb, setPref } from '@/lib/db';

// Raw URL of the agent-maintained races.json (public repo, no auth needed).
// The Mon+Fri race-watch cloud routine commits verified status updates here.
export const REMOTE_RACES_URL: string | null =
  'https://raw.githubusercontent.com/pemarroquin/runners-races-mx/main/assets/data/races.json';

export type Confidence = 'high' | 'medium' | 'low';
export type DistanceTag =
  | '3K'
  | '5K'
  | '10K'
  | '15K'
  | 'Half'
  | '30K'
  | 'Full'
  | 'Ultra'
  | 'TBD'; // distance not yet confirmed (empty `distances[]`)

/** Canonical render/filter order — matches the re-tag script's bucket order. */
export const DISTANCE_TAGS: DistanceTag[] = [
  '3K',
  '5K',
  '10K',
  '15K',
  'Half',
  '30K',
  'Full',
  'Ultra',
  'TBD',
];

const DISTANCE_TAG_LABEL_KEY: Record<DistanceTag, string> = {
  '3K': 'filters.3K',
  '5K': 'filters.5K',
  '10K': 'filters.10K',
  '15K': 'filters.15K',
  Half: 'filters.half',
  '30K': 'filters.30K',
  Full: 'filters.full',
  Ultra: 'filters.ultra',
  TBD: 'filters.tbd',
};

/** i18n key for a distance tag's chip label (e.g. 'Half' -> 'filters.half'). */
export function distanceTagLabelKey(tag: DistanceTag): string {
  return DISTANCE_TAG_LABEL_KEY[tag];
}

/** Start-line location. `approx: true` = venue centroid, not the official start. */
export interface StartPoint {
  lat: number;
  lng: number;
  approx?: boolean;
}

export interface Race {
  id: string;
  name: string;
  date: string | null; // YYYY-MM-DD
  time: string | null; // HH:MM
  distances: string[];
  distanceTags: DistanceTag[];
  city: string;
  state: string;
  venue: string | null;
  organizer: string | null;
  signupUrl: string | null;
  sourceUrl: string;
  confidence: Confidence;
  notes: string | null; // user-facing description — shown in the app
  notesEs?: string | null; // Spanish translation of `notes`; falls back to `notes` when absent
  sourceNotes?: string | null; // research/verification trail for maintainers — never shown to users
  // Route data (optional — only present when verified from a source)
  start?: StartPoint | null;
  routeCoords?: [number, number][] | null; // [lat, lng] pairs along the course
  courseMapUrl?: string | null; // official course-map image
  // Pre-race verification (written by the weekly race-watch agent; absent = ok)
  status?: 'ok' | 'changed' | 'canceled' | null;
  statusNote?: string | null; // what changed, with source — shown to the user
  lastVerified?: string | null; // YYYY-MM-DD of the last verification pass
}

/**
 * Per-record shape check. The UI dereferences far more than `id`/`name`
 * (distanceTags, distances, city, state, sourceUrl, date), so a record
 * missing any of those would throw deep in a render — not here. Used to
 * filter both the remote payload and the bundled seed, so nothing gets a
 * free pass just for shipping inside the app.
 */
function isValidRace(r: unknown): r is Race {
  if (typeof r !== 'object' || r === null) return false;
  const race = r as Record<string, unknown>;
  if (typeof race.id !== 'string' || race.id === '') return false;
  if (typeof race.name !== 'string' || race.name === '') return false;
  if (typeof race.city !== 'string') return false;
  if (typeof race.state !== 'string') return false;
  if (typeof race.sourceUrl !== 'string') return false;
  if (!Array.isArray(race.distances)) return false;
  if (!Array.isArray(race.distanceTags)) return false;
  if (!race.distanceTags.every((t) => (DISTANCE_TAGS as string[]).includes(t as string))) {
    return false;
  }
  if (race.date !== null && !(typeof race.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(race.date))) {
    return false;
  }
  return true;
}

// The bundled seed, filtered through the same validator as remote data — no
// free pass just for shipping in the app. Consumers hold their own React
// state seeded from this (see RacesProvider); nothing here is mutated.
export const SEED_RACES: Race[] = (racesJson.races as unknown[]).filter(isValidRace);

/** Sort by date ascending; undated races sink to the bottom, ties by name. */
export function sortRaces(races: Race[]): Race[] {
  return races.slice().sort((a, b) => {
    if (a.date === b.date) return a.name.localeCompare(b.name);
    if (a.date === null) return 1;
    if (b.date === null) return -1;
    return a.date < b.date ? -1 : 1;
  });
}

/**
 * Fetch the agent-maintained races.json. Returns the validated array on
 * success, or null on any failure (offline, 404, bad shape) — the caller
 * must leave existing data untouched on null, since the app must always
 * work offline.
 */
export async function fetchRemoteRaces(): Promise<Race[] | null> {
  if (!REMOTE_RACES_URL) return null;
  try {
    // No custom headers here: on web, any non-safelisted request header (e.g.
    // 'cache-control') forces a CORS preflight OPTIONS request, and GitHub's
    // raw host 403s that preflight, silently breaking every refresh on web.
    // Cache-bust with a query param instead (no header needed), and pass
    // `cache: 'no-store'` — a standard RequestInit option, not a header, so
    // it never triggers a preflight either.
    const res = await fetch(`${REMOTE_RACES_URL}?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return null;
    const json = await res.json();
    const races = json?.races;
    if (!Array.isArray(races) || races.length === 0) return null;
    // Validate every record and drop the bad ones instead of rejecting the
    // whole payload — a single malformed record (e.g. a renamed field on one
    // race) shouldn't discard 194 good ones. But a payload that's MOSTLY bad
    // records is a sign of real corruption (truncated commit, wrong schema,
    // wrong file entirely), not a one-off typo, so guard against that with a
    // sanity floor: if fewer than half the records survive validation, treat
    // the whole payload as untrustworthy and keep the data we already have.
    const valid = races.filter(isValidRace);
    if (valid.length < races.length / 2) return null;
    return valid;
  } catch {
    return null;
  }
}

const CACHE_KEY = 'racesCache';

/**
 * Load the last successfully-fetched remote payload from device storage, if
 * any. Returns null on a cold device, a storage failure, or corrupt/invalid
 * cached JSON — callers fall back to the bundled seed in that case.
 */
export function loadCachedRaces(): Race[] | null {
  try {
    initDb();
    const raw = getPref(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const valid = parsed.filter(isValidRace);
    if (valid.length === 0) return null;
    return valid;
  } catch {
    return null;
  }
}

/** Persist a freshly-fetched races payload for the next cold start. */
export function saveCachedRaces(races: Race[]): void {
  try {
    initDb();
    setPref(CACHE_KEY, JSON.stringify(races));
  } catch {
    // Non-fatal — the in-memory state the caller already set is still
    // correct for this session; only the next cold start misses the cache.
  }
}

const MONTHS: Record<string, string[]> = {
  es: ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'],
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
};

/** "13 dic 2026" (es) / "13 Dec 2026" (en). Null date → null. */
export function formatDate(dateStr: string | null, locale: string): string | null {
  if (!dateStr) return null;
  const [y, m, d] = dateStr.split('-').map(Number);
  const months = MONTHS[locale] ?? MONTHS.en;
  return `${d} ${months[m - 1]} ${y}`;
}

/** Whole days from today until the race date (negative = past, null = undated). */
export function daysUntil(dateStr: string | null): number | null {
  if (!dateStr) return null;
  const [y, m, d] = dateStr.split('-').map(Number);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(y, m - 1, d);
  return Math.round((target.getTime() - today.getTime()) / 86_400_000);
}

/** 'YYYY-MM' key for grouping by month; undated races sort into 'tbd'. */
export function monthKey(dateStr: string | null): string {
  return dateStr === null ? 'tbd' : dateStr.slice(0, 7);
}

/** Month keys present in `races` (+ 'tbd' if any are undated), chronological, labeled. */
export function getAvailableMonths(
  races: Race[],
  locale: string,
): { key: string; label: string }[] {
  const months = MONTHS[locale] ?? MONTHS.en;
  const keys = new Set(races.map((r) => monthKey(r.date)));
  return Array.from(keys)
    .sort((a, b) => (a === 'tbd' ? 1 : b === 'tbd' ? -1 : a < b ? -1 : 1))
    .map((key) => {
      if (key === 'tbd') return { key, label: 'tbd' };
      const [y, m] = key.split('-').map(Number);
      return { key, label: `${months[m - 1]} ${y}` };
    });
}
