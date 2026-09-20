// buildMergedTerritories / buildMergedRimLines — the ONE shared copy of the
// merged-territory dissolve that used to be hand-written twice (once per
// platform, in territories-map.web.tsx and territories-map.tsx). Neither
// copy was ever reachable by a test before this extraction: both lived
// inside a .tsx component file, and vitest.config.ts is `environment: 'node'`
// with no React renderer. See src/lib/merged-territory.ts's own header for
// the full story, including commit 40fa9ce ("fix: implement territory merge
// on native (was web-only)") — the exact kind of drift this module exists to
// make impossible.
//
// Cell fixtures are real H3 res-12 cells (DEFAULT_TILE_RES, tiles.ts) around
// a Monterrey coordinate, generated with h3-js's own latLngToCell/gridDisk —
// never hand-written H3 id strings, so a fixture can never accidentally
// encode an assumption about H3's internals that isn't actually true.
import { gridDisk, gridDistance, latLngToCell } from 'h3-js';
import { describe, expect, it } from 'vitest';

import {
  buildMergedRimLines,
  buildMergedTerritories,
  type MergeableFeature,
  type MergedTerritory,
} from '@/lib/merged-territory';

const FALLBACK_COLOR = '#8E8E93';

// A real Monterrey fix, same city this app's other H3 fixtures use.
const CENTER = latLngToCell(25.6714, -100.369, 12);
// gridDisk(CENTER, 1) is [CENTER, ...its 6 immediate neighbours] for a
// non-pentagon cell (true for ordinary Monterrey ground) — index 1 is
// therefore guaranteed grid-adjacent to CENTER.
const NEIGHBOR = gridDisk(CENTER, 1)[1];
// A cell several rings out — gridDistance asserts it below so this test's
// own precondition ("these two are NOT adjacent") is checked, not assumed.
const FAR_CELL = gridDisk(CENTER, 6)[gridDisk(CENTER, 6).length - 1];

function feature(overrides: Partial<MergeableFeature>): MergeableFeature {
  return {
    id: 'run-a',
    kind: 'saved',
    cells: [],
    startedAtMs: 0,
    ...overrides,
  };
}

describe('buildMergedTerritories', () => {
  it('sanity-checks its own fixtures: NEIGHBOR is adjacent to CENTER, FAR_CELL is not', () => {
    expect(gridDistance(CENTER, NEIGHBOR)).toBe(1);
    expect(gridDistance(CENTER, FAR_CELL)).toBeGreaterThan(1);
  });

  it('dissolves two runs on adjacent cells into ONE cluster', () => {
    const colorMap = new Map([
      ['run-a', '#ff0000'],
      ['run-b', '#00ff00'],
    ]);
    const features = [
      feature({ id: 'run-a', cells: [CENTER], startedAtMs: 1000 }),
      feature({ id: 'run-b', cells: [NEIGHBOR], startedAtMs: 2000 }),
    ];
    const result = buildMergedTerritories(features, colorMap, FALLBACK_COLOR);
    expect(result).toHaveLength(1);
    // The more recent run (run-b, startedAtMs 2000) owns the merged cluster's
    // colour + id — see the "last-write-wins" test below for the same rule
    // applied to a single shared cell rather than two adjacent ones.
    expect(result[0].id).toBe('run-b');
    expect(result[0].color).toBe('#00ff00');
  });

  it('keeps two runs on non-adjacent cells as TWO clusters with their own colours', () => {
    const colorMap = new Map([
      ['run-a', '#ff0000'],
      ['run-b', '#00ff00'],
    ]);
    const features = [
      feature({ id: 'run-a', cells: [CENTER], startedAtMs: 1000 }),
      feature({ id: 'run-b', cells: [FAR_CELL], startedAtMs: 2000 }),
    ];
    const result = buildMergedTerritories(features, colorMap, FALLBACK_COLOR);
    expect(result).toHaveLength(2);
    const byId = new Map(result.map((t) => [t.id, t]));
    expect(byId.get('run-a')?.color).toBe('#ff0000');
    expect(byId.get('run-b')?.color).toBe('#00ff00');
  });

  it('gives a cell claimed by two runs to the MORE RECENT run (last-write-wins on startedAtMs)', () => {
    const colorMap = new Map([
      ['run-old', '#ff0000'],
      ['run-new', '#00ff00'],
    ]);
    // Both runs claim the exact same single cell — order in `features`
    // deliberately puts the more-recent run FIRST, so a pass would prove the
    // result follows startedAtMs and not array order.
    const features = [
      feature({ id: 'run-new', cells: [CENTER], startedAtMs: 5000 }),
      feature({ id: 'run-old', cells: [CENTER], startedAtMs: 1000 }),
    ];
    const result = buildMergedTerritories(features, colorMap, FALLBACK_COLOR);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('run-new');
    expect(result[0].color).toBe('#00ff00');
  });

  it('excludes kind: "pending" features and features with zero cells', () => {
    const colorMap = new Map([
      ['run-a', '#ff0000'],
      ['run-pending', '#0000ff'],
      ['run-empty', '#ffff00'],
    ]);
    const features = [
      feature({ id: 'run-a', cells: [CENTER], startedAtMs: 1000 }),
      feature({ id: 'run-pending', kind: 'pending', cells: [NEIGHBOR], startedAtMs: 2000 }),
      feature({ id: 'run-empty', cells: [], startedAtMs: 3000 }),
    ];
    const result = buildMergedTerritories(features, colorMap, FALLBACK_COLOR);
    // Only run-a's cell (CENTER) should have contributed. If the pending or
    // empty features leaked in, CENTER and NEIGHBOR are adjacent so this
    // would still merge into one cluster — but it would carry run-pending's
    // colour/id (later startedAtMs), which the assertions below catch.
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('run-a');
    expect(result[0].color).toBe('#ff0000');
  });

  it('returns an empty array for empty input', () => {
    expect(buildMergedTerritories([], new Map(), FALLBACK_COLOR)).toEqual([]);
  });

  it('returns an empty array when every feature is pending or empty', () => {
    const features = [
      feature({ id: 'run-pending', kind: 'pending', cells: [CENTER], startedAtMs: 1000 }),
      feature({ id: 'run-empty', cells: [], startedAtMs: 2000 }),
    ];
    expect(buildMergedTerritories(features, new Map(), FALLBACK_COLOR)).toEqual([]);
  });

  it('falls back to fallbackColor when a run has no entry in colorMap', () => {
    const result = buildMergedTerritories(
      [feature({ id: 'run-a', cells: [CENTER], startedAtMs: 1000 })],
      new Map(), // deliberately missing 'run-a'
      FALLBACK_COLOR,
    );
    expect(result).toHaveLength(1);
    expect(result[0].color).toBe(FALLBACK_COLOR);
  });
});

describe('buildMergedRimLines', () => {
  // Synthetic (non-H3) coordinates here are deliberate, not a shortcut around
  // the "use real H3 cells" rule above: this function operates on already-
  // built MultiPolygon ring coordinates (plain [lng, lat] vertex arrays), not
  // on H3 cell ids, so there is nothing H3-specific to fake by hand-writing a
  // small square. What's under test is purely "outer ring in, outer ring
  // out; hole rings discarded" — a real cellsToMultiPolygon output exercises
  // the exact same code path with messier numbers.
  const outerRing = [
    [-100.37, 25.671],
    [-100.369, 25.671],
    [-100.369, 25.672],
    [-100.37, 25.672],
    [-100.37, 25.671],
  ];
  const holeRing = [
    [-100.3696, 25.6712],
    [-100.3694, 25.6712],
    [-100.3694, 25.6714],
    [-100.3696, 25.6714],
    [-100.3696, 25.6712],
  ];

  it('returns only the outer ring for a polygon with no hole', () => {
    const territories: MergedTerritory[] = [
      { id: 'run-a', color: '#ff0000', coordinates: [[outerRing]] },
    ];
    const lines = buildMergedRimLines(territories);
    expect(lines).toHaveLength(1);
    expect(lines[0].coordinates).toEqual(outerRing);
  });

  // Documents CURRENT behaviour exactly, per the trifecta brief for this
  // extraction ("2. Extract the merged-territory geometry"): a shape WITH a
  // hole yields NO separate rim line for that hole's own boundary — only
  // polygon[0] (the outer ring) is ever emitted. Whether a hole (e.g. a
  // donut-shaped claimed area with an unclaimed pocket in the middle) should
  // ALSO get rimmed is an open product decision the user has not made. Do
  // not change this without that decision — see merged-territory.ts's doc
  // comment on buildMergedRimLines.
  it('yields no ring for a hole — only the outer ring, per the open product decision', () => {
    const territories: MergedTerritory[] = [
      { id: 'run-a', color: '#ff0000', coordinates: [[outerRing, holeRing]] },
    ];
    const lines = buildMergedRimLines(territories);
    expect(lines).toHaveLength(1);
    expect(lines[0].coordinates).toEqual(outerRing);
    // The hole ring's own coordinates never appear anywhere in the output.
    expect(lines.some((l) => l.coordinates === holeRing)).toBe(false);
  });

  it('emits one line per polygon across multiple territories, regardless of hole count', () => {
    const territories: MergedTerritory[] = [
      { id: 'run-a', color: '#ff0000', coordinates: [[outerRing, holeRing]] },
      { id: 'run-b', color: '#00ff00', coordinates: [[outerRing]] },
    ];
    expect(buildMergedRimLines(territories)).toHaveLength(2);
  });

  it('returns an empty array for empty input', () => {
    expect(buildMergedRimLines([])).toEqual([]);
  });
});
