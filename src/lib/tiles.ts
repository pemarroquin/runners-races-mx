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

/**
 * Fastest sustained human running speed the server's OWN anti-cheat
 * flagging already treats as implausible — reused rather than inventing a
 * second number, so the two subsystems agree on what "physically possible
 * for a runner" means. See supabase/migrations/20260827_anti_cheat_flag.sql:
 * `max_kmh constant numeric := 25` (marathon world record pace is ~21 km/h;
 * 25 is already generous).
 *
 * A gap whose implied speed exceeds this is never bridged — see
 * PathToTilesResult.bridgesSkipped.
 */
export const MAX_BRIDGE_SPEED_MS = (25 * 1000) / 3600; // ≈ 6.94 m/s

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
   *  trail. Counted, not silently swallowed, for the same reason
   *  bridgesSkipped is: "the fill failed and left a hole" must never be
   *  indistinguishable from "there was nothing to fill". */
  bridgeFailures: number;
  /**
   * Gaps deliberately left UNFILLED because bridging them would imply a
   * speed above MAX_BRIDGE_SPEED_MS. This is not defensive padding — it is
   * the fix for a real bug found reviewing this exact file: an earlier
   * version bridged EVERY gap regardless of implied speed, which is the
   * enclosure model's auto-close bug wearing different clothes. closeRing
   * connected two distant points and claimed everything between them (a
   * one-way 3.77km arc claimed 1.82 km² it never ran around); an unbounded
   * gridPathCells bridge does the same thing tile-by-tile — a 2km
   * background-gap jump silently claimed ~95,000 m² of ground never
   * covered, with bridgeFailures staying 0 the whole time because nothing
   * THREW — the bridge worked exactly as designed, across a gap it should
   * never have spanned.
   *
   * The single most common real trigger is a runner locking their phone
   * mid-run: tracking.ts's visibilitychange handler clears `lastRef` on
   * reconnect (a leg break, protecting distanceM and the drawn route line),
   * but this function reads the raw, still-continuous `points` array and
   * never sees that seam — the speed check is what catches it here instead.
   */
  bridgesSkipped: number;
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
  let bridgesSkipped = 0;
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
        // never ran over — see bridgesSkipped's own doc for why this
        // matters.
        bridgesSkipped += 1;
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
    bridgesSkipped,
  };
}
