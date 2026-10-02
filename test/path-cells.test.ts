// Places I've been draws every saved run from its stored route. For a run
// that claimed, those tiles must be exactly what the claim computed.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/supabase', () => ({ supabase: {}, ensureSession: async () => null, TERRITORY_ENABLED: false }));

import { pathCellsOf } from '../src/lib/territory-sync';
import { pathToTiles } from '../src/lib/tiles';

const points = Array.from({ length: 60 }, (_, i) => ({
  lat: 25.6555 + i * 0.00012,
  lng: -100.372 + Math.sin(i / 6) * 0.0004,
  ts: 1_700_000_000_000 + i * 2000,
}));

describe('pathCellsOf', () => {
  it('matches pathToTiles on the same timed route — the claim computation', () => {
    const raw = points.map((p) => [p.lat, p.lng, p.ts]);
    expect(pathCellsOf(raw)).toEqual(pathToTiles(points).cells);
    expect(pathCellsOf(JSON.stringify(raw))).toEqual(pathToTiles(points).cells);
  });

  it('yields nothing for a route without timestamps, or junk', () => {
    expect(pathCellsOf(points.map((p) => [p.lat, p.lng]))).toEqual([]);
    expect(pathCellsOf(null)).toEqual([]);
    expect(pathCellsOf('not json')).toEqual([]);
  });
});
