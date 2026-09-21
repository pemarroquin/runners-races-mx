// Lap / loop detection — replaces the "cycle bonus" that never detected a
// cycle (reported 2026-09-20: "I got a 2 marker indicating I ran the same
// circuit twice, BUT I DID NOT").
//
// The old check in territory-sync.ts's uploadRun compared this run's path
// cells against the runner's OWN EXISTING TERRITORY (`ownedSet`, built from
// every tile they hold across every past run) and awarded the bonus once 50
// of THIS run's cells were already owned ground. That is "you ran over your
// own neighbourhood", not "you ran a loop" — for a runner who owns a few
// thousand tiles, almost every run trips it. There was no loop or repeat
// detection anywhere in the old code. This module is the real thing: it
// looks at whether THIS run's own path revisits itself, and nothing else.
//
// Pure and dependency-free of Supabase/territory state, unlike the code it
// replaces — testable exactly like tiles.ts/gap-policy.ts (vitest.config.ts
// is `environment: 'node'`, no React renderer, so this logic could not have
// lived inside a component or inside uploadRun's own closure and still be
// tested at all).
import { cellToLatLng, latLngToCell } from 'h3-js';

import type { TimedPoint } from '@/lib/gap-policy';
import { haversineM } from '@/lib/territory';
import { DEFAULT_TILE_RES } from '@/lib/tiles';

/**
 * How many DISTINCT other cells must appear between two visits to the same
 * cell for the second visit to count as a genuine revisit, rather than GPS
 * jitter or briefly stopping.
 *
 * This is an intervening-CELL count, deliberately not a time gap. A time
 * threshold long enough to reject jitter (GPS noise flickering between two
 * or three adjacent cells for minutes at a standstill needs ~2 minutes of
 * cooldown to be safely excluded) is also long enough to reject a real short
 * loop — a 400 m circuit takes about that long to run, and would be told
 * apart from jitter by a threshold picked for a completely unrelated reason.
 * Jitter oscillates in place: however long it runs, it only ever touches the
 * same handful of adjacent cells, so it can never clear a 10-distinct-cell
 * separation no matter how much real time passes. A genuine lap, in
 * contrast, necessarily crosses many distinct cells to get all the way
 * around and back. This also behaves identically for a fast runner and a
 * slow one — a time-based cooldown would not, since the same physical loop
 * takes longer at an easy pace.
 */
export const MIN_SEPARATION_CELLS = 10;

/** Minimum number of distinctly-repeated cells for the run to qualify — the
 *  flat-count half of `qualifies`. Guards against a tiny loop run many
 *  times (high `laps`, high `repeatFraction`, but only a handful of cells
 *  actually re-covered) scoring the same as a real lap of a real route. */
export const MIN_REPEATED_CELLS = 50;

/**
 * Minimum share of the run's distinct cells that must be repeated for the
 * run to qualify — the half of `qualifies` that scales with run length. A
 * flat cell count alone can't do this job: 50 repeated cells is close to
 * everything on a 3 km loop and a rounding error on a 32 km one. The
 * fraction is what makes one threshold work at both ends — a route
 * genuinely covered twice scores near 1.0 regardless of its length; a
 * one-way run that merely shares its first and last couple hundred metres
 * (leaving the house, coming home) scores 0.05-0.15; a figure-8 with a
 * shared middle scores around 0.3. 0.6 sits clearly above the shared-ends
 * and figure-8 cases and clearly below a real repeat.
 */
export const MIN_REPEAT_FRACTION = 0.6;

export interface LapResult {
  /** Highest number of separated visits to any one cell. 1 = no laps at all
   *  (every cell was visited at most once, ignoring jitter). 0 only for a
   *  path with no valid cells (empty input, or every fix malformed).
   *
   *  Can read 2 for a completely ORDINARY single loop that never repeats
   *  anything: a route's own start/finish cell is crossed once leaving and
   *  once arriving back, which this counts honestly as "2 separated visits"
   *  to that one cell (see test/laps.test.ts's "ordinary single loop" case).
   *  This is real, not a bug, and is exactly why `qualifies` — not this raw
   *  number — is what gates the bonus: MIN_REPEATED_CELLS/MIN_REPEAT_FRACTION
   *  need far more than one coincidental cell to fire. Don't surface `laps`
   *  to the runner directly without accounting for this. */
  laps: number;
  /** Cells visited 2+ times with proper separation (see
   *  MIN_SEPARATION_CELLS) — the ground that was actually lapped. Each cell
   *  id appears once, regardless of how many times it was revisited. */
  repeatedCells: string[];
  /** repeatedCells.length / distinct cells on the route. 0 when the route
   *  has no distinct cells at all. */
  repeatFraction: number;
  /** Whether this run qualifies for the cycle bonus — see MIN_REPEATED_CELLS
   *  and MIN_REPEAT_FRACTION for why both a flat count and a fraction are
   *  required. */
  qualifies: boolean;
}

/**
 * Detects laps/loops in a run's ORDERED path — never `pathToTiles`'s output.
 * `pathToTiles` accumulates into a `Set`, so a repeat visit is discarded
 * before any caller can see it; lap detection needs the sequence, not the
 * set.
 *
 * Algorithm:
 *  1. Map each point to its H3 cell at `res` (default DEFAULT_TILE_RES). A
 *     single malformed fix (NaN/out-of-range lat/lng) is skipped, not
 *     thrown out of the whole function — same defensive posture as
 *     `pathToTiles`'s own per-point try/catch (tiles.ts), and for the same
 *     reason: one bad GPS read must not blank the result for the rest of
 *     the run.
 *  2. Collapse CONSECUTIVE duplicate cells into one "visit" — standing
 *     still (or GPS noise that keeps re-reporting the same cell) is not a
 *     revisit of anything.
 *  3. For each cell that appears more than once in that collapsed sequence,
 *     walk its visits in order and count a visit as a genuine repeat only
 *     when at least MIN_SEPARATION_CELLS distinct OTHER cells appear in the
 *     collapsed sequence between it and the previously-COUNTED visit (not
 *     merely the previous visit — a rejected visit does not reset the
 *     separation clock). `laps` for that cell is how many visits this
 *     produces in total (1 = just the first, never repeated).
 *  4. `laps` overall is the max of every cell's own count. `repeatedCells`
 *     is every cell whose count reached 2 or more.
 */
export function detectLaps(points: TimedPoint[], res: number = DEFAULT_TILE_RES): LapResult {
  // Step 1 + 2: ordered, consecutive-deduplicated sequence of cells.
  const seq: string[] = [];
  let prevCell: string | null = null;
  for (const p of points) {
    let cell: string;
    try {
      cell = latLngToCell(p.lat, p.lng, res);
    } catch {
      // Skip just this point (see the doc comment above) — prevCell is left
      // untouched, so a good fix right after a bad one is still correctly
      // compared against the last GOOD cell, not treated as a new visit of
      // whatever the bad fix would have produced.
      continue;
    }
    if (cell !== prevCell) {
      seq.push(cell);
      prevCell = cell;
    }
  }

  if (seq.length === 0) {
    return { laps: 0, repeatedCells: [], repeatFraction: 0, qualifies: false };
  }

  // Every occurrence index (into `seq`) of each cell, in order.
  const visitsByCell = new Map<string, number[]>();
  for (let i = 0; i < seq.length; i++) {
    let list = visitsByCell.get(seq[i]);
    if (!list) {
      list = [];
      visitsByCell.set(seq[i], list);
    }
    list.push(i);
  }

  let laps = 1;
  const repeatedCells: string[] = [];

  for (const [cell, indices] of visitsByCell) {
    if (indices.length < 2) continue;

    let lastCounted = indices[0];
    let count = 1;
    for (let k = 1; k < indices.length; k++) {
      const idx = indices[k];
      // Distinct cells strictly between lastCounted and idx, excluding
      // `cell` itself — `cell` CAN appear in this range (a visit that was
      // rejected for insufficient separation doesn't move lastCounted, so a
      // later visit's range can contain one or more of those in-between
      // occurrences of the same cell), and those must not count as an
      // "other" cell separating the loop from itself.
      //
      // Straightforward O(range length) scan, not a Fenwick/BIT range-
      // distinct structure — the worst case across a whole run is bounded
      // by realistic path lengths (a marathon's collapsed sequence is a few
      // thousand entries at most), and this only runs once per upload, not
      // per GPS tick. Same "measured and bounded, not asymptotically
      // optimal" posture as measure-holes.ts's spanM.
      const distinctOther = new Set<string>();
      for (let i = lastCounted + 1; i < idx; i++) {
        if (seq[i] !== cell) distinctOther.add(seq[i]);
      }
      if (distinctOther.size >= MIN_SEPARATION_CELLS) {
        count++;
        lastCounted = idx;
      }
    }

    if (count >= 2) repeatedCells.push(cell);
    if (count > laps) laps = count;
  }

  // visitsByCell.size is never 0 here — seq.length === 0 already returned
  // above, and a non-empty seq means at least one cell has at least one visit.
  const repeatFraction = repeatedCells.length / visitsByCell.size;

  return {
    laps,
    repeatedCells,
    repeatFraction,
    qualifies:
      laps >= 2 && repeatedCells.length >= MIN_REPEATED_CELLS && repeatFraction >= MIN_REPEAT_FRACTION,
  };
}

/**
 * Where the lap-bonus marker actually lands: the centroid of `repeatedCells`
 * (the ground that was actually lapped), SNAPPED to whichever of those cells
 * is nearest that centroid — never the raw arithmetic mean on its own.
 *
 * The mean of a non-convex set of cells (an out-and-back's two parallel
 * strips, a loop's ring) can fall outside the set entirely — measured
 * 482 m off-route on a real V-shaped run for the conquest "+N" marker,
 * fixed on branch `fix/conquest-marker-centre` via
 * `src/lib/marker-anchor.ts`'s `pickMarkerAnchor`. This function is the same
 * fix (mean, then snap to the nearest actual member), reimplemented locally
 * rather than importing that module: this branch is not based on
 * fix/conquest-marker-centre, and brief instructions were to either
 * reimplement or note the two should be unified later — noted here and in
 * the executor's report. `pickMarkerAnchor` additionally picks the LARGEST
 * connected cluster before snapping (for conquest's possibly-disjoint taken
 * cells); that step is intentionally omitted here since `repeatedCells` is
 * already the single set this bonus is about, not multiple unrelated
 * patches — but if these two ever diverge further, unify them.
 *
 * Returns null for empty input.
 */
export function pickLapMarkerCenter(repeatedCells: string[]): { lat: number; lng: number } | null {
  if (repeatedCells.length === 0) return null;

  let latSum = 0;
  let lngSum = 0;
  const points: { cell: string; lat: number; lng: number }[] = [];
  for (const cell of repeatedCells) {
    const [lat, lng] = cellToLatLng(cell);
    points.push({ cell, lat, lng });
    latSum += lat;
    lngSum += lng;
  }
  const mean = { lat: latSum / points.length, lng: lngSum / points.length };

  let best = points[0];
  let bestDistanceM = haversineM(points[0], mean);
  for (let i = 1; i < points.length; i++) {
    const d = haversineM(points[i], mean);
    if (d < bestDistanceM) {
      best = points[i];
      bestDistanceM = d;
    }
  }
  return { lat: best.lat, lng: best.lng };
}
