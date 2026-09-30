// "Steals and conquests live" on the Leaderboard, without streaming the
// territory table.
//
// Subscribing to territory_tiles changes was the obvious route and the wrong
// one: a 10 km loop rewrites ~26,000 tiles, which would push 26,000 messages
// to every phone with Leaderboard open — the overheating this app just spent
// a pass removing. Instead the runner whose claim just succeeded sends ONE
// small broadcast naming the districts it touched, and anyone viewing an
// arena that overlaps them refetches, at most once per LIVE_MIN_INTERVAL_MS.
//
// The message carries district ids only (res-7, ~2.8 km across) and no user
// id — coarser than what territory_tiles already shows anyone. A forged
// message can only cause an extra refetch; the board's truth is still the
// database. Checked live 2026-09-30: public broadcast is enabled on this
// project and `httpSend` delivers without the sender holding a socket.
import { districtOfCell } from '@/lib/district';
import { supabase } from '@/lib/supabase';

export const TERRITORY_TOPIC = 'territory-claims';
export const CLAIMED_EVENT = 'claimed';
/** No arena refetches more often than this, however busy the city is. */
export const LIVE_MIN_INTERVAL_MS = 15_000;
/** A message never names more districts than this (a 10 km loop spans a
 *  handful); anything larger is ignored as junk. */
export const MAX_ANNOUNCED_DISTRICTS = 200;

/** Distinct districts of a claim's cells, capped. */
export function claimDistricts(cells: string[]): string[] {
  const set = new Set<string>();
  for (const cell of cells) {
    const d = districtOfCell(cell);
    if (d) set.add(d);
    if (set.size >= MAX_ANNOUNCED_DISTRICTS) break;
  }
  return [...set];
}

/** Whether a received message concerns the arena on screen. Anything that
 *  isn't a short list of strings is ignored — the payload is untrusted. */
export function touchesArena(payload: unknown, arenaDistricts: string[]): boolean {
  const districts = (payload as { districts?: unknown } | null)?.districts;
  if (!Array.isArray(districts) || districts.length > MAX_ANNOUNCED_DISTRICTS) return false;
  const mine = new Set(arenaDistricts);
  return districts.some((d) => typeof d === 'string' && mine.has(d));
}

/** Milliseconds to wait before refetching, so refetches are at least
 *  LIVE_MIN_INTERVAL_MS apart. 0 means now. */
export function refetchDelay(lastRefetchMs: number | null, now: number): number {
  if (lastRefetchMs === null) return 0;
  return Math.max(0, lastRefetchMs + LIVE_MIN_INTERVAL_MS - now);
}

/**
 * Tell anyone watching that ground changed hands. Best effort by design:
 * a lost nudge costs a viewer nothing but a few seconds, since every focus
 * and pull already refetches — so a failure here is dropped, never surfaced,
 * and never allowed to fail the run's own save.
 */
export function announceClaim(cells: string[]): void {
  // Synchronous throws too, not just a rejected promise: this runs inside
  // uploadRun after the claim succeeded, and anything escaping here would
  // discard that claim's result.
  try {
    const districts = claimDistricts(cells);
    if (districts.length === 0) return;
    void supabase
      .channel(TERRITORY_TOPIC)
      .httpSend(CLAIMED_EVENT, { districts })
      .catch(() => undefined);
  } catch {
    // Best effort — see this function's header.
  }
}

/** Listen for claims. Returns the unsubscribe. */
export function subscribeClaims(onMessage: (payload: unknown) => void): () => void {
  const channel = supabase
    .channel(TERRITORY_TOPIC)
    .on('broadcast', { event: CLAIMED_EVENT }, (msg) => onMessage(msg.payload))
    .subscribe();
  return () => {
    void supabase.removeChannel(channel);
  };
}
