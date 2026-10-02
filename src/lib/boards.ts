// The leaderboard's district-scoped read.
//
// Filters SERVER-SIDE by the district's H3 prefix (districtCellPattern)
// rather than pulling a table down and truncating every id on device — this
// repo has already shipped a leaderboard that silently ranked a truncated
// 1000-row sample (see fetchTileLeaderboard's own paging comment).
//
// NEEDS NO MIGRATION, which is the point. `tile_visits` already has a `read
// all` policy, opened when the table was created for exactly this ("other
// runners' tile_visits eventually for the Layer 2 rolling board"). Migrations
// here are applied BY HAND and an unapplied one reads as an honest zero, so
// a board that needs no SQL cannot be broken by forgetting to run any.
//
// A park-path read used to live here and was deleted 2026-09-09 — at the
// time, `park_path_cells` was genuinely empty in production, so the read fed
// nothing and the conquest denominator moved to claimed ground instead (see
// leaderboard.ts's ConquestEntry.share; that change stands). The table was
// loaded the same day (36,193 cells, see BACKLOG). `fetchDistrictParkCells`
// is restored ONLY for district.ts's districtLabel — a decorative caption,
// never a score — not for any denominator.
import { gridDisk } from 'h3-js';

import { districtCellPattern, districtChunks, districtOfCell, districtsOrFilter } from '@/lib/district';
import { sessionGroundVisits } from '@/lib/local-leaders';
import {
  MAYORSHIP_WINDOW_DAYS,
  mayorByCell,
  namesOf,
  type RunStats,
  type TileVisitRow,
} from '@/lib/mayorship';
import { supabase } from '@/lib/supabase';
import { withSession, type Outcome } from '@/lib/territory-sync';

/** PostgREST's hard page size. Paged rather than assumed — see this file's
 *  header for what happened the last time a read here assumed. */
const PAGE = 1000;

/** One park-path cell, with the municipio it was attributed to. The
 *  municipio is for districtLabel's decorative caption only — see its own
 *  comment for why nothing scores by it. */
export interface ParkCell {
  h3: string;
  municipio: string;
}

/**
 * A district's park-path cells, for districtLabel's caption only.
 *
 * Empty is a valid answer (most of the planet has no extracted park data);
 * callers must fall back to something else, never render "0 parks".
 */
export async function fetchDistrictParkCells(
  district: string,
): Promise<Outcome<{ parkCells: ParkCell[] }>> {
  return withSession<{ parkCells: ParkCell[] }>(async () => {
    const pattern = `${districtCellPattern(district)}%`;
    const parkCells: ParkCell[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await supabase
        .from('park_path_cells')
        .select('h3, municipio')
        .like('h3', pattern)
        // Ordered so paging is deterministic — (municipio, h3) is the
        // primary key, so h3 alone is unique within a municipio and the pair
        // is a total order. Same reasoning as fetchTileLeaderboard's paging.
        .order('municipio', { ascending: true })
        .order('h3', { ascending: true })
        .range(offset, offset + PAGE - 1);
      if (error || !data) return { ok: false, reason: 'network' as const };
      parkCells.push(...data);
      if (data.length < PAGE) break;
    }
    return { ok: true, parkCells };
  });
}

/**
 * The district's visits: Board 2's raw material.
 *
 * Everyone's, not just this device's — mayorship is a contest, so the whole
 * district's visits are needed to decide who holds each cell. The window is
 * applied CLIENT-SIDE in mayorByCell rather than as a `gte` here, on purpose:
 * one function owns what "inside the window" means, so the fetch and the
 * ranking can never disagree about it, and MAYORSHIP_WINDOW_DAYS stays a
 * single constant to tune.
 *
 * Ceiling, stated because it will arrive: tile_visits grows by roughly the
 * number of cells a run touches directly (~160 for a 3 km run — visits, not
 * enclosure). The district prefix keeps this proportional to one arena rather
 * than the whole table, and `tile_visits` has no index usable by a prefix
 * LIKE (its indexes are on user_id and run_id), so this is a sequential scan.
 * Fine at 1,745 rows; when it is not, the fix is an RPC that returns
 * mayorship per cell, not more paging here.
 */
export async function fetchDistrictVisits(
  /** One district, or every district covering a subdivision (subdivisions.ts
   *  cuts the exact outline on device afterwards). */
  districts: string | string[],
): Promise<Outcome<{ visits: TileVisitRow[] }>> {
  return withSession<{ visits: TileVisitRow[] }>(async () => {
    const rows: { h3: string; user_id: string; visited_at: string; run_id: string }[] = [];
    // Chunked so a municipio's hundred-odd districts never build one giant
    // URL; each chunk pages on its own. Chunks can't overlap (districts are
    // disjoint), so concatenating them never double-counts a visit.
    for (const chunk of districtChunks(typeof districts === 'string' ? [districts] : districts)) {
      for (let offset = 0; ; offset += PAGE) {
        const { data, error } = await supabase
          .from('tile_visits')
          .select('h3, user_id, visited_at, run_id')
          .or(districtsOrFilter(chunk))
          // (h3, run_id) is the primary key; h3 alone is not unique, so the
          // second key makes paging deterministic.
          .order('h3', { ascending: true })
          .order('run_id', { ascending: true })
          .range(offset, offset + PAGE - 1);
        if (error || !data) return { ok: false, reason: 'network' as const };
        rows.push(...data);
        if (data.length < PAGE) break;
      }
    }

    // Names in one follow-up query keyed on the distinct users present,
    // rather than a PostgREST embed: tile_visits has no FK to profiles (it
    // references auth.users), so there is no relationship for PostgREST to
    // resolve. Same shape as fetchTileLeaderboard's own profile lookup.
    const userIds = Array.from(new Set(rows.map((r) => r.user_id)));
    const nameById = new Map<string, string | null>();
    if (userIds.length > 0) {
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, display_name')
        .in('id', userIds);
      // A failed name lookup leaves every displayName null, which renders as
      // "Anonymous". The mayorship itself is unaffected — the count is the
      // point, the name is a garnish.
      if (profiles) for (const p of profiles) nameById.set(p.id, p.display_name ?? null);
    }

    return {
      ok: true,
      visits: rows.map((r) => ({
        h3: r.h3,
        userId: r.user_id,
        displayName: nameById.get(r.user_id) ?? null,
        visitedAt: r.visited_at,
        runId: r.run_id,
      })),
    };
  });
}

/** Runs per `run_stats` call — the function's own cap. */
const RUN_STATS_PER_CALL = 2000;

/**
 * Distance, duration and laps of the runs behind an arena's visits, for
 * Local Leaders' tiebreakers and row totals. Through the `run_stats` RPC
 * (20260930120000_runs_laps_and_stats), because `runs` itself is readable
 * only by its owner — the RPC returns those three numbers and nothing else,
 * and nothing for a flagged run.
 *
 * A failure is its own outcome, not an empty map: before the migration is
 * applied this errors, and the board must then say it has no effort numbers
 * rather than show everyone at zero.
 */
export async function fetchRunStats(
  runIds: string[],
): Promise<Outcome<{ stats: Map<string, RunStats> }>> {
  return withSession<{ stats: Map<string, RunStats> }>(async () => {
    const stats = new Map<string, RunStats>();
    const unique = [...new Set(runIds)];
    for (let i = 0; i < unique.length; i += RUN_STATS_PER_CALL) {
      const { data, error } = await supabase.rpc('run_stats', {
        p_run_ids: unique.slice(i, i + RUN_STATS_PER_CALL),
      });
      if (error || !Array.isArray(data)) return { ok: false, reason: 'network' as const };
      for (const row of data as { id: string; distance_m: number | string; duration_s: number; laps: number }[]) {
        stats.set(row.id, {
          // numeric arrives as a string from PostgREST.
          distanceM: Number(row.distance_m),
          durationS: row.duration_s,
          laps: row.laps,
        });
      }
    }
    return { ok: true, stats };
  });
}

/** Runs per request when fetching sessions' whole visit lists. */
const RUNS_PER_REQUEST = 100;

/**
 * Every visit of the given runs, wherever they are — each session's WHOLE
 * path, so its enclosure can be rebuilt (local-leaders.ts,
 * sessionGroundVisits). The arena read only returns tiles near the arena, and
 * a loop that crosses its edge would never close from that alone.
 */
export async function fetchRunVisits(
  runIds: string[],
  nameById: Map<string, string | null>,
): Promise<Outcome<{ visits: TileVisitRow[] }>> {
  return withSession<{ visits: TileVisitRow[] }>(async () => {
    const unique = [...new Set(runIds)];
    const visits: TileVisitRow[] = [];
    for (let i = 0; i < unique.length; i += RUNS_PER_REQUEST) {
      const chunk = unique.slice(i, i + RUNS_PER_REQUEST);
      for (let offset = 0; ; offset += PAGE) {
        const { data, error } = await supabase
          .from('tile_visits')
          .select('h3, user_id, visited_at, run_id')
          .in('run_id', chunk)
          .order('h3', { ascending: true })
          .order('run_id', { ascending: true })
          .range(offset, offset + PAGE - 1);
        if (error || !data) return { ok: false, reason: 'network' as const };
        for (const r of data) {
          visits.push({
            h3: r.h3,
            userId: r.user_id,
            displayName: nameById.get(r.user_id) ?? null,
            visitedAt: r.visited_at,
            runId: r.run_id,
          });
        }
        if (data.length < PAGE) break;
      }
    }
    return { ok: true, visits };
  });
}

/**
 * Every tile the runner is Local Leaders mayor of, in EVERY place — for the
 * map's faded "your ground elsewhere" layer (Pedro, 2026-10-01). Mayorship
 * depends on other runners' days too, so it can't come from the runner's
 * own data alone:
 *
 *   1. the runner's sessions in the window, rebuilt as session ground;
 *   2. the districts that ground touches, plus one ring (a rival loop that
 *      encloses those tiles can run entirely in the next district);
 *   3. EVERY runner's sessions there, through the same pipeline the board
 *      uses (whole paths, session ground, run stats for the tiebreakers);
 *   4. the cells where the runner is mayor.
 *
 * Heavier than one place's board, so callers load it once per tab visit and
 * on pull-to-refresh, never per place switch.
 */
export async function fetchMyMayorCells(
  now: number = Date.now(),
): Promise<Outcome<{ cells: string[] }>> {
  return withSession<{ cells: string[] }>(async (session) => {
    const me = session.user.id;
    const cutoffMs = now - MAYORSHIP_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    const cutoff = new Date(cutoffMs).toISOString();

    // 1. The runner's own sessions in the window.
    const myRunIds = new Set<string>();
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await supabase
        .from('tile_visits')
        .select('run_id')
        .eq('user_id', me)
        .gte('visited_at', cutoff)
        .order('run_id', { ascending: true })
        .order('h3', { ascending: true })
        .range(offset, offset + PAGE - 1);
      if (error || !data) return { ok: false, reason: 'network' as const };
      for (const row of data as { run_id: string }[]) myRunIds.add(row.run_id);
      if (data.length < PAGE) break;
    }
    if (myRunIds.size === 0) return { ok: true, cells: [] };

    const mine = await fetchRunVisits([...myRunIds], new Map());
    if (!mine.ok) return { ok: false, reason: 'network' as const };

    // 2. Districts the runner's ground touches, plus one ring.
    const districts = new Set<string>();
    for (const v of sessionGroundVisits(mine.visits)) {
      const d = districtOfCell(v.h3);
      if (d) for (const near of gridDisk(d, 1)) districts.add(near);
    }
    if (districts.size === 0) return { ok: true, cells: [] };

    // 3. Everyone's sessions there, inside the window.
    const there = await fetchDistrictVisits([...districts]);
    if (!there.ok) return { ok: false, reason: 'network' as const };
    const runIds = [
      ...new Set(
        there.visits.flatMap((v) => (v.runId && Date.parse(v.visitedAt) >= cutoffMs ? [v.runId] : [])),
      ),
    ];
    const [all, stats] = await Promise.all([
      fetchRunVisits(runIds, namesOf(there.visits)),
      fetchRunStats(runIds),
    ]);
    if (!all.ok) return { ok: false, reason: 'network' as const };

    // 4. Where the runner is mayor. Stats missing (the RPC failing) only
    //    drops the tiebreakers, exactly as on the board.
    const mayors = mayorByCell(sessionGroundVisits(all.visits), now, stats.ok ? stats.stats : undefined);
    const cells: string[] = [];
    for (const [h3, mayor] of mayors) if (mayor.userId === me) cells.push(h3);
    return { ok: true, cells };
  });
}
