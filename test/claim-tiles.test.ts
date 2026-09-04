// claimTiles — the Tile Coverage Model's actual claim/first-to-claim/rival
// accounting (territory-sync.ts, brief §2/§2.5/§3). Same reasoning as
// territory-sync-delete.test.ts's own header: importing '@/lib/territory-sync'
// for real pulls in @supabase/supabase-js, which schedules an internal timer
// that throws under Node, so '@/lib/supabase' is mocked completely with a
// minimal chainable stand-in for the exact `.from(...).method(...).method(...)`
// shapes claimTiles calls.
//
// What this does NOT cover: the actual §2.5 forgery-guard SQL trigger, or
// the real ON CONFLICT DO NOTHING semantics — those only exist once the
// migration is applied against a real Postgres instance (this suite is
// `environment: 'node'`, no database). This only proves claimTiles'
// TypeScript-side branching (how it reacts to what Postgres WOULD return)
// is correct, not that Postgres actually returns those shapes — see the
// executor's report.
import { describe, expect, it, vi } from 'vitest';

interface Row {
  h3: string;
  [key: string]: unknown;
}

let nextVisitError: { message: string } | null = null;
let nextClaimed: { h3: string }[] | null = null;
let nextClaimError: { message: string } | null = null;
let nextExisting: { h3: string; owner_id: string }[] | null = null;

function makeFrom(table: string) {
  if (table === 'tile_visits') {
    return {
      insert: (_rows: Row[]) => Promise.resolve({ error: nextVisitError }),
    };
  }
  // territory_tiles — three independent chains, matching claimTiles' three
  // distinct call shapes exactly. Each `.upsert()`/`.update()`/`.select()`
  // call returns its OWN chain object, so the two different `.in()` calls
  // (one off `.update()`, one off `.select()`) never collide.
  return {
    upsert: (_rows: Row[], _opts: unknown) => ({
      select: (_cols: string) => Promise.resolve({ data: nextClaimed, error: nextClaimError }),
    }),
    update: (_patch: Record<string, unknown>) => ({
      in: (_col: string, _vals: string[]) => Promise.resolve({ data: [], error: null }),
    }),
    select: (_cols: string) => ({
      in: (_col: string, _vals: string[]) => Promise.resolve({ data: nextExisting, error: null }),
    }),
  };
}

vi.mock('@/lib/supabase', () => ({
  supabase: { from: (table: string) => makeFrom(table) },
  ensureSession: async () => ({ user: { id: 'me' } }),
  TERRITORY_ENABLED: true,
}));

const { claimTiles } = await import('@/lib/territory-sync');

describe('claimTiles', () => {
  it('returns an all-zero result for an empty cell list without touching the network', () => {
    // No mock state configured — if this reached the network paths at all
    // it would resolve against stale/null fixtures from a previous test and
    // likely fail, which is itself a decent tripwire.
    return claimTiles('run-1', [], 'mty').then((outcome) => {
      expect(outcome).toEqual({
        ok: true,
        result: { claimedCount: 0, rivalTiles: 0, rivalRunners: 0, rivalCells: [] },
      });
    });
  });

  it('reports every submitted cell as newly claimed when none conflict', () => {
    nextVisitError = null;
    // ON CONFLICT DO NOTHING's RETURNING only echoes back the rows that were
    // actually inserted — here, everything.
    nextClaimed = [{ h3: 'a' }, { h3: 'b' }];
    nextExisting = null; // must not even be read — notNewlyClaimed is empty
    return claimTiles('run-1', ['a', 'b'], 'mty').then((outcome) => {
      expect(outcome).toEqual({
        ok: true,
        result: { claimedCount: 2, rivalTiles: 0, rivalRunners: 0, rivalCells: [] },
      });
    });
  });

  it('splits newly-claimed from rival tiles, and counts distinct rival owners not rows', () => {
    nextVisitError = null;
    // Only 'a' won the ON CONFLICT DO NOTHING race — 'b' and 'c' already
    // belonged to someone else.
    nextClaimed = [{ h3: 'a' }];
    nextExisting = [
      { h3: 'b', owner_id: 'rival-1' },
      { h3: 'c', owner_id: 'rival-1' }, // same rival owns both — one runner, two tiles
    ];
    return claimTiles('run-1', ['a', 'b', 'c'], 'mty').then((outcome) => {
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.result.claimedCount).toBe(1);
      expect(outcome.result.rivalTiles).toBe(2);
      // Distinct owners, not rows — same "count people, not events" rule as
      // the old spoils banner's runnersAffected.
      expect(outcome.result.rivalRunners).toBe(1);
      expect(outcome.result.rivalCells.sort()).toEqual(['b', 'c']);
    });
  });

  it('never counts a tile this session already owns as a rival', () => {
    nextVisitError = null;
    nextClaimed = [{ h3: 'a' }];
    // 'b' shows up as "not newly claimed" (raced and lost) but its owner IS
    // this same session — must not inflate rivalTiles/rivalCells.
    nextExisting = [{ h3: 'b', owner_id: 'me' }];
    return claimTiles('run-1', ['a', 'b'], 'mty').then((outcome) => {
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.result.rivalTiles).toBe(0);
      expect(outcome.result.rivalCells).toEqual([]);
    });
  });

  it('reports "rejected", not "network", when the §2.5 forgery guard fires', () => {
    // The exact shape a plpgsql RAISE EXCEPTION comes back as via PostgREST
    // — an {error} with our own message text, no thrown JS exception.
    nextVisitError = {
      message: 'TILE_FORGERY_GUARD: run run-1 has 9001 distinct claimed tiles total, which exceeds the plausible bound of 30',
    };
    return claimTiles('run-1', ['a'], 'mty').then((outcome) => {
      expect(outcome).toEqual({ ok: false, reason: 'rejected' });
    });
  });

  it('reports "network" for any other tile_visits insert error', () => {
    nextVisitError = { message: 'connection refused' };
    return claimTiles('run-1', ['a'], 'mty').then((outcome) => {
      expect(outcome).toEqual({ ok: false, reason: 'network' });
    });
  });

  it('reports "network" when the territory_tiles claim itself fails', () => {
    nextVisitError = null;
    nextClaimed = null;
    nextClaimError = { message: 'boom' };
    return claimTiles('run-1', ['a'], 'mty').then((outcome) => {
      expect(outcome).toEqual({ ok: false, reason: 'network' });
      nextClaimError = null; // reset for later tests
    });
  });
});
