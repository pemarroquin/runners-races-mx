// uploadRun writes the gap counters onto the runs row, and still saves the
// run if the insert with them is refused (migration not applied yet).
// Own file for the same reason as territory-sync-upload.test.ts: the real
// '@/lib/supabase' must be mocked completely.
import { describe, expect, it, vi } from 'vitest';

function makeMock(failFirstInsert: boolean) {
  const inserts: Record<string, unknown>[] = [];
  const from = vi.fn((table: string) => {
    if (table === 'profiles') return { upsert: () => Promise.resolve({ error: null }) };
    if (table === 'runs') {
      let result = { data: { id: 'run-1' } as unknown, error: null as unknown };
      const chain: Record<string, unknown> = {
        insert: (row: Record<string, unknown>) => {
          inserts.push(row);
          result =
            failFirstInsert && inserts.length === 1
              ? { data: null, error: { message: 'column "gap_count" does not exist' } }
              : { data: { id: 'run-1' }, error: null };
          return chain;
        },
        select: () => chain,
        single: () => Promise.resolve(result),
      };
      return chain;
    }
    throw new Error(`unexpected table: ${table}`);
  });
  return { supabase: { from, rpc: vi.fn() }, inserts };
}

const run = {
  points: [{ lat: 25.67, lng: -100.31, ts: 1000 }],
  fence: {
    geometry: {
      type: 'Feature' as const,
      properties: {},
      geometry: { type: 'Polygon' as const, coordinates: [[[0, 0], [0, 1], [1, 1], [0, 0]]] },
    },
    areaM2: 100,
  },
  // Under 300 m: saves the row and stops before any claim.
  distanceM: 200,
  startedAt: 1000,
  endedAt: 2000,
  gaps: { count: 2, durationMs: 45_500.4, chordM: 120.6, creditedM: 80.2 },
};

async function load(failFirstInsert: boolean) {
  vi.resetModules();
  const mock = makeMock(failFirstInsert);
  vi.doMock('@/lib/supabase', () => ({
    supabase: mock.supabase,
    ensureSession: async () => ({ user: { id: 'user-1' } }),
    TERRITORY_ENABLED: true,
  }));
  vi.doMock('@/lib/tiles', async () => {
    const actual = await vi.importActual<typeof import('@/lib/tiles')>('@/lib/tiles');
    return {
      ...actual,
      pathToTiles: () => ({ cells: [], bridgesSkippedDistance: 1, bridgesSkippedSpeed: 0 }),
    };
  });
  const { uploadRun } = await import('@/lib/territory-sync');
  return { uploadRun, mock };
}

describe('uploadRun — gap counters', () => {
  it('writes the recorder and tile-builder counters onto the run row', async () => {
    const { uploadRun, mock } = await load(false);
    const outcome = await uploadRun(run as never);
    expect(outcome.ok).toBe(true);
    expect(mock.inserts).toHaveLength(1);
    expect(mock.inserts[0]).toMatchObject({
      gap_count: 2,
      gap_duration_ms: 45_500,
      gap_chord_m: 121,
      credited_gap_m: 80,
      bridges_skipped_distance: 1,
      bridges_skipped_speed: 0,
    });
  });

  it('retries without the counters when the insert with them is refused', async () => {
    const { uploadRun, mock } = await load(true);
    const outcome = await uploadRun(run as never);
    expect(outcome.ok).toBe(true);
    expect(mock.inserts).toHaveLength(2);
    expect(mock.inserts[1]).not.toHaveProperty('gap_count');
  });

  it('sends no counter columns for a queued entry from an older build', async () => {
    const { uploadRun, mock } = await load(false);
    const { gaps: _omit, ...old } = run;
    await uploadRun(old as never);
    expect(mock.inserts[0]).not.toHaveProperty('gap_count');
    expect(mock.inserts[0]).not.toHaveProperty('bridges_skipped_distance');
  });
});
