// Keeps the RAW (pre-privacy-mask) point list of the most recently FINISHED
// run on this device — a diagnostic escape hatch, not a feature. Every other
// place this data could come from throws it away deliberately: the upload
// queue only ever stores the masked path (privacy-zone.ts trims it before
// upload-queue.ts ever sees it), and run-checkpoint.ts is cleared the moment
// a run reaches a durable state. When a run's reported area looks wrong,
// there was previously no way to get the actual recorded path back out —
// buildFence() is pure and fully unit-testable (territory.test.ts), so ONE
// real path turns a geometry question from speculation into a fixture. This
// exists solely to close that gap (2026-08-31, Pedro's 8.25km run reporting
// an area that looked too small for its length).
//
// Exposed via a long-press on the version row in Settings — see that
// screen's header. Deliberately not a visible button: nothing about this
// should read as a feature a runner is meant to find.
import { getPref, initDb, setPref } from '@/lib/db';
import type { TrackPoint } from '@/lib/tracking';

const PREF_LAST_RUN = 'debug.lastRun.v1';

export interface LastRunDebug {
  points: TrackPoint[];
  /** The TRUE distance (tracker.distanceM) — never the masked path's. */
  distanceM: number;
  /** The area actually shown to the runner on the summary screen (computed
   *  from the MASKED path, same as everywhere else in the app) — kept
   *  alongside the raw points specifically so a re-run of buildFence(points)
   *  against the raw path can be compared to what the app reported, not
   *  just recomputed in a vacuum. Null if no fence formed at all. */
  areaM2: number | null;
  startedAt: number;
  endedAt: number;
}

function isLastRunDebug(value: unknown): value is LastRunDebug {
  if (typeof value !== 'object' || value === null) return false;
  const d = value as Partial<LastRunDebug>;
  if (
    !Array.isArray(d.points) ||
    typeof d.distanceM !== 'number' ||
    typeof d.startedAt !== 'number' ||
    typeof d.endedAt !== 'number' ||
    (d.areaM2 !== null && typeof d.areaM2 !== 'number')
  ) {
    return false;
  }
  return d.points.every(
    (p) =>
      p &&
      typeof p === 'object' &&
      typeof (p as Partial<TrackPoint>).lat === 'number' &&
      typeof (p as Partial<TrackPoint>).lng === 'number' &&
      typeof (p as Partial<TrackPoint>).ts === 'number',
  );
}

/** Overwrites whatever was there — this is "the last run", singular, not a
 *  history. Returns false if storage rejected the write (nothing else
 *  depends on this succeeding — it degrades to "nothing to export" rather
 *  than blocking anything). */
export function saveLastRunDebug(debug: LastRunDebug): boolean {
  initDb();
  return setPref(PREF_LAST_RUN, JSON.stringify(debug));
}

export function loadLastRunDebug(): LastRunDebug | null {
  initDb();
  const raw = getPref(PREF_LAST_RUN);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isLastRunDebug(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Plain JSON, not GeoJSON — the direct consumer is a vitest fixture
 *  (`buildFence(points)`), so the exported shape matches LastRunDebug
 *  exactly rather than needing a conversion step before it's usable. */
export function lastRunDebugToJSON(debug: LastRunDebug): string {
  return JSON.stringify(debug, null, 2);
}
