// Protects an IN-PROGRESS run against iOS Safari evicting a backgrounded
// tab. Today a run in progress exists only in React memory — a runner who
// checks WhatsApp mid-run can return to a reloaded tab and a vanished
// 40-minute session. upload-queue.ts solves the equivalent problem on the
// OTHER side of a run (a FINISHED run that failed to upload); this is that
// same fix applied earlier, while the run is still being recorded.
//
// WHERE IT LIVES. The same prefs key/value store as upload-queue.ts (db.ts
// on native / db.web.ts on web) — see that file's header for why an
// identical getPref/setPref on both platforms means no schema change and no
// second implementation here either.
import { getPref, initDb, setPref } from '@/lib/db';
import { incrementPilotCounter } from '@/lib/pilot-instrumentation';
import type { TrackPoint } from '@/lib/tracking';

const PREF_CHECKPOINT = 'run.checkpoint.v1';

// ~2.7h at the tracker's 2s fix cadence — comfortably past any real run, so
// trimming only ever discards points from a session that's already
// abnormally long, never a normal one. Distance and duration are carried in
// the checkpoint separately (see RunCheckpoint), so trimming the route's
// tail costs the recovered map's precision, never the stats.
export const MAX_POINTS = 5000;
// How stale a checkpoint may be and still be RESUMED. Longer than this isn't
// "the runner just reopened the tab": it's a session that is genuinely over,
// and carrying on recording a six-hour-old route would be confusing.
export const RESUME_MAX_AGE_MS = 6 * 60 * 60 * 1000;
// How long a checkpoint is kept at all, so it can still be SAVED as it
// stands. This used to equal the resume window, and that threw real runs
// away: a phone that dies mid-run (2026-10-25, a ~3 h run, battery empty at
// 11:50) is usually charged and reopened hours later, and by then the only
// copy of the run read as stale and was dropped without a word. Same window
// as the finished-but-unsaved offer in the Track screen.
export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface RunCheckpoint {
  startedAt: number;
  points: TrackPoint[];
  distanceM: number;
  accumulatedMs: number;
  savedAt: number;
}

/**
 * Enough of a shape check that a half-written or hand-edited value can't
 * reach the resume path and throw. Same reasoning as upload-queue.ts's
 * isQueuedRun: a malformed checkpoint is dropped rather than failing the
 * whole read.
 */
function isRunCheckpoint(value: unknown): value is RunCheckpoint {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Partial<RunCheckpoint>;
  if (
    typeof c.startedAt !== 'number' ||
    typeof c.distanceM !== 'number' ||
    typeof c.accumulatedMs !== 'number' ||
    typeof c.savedAt !== 'number' ||
    !Array.isArray(c.points)
  ) {
    return false;
  }
  return c.points.every(
    (p) =>
      p &&
      typeof p === 'object' &&
      typeof (p as Partial<TrackPoint>).lat === 'number' &&
      typeof (p as Partial<TrackPoint>).lng === 'number' &&
      typeof (p as Partial<TrackPoint>).ts === 'number',
  );
}

/**
 * Persists the run's current state. Returns false if storage rejected the
 * write — callers should treat that the same way upload-queue.ts's
 * enqueueRun does: the run stays safe ONLY in memory, and nothing here
 * should be reported as more durable than that.
 */
export function saveCheckpoint(c: RunCheckpoint): boolean {
  initDb();
  const points =
    c.points.length > MAX_POINTS ? c.points.slice(c.points.length - MAX_POINTS) : c.points;
  return setPref(PREF_CHECKPOINT, JSON.stringify({ ...c, points }));
}

/** The last saved checkpoint, or null if there isn't one or it's too old. */
export function loadCheckpoint(): RunCheckpoint | null {
  initDb();
  const raw = getPref(PREF_CHECKPOINT);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    // clearCheckpoint()'s deliberate "no checkpoint" sentinel — JSON `null`,
    // not an empty string (see that function's comment). This is the
    // ordinary post-finish/post-discard state, not a loss: `typeof null ===
    // 'object'` means isRunCheckpoint(null) below would otherwise reject it
    // as malformed and increment runsLost on every normal app open after a
    // user's very first completed run.
    if (parsed === null) return null;
    if (!isRunCheckpoint(parsed)) {
      // Raw data existed but was malformed — a run silently lost before it
      // was ever offered for recovery. Invisible today; see
      // pilot-instrumentation.ts.
      incrementPilotCounter('runsLost');
      return null;
    }
    if (Date.now() - parsed.savedAt > MAX_AGE_MS) {
      // Raw data existed but was stale — same "never offered for recovery"
      // loss as above, just a different reason.
      incrementPilotCounter('runsLost');
      return null;
    }
    return parsed;
  } catch {
    // getPref returned non-null but JSON.parse failed — malformed data, the
    // same loss as isRunCheckpoint rejecting it above.
    incrementPilotCounter('runsLost');
    return null;
  }
}

/** Whether a checkpoint is recent enough to continue recording, rather than
 *  only to save as it stands. */
export function canResume(c: RunCheckpoint, now: number = Date.now()): boolean {
  return now - c.savedAt <= RESUME_MAX_AGE_MS;
}

/** When the recorded part of the run ended: its last point, or the last save
 *  if no point was ever recorded. Never "now": the time between a dead phone
 *  and reopening the app is not running time. */
export function checkpointEndedAt(c: RunCheckpoint): number {
  const last = c.points[c.points.length - 1];
  return last ? last.ts : c.savedAt;
}

export function clearCheckpoint(): boolean {
  initDb();
  // JSON `null`, not an empty string: loadCheckpoint's JSON.parse + shape
  // check already treats that as "no checkpoint", so there's no second
  // "empty" representation for the two functions to disagree about.
  return setPref(PREF_CHECKPOINT, JSON.stringify(null));
}
