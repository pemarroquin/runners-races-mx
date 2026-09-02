// Durable, LOCAL-ONLY counters for the pilot instrumentation backlog item —
// "Backgrounding events, watch restarts, runs recovered, runs lost." Today
// those four signals either don't persist at all, or exist only as ephemeral
// per-run React state (see tracking.ts's gapCount/gapDurationMs) that's gone
// the moment the app restarts. This is the cheapest possible fix: a single
// persisted counters object, same PREF store as run-checkpoint.ts /
// last-run-debug.ts (getPref/setPref from db.ts / db.web.ts — no schema
// change, no new table, no backend). Deliberately NOT a Supabase table: this
// project's migrations are manual-apply-only, and a remote table here would
// contradict "cheapest item on this list". If cross-device aggregation turns
// out to matter, that's a follow-up decision, not this one.
//
// This is instrumentation, not a feature — it must never be able to affect
// the run it's observing. incrementPilotCounter() never throws (same
// defensive posture as run-checkpoint.ts's isRunCheckpoint) and a failed
// write is swallowed exactly like every other pref write in this codebase
// tolerates setPref returning false elsewhere.
import { getPref, initDb, setPref } from '@/lib/db';

const PREF_COUNTERS = 'pilot.counters.v1';

export type PilotCounterKey = 'backgroundEvents' | 'watchRestarts' | 'runsRecovered' | 'runsLost';

export interface PilotCounters {
  /** Times a live run survived a background/foreground cycle — the SAME
   *  trigger point as tracking.ts's gapCount (a hidden→visible transition
   *  with a live gap), just persisted across app restarts instead of reset
   *  per-run. */
  backgroundEvents: number;
  /** Times the GPS watch was torn down and restarted on an ALREADY-RUNNING
   *  session — the visibilitychange reconnect, resume() after a pause, and
   *  restoreFromCheckpoint() after a reload. Never a fresh run's first
   *  start(). */
  watchRestarts: number;
  /** Times a checkpointed run was actually accepted and resumed via
   *  resumeCheckpoint() in the Track screen. */
  runsRecovered: number;
  /** Times a run was lost: either the runner explicitly discarded a
   *  recoverable checkpoint, or a checkpoint existed in storage but was
   *  rejected as stale or malformed before it was ever offered for
   *  recovery — the case that's otherwise invisible. */
  runsLost: number;
}

const ZERO_COUNTERS: PilotCounters = {
  backgroundEvents: 0,
  watchRestarts: 0,
  runsRecovered: 0,
  runsLost: 0,
};

/** Enough of a shape check that a half-written or hand-edited value can't
 *  produce NaN/undefined counters. Same reasoning as run-checkpoint.ts's
 *  isRunCheckpoint: malformed data is dropped (defaults to zero) rather than
 *  failing the read. */
function isPilotCounters(value: unknown): value is PilotCounters {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Partial<PilotCounters>;
  return (
    typeof c.backgroundEvents === 'number' &&
    typeof c.watchRestarts === 'number' &&
    typeof c.runsRecovered === 'number' &&
    typeof c.runsLost === 'number'
  );
}

/** Reads the persisted counters, defaulting missing/corrupted storage to all
 *  zeros rather than throwing — never reported as more durable than it is. */
export function getPilotCounters(): PilotCounters {
  initDb();
  const raw = getPref(PREF_COUNTERS);
  if (!raw) return { ...ZERO_COUNTERS };
  try {
    const parsed: unknown = JSON.parse(raw);
    return isPilotCounters(parsed) ? parsed : { ...ZERO_COUNTERS };
  } catch {
    return { ...ZERO_COUNTERS };
  }
}

/**
 * Increments exactly one counter and persists the result. Never throws — a
 * storage failure (setPref returning false, or any unexpected error reading
 * the current value) is swallowed, same as the rest of this codebase treats
 * prefs writes: instrumentation degrading is acceptable, instrumentation
 * affecting the run it's observing is not.
 */
export function incrementPilotCounter(key: PilotCounterKey): void {
  try {
    const current = getPilotCounters();
    const next: PilotCounters = { ...current, [key]: current[key] + 1 };
    setPref(PREF_COUNTERS, JSON.stringify(next));
  } catch {
    // Swallowed deliberately — see the file header. Losing one increment is
    // acceptable; throwing out of an instrumentation call site is not.
  }
}
