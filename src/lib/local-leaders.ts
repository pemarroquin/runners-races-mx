// Local Leaders drawn as a map: who is mayor of which cells, and where to
// point the camera.
//
// Pure, on rows already fetched, so vitest (no renderer) covers all of it.
// Scoping mirrors rankMayors exactly — filter visits to the arena FIRST, then
// decide mayors — so a runner's shape on the map always has the same cell
// count as their row on the card. A test holds the two together.
import { cellToBoundary, isValidCell } from 'h3-js';

import { groundOfRun } from '@/lib/enclosure';
import { DEFAULT_TILE_RES } from '@/lib/tiles';

import type { ArenaScope } from '@/lib/district';
import {
  MAYORSHIP_WINDOW_DAYS,
  mayorByCell,
  scopeVisits,
  type RunStats,
  type TileVisitRow,
} from '@/lib/mayorship';

const WINDOW_MS = MAYORSHIP_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/** Cells each runner is mayor of inside the arena, keyed by user id. */
export function mayorHoldings(
  visits: TileVisitRow[],
  arena: string | ArenaScope | null,
  now: number = Date.now(),
  /** Same stats rankMayors gets, or a tie broken by effort would draw one
   *  runner's shape under another's row. */
  stats?: Map<string, RunStats>,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [h3, { userId }] of mayorByCell(scopeVisits(visits, arena), now, stats)) {
    const cells = out.get(userId);
    if (cells) cells.push(h3);
    else out.set(userId, [h3]);
  }
  return out;
}

/**
 * Distinct UTC days each runner set foot anywhere in the arena, inside the
 * window. The number a row shows next to tiles: "came 19 of the last 30
 * days". Display only — the ranking is still rankMayors'. UTC for the same
 * reason mayorship.ts uses it: every device counts days on one clock.
 */
export function daysPresent(
  visits: TileVisitRow[],
  arena: string | ArenaScope | null,
  now: number = Date.now(),
): Map<string, number> {
  const cutoff = now - WINDOW_MS;
  const days = new Map<string, Set<string>>();
  for (const visit of scopeVisits(visits, arena)) {
    const ms = new Date(visit.visitedAt).getTime();
    // NaN fails both comparisons, so an unparseable row is dropped rather
    // than reaching toISOString(), which would throw.
    if (!(ms >= cutoff) || !(ms <= now)) continue;
    const key = new Date(ms).toISOString().slice(0, 10);
    const set = days.get(visit.userId);
    if (set) set.add(key);
    else days.set(visit.userId, new Set([key]));
  }
  const out = new Map<string, number>();
  for (const [userId, set] of days) out.set(userId, set.size);
  return out;
}

export interface CellBounds {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

/** Bounding box of every cell's own boundary, or null for no (valid) cells.
 *  What the full-bleed map frames: the conquered ground, not the arena. */
export function cellsBounds(cells: Iterable<string>): CellBounds | null {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const cell of cells) {
    if (!isValidCell(cell)) continue;
    let ring: number[][];
    try {
      ring = cellToBoundary(cell);
    } catch {
      continue;
    }
    for (const [lat, lng] of ring) {
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
    }
  }
  return Number.isFinite(minLat) ? { minLat, maxLat, minLng, maxLng } : null;
}

/** What a map of the board frames: the held ground in full-bleed mode (the
 *  sketch centres on conquered areas), else — or with nobody holding
 *  anything — the arena's own bounds. */
export function frameOf(
  arena: CellBounds | null,
  holdings: { cells: string[] }[],
  full: boolean,
): CellBounds | null {
  if (full) {
    const held = cellsBounds(holdings.flatMap((h) => h.cells));
    if (held) return held;
  }
  return arena;
}

/** One runner's effort in an arena over the window: what a row shows next
 *  to days. Pace is derived from these two totals, never ranked. */
export interface RunnerTotals {
  distanceM: number;
  durationS: number;
  laps: number;
  runs: number;
}

/**
 * Totals of the runs behind each runner's visits in the arena, inside the
 * window (Pedro, 2026-09-30: 30-day totals of runs touching the place). A
 * run counts once however many of its cells are here, and its whole
 * distance counts — splitting a run at a boundary would need its path,
 * which never leaves the server. A run with no stats (flagged, or the RPC
 * unavailable) is left out rather than counted as zero.
 */
export function runnerTotals(
  visits: TileVisitRow[],
  arena: string | ArenaScope | null,
  stats: Map<string, RunStats>,
  now: number = Date.now(),
): Map<string, RunnerTotals> {
  const cutoff = now - WINDOW_MS;
  const runsByUser = new Map<string, Set<string>>();
  for (const visit of scopeVisits(visits, arena)) {
    if (!visit.runId) continue;
    const ms = new Date(visit.visitedAt).getTime();
    if (!(ms >= cutoff) || !(ms <= now)) continue;
    const set = runsByUser.get(visit.userId);
    if (set) set.add(visit.runId);
    else runsByUser.set(visit.userId, new Set([visit.runId]));
  }
  const out = new Map<string, RunnerTotals>();
  for (const [userId, runs] of runsByUser) {
    const totals: RunnerTotals = { distanceM: 0, durationS: 0, laps: 0, runs: 0 };
    for (const id of runs) {
      const s = stats.get(id);
      if (!s) continue;
      totals.distanceM += s.distanceM;
      totals.durationS += s.durationS;
      totals.laps += s.laps;
      totals.runs++;
    }
    if (totals.runs > 0) out.set(userId, totals);
  }
  return out;
}

/**
 * Each session's GROUND as visits: the tiles it crossed plus the inside of
 * any loop that same session closed (enclosure.ts's groundOfRun, the rule
 * Places I've been draws with), every tile stamped with the session's day.
 *
 * This is what makes enclosure count on Local Leaders (Pedro, 2026-09-30):
 * both boards enclose; Leaderboard's ground changes hands to whoever ran it
 * last, Local Leaders' to whoever keeps coming back — loop the same block on
 * 17 days and you were there 17 days. It reverses the 2026-09-07 rule that
 * circling a place from outside didn't count.
 *
 * Per SESSION, never across sessions, so six months of perimeter can't
 * claim a city. Built from stored cells, which are privacy-trimmed: a loop
 * that closes only inside the privacy zone encloses nothing here — a subset
 * near home, never a leak. Pass each session's WHOLE visit list
 * (fetchRunVisits), or a loop crossing the arena edge won't close.
 *
 * One day per session (its earliest visit), so an evening run that crosses
 * UTC midnight counts once. Rows without a runId pass through unchanged.
 */
export function sessionGroundVisits(
  visits: TileVisitRow[],
  res: number = DEFAULT_TILE_RES,
): TileVisitRow[] {
  const runs = new Map<string, { first: TileVisitRow; cells: Set<string> }>();
  const out: TileVisitRow[] = [];
  for (const v of visits) {
    if (!v.runId) {
      out.push(v);
      continue;
    }
    const run = runs.get(v.runId);
    if (!run) runs.set(v.runId, { first: v, cells: new Set([v.h3]) });
    else {
      run.cells.add(v.h3);
      if (v.visitedAt < run.first.visitedAt) run.first = v;
    }
  }
  for (const [runId, { first, cells }] of runs) {
    let ground: string[];
    try {
      ground = groundOfRun([...cells], res);
    } catch {
      // A malformed cell must not take the board down; the crossed tiles
      // still count.
      ground = [...cells];
    }
    for (const h3 of ground) {
      out.push({ h3, userId: first.userId, displayName: first.displayName, visitedAt: first.visitedAt, runId });
    }
  }
  return out;
}

/** Cells per mayor, from an already-computed mayor map. */
export function holdingsOf(mayors: Map<string, { userId: string }>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [h3, { userId }] of mayors) {
    const cells = out.get(userId);
    if (cells) cells.push(h3);
    else out.set(userId, [h3]);
  }
  return out;
}

/**
 * The map's holdings with the runner's ground ELSEWHERE added (Pedro,
 * 2026-10-01): inside the selected place everything stays exactly as the
 * board computed it (so it matches the card); the runner's tiles outside the
 * place are appended as one faded holding. Rivals are never shown outside.
 */
export function withMineElsewhere<H extends { userId: string; cells: string[] }>(
  inside: H[],
  mine: string[] | null,
  contains: (h3: string) => boolean,
  make: (cells: string[]) => H,
): H[] {
  if (!mine) return inside;
  const outside = mine.filter((c) => !contains(c));
  return outside.length > 0 ? [...inside, make(outside)] : inside;
}
