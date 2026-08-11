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
  statusNoteEs?: string | null; // Spanish translation of `statusNote`; falls back to `statusNote`
  lastVerified?: string | null; // YYYY-MM-DD of the last verification pass
}

/**
 * True only for a well-formed absolute http(s) URL.
 *
 * Every URL in this file is attacker-influenced in practice: the race-watch
 * agent harvests `signupUrl` from third-party race-calendar sites twice a week
 * and commits it, and the whole payload is refetched from GitHub at runtime.
 * Those values reach privileged sinks — `WebView source={{uri}}`, `<iframe
 * src>`, `Linking.openURL` — where a non-http scheme is a real weapon:
 * `Linking.openURL` will happily fire `intent:`/custom-scheme deep links into
 * other installed apps, and the in-app checkout has no URL bar for a user to
 * notice with.
 *
 * Deliberately NOT built on `new URL()`: React Native ships an incomplete,
 * non-spec URL implementation, so parsing behaviour differs between native and
 * web — exactly the kind of gap this check exists to close. A literal prefix
 * test behaves identically everywhere.
 *
 * This allowlists the SCHEME, not the host. Race registrations live on
 * hundreds of legitimate domains, so a host allowlist isn't possible; what
 * this stops is `javascript:`, `data:`, `file:`, `intent:` and friends.
 */
export function isSafeUrl(u: unknown): u is string {
  if (typeof u !== 'string') return false;
  const trimmed = u.trim();
  // Browsers strip tabs, newlines and other control characters out of URLs
  // before navigating, so `java\nscript:...` can smuggle a scheme past a naive
  // check. Reject any control character outright rather than trying to model
  // each engine's stripping rules.
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return false;
  return /^https?:\/\/[^\s]+$/i.test(trimmed);
}

/**
 * Null out any URL field that isn't a safe http(s) URL, keeping the rest of
 * the race. Degrading one field beats dropping a real listing: a race with a
 * rejected `signupUrl` still appears, just with the CTA disabled and showing
 * "Registro próximamente" — the same state as a race whose registration isn't
 * published yet.
 *
 * `sourceUrl` is handled in `isValidRace` instead, not here: it's required by
 * the schema (no race without a fetched source), so a record whose source
 * isn't an http(s) URL is malformed rather than degraded, and is dropped.
 */
function sanitizeRace(race: Race): Race {
  const signupUrl = isSafeUrl(race.signupUrl) ? race.signupUrl : null;
  const courseMapUrl = isSafeUrl(race.courseMapUrl) ? race.courseMapUrl : null;
  if (signupUrl === race.signupUrl && courseMapUrl === (race.courseMapUrl ?? null)) {
    return race; // untouched — keep the original object identity
  }
  return { ...race, signupUrl, courseMapUrl };
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
  // sourceUrl is rendered as a tappable "Ver fuente" that calls
  // Linking.openURL, so a non-http(s) value here is a live deep-link sink, not
  // a cosmetic problem. It's also required by the research contract (no race
  // without a fetched source), so a record failing this is malformed and gets
  // dropped rather than degraded. All 312 URLs in the current dataset pass.
  if (!isSafeUrl(race.sourceUrl)) return false;
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
export const SEED_RACES: Race[] = (racesJson.races as unknown[])
  .filter(isValidRace)
  .map(sanitizeRace);

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
    // Scheme-sanitize AFTER the sanity floor so a payload full of hostile URLs
    // still trips the floor on its record count rather than sneaking through
    // as a pile of successfully-nulled links.
    return valid.map(sanitizeRace);
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
    // The device cache is written by us, but it's still on-disk state that a
    // previous (pre-allowlist) build may have populated — re-sanitize on read.
    const valid = parsed.filter(isValidRace).map(sanitizeRace);
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

// Only states whose full name is genuinely long enough to cause wrapping in
// a compact card's one-line city/state string get an entry — most of the 13
// states in the dataset (Jalisco, Puebla, Yucatán...) are already short.
// Colloquial Mexican Spanish abbreviation, not a formal postal code (those
// are 2-3 uppercase letters and read as shouting in body text — "Edo de
// México" is how it's actually said/written day to day).
const STATE_ABBREVIATIONS: Record<string, string> = {
  'Estado de México': 'Edo de México',
};

/** Shortens a small set of known-long state names for tight layouts (card city/state line). Falls through unchanged for every other state. */
export function abbreviateState(state: string): string {
  return STATE_ABBREVIATIONS[state] ?? state;
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

/** This calendar month's key, in the same 'YYYY-MM' shape as `monthKey`. */
export function currentMonthKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * The next `count` consecutive calendar-month keys starting from THIS month
 * (inclusive) — so the "next 3 months" preset is a superset of "this month"
 * rather than a disjoint window starting after it.
 */
export function nextMonthKeys(count: number): string[] {
  const d = new Date();
  return Array.from({ length: count }, (_, i) => {
    const dt = new Date(d.getFullYear(), d.getMonth() + i, 1);
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
  });
}
