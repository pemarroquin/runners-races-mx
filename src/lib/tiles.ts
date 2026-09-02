// Path → H3 tiles — the core of Territory Mode's coverage model (claim the
// ground you ran OVER, not the area you ran around). Pure functions, no
// React, no network: same testing philosophy as territory.ts (the enclosure
// model this replaces — see that file's own header and the Tile Coverage
// Model brief §4 for what survives/dies).
//
// h3-js v4 API (verified against the installed package, not assumed from
// memory — v3 used different names: geoToH3, h3Line): latLngToCell,
// gridPathCells, cellToBoundary, cellToParent.
import { gridPathCells, latLngToCell } from 'h3-js';

import { MAX_BRIDGE_DISTANCE_M, MAX_BRIDGE_SPEED_MS } from '@/lib/gap-policy';
import { haversineM, type LatLng } from '@/lib/territory';

/**
 * H3 resolution for claimed tiles: ~25 m edge, ~2,150 m² per tile.
 * Street-scale — GPS error mostly stays inside one tile at this size.
 * res 10 (66 m edge) is too coarse (whole blocks in one tile); res 12 (9 m)
 * is below the noise floor. See the brief §1.
 */
export const DEFAULT_TILE_RES = 11;

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
 * consecutive fixes can be 30-50m apart, further than one res-11 tile's
 * ~25m edge, so a naive per-fix conversion leaves holes in the trail. Looks
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
  let prevPoint: TilePoint | null = null;

  for (const p of path) {
    const cell = latLngToCell(p.lat, p.lng, res);
    direct.add(cell);

    if (prevCell !== null && prevCell !== cell && prevPoint !== null) {
      const dtS = (p.ts - prevPoint.ts) / 1000;
      const distM = haversineM(prevPoint, p);
      // dtS <= 0 (out-of-order or identical timestamps) can't imply a real
      // speed — treated as implausible rather than divided by zero/negative,
      // so a bad pair of timestamps fails safe (no bridge) instead of
      // silently passing the check.
      const impliedSpeedMs = dtS > 0 ? distM / dtS : Infinity;

      if (impliedSpeedMs > MAX_BRIDGE_SPEED_MS) {
        // Leave the hole. Bridging here would claim ground the runner
        // never ran over at all — see MAX_BRIDGE_SPEED_MS's own doc.
        bridgesSkippedSpeed += 1;
      } else if (distM > MAX_BRIDGE_DISTANCE_M) {
        // Physically possible, but a straight line here is a guess about
        // which streets they took — see MAX_BRIDGE_DISTANCE_M's own doc.
        bridgesSkippedDistance += 1;
      } else {
        try {
          const line = gridPathCells(prevCell, cell);
          for (const c of line) gapFilled.add(c);
        } catch {
          // gridPathCells can fail for cells very far apart (h3-js's own
          // documented limit — empirically confirmed at ~5000km+, not
          // anything a real gap produces). Fail OPEN to just the two
          // endpoints (already in `direct`) rather than losing the rest of
          // the path.
          bridgeFailures += 1;
        }
      }
    }
    prevCell = cell;
    prevPoint = p;
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
