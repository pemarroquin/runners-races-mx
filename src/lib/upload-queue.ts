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
// by the caller. That matters for privacy: the Track screen passes the
// MASKED path (see privacy-zone.ts), so the queue never holds coordinates
// that wouldn't have been uploaded anyway. Nothing here re-derives the
// payload, precisely so it can't diverge from what would have been sent.
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
  return (
    Array.isArray(run.points) &&
    typeof run.distanceM === 'number' &&
    typeof run.startedAt === 'number' &&
    typeof run.endedAt === 'number' &&
    typeof run.fence === 'object' &&
    run.fence !== null
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
 * Persists a run that failed to upload. Returns false if storage rejected
 * the write — the caller must then keep telling the runner the run is only
 * in memory, because claiming it is safe when it isn't is the one outcome
 * this whole module exists to prevent.
 */
export function enqueueRun(run: RunUpload): boolean {
  const queue = listQueued();
  // Same run twice (a retry that failed again) — match on the timestamps,
  // which uniquely identify a session on this device.
  const duplicate = queue.some(
    (q) => q.run.startedAt === run.startedAt && q.run.endedAt === run.endedAt,
  );
  if (duplicate) return true;

  const next = [...queue, { id: localId(), queuedAt: Date.now(), run }];
  // Drop the OLDEST when full: the newest run is the one the runner just
  // finished and is actively watching, so losing that one would be the most
  // visible possible failure.
  const trimmed = next.length > MAX_QUEUED ? next.slice(next.length - MAX_QUEUED) : next;
  return writeQueue(trimmed);
}

export function removeQueued(id: string): boolean {
  return writeQueue(listQueued().filter((q) => q.id !== id));
}

export function queuedCount(): number {
  return listQueued().length;
}

export interface FlushResult {
  uploaded: number;
  remaining: number;
  /** Why it stopped early, if it did. Null when the queue drained. */
  stoppedBecause: SyncFailureReason | null;
}

/**
 * Tries to upload everything queued, oldest first.
 *
 * Stops at the FIRST failure rather than continuing down the list. If one
 * upload just failed on the network, the next will too — marching through
 * twenty of them would burn battery and radio to learn the same thing twenty
 * times. The queue is preserved either way; the next flush picks it up.
 */
export async function flushQueue(upload: Uploader): Promise<FlushResult> {
  const queue = listQueued();
  if (queue.length === 0) {
    return { uploaded: 0, remaining: 0, stoppedBecause: null };
  }

  let uploaded = 0;
  for (const item of queue) {
    const outcome = await upload(item.run);
    if (!outcome.ok) {
      return {
        uploaded,
        remaining: queue.length - uploaded,
        stoppedBecause: outcome.reason,
      };
    }
    // Removed one at a time, re-reading the queue each write, so an app kill
    // mid-flush can at worst re-upload a run rather than lose the rest.
    removeQueued(item.id);
    uploaded++;
  }
  return { uploaded, remaining: 0, stoppedBecause: null };
}
