// Path → H3 tiles — the core of Territory Mode's coverage model (claim the
// ground you ran OVER, not the area you ran around). Pure functions, no
// React, no network: same testing philosophy as territory.ts (the enclosure
// model this replaces — see that file's own header and the Tile Coverage
// Model brief §4 for what survives/dies).
//
// h3-js v4 API (verified against the installed package, not assumed from
// memory — v3 used different names: geoToH3, h3Line): latLngToCell,
// gridPathCells, cellToBoundary, cellToParent.
import { cellArea, cellToLatLng, getResolution, gridDisk, gridPathCells, latLngToCell, UNITS } from 'h3-js';

import { planGapClosures } from '@/lib/gap-policy';
import type { LatLng } from '@/lib/territory';

/**
 * H3 resolution for claimed tiles: ~10.8 m edge, ~307 m² per tile.
 *
 * Raised from 11 (~28.7 m edge, ~2,150 m²) on 2026-09-07, the owner's
 * explicit call after being shown this exact trade. He asked for tiles
 * "15x smaller"; H3 resolutions step by a FIXED factor of 7 in area, so 15x
 * does not exist — res 12 is 7.0x smaller and res 13 is 49x. Verified
 * against the installed package (getHexagonAreaAvg), not from memory.
 *
 * This reverses what this comment used to say — that res 12 "is below the
 * noise floor" — so the reasoning stays recorded rather than looking like
 * an oversight to be "corrected" back:
 *
 *  - The concern is real and was not disproven. Consumer GPS is accurate to
 *    ~5-10 m, which at a 10.8 m edge is a large fraction of a tile. Expect
 *    the same street run twice to claim somewhat different tiles, and
 *    expect a stationary runner to claim a small spread rather than one
 *    cell. Finer tiles buy resolution, NOT accuracy.
 *  - It was accepted anyway for the denominator: coverage is headed for
 *    "% of a municipio" (see the backlog's NEXT), and at res 11 a 400-tile
 *    run reads as 0.27% of Monterrey — a number too coarse to move.
 *  - Cost: ~7x more rows per run upload and ~7x more polygons drawn.
 *
 * res 10 (75.9 m edge) remains far too coarse — whole blocks in one tile.
 * See the brief §1 for the original framing.
 */
export const DEFAULT_TILE_RES = 12;

/**
 * Whether a stored cell belongs to the resolution the app currently claims
 * at.
 *
 * Needed because the two can coexist. Resolution changed from 11 to 12 on
 * 2026-09-07, and the conversion of already-stored tiles is a migration
 * applied BY HAND (nothing in this repo runs them — see CLAUDE.md), so
 * there is a real window where the deployed app claims res-12 cells while
 * res-11 rows are still in the table. Counting both would silently inflate
 * every total — the tile is the unit of the score, and a res-11 cell is 7
 * of them. An unapplied migration must read as "your old tiles aren't
 * converted yet", never as "you own 8x more ground than you do".
 */
export function isCurrentTileRes(h3: string, res: number = DEFAULT_TILE_RES): boolean {
  return getResolution(h3) === res;
}

// tileResLikePattern lived here and is DELETED, not deprecated — it was the
// same filter as a SQL LIKE pattern, for a server-side COUNT query that
// never saw the cell strings. Its only caller, territory-sync.ts's
// fetchMyTileTotal, is gone too (see that file's header). The invariant it
// depended on — an H3 index's SECOND character is its resolution nibble
// (res 10 "8a…", 11 "8b…", 12 "8c…", 13 "8d…") — is still asserted in
// tiles.test.ts against h3-js for every resolution 0-15, since districtOfCell
// and isCurrentTileRes both still rely on it.

export interface TilePoint extends LatLng {
  /** Epoch ms — the GPS fix's own timestamp. Required, not optional: without
   *  it there is no way to tell "a plausible running gap" apart from "a
   *  background-gap jump that must NOT be bridged" — exactly the bug
   *  MAX_BRIDGE_SPEED_MS exists to catch. TrackPoint (tracking.ts) always
   *  carries this. */
  ts: number;
}

// MAX_BRIDGE_SPEED_MS / MAX_BRIDGE_DISTANCE_M used to be defined here alone.
// They now live in src/lib/gap-policy.ts, shared with tracking.ts's distance
// credit — see that module's header for why (the 2026-09-02 geometry audit
// caught the recorder and the tile builder disagreeing about the same real
// gap). Re-exported so every existing import of these two names from this
// module keeps working unchanged.
export { MAX_BRIDGE_DISTANCE_M, MAX_BRIDGE_SPEED_MS } from '@/lib/gap-policy';

export interface PathToTilesResult {
  /** Every unique H3 cell the path covers — direct fixes plus gap-fill,
   *  deduplicated. This is what gets claimed. */
  cells: string[];
  /** Cells a GPS fix landed in directly (latLngToCell on an actual recorded
   *  point). A cell reached BOTH directly and via gap-fill counts here, not
   *  in gapFilledCount — it needed no bridging regardless of what else
   *  revisited it. */
  directCount: number;
  /** Cells that exist ONLY because gridPathCells bridged a gap between two
   *  consecutive fixes — no recorded point landed in them directly. High
   *  relative to directCount means the fill is load-bearing (the fix
   *  cadence really does leave holes without it); near zero means it's
   *  mostly cosmetic for this path. */
  gapFilledCount: number;
  /** Times gridPathCells THREW trying to bridge a gap and this function
   *  fell back to the two endpoints instead — an unrecorded hole in the
   *  trail. Counted, not silently swallowed, for the same reason the
   *  skipped-bridge counters are: "the fill failed and left a hole" must
   *  never be indistinguishable from "there was nothing to fill". */
  bridgeFailures: number;
  /**
   * Gaps deliberately left UNFILLED because bridging them would imply a
   * speed above MAX_BRIDGE_SPEED_MS — "this was not physically possible for
   * a runner" (a car, a spoofed fix, a teleport). See MAX_BRIDGE_SPEED_MS's
   * own doc for the history: an earlier version bridged EVERY gap
   * regardless of implied speed, which is the enclosure model's auto-close
   * bug wearing different clothes.
   *
   * Kept separate from bridgesSkippedDistance on purpose (b8's review,
   * 2026-09-01): "we could not bridge", "we chose not to because it was
   * impossible", and "we chose not to because we don't know the path taken"
   * are three different facts, and only reporting one combined number would
   * make it impossible to tell which reason actually fired on a real run.
   */
  bridgesSkippedSpeed: number;
  /**
   * Gaps deliberately left UNFILLED because they exceed MAX_BRIDGE_DISTANCE_M
   * — "this was physically possible, but we don't know which streets they
   * actually ran, so we won't guess with a straight line." This is the more
   * common real trigger: a runner locking their phone mid-run.
   * tracking.ts's visibilitychange handler clears `lastRef` on reconnect (a
   * leg break, protecting distanceM and the drawn route line), but this
   * function reads the raw, still-continuous `points` array and never sees
   * that seam — the distance check is what catches it here instead. Expect
   * this to roughly track tracking.ts's own `gapCount` (Task B) on a real
   * run; if the two ever disagree once real data exists, treat that as a
   * bug in one of them, not two independent facts.
   */
  bridgesSkippedDistance: number;
}

/**
 * Converts a recorded GPS path into the set of H3 cells it covers.
 *
 * Does NOT just map each fix to a cell — at the tracker's 2s/3m throttle,
 * consecutive fixes can be 30-50m apart, several times one res-12 tile's
 * ~10.8m edge, so a naive per-fix conversion leaves holes in the trail. Looks
 * almost right, which is the worst kind of wrong (brief §3). Consecutive
 * DISTINCT cells are bridged with H3's own gridPathCells so the covered
 * area is contiguous, the way the runner's actual path was — UNLESS the
 * implied speed across the gap is superhuman (MAX_BRIDGE_SPEED_MS), in
 * which case the gap is left unfilled rather than claiming ground the
 * runner never touched.
 *
 * Returns cells: [] for an empty path. A single-point (or entirely
 * stationary) path returns exactly the one cell it sits in — there is
 * nothing to bridge.
 */
export function pathToTiles(path: TilePoint[], res: number = DEFAULT_TILE_RES): PathToTilesResult {
  const direct = new Set<string>();
  const gapFilled = new Set<string>();
  let bridgeFailures = 0;
  let bridgesSkippedSpeed = 0;
  let bridgesSkippedDistance = 0;
  let prevCell: string | null = null;
  let prevIdx: number | null = null;

  // ONE decision about which gaps close, shared with the map components'
  // splitLegs — see planGapClosures. Before this each side applied the caps
  // itself, which is how the recorder and the tile builder came to disagree
  // about the same physical gap on a real run.
  const plan = planGapClosures(path);
  bridgesSkippedSpeed = plan.skippedSpeed;
  bridgesSkippedDistance = plan.skippedBudget;

  for (let i = 0; i < path.length; i++) {
    const p = path[i];
    let cell: string;
    try {
      cell = latLngToCell(p.lat, p.lng, res);
    } catch {
      // A single malformed fix (NaN/out-of-range lat/lng from a bad GPS
      // read) used to throw out of the whole function, and since this walks
      // the FULL path on every throttle tick — not just new points — that
      // one bad fix broke every call for the rest of the run: the live
      // wall/tile fill silently never appeared, while the finished-run
      // summary was fine because it computes off maskPath's cleaned path,
      // not this raw one. Skip just this point and keep going.
      continue;
    }
    direct.add(cell);

    // plan.bridged[i] describes ONE specific segment, path[i-1] -> path[i]
    // (see planGapClosures). It only applies here when path[i-1] is the
    // point we actually bridge FROM — i.e. nothing between prevIdx and i was
    // skipped above. A skip (NaN/out-of-range lat/lng) means prevCell is
    // some earlier point, and reusing plan.bridged[i] for that longer,
    // unvalidated span both misreads the plan and can invent ground: a
    // finite-but-out-of-range coordinate (unlike NaN) still produces a real
    // haversineM, so the plan can mark the short i-1->i hop bridgeable while
    // this would silently apply that verdict to a much longer prevIdx->i
    // span it never evaluated. Skipping it here is the same "never connect
    // across a gap" default as an explicit skippedSpeed/skippedBudget call.
    if (prevCell !== null && prevCell !== cell && prevIdx === i - 1 && plan.bridged[i]) {
      try {
        for (const c of gridPathCells(prevCell, cell)) gapFilled.add(c);
      } catch {
        // gridPathCells can fail for cells very far apart (h3-js's own
        // documented limit — empirically confirmed at ~5000km+, not
        // anything a real gap produces). Fail OPEN to just the two
        // endpoints (already in `direct`) rather than losing the rest of
        // the path.
        bridgeFailures += 1;
      }
    }
    prevCell = cell;
    prevIdx = i;
  }

  // A cell hit both directly and by gap-fill counts as direct only.
  for (const c of direct) gapFilled.delete(c);

  return {
    cells: [...direct, ...gapFilled],
    directCount: direct.size,
    gapFilledCount: gapFilled.size,
    bridgeFailures,
    bridgesSkippedSpeed,
    bridgesSkippedDistance,
  };
}

/**
 * Total ground a set of tiles covers, in m².
 *
 * Summed per cell rather than `count × oneCellArea`: H3 cells are not equal
 * area — they vary by a few percent with latitude and with proximity to a
 * pentagon — and this number is shown to the runner beside a map of the
 * exact same cells.
 *
 * Exists because the Saved tab used to print `runs.area_m2`, the area of the
 * FENCE POLYGON, next to that map. Measured 2026-09-09, one real 5.8 km run
 * (`e058a4c9`) had a fence area of 1 155 m² against 204 covered tiles —
 * roughly 74 000 m² — because the run never closed a loop and there was
 * almost nothing for buildFence to enclose. A caption from one source beside
 * a shape from another is how a screen ends up arguing with itself.
 */
export function tilesAreaM2(cells: string[]): number {
  let total = 0;
  for (const cell of cells) total += cellArea(cell, UNITS.m2);
  return total;
}

/** One contiguous group of cells conquered together, for the "+N" bubble
 *  markers on the session-end map — see clusterCells below. */
export interface CellCluster {
  cells: string[];
  /** Cell count — the number the bubble shows. */
  count: number;
  /** Plain average of member cells' centers, not an area-weighted or
   *  boundary-aware centroid — good enough for dropping a pin, and res-12
   *  cells are near-equal area so weighting would not move it meaningfully. */
  center: { lat: number; lng: number };
}

/**
 * Groups H3 cells into contiguous clusters by grid adjacency (BFS over
 * gridDisk neighbors), not geographic distance. One "+N" bubble per
 * conquered AREA, not per cell — at the res-12 tile size (~10.8 m edge), a
 * single block of taken road is dozens of individual cells, and marking each
 * one would bury the map in labels the way the old single "You took N
 * tiles" banner undersold it by collapsing every area into one number with
 * no place on the map.
 *
 * Order-independent and does not mutate `cells`. A cell absent from the
 * input is never treated as a bridge between two clusters, even if it would
 * connect them geometrically — this only clusters what was actually passed
 * in (e.g. this run's own takenCells), not the wider board.
 */
export function clusterCells(cells: string[]): CellCluster[] {
  const remaining = new Set(cells);
  const clusters: CellCluster[] = [];
  for (const start of cells) {
    if (!remaining.has(start)) continue;
    const group: string[] = [];
    const queue = [start];
    remaining.delete(start);
    while (queue.length > 0) {
      const cell = queue.pop()!;
      group.push(cell);
      for (const neighbor of gridDisk(cell, 1)) {
        if (remaining.has(neighbor)) {
          remaining.delete(neighbor);
          queue.push(neighbor);
        }
      }
    }
    let latSum = 0;
    let lngSum = 0;
    for (const cell of group) {
      const [lat, lng] = cellToLatLng(cell);
      latSum += lat;
      lngSum += lng;
    }
    clusters.push({
      cells: group,
      count: group.length,
      center: { lat: latSum / group.length, lng: lngSum / group.length },
    });
  }
  return clusters;
}
