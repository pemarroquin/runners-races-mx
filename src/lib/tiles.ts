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

import type { LatLng } from '@/lib/territory';

/**
 * H3 resolution for claimed tiles: ~25 m edge, ~2,150 m² per tile.
 * Street-scale — GPS error mostly stays inside one tile at this size.
 * res 10 (66 m edge) is too coarse (whole blocks in one tile); res 12 (9 m)
 * is below the noise floor. See the brief §1.
 */
export const DEFAULT_TILE_RES = 11;

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
}

/**
 * Converts a recorded GPS path into the set of H3 cells it covers.
 *
 * Does NOT just map each fix to a cell — at the tracker's 2s/3m throttle,
 * consecutive fixes can be 30-50m apart, further than one res-11 tile's
 * ~25m edge, so a naive per-fix conversion leaves holes in the trail. Looks
 * almost right, which is the worst kind of wrong (brief §3). Consecutive
 * DISTINCT cells are bridged with H3's own gridPathCells so the covered
 * area is contiguous, the way the runner's actual path was.
 *
 * Returns cells: [] for an empty path. A single-point (or entirely
 * stationary) path returns exactly the one cell it sits in — there is
 * nothing to bridge.
 */
export function pathToTiles(path: LatLng[], res: number = DEFAULT_TILE_RES): PathToTilesResult {
  const direct = new Set<string>();
  const gapFilled = new Set<string>();
  let prevCell: string | null = null;

  for (const p of path) {
    const cell = latLngToCell(p.lat, p.lng, res);
    direct.add(cell);

    if (prevCell !== null && prevCell !== cell) {
      try {
        const line = gridPathCells(prevCell, cell);
        for (const c of line) gapFilled.add(c);
      } catch {
        // gridPathCells can fail for cells very far apart (h3-js's own
        // documented limit) — a background-gap leg-break jump or a wild
        // outlier fix, not the routine 30-50m throttle gap this exists to
        // bridge. Fail OPEN to just the two endpoints (already in `direct`)
        // rather than losing the rest of the path: a hole here is honest —
        // that ground genuinely wasn't tracked — unlike the ordinary
        // between-fix gaps this function's whole job is to close.
      }
    }
    prevCell = cell;
  }

  // A cell hit both directly and by gap-fill counts as direct only.
  for (const c of direct) gapFilled.delete(c);

  return {
    cells: [...direct, ...gapFilled],
    directCount: direct.size,
    gapFilledCount: gapFilled.size,
  };
}
