// Tile claims that failed AFTER their run saved — retried until they land.
//
// A run's upload and its tile claim are two requests. Before this, a claim
// that failed once (a signal blip, a timeout) was never retried: the run sat
// in history with no territory and no Local Leaders days, and nothing told
// the runner it could still be fixed. Now the claim — tile ids and region,
// never the route — waits here and is retried on every flush, with the same
// never-abandon backoff as the upload queue (upload-queue.ts, isDue).
//
// Dropped only on the server's FINAL answer: 'tooOld' (past the claim
// window) or 'rejected' (a claim bound refused it). Retrying either would
// get the same answer forever.
import { getPref, initDb, setPref } from '@/lib/db';
import { isDue } from '@/lib/upload-queue';

const PREF_CLAIMS = 'tileClaimQueue';

export interface PendingClaim {
  runId: string;
  visited: string[];
  enclosed: string[];
  region: string | null;
  queuedAt: number;
  attempts: number;
  lastAttemptAt?: number;
}

export type ClaimRetryOutcome =
  | { ok: true }
  | { ok: false; reason: 'disabled' | 'auth' | 'network' | 'rejected' | 'tooOld' };

function isPendingClaim(value: unknown): value is PendingClaim {
  if (!value || typeof value !== 'object') return false;
  const c = value as Partial<PendingClaim>;
  return (
    typeof c.runId === 'string' &&
    Array.isArray(c.visited) &&
    Array.isArray(c.enclosed) &&
    (c.region === null || typeof c.region === 'string') &&
    typeof c.queuedAt === 'number' &&
    typeof c.attempts === 'number'
  );
}

export function listClaims(): PendingClaim[] {
  initDb();
  const raw = getPref(PREF_CLAIMS);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isPendingClaim) : [];
  } catch {
    return [];
  }
}

function writeClaims(claims: PendingClaim[]): boolean {
  initDb();
  return setPref(PREF_CLAIMS, JSON.stringify(claims));
}

/** Queue a claim for retry. One per run; a second call replaces the first. */
export function enqueueClaim(claim: {
  runId: string;
  visited: string[];
  enclosed: string[];
  region: string | null;
}): boolean {
  const rest = listClaims().filter((c) => c.runId !== claim.runId);
  return writeClaims([...rest, { ...claim, queuedAt: Date.now(), attempts: 0 }]);
}

export interface ClaimFlushResult {
  claimed: number;
  dropped: number;
  remaining: number;
}

let flushing = false;

/** Retry every due claim, fewest attempts first, stopping at the first
 *  connectivity failure (same radio rule as flushQueue). */
export async function flushClaims(
  claim: (c: PendingClaim) => Promise<ClaimRetryOutcome>,
  now: number = Date.now(),
): Promise<ClaimFlushResult> {
  if (flushing) return { claimed: 0, dropped: 0, remaining: listClaims().length };
  flushing = true;
  try {
    let claimed = 0;
    let dropped = 0;
    const queue = listClaims().sort((a, b) => a.attempts - b.attempts);
    for (const item of queue) {
      if (!isDue(item, now)) continue;
      const outcome = await claim(item);
      if (outcome.ok || outcome.reason === 'tooOld' || outcome.reason === 'rejected') {
        writeClaims(listClaims().filter((c) => c.runId !== item.runId));
        if (outcome.ok) claimed++;
        else dropped++;
        continue;
      }
      if (outcome.reason !== 'disabled') {
        writeClaims(
          listClaims().map((c) =>
            c.runId === item.runId ? { ...c, attempts: c.attempts + 1, lastAttemptAt: now } : c,
          ),
        );
      }
      break;
    }
    return { claimed, dropped, remaining: listClaims().length };
  } finally {
    flushing = false;
  }
}
