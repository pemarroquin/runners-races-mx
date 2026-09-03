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
  /** Failed upload attempts. Without this a single un-uploadable entry sits
   *  at the head of the queue forever and blocks every run behind it, since
   *  flushQueue stops at the first failure. */
  attempts: number;
}

/**
 * Attempts before an entry is abandoned. A run that has failed this many
 * times is not failing on the network — it is malformed, or violates a
 * constraint the server will never accept — and keeping it costs every
 * later run its upload.
 *
 * Does NOT apply to a 'disabled' failure (see flushQueue) — that means no
 * server is configured on this BUILD, not that the server rejected this
 * PAYLOAD, and unlike a malformed run it resolves itself the moment a build
 * with real credentials loads. Counting those attempts would delete a
 * safely-queued run before that fix ever gets a chance to land.
 */
export const MAX_ATTEMPTS = 8;

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
  remaining: number;
  /** Why it stopped early, if it did. Null when the queue drained. */
  stoppedBecause: SyncFailureReason | 'storage' | null;
  /** Entries abandoned after MAX_ATTEMPTS. Non-zero means runs were thrown
   *  away — the caller should say so rather than reporting a clean drain. */
  abandoned: number;
  /** Queue ids that uploaded successfully THIS flush, paired with the
   *  server run id each landed as. This flush runs independently of
   *  whatever a caller has on screen (it drains the whole on-disk queue),
   *  so a caller displaying one specific queued run needs a way to tell
   *  "was MY run one of these" apart from "some other queued run finished"
   *  — a bare count can't answer that. See index.tsx's flush-effect
   *  reconciliation. */
  resolved: { id: string; runId: string }[];
  /** Queue ids abandoned THIS flush (a subset of `abandoned`'s count, by
   *  id rather than just a number) — same reconciliation need as
   *  `resolved`, for the give-up path instead of the success path. */
  abandonedIds: string[];
}

// Module-level, deliberately: the guard has to hold across every caller and
// every remount, not per component instance. Without it, leaving and
// re-entering the Track tab starts a SECOND flush over the same un-drained
// snapshot and uploads every run in it twice — React 19's double-invoked
// effects reproduce that in development on their own.
let flushing = false;

/**
 * Tries to upload everything queued, oldest first.
 *
 * Stops at the FIRST failure rather than continuing down the list. If one
 * upload just failed on the network, the next will too — marching through
 * twenty of them would burn battery and radio to learn the same thing twenty
 * times. The queue is preserved either way; the next flush picks it up.
 */
export async function flushQueue(upload: Uploader): Promise<FlushResult> {
  if (flushing) {
    // Already draining. Reporting the current depth is honest; starting a
    // second pass over the same entries is not.
    return {
      uploaded: 0,
      remaining: queuedCount(),
      stoppedBecause: null,
      abandoned: 0,
      resolved: [],
      abandonedIds: [],
    };
  }
  flushing = true;
  try {
    const queue = listQueued();
    if (queue.length === 0) {
      return {
        uploaded: 0,
        remaining: 0,
        stoppedBecause: null,
        abandoned: 0,
        resolved: [],
        abandonedIds: [],
      };
    }

    let uploaded = 0;
    let abandoned = 0;
    const resolved: { id: string; runId: string }[] = [];
    const abandonedIds: string[] = [];
    for (const item of queue) {
      const outcome = await upload(item.run);

      if (!outcome.ok) {
        // 'disabled' NEVER counts toward MAX_ATTEMPTS and is never
        // abandoned. MAX_ATTEMPTS exists to stop retrying a payload the
        // SERVER will never accept — 'disabled' means there is no server
        // configured on THIS build at all, which is categorically
        // different: no number of retries against a misconfigured client
        // will ever succeed, but the run becomes uploadable the instant a
        // build with real credentials loads (see check-web-env.mjs /
        // deploy.yml). Counting these attempts would delete a safely-queued
        // run before the actual fix — an env var, not a retry — ever gets a
        // chance to land. Confirmed live 2026-08-31: a run queued under a
        // misconfigured deploy sat through repeated flushes (every Track
        // tab focus) with nothing to fix it except the deploy itself.
        if (outcome.reason !== 'disabled') {
          const attempts = item.attempts + 1;
          if (attempts >= MAX_ATTEMPTS) {
            // Give up on this one so it stops blocking everything behind it.
            // Repeated failure at this point is a run the server will never
            // accept, not a network blip.
            removeQueued(item.id);
            abandoned++;
            abandonedIds.push(item.id);
            continue;
          }
          bumpAttempts(item.id, attempts);
        }
        return {
          uploaded,
          remaining: queue.length - uploaded - abandoned,
          stoppedBecause: outcome.reason,
          abandoned,
          resolved,
          abandonedIds,
        };
      }

      // Removed one at a time, re-reading the queue each write, so an app kill
      // mid-flush can at worst re-upload a run rather than lose the rest.
      //
      // The RESULT IS CHECKED. If the store refuses the write the run is
      // still on disk, and reporting a clean drain would mean re-uploading
      // it on every future launch — a duplicate row and duplicate territory
      // theft each time, with the UI showing all-clear.
      if (!removeQueued(item.id)) {
        return {
          uploaded,
          remaining: queue.length - uploaded - abandoned,
          stoppedBecause: 'storage',
          abandoned,
          resolved,
          abandonedIds,
        };
      }
      uploaded++;
      resolved.push({ id: item.id, runId: outcome.runId });
    }
    return { uploaded, remaining: 0, stoppedBecause: null, abandoned, resolved, abandonedIds };
  } finally {
    flushing = false;
  }
}

function bumpAttempts(id: string, attempts: number): void {
  writeQueue(listQueued().map((q) => (q.id === id ? { ...q, attempts } : q)));
}
