// uploadRun's union-enclosure owned-tiles read, PAGED — regression coverage
// for the 2026-09-20 fix (fix/union-enclosure-paging).
//
// PostgREST caps a response at 1000 rows. Before this fix, the read of the
// runner's OWNED tiles inside uploadRun (`.from('territory_tiles').select
// ('h3').eq('owner_id', ...)`, no `.range()`) silently truncated `ownedSet`
// to an arbitrary 1000-row slice for any account past that count — verified
// in production on 2026-09-20: a 6,049-tile owner's union enclosure was
// reasoning about ~17% of their real territory, and the same truncated set
// fed the CYCLE_MIN_TILES check. This file exercises the fixed paging loop
// in isolation from the real Supabase network and from the real enclosure
// geometry (enclosure.ts's `enclosedCells` is mocked to a spy — that module
// was verified separately and is out of scope here; what this file checks is
// that the FULL owned set actually reaches it and reaches the cycle-bonus
// check).
//
// Same reasoning as territory-sync-delete.test.ts's header for why this is
// its own file: importing '@/lib/territory-sync' for real pulls in
// @supabase/supabase-js, which schedules a timer that throws under Node, so
// '@/lib/supabase' is mocked completely rather than partially.
import { gridDisk } from 'h3-js';
import { describe, expect, it, vi } from 'vitest';

// A real, valid res-12 H3 index (same cell territory-sync.test.ts's own
// `groupVisitsByRun` suite uses) as the center of a big disk of real,
// distinct H3 indexes. Slicing disjoint ranges out of ONE such array (rather
// than hand-writing thousands of fake strings) guarantees every cell used
// below is both valid — isCurrentTileRes calls h3-js's getResolution, which
// rejects a made-up literal — and unique, with no accidental overlap between
// "path" and "owned" slices unless a test deliberately arranges one.
const CENTER = '8c48a2062d835ff';
// 3k(k+1)+1 cells for gridDisk(_, k); k=34 → 3571, comfortably past the
// ~3050 distinct cells the largest test below needs.
const POOL = gridDisk(CENTER, 34);

type Page = { h3: string }[];

interface MockConfig {
  /** Pages returned in order for the owned-tiles paging loop. A call past
   *  the configured pages returns an empty page (so a bug that pages too far
   *  fails the test's call-count assertion instead of hanging). */
  ownedPages: Page[];
  /** If set, the paging loop's call at this 0-based index (into `range`
   *  calls) returns this error instead of the configured page. */
  errorAtCall?: number;
  pathCells: string[];
  claimedResult?: { claimed: number; taken: number; skipped_older: number; taken_cells: string[] };
}

function makeSupabaseMock(cfg: MockConfig) {
  let rangeCallCount = 0;
  const rangeSpy = vi.fn(() => {
    const i = rangeCallCount++;
    if (cfg.errorAtCall === i) {
      return Promise.resolve({ data: null, error: { message: 'boom' } });
    }
    const page = cfg.ownedPages[i] ?? [];
    return Promise.resolve({ data: page, error: null });
  });

  const territoryTilesChain: Record<string, unknown> = {
    select: () => territoryTilesChain,
    eq: () => territoryTilesChain,
    order: () => territoryTilesChain,
    range: rangeSpy,
  };

  const from = vi.fn((table: string) => {
    if (table === 'profiles') {
      return { upsert: () => Promise.resolve({ error: null }) };
    }
    if (table === 'runs') {
      const chain: Record<string, unknown> = {
        insert: () => chain,
        select: () => chain,
        single: () => Promise.resolve({ data: { id: 'run-1' }, error: null }),
      };
      return chain;
    }
    if (table === 'territory_tiles') {
      return territoryTilesChain;
    }
    throw new Error(`unexpected table in test: ${table}`);
  });

  const rpc = vi.fn(() =>
    Promise.resolve({
      data: [cfg.claimedResult ?? { claimed: 1, taken: 0, skipped_older: 0, taken_cells: [] }],
      error: null,
    }),
  );

  return { supabase: { from, rpc }, rangeSpy, rpc };
}

function makeRun(overrides: { pathCells: string[]; enclosedCells?: string[] }) {
  return {
    points: [{ lat: 25.67, lng: -100.31, ts: 1000 }],
    fence: {
      geometry: {
        type: 'Feature' as const,
        properties: {},
        geometry: { type: 'Polygon' as const, coordinates: [[[0, 0], [0, 1], [1, 1], [0, 0]]] },
      },
      areaM2: 100,
    },
    distanceM: 500,
    startedAt: 1000,
    endedAt: 2000,
    enclosedCells: overrides.enclosedCells ?? [],
  };
}

describe('uploadRun — owned-tiles paging (union enclosure)', () => {
  it('fetches ALL owned tiles across more than 1000 rows (1000, 1000, 49 -> 2049)', async () => {
    const pathCells = POOL.slice(0, 5);
    const owned = [POOL.slice(1000, 2000), POOL.slice(2000, 3000), POOL.slice(3000, 3049)];
    expect(owned[0]).toHaveLength(1000);
    expect(owned[1]).toHaveLength(1000);
    expect(owned[2]).toHaveLength(49);

    const enclosedSpy = vi.fn((_cells: string[], _res: number): string[] => []);
    vi.resetModules();
    const mock = makeSupabaseMock({
      ownedPages: owned.map((cells) => cells.map((h3) => ({ h3 }))),
      pathCells,
    });
    vi.doMock('@/lib/supabase', () => ({
      supabase: mock.supabase,
      ensureSession: async () => ({ user: { id: 'user-1' } }),
      TERRITORY_ENABLED: true,
    }));
    vi.doMock('@/lib/tiles', async () => {
      const actual = await vi.importActual<typeof import('@/lib/tiles')>('@/lib/tiles');
      return { ...actual, pathToTiles: () => ({ cells: pathCells, directCount: pathCells.length, gapFilledCount: 0 }) };
    });
    vi.doMock('@/lib/enclosure', () => ({ enclosedCells: enclosedSpy }));

    const { uploadRun } = await import('@/lib/territory-sync');
    const outcome = await uploadRun(makeRun({ pathCells }) as never);

    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.unionEnclosureReason).toBeUndefined();
    // Every configured page was consumed (2049 owned rows), plus the
    // terminal request that returns short/empty to end the loop.
    expect(mock.rangeSpy).toHaveBeenCalledTimes(3);
    // The union handed to enclosedCells must contain every owned tile, not
    // just the first page — 5 disjoint path cells + 2049 disjoint owned.
    expect(enclosedSpy).toHaveBeenCalledTimes(1);
    const unionArg = enclosedSpy.mock.calls[0][0] as string[];
    expect(new Set(unionArg).size).toBe(5 + 2049);
  });

  it('terminates after a page of exactly 1000 followed by an empty page (no infinite loop)', async () => {
    const pathCells = POOL.slice(0, 5);
    const owned = POOL.slice(1000, 2000);
    expect(owned).toHaveLength(1000);

    const enclosedSpy = vi.fn((_cells: string[], _res: number): string[] => []);
    vi.resetModules();
    const mock = makeSupabaseMock({
      ownedPages: [owned.map((h3) => ({ h3 }))],
      pathCells,
    });
    vi.doMock('@/lib/supabase', () => ({
      supabase: mock.supabase,
      ensureSession: async () => ({ user: { id: 'user-1' } }),
      TERRITORY_ENABLED: true,
    }));
    vi.doMock('@/lib/tiles', async () => {
      const actual = await vi.importActual<typeof import('@/lib/tiles')>('@/lib/tiles');
      return { ...actual, pathToTiles: () => ({ cells: pathCells, directCount: pathCells.length, gapFilledCount: 0 }) };
    });
    vi.doMock('@/lib/enclosure', () => ({ enclosedCells: enclosedSpy }));

    const { uploadRun } = await import('@/lib/territory-sync');
    const outcome = await uploadRun(makeRun({ pathCells }) as never);

    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.unionEnclosureReason).toBeUndefined();
    // One page of 1000 (ambiguous — could be exactly 1000 or the start of
    // more) plus exactly one more request that comes back empty. Not fewer
    // (would mean it stopped without checking) and not more (would mean it
    // never terminates on an empty page).
    expect(mock.rangeSpy).toHaveBeenCalledTimes(2);
    const unionArg = enclosedSpy.mock.calls[0][0] as string[];
    expect(new Set(unionArg).size).toBe(5 + 1000);
  });

  it('terminates after one request when fewer than 1000 owned tiles exist', async () => {
    const pathCells = POOL.slice(0, 5);
    const owned = POOL.slice(1000, 1049);
    expect(owned).toHaveLength(49);

    const enclosedSpy = vi.fn((_cells: string[], _res: number): string[] => []);
    vi.resetModules();
    const mock = makeSupabaseMock({
      ownedPages: [owned.map((h3) => ({ h3 }))],
      pathCells,
    });
    vi.doMock('@/lib/supabase', () => ({
      supabase: mock.supabase,
      ensureSession: async () => ({ user: { id: 'user-1' } }),
      TERRITORY_ENABLED: true,
    }));
    vi.doMock('@/lib/tiles', async () => {
      const actual = await vi.importActual<typeof import('@/lib/tiles')>('@/lib/tiles');
      return { ...actual, pathToTiles: () => ({ cells: pathCells, directCount: pathCells.length, gapFilledCount: 0 }) };
    });
    vi.doMock('@/lib/enclosure', () => ({ enclosedCells: enclosedSpy }));

    const { uploadRun } = await import('@/lib/territory-sync');
    const outcome = await uploadRun(makeRun({ pathCells }) as never);

    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.unionEnclosureReason).toBeUndefined();
    expect(mock.rangeSpy).toHaveBeenCalledTimes(1);
    const unionArg = enclosedSpy.mock.calls[0][0] as string[];
    expect(new Set(unionArg).size).toBe(5 + 49);
  });

  it('degrades to per-run enclosure and SURFACES the failure when a page errors mid-paging', async () => {
    const pathCells = POOL.slice(0, 5);
    const owned = POOL.slice(1000, 2000);
    expect(owned).toHaveLength(1000);
    const priorEnclosed = ['prior-enclosed-cell'];

    const enclosedSpy = vi.fn((_cells: string[], _res: number): string[] => []);
    vi.resetModules();
    const mock = makeSupabaseMock({
      ownedPages: [owned.map((h3) => ({ h3 }))],
      errorAtCall: 1, // first page succeeds (1000, forcing a 2nd request), 2nd errors
      pathCells,
    });
    vi.doMock('@/lib/supabase', () => ({
      supabase: mock.supabase,
      ensureSession: async () => ({ user: { id: 'user-1' } }),
      TERRITORY_ENABLED: true,
    }));
    vi.doMock('@/lib/tiles', async () => {
      const actual = await vi.importActual<typeof import('@/lib/tiles')>('@/lib/tiles');
      return { ...actual, pathToTiles: () => ({ cells: pathCells, directCount: pathCells.length, gapFilledCount: 0 }) };
    });
    vi.doMock('@/lib/enclosure', () => ({ enclosedCells: enclosedSpy }));

    const { uploadRun } = await import('@/lib/territory-sync');
    const outcome = await uploadRun(makeRun({ pathCells, enclosedCells: priorEnclosed }) as never);

    // The run itself still saves and still claims tiles — this is a
    // non-fatal degrade, not a failed upload.
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    // The failure must be OBSERVABLE, not swallowed: distinct from the
    // success case above, which leaves this undefined.
    expect(outcome.unionEnclosureReason).toBe('network');
    // Never computed against the partial 1000-row page that DID arrive —
    // enclosedCells must not have been called at all.
    expect(enclosedSpy).not.toHaveBeenCalled();
    // Falls all the way back to the caller's own per-run enclosure: the RPC
    // must still see the run's own enclosedCells, not an empty array.
    expect(mock.rpc).toHaveBeenCalledWith(
      'claim_run_tiles',
      expect.objectContaining({ p_enclosed: priorEnclosed }),
    );
  });

  it('evaluates the CYCLE_MIN_TILES threshold against the FULL owned set, not a truncated one', async () => {
    // 60 path cells the runner already owns — CYCLE_MIN_TILES is 50, so this
    // must trigger the bonus, but ONLY if paging actually reaches them: they
    // live entirely in the SECOND page, past where a truncated (1-page,
    // 1000-row) read would have stopped.
    const pathCells = POOL.slice(0, 60);
    const fillerOwned = POOL.slice(1000, 2000); // 1000 cells, disjoint from pathCells
    expect(fillerOwned).toHaveLength(1000);

    const enclosedSpy = vi.fn((_cells: string[], _res: number): string[] => []);
    vi.resetModules();
    const mock = makeSupabaseMock({
      ownedPages: [fillerOwned.map((h3) => ({ h3 })), pathCells.map((h3) => ({ h3 }))],
      pathCells,
      claimedResult: { claimed: 60, taken: 0, skipped_older: 0, taken_cells: [] },
    });
    vi.doMock('@/lib/supabase', () => ({
      supabase: mock.supabase,
      ensureSession: async () => ({ user: { id: 'user-1' } }),
      TERRITORY_ENABLED: true,
    }));
    vi.doMock('@/lib/tiles', async () => {
      const actual = await vi.importActual<typeof import('@/lib/tiles')>('@/lib/tiles');
      return { ...actual, pathToTiles: () => ({ cells: pathCells, directCount: pathCells.length, gapFilledCount: 0 }) };
    });
    vi.doMock('@/lib/enclosure', () => ({ enclosedCells: enclosedSpy }));

    const { uploadRun } = await import('@/lib/territory-sync');
    const outcome = await uploadRun(makeRun({ pathCells }) as never);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    expect(outcome.unionEnclosureReason).toBeUndefined();
    expect(mock.rangeSpy).toHaveBeenCalledTimes(2);
    expect(outcome.tiles?.cycleBonus).toBeDefined();
    expect(outcome.tiles?.cycleBonus?.pts).toBe(10);
  });
});
