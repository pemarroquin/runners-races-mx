// Leaderboard aggregation — pure functions over rows already fetched, so the
// ranking maths is unit-testable without a network or a database, same
// philosophy as territory.ts and races.ts.
//
// This file used to hold two models side by side. The area model (a turf
// union of every fence per user) was kept alongside the tile model on the
// brief's own instruction — land the new one, prove it on a real run, then
// remove — and this is that removal: `rankByArea`, `unionAreaM2`,
// `regionsWithRuns`, `LeaderboardRun` and `LeaderboardEntry` are gone, along
// with the turf dependency they needed here and the `fetchLeaderboard` that
// fed them. Nothing rendered them; leaderboard.tsx has been on
// districtConquest since the tile migration.
import { cellToChildrenSize } from 'h3-js';

import { districtOfCell } from '@/lib/district';
import { DEFAULT_TILE_RES } from '@/lib/tiles';

// ============================================================================
// Tile Coverage Model — count-based ranking (Tile Coverage brief §6 step 6)
// ============================================================================
//
// Why this is simpler than the union pipeline it replaced, not just newer:
// one tile has exactly one owner AT A TIME. It is no longer forever —
// conquest (20260908010000) lets a later run take a tile — but ownership is
// still single-valued at any moment, which is all the ranking needs.
// Ranking is therefore a plain count of
// territory_tiles rows per owner, no turf, no polygon union, no "did these
// two fences overlap" question at all — the DB schema itself already
// answers "who owns this ground" per tile.

/** One row of `territory_tiles`, already joined to its owner's display name
 *  and the flagged status of the run that claimed it — see
 *  territory-sync.ts's fetchTileLeaderboard for how this is assembled. */
export interface TileOwnerRow {
  /** The cell itself. Was fetched and discarded before districtConquest
   *  needed it — the district filter and the map both key off it. */
  h3: string;
  ownerId: string;
  displayName: string | null;
  regionId: string | null;
  /** The §2.5 forgery guard rejects wholesale fabrication before a claim
   *  ever lands here — this is the OTHER guard, flag_implausible_speed,
   *  carried over from the run that claimed this specific tile. A flagged
   *  claim still counts (same "marked, not punished" posture as the old
   *  leaderboard), the row just says so. */
  flagged: boolean;
}

// rankByTileCount and TileLeaderboardEntry lived here and are DELETED, not
// deprecated: districtConquest replaced them outright when the leaderboard
// stopped ranking by a raw tile count over a whole metro. Nothing imported
// them any more — the two remaining mentions in this repo are comments.
//
// rankByArea / unionAreaM2 / regionsWithRuns went the same way, one
// change later — see this file's header.


// ============================================================================
// BOARD 1 — CONQUEST, as a share of the district's park paths
// ============================================================================
//
// What the board shows changed from a raw tile count to a PERCENTAGE, at
// Pedro's ask: "% of parks conquered in the municipio I'm located at,
// period." Two substitutions were needed to deliver that, and both are
// deliberate:
//
//   municipio -> DISTRICT. Nothing can resolve a lat/lng to a municipio and
//   the cheap substitute measured 21.3% ambiguous. See district.ts's header
//   for the full reasoning and the games precedent.
//
//   "parks" -> PARK PATHS, which is the denominator park_paths.sql already
//   measured as the only one that moves: one 5.7 km run is 0.262% of San
//   Pedro's area, 0.63% of its street network, and 5.5% of its park paths.
//
// CONQUERED, NOT VISITED — and this is the one place where this board and
// the `municipio_progress` RPC that shipped the same week deliberately
// disagree. That RPC counts visits, on purpose, because it is a personal
// record of where someone went. This is a contest over ground, so it counts
// what a runner OWNS: territory_tiles.owner_id. The two numbers will differ
// for the same runner (enclosure can hand you park paths you never set foot
// on) and neither is wrong.
//
// Zero migrations, which is why it is here rather than in SQL: every tile's
// h3 + owner_id is already fetched by fetchTileLeaderboard, and park cells
// are H3-keyed, so the whole thing is a set intersection on data in memory.
// Migrations in this project are applied BY HAND and an unapplied one reads
// as an honest zero (see CLAUDE.md, and the backlog's own warnings) — a
// leaderboard that says 0% because nobody ran the SQL is indistinguishable
// from one that says 0% because nobody ran.

export interface ConquestEntry {
  userId: string;
  displayName: string | null;
  /**
   * This runner's share of the CLAIMED ground in the district, 0-1.
   *
   * Share of claimed, not share of the district, and that was measured. A
   * res-7 district holds 16 807 res-12 cells and most of them are buildings,
   * private land or water — ground nobody can run. Against that denominator
   * every real runner sits between 0.02% and 2.39% (measured across all four
   * live districts, 2026-09-09) and no amount of running moves it. That is
   * precisely the "years or never" denominator park_paths.sql measured and
   * rejected — 0.262% of a municipio's area for a 5.7 km run — and an
   * earlier version of this file reproduced it.
   *
   * Against claimed ground the same runs read 8.6% to 91.4%: 58.5% against
   * 41.5% is a contest, 85% against 15% is a rout you can see. That is the
   * question a leaderboard asks — who holds this place — and it is inherently
   * relative. It also moves the moment anyone runs, in both directions,
   * which is what makes it worth defending.
   */
  share: number;
  /** Cells this runner owns in the district. The absolute number, kept
   *  because a share alone cannot distinguish holding half of a busy
   *  district from holding half of an empty one. */
  cellsHeld: number;
  flaggedCellsHeld: number;
}

export interface DistrictConquest {
  entries: ConquestEntry[];
  /** Cells owned by anyone in this district — the shares' denominator. */
  claimedTotal: number;
  /** Every res-12 cell in the arena: 16 807, always, anywhere on Earth, with
   *  no data at all. Not a share denominator (see ConquestEntry.share) — it
   *  is what the FRONTIER is measured against: how much of this district has
   *  been claimed by anyone yet. Small is the honest answer there, and the
   *  point: it is how much is left to take. */
  districtTotal: number;
}

/**
 * Board 1 for one district — who holds the claimed ground.
 *
 * Pure, over rows already fetched. Ties broken by user id for a stable order
 * between loads, same reasoning as the rest of this file.
 */
export function districtConquest(tiles: TileOwnerRow[], district: string): DistrictConquest {
  const byUser = new Map<
    string,
    { displayName: string | null; cellsHeld: number; flaggedCellsHeld: number }
  >();

  let claimedTotal = 0;
  for (const tile of tiles) {
    // districtOfCell also rejects any cell not at the tile resolution, so an
    // unconverted res-11 tile is excluded rather than inflating a district.
    if (districtOfCell(tile.h3) !== district) continue;
    claimedTotal++;
    let entry = byUser.get(tile.ownerId);
    if (!entry) {
      entry = { displayName: tile.displayName, cellsHeld: 0, flaggedCellsHeld: 0 };
      byUser.set(tile.ownerId, entry);
    }
    entry.cellsHeld++;
    if (tile.flagged) entry.flaggedCellsHeld++;
    if (entry.displayName === null && tile.displayName !== null) {
      entry.displayName = tile.displayName;
    }
  }

  const entries: ConquestEntry[] = [...byUser.entries()]
    .map(([userId, agg]) => ({
      userId,
      displayName: agg.displayName,
      // claimedTotal is 0 only when byUser is empty, so this never divides by
      // zero — but it is written defensively anyway, because a NaN reaching
      // the UI would render as "NaN%" rather than fail.
      share: claimedTotal > 0 ? agg.cellsHeld / claimedTotal : 0,
      cellsHeld: agg.cellsHeld,
      flaggedCellsHeld: agg.flaggedCellsHeld,
    }))
    .sort(
      (a, b) =>
        b.cellsHeld - a.cellsHeld || (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0),
    );

  return { entries, claimedTotal, districtTotal: cellToChildrenSize(district, DEFAULT_TILE_RES) };
}
