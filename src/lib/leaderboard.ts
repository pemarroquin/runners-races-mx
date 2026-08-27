// Phase 2 — leaderboard aggregation. Pure functions over rows already
// fetched, so the ranking maths is unit-testable without a network or a
// database, same philosophy as territory.ts and races.ts.
//
// WHY THIS IS CLIENT-SIDE, not the `ST_Union ... group by user_id` query in
// the feature plan: PostgREST can't express that aggregate, so it would need
// a Postgres function — and migrations in this project are applied BY HAND
// (see CLAUDE.md). An unapplied one fails silently and reads as "nobody has
// any territory", which is indistinguishable from an empty board. Turf is
// already a dependency and the union pipeline already exists here, so this
// path works the moment a run is saved, with no setup step that can be
// forgotten.
//
// The union is NOT optional and summing `area_m2` is not a shortcut: running
// the same loop twice would otherwise count that ground twice. Overlapping
// runs by one user collapse into the area actually held — which is the whole
// definition of the score.
//
// Ceiling: this fetches every fence geometry to aggregate them on device.
// Fine at friends scale (tens of runs); if the board ever gets slow, the fix
// is the `profile_stats` table in the plan (a trigger unions just the one
// user's rows per insert, so write cost stays flat) — at which point this
// file becomes a fallback rather than the primary path.
import area from '@turf/area';
import { featureCollection } from '@turf/helpers';
import union from '@turf/union';
import type { Feature, MultiPolygon, Polygon } from 'geojson';

export interface LeaderboardRun {
  userId: string;
  displayName: string | null;
  region: string | null;
  geometry: Polygon | MultiPolygon;
  /** Server-side speed flag. Flagged runs still count toward the ranking —
   *  the board marks them rather than excluding them, so a GPS glitch never
   *  silently costs someone their score. */
  flagged?: boolean;
}

export interface LeaderboardEntry {
  userId: string;
  displayName: string | null;
  /** Area actually held — overlapping runs by this user counted once. */
  areaM2: number;
  runCount: number;
  /** How many of those runs the speed trigger flagged. Surfaced so a board
   *  built partly on implausible runs says so, rather than presenting every
   *  row as equally solid. */
  flaggedCount: number;
}

function asFeature(geometry: Polygon | MultiPolygon): Feature<Polygon | MultiPolygon> {
  return { type: 'Feature', properties: {}, geometry };
}

/**
 * Total area held by one user: the union of all their fences, measured once.
 *
 * Falls back to the largest single fence if turf's union fails outright —
 * a degenerate ring can make it return null, and reporting a smaller-but-real
 * number beats reporting a 0 that looks like "this user has no territory".
 */
export function unionAreaM2(geometries: (Polygon | MultiPolygon)[]): number {
  if (geometries.length === 0) return 0;
  if (geometries.length === 1) return area(asFeature(geometries[0]));

  try {
    const merged = union(featureCollection(geometries.map(asFeature)));
    if (merged) return area(merged);
  } catch {
    // Fall through to the per-fence maximum below.
  }
  return Math.max(...geometries.map((g) => area(asFeature(g))));
}

/**
 * Rank users by area held, descending. `regionId` narrows to runs tagged
 * with that region (set at insert time by territory-sync.ts); pass null for
 * the global board.
 *
 * A user whose runs are all outside the selected region drops off entirely
 * rather than appearing with 0 — a regional board is a claim about that
 * metro, and a 0-area row there says something false.
 */
export function rankByArea(
  runs: LeaderboardRun[],
  regionId: string | null,
): LeaderboardEntry[] {
  const byUser = new Map<string, LeaderboardRun[]>();
  for (const run of runs) {
    if (regionId !== null && run.region !== regionId) continue;
    const existing = byUser.get(run.userId);
    if (existing) existing.push(run);
    else byUser.set(run.userId, [run]);
  }

  const entries: LeaderboardEntry[] = [];
  for (const [userId, userRuns] of byUser) {
    entries.push({
      userId,
      // Any row's name will do — they all come from the same profile row —
      // but prefer a set one over a null in case of a partial join.
      displayName: userRuns.find((r) => r.displayName !== null)?.displayName ?? null,
      areaM2: unionAreaM2(userRuns.map((r) => r.geometry)),
      runCount: userRuns.length,
      flaggedCount: userRuns.filter((r) => r.flagged === true).length,
    });
  }

  // Ties broken by run count then id, so the order is stable between loads
  // rather than reshuffling on every refresh.
  entries.sort(
    (a, b) =>
      b.areaM2 - a.areaM2 || b.runCount - a.runCount || a.userId.localeCompare(b.userId),
  );
  return entries;
}

/** Which regions actually have runs, for the region picker. */
export function regionsWithRuns(runs: LeaderboardRun[]): string[] {
  const seen = new Set<string>();
  for (const run of runs) if (run.region !== null) seen.add(run.region);
  return Array.from(seen).sort();
}
