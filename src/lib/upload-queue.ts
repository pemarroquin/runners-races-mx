// Offline retry queue for finished runs — the last unbuilt piece of the
// Phase 1 plan, and the only one that loses user data.
//
// THE PROBLEM IT SOLVES. A finished run exists ONLY in memory. When the
// upload failed, the summary screen kept it on screen for a manual retry —
// which is correct as far as it goes, but the moment the runner closed the
// tab (or the app was backgrounded out of existence) the run was gone for
// good. Someone who ran 10km with no signal lost the whole thing.
//
// WHERE IT LIVES. The `prefs` key/value store (db.ts on native / db.web.ts
// on web), not a new table: both platforms already expose an identical
// getPref/setPref, so this needs no schema change and no second
// implementation. The trade is that the whole queue is read and rewritten as
// one JSON blob, which is fine at this size — see MAX_QUEUED.
//
// WHAT IT STORES. Exactly the RunUpload payload that uploadRun takes, built
// by the caller — never re-derived here, precisely so the queued copy can't
// diverge from what would have been sent.
//
// That property is what makes the privacy-zone work (a separate branch)
// correct by construction rather than by remembering: whatever path the
// caller decides to upload is the path that gets stored. TODAY, on this
// branch, no masking exists, so this holds the RAW track — including the
// runner's start and finish points — at rest in SQLite/localStorage until
// it uploads. That is new at-rest storage of precise location, and the
// privacy copy in settings.tsx says so.
import { getPref, initDb, setPref } from '@/lib/db';
import type { RunUpload } from '@/lib/territory-sync';

/** The failure reasons an uploader can report. */
type SyncFailureReason = 'disabled' | 'auth' | 'network';

/**
 * The upload call, injected rather than imported.
 *
 * This is a TYPE-ONLY import of RunUpload above for a concrete reason:
 * importing `uploadRun` itself would drag in supabase-js, AsyncStorage and
 * a crypto polyfill, none of which run in a plain Node process — and this
 * is data-loss-critical logic that has to be testable. Injecting the
 * uploader keeps this module pure, so the queue's behaviour can be verified
 * without a device or a network.
 */
export type Uploader = (
  run: RunUpload,
) => Promise<{ ok: true; runId: string } | { ok: false; reason: SyncFailureReason }>;

const PREF_QUEUE = 'runUploadQueue';

/**
 * Runs held at once. A failed run is roughly 40-80KB of JSON (a 5km track is
 * ~1600 points), so 20 is comfortably inside both SQLite's limits and the
 * ~5MB localStorage budget on web. Reaching this number means something is
 * badly wrong, not that someone ran a lot.
 */
export const MAX_QUEUED = 20;

export interface QueuedRun {
  id: string;
  queuedAt: number;
  run: RunUpload;
  /** Failed upload attempts — decides when it drops to slow retries. */
  attempts: number;
  /** When it last failed, for the slow-retry spacing. Absent on entries
   *  queued by older builds, which simply count as due. */
  lastAttemptAt?: number;
}

/**
 * Failed attempts before an entry drops to SLOW retries. It is never
 * deleted (2026-10-01): this queue holds the runner's only copy of a run,
 * and the old policy — abandon after 8 failures — lost exactly the runs
 * that most needed keeping (a long offline stretch, a server-side bug that
 * gets fixed later). Past this many failures it retries at most once per
 * SLOW_RETRY_MS, so a run the server keeps refusing costs one request a
 * day, not one per app open, and stays visible as pending in Profile ›
 * Places I've been, where the runner can retry or discard it.
 */
export const MAX_ATTEMPTS = 8;
export const SLOW_RETRY_MS = 24 * 60 * 60 * 1000;

/** Whether an entry should be tried in this flush. */
export function isDue(item: { attempts: number; lastAttemptAt?: number }, now: number): boolean {
  if (item.attempts < MAX_ATTEMPTS || item.lastAttemptAt === undefined) return true;
  return now - item.lastAttemptAt >= SLOW_RETRY_MS;
}

/** Local id — only ever used to remove the right entry from this queue, so
 *  it needs to be unique on one device, not globally. */
function localId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Enough of a shape check that a half-written or hand-edited value can't
 * reach uploadRun and throw. A malformed entry is dropped rather than
 * failing the whole read — losing one unrecoverable entry beats losing the
 * queue.
 */
function isQueuedRun(value: unknown): value is QueuedRun {
  if (typeof value !== 'object' || value === null) return false;
  const q = value as Partial<QueuedRun>;
  if (typeof q.id !== 'string' || typeof q.queuedAt !== 'number') return false;
  const run = q.run as Partial<RunUpload> | undefined;
  if (!run || typeof run !== 'object') return false;
  if (
    !Array.isArray(run.points) ||
    typeof run.distanceM !== 'number' ||
    typeof run.startedAt !== 'number' ||
    typeof run.endedAt !== 'number'
  ) {
    return false;
  }
  // `typeof [] === 'object'`, so an array fence passed the old check and
  // then blew up inside uploadRun reading fence.geometry.geometry. Validate
  // the shape that is actually dereferenced, not merely "is an object".
  const fence = run.fence as Partial<RunUpload['fence']> | undefined;
  if (!fence || typeof fence !== 'object' || Array.isArray(fence)) return false;
  if (typeof fence.areaM2 !== 'number') return false;
  const feature = fence.geometry as { geometry?: unknown } | undefined;
  if (!feature || typeof feature !== 'object' || !feature.geometry) return false;
  // Points must be real coordinates — an empty array is valid JSON and a
  // useless upload.
  return run.points.every(
    (pt) => pt && typeof pt.lat === 'number' && typeof pt.lng === 'number',
  );
}

export function listQueued(): QueuedRun[] {
  // Same defensive call races.ts makes: getPref/setPref return null/false
  // until the store is open, and this module can be reached before any
  // screen that would have opened it. A silent false here would mean a
  // failed run is never persisted — the exact data loss this file exists to
  // prevent. initDb is idempotent.
  initDb();
  const raw = getPref(PREF_QUEUE);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isQueuedRun);
  } catch {
    return [];
  }
}

function writeQueue(queue: QueuedRun[]): boolean {
  initDb();
  return setPref(PREF_QUEUE, JSON.stringify(queue));
}

/**
 * Persists a run that failed to upload.
 *
 * Returns the queue id, or null if storage rejected the write — the caller
 * must then keep telling the runner the run is only in memory, because
 * claiming it is safe when it isn't is the one outcome this whole module
 * exists to prevent.
 *
 * The ID IS THE POINT, not a convenience: the caller has to be able to take
 * the run back out again when a manual retry succeeds, or when the runner
 * discards it. Returning a bare boolean left no handle, so a discarded run
 * uploaded itself later and a successful retry uploaded twice.
 */
export function enqueueRun(run: RunUpload): string | null {
  const queue = listQueued();
  // Same run twice (a retry that failed again) — match on the timestamps,
  // which uniquely identify a session on this device. Return the EXISTING
  // id so the caller still has a handle on it.
  const duplicate = queue.find(
    (q) => q.run.startedAt === run.startedAt && q.run.endedAt === run.endedAt,
  );
  if (duplicate) return duplicate.id;

  const id = localId();
  const next = [...queue, { id, queuedAt: Date.now(), run, attempts: 0 }];
  // Drop the OLDEST when full: the newest run is the one the runner just
  // finished and is actively watching, so losing that one would be the most
  // visible possible failure.
  const trimmed = next.length > MAX_QUEUED ? next.slice(next.length - MAX_QUEUED) : next;
  return writeQueue(trimmed) ? id : null;
}

export function removeQueued(id: string): boolean {
  return writeQueue(listQueued().filter((q) => q.id !== id));
}

export function queuedCount(): number {
  return listQueued().length;
}

export interface FlushResult {
  uploaded: number;
  /** Entries still queued after this flush. */
  remaining: number;
  /** The last failure this flush hit, or null when everything tried landed.
   *  'storage' means the queue itself couldn't be written. */
  stoppedBecause: SyncFailureReason | 'storage' | null;
  /** Queue ids that reached the server this flush, with their server runId
   *  — so a screen showing one of them can reconcile its own state. */
  resolved: { id: string; runId: string }[];
}

let flushing = false;

/**
 * Upload every DUE queued run, FEWEST failed attempts first, stopping at
 * the first failure — an offline phone makes one doomed request, not one
 * per queued run.
 *
 * The ordering is what lets this never abandon a run. Stopping at the first
 * failure used to mean a run that always failed sat at the head and blocked
 * every run behind it, so it was deleted after MAX_ATTEMPTS. Now a fresh run
 * is always tried before one that keeps failing, and past MAX_ATTEMPTS the
 * failing one waits SLOW_RETRY_MS between tries. 'disabled' (no server on
 * this build) never counts as an attempt — nothing is wrong with the run.
 */
export async function flushQueue(upload: Uploader, now: number = Date.now()): Promise<FlushResult> {
  if (flushing) {
    return { uploaded: 0, remaining: queuedCount(), stoppedBecause: null, resolved: [] };
  }
  flushing = true;
  try {
    // Stable sort: equal attempts keep queue (oldest-first) order.
    const queue = listQueued().sort((a, b) => a.attempts - b.attempts);
    let uploaded = 0;
    let stoppedBecause: FlushResult['stoppedBecause'] = null;
    const resolved: { id: string; runId: string }[] = [];
    for (const item of queue) {
      if (!isDue(item, now)) continue;
      const outcome = await upload(item.run);
      if (!outcome.ok) {
        stoppedBecause = outcome.reason;
        if (outcome.reason !== 'disabled' && !bumpAttempts(item.id, item.attempts + 1, now)) {
          stoppedBecause = 'storage';
        }
        break;
      }
      if (!removeQueued(item.id)) {
        stoppedBecause = 'storage';
        break;
      }
      uploaded++;
      resolved.push({ id: item.id, runId: outcome.runId });
    }
    return { uploaded, remaining: queuedCount(), stoppedBecause, resolved };
  } finally {
    flushing = false;
  }
}

function bumpAttempts(id: string, attempts: number, at: number): boolean {
  return writeQueue(listQueued().map((q) => (q.id === id ? { ...q, attempts, lastAttemptAt: at } : q)));
}
