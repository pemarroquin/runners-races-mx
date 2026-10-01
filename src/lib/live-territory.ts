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

// ONE shared subscription for the app, with listeners attached to it.
// supabase.channel(topic) hands back any existing channel with that topic,
// and removeChannel is async — so subscribing afresh per screen let a quick
// tab switch reuse a channel that was mid-teardown, and live updates then
// stopped with no error. Now the channel is created once, torn down when
// the last listener leaves, and a new listener waits out any teardown first.
type RealtimeChannel = ReturnType<typeof supabase.channel>;
const listeners = new Set<(payload: unknown) => void>();
let live: RealtimeChannel | null = null;
let removing: Promise<void> | null = null;

async function ensureChannel(): Promise<void> {
  if (removing) await removing;
  if (live || listeners.size === 0) return;
  live = supabase
    .channel(TERRITORY_TOPIC)
    .on('broadcast', { event: CLAIMED_EVENT }, (msg) => {
      for (const listener of listeners) listener(msg.payload);
    })
    .subscribe();
}

function teardownChannel(): void {
  const channel = live;
  if (!channel) return;
  live = null;
  removing = supabase
    .removeChannel(channel)
    .then(() => undefined, () => undefined)
    .finally(() => {
      removing = null;
      // Someone subscribed while this was closing.
      if (listeners.size > 0) void ensureChannel();
    });
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
    // Our own subscribed channel when one exists; otherwise a throwaway one,
    // removed after sending so it doesn't sit registered on the client and
    // get handed back to the next subscriber unsubscribed.
    const channel = live ?? supabase.channel(TERRITORY_TOPIC);
    const throwaway = channel !== live;
    void channel
      .httpSend(CLAIMED_EVENT, { districts })
      .catch(() => undefined)
      .finally(() => {
        if (throwaway && channel !== live) void supabase.removeChannel(channel).catch(() => undefined);
      });
  } catch {
    // Best effort — see this function's header.
  }
}

/** Listen for claims. Returns the unsubscribe. */
export function subscribeClaims(onMessage: (payload: unknown) => void): () => void {
  listeners.add(onMessage);
  void ensureChannel();
  return () => {
    listeners.delete(onMessage);
    if (listeners.size === 0) teardownChannel();
  };
}
