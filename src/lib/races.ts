// Race data layer — bundled seed (assets/data/races.json) + optional remote
// refresh on launch. The weekly race-watch agent commits verified data to
// GitHub; the app fetches it on open ("update fresh on app open", per PRD) and
// falls back to the bundled copy offline.
import racesJson from '@/assets/data/races.json';

// Raw URL of the agent-maintained races.json (public repo, no auth needed).
// The Mon+Fri race-watch cloud routine commits verified status updates here.
export const REMOTE_RACES_URL: string | null =
  'https://raw.githubusercontent.com/pemarroquin/carrera-monterrey/main/assets/data/races.json';

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

// Module-level store: starts as the bundled seed; refreshRaces() may replace
// it with fresh remote data. Consumers re-render via RacesProvider's version.
let ALL_RACES = (racesJson.races as Race[]).slice();

/** All races, sorted by date ascending; undated races sink to the bottom. */
export function getRaces(): Race[] {
  return ALL_RACES.slice().sort((a, b) => {
    if (a.date === b.date) return a.name.localeCompare(b.name);
    if (a.date === null) return 1;
    if (b.date === null) return -1;
    return a.date < b.date ? -1 : 1;
  });
}

export function getRace(id: string | undefined): Race | undefined {
  return ALL_RACES.find((r) => r.id === id);
}

/**
 * Fetch the agent-maintained races.json and swap it in if it looks valid.
 * Returns true if data was replaced. Any failure (offline, 404, bad shape)
 * leaves the bundled data untouched — the app must always work offline.
 */
export async function refreshRaces(): Promise<boolean> {
  if (!REMOTE_RACES_URL) return false;
  try {
    const res = await fetch(REMOTE_RACES_URL, { headers: { 'cache-control': 'no-cache' } });
    if (!res.ok) return false;
    const json = await res.json();
    const races = json?.races;
    if (!Array.isArray(races) || races.length === 0) return false;
    // Minimal shape check on a sample — protects against a bad commit.
    const ok = races.every(
      (r: unknown) =>
        typeof (r as Race)?.id === 'string' && typeof (r as Race)?.name === 'string',
    );
    if (!ok) return false;
    ALL_RACES = races as Race[];
    return true;
  } catch {
    return false;
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
