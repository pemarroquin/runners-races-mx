// The leaderboard's district-scoped read.
//
// Filters SERVER-SIDE by the district's H3 prefix (districtCellPattern)
// rather than pulling a table down and truncating every id on device — this
// repo has already shipped a leaderboard that silently ranked a truncated
// 1000-row sample (see fetchTileLeaderboard's own paging comment).
//
// Board 2 (Local Leaders) DOES need SQL since 2026-10-23: its scoring moved
// into 20261023120000 so `tile_visits` could stop serving every runner's
// dated routes. The old rule here was "needs no migration, so forgetting
// one can't break it"; that rule cost a privacy hole. An unapplied
// migration now FAILS the board (an RPC error is 'network', and the card
// says it couldn't load), never a silent zero.
//
// A park-path read used to live here and was deleted 2026-09-09 — at the
// time, `park_path_cells` was genuinely empty in production, so the read fed
// nothing and the conquest denominator moved to claimed ground instead (see
// leaderboard.ts's ConquestEntry.share; that change stands). The table was
// loaded the same day (36,193 cells, see BACKLOG). `fetchDistrictParkCells`
// is restored ONLY for district.ts's districtLabel — a decorative caption,
// never a score — not for any denominator.
import { districtCellPattern } from '@/lib/district';
import type { RunnerTotals } from '@/lib/local-leaders';
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

/** One mayor per cell, cut to the arena: what the map and the ranking both
 *  read, so they can't disagree. */
export type MayorMap = Map<string, { userId: string; days: number }>;

/** Board 2, as the server scored it (20261023120000). */
export interface LocalLeaders {
  /** Every cell with a mayor inside the arena. */
  mayors: MayorMap;
  /** Display names of those mayors; null renders as Anonymous. */
  names: Map<string, string | null>;
  /** Distinct days each mayor was anywhere in the arena, in the window. */
  days: Map<string, number>;
  /** 30-day totals of each mayor's sessions touching the arena. A mayor
   *  whose every session there is flagged has no entry. */
  totals: Map<string, RunnerTotals>;
}

/**
 * `local_leaders_cells`' answer, `[[h3, user_id, days], ...]`, cut to the
 * arena. Pure so it can be tested without a server. Anything that isn't
 * that shape throws: a board that silently drops rows reads as "nobody
 * runs here", the failure this file keeps refusing.
 */
export function parseMayorCells(raw: unknown, contains: (h3: string) => boolean): MayorMap {
  if (!Array.isArray(raw)) throw new Error('local_leaders_cells: not an array');
  const out: MayorMap = new Map();
  for (const row of raw) {
    if (
      !Array.isArray(row) ||
      typeof row[0] !== 'string' ||
      typeof row[1] !== 'string' ||
      typeof row[2] !== 'number'
    ) {
      throw new Error('local_leaders_cells: malformed row');
    }
    if (contains(row[0])) out.set(row[0], { userId: row[1], days: row[2] });
  }
  return out;
}

/** `local_leaders_runners`' answer as the row numbers the card shows.
 *  numeric arrives from Postgres as a number inside jsonb, but is coerced
 *  anyway: a string there would otherwise concatenate on the next sum. */
export function parseRunnerRows(raw: unknown): { days: Map<string, number>; totals: Map<string, RunnerTotals> } {
  if (!Array.isArray(raw)) throw new Error('local_leaders_runners: not an array');
  const days = new Map<string, number>();
  const totals = new Map<string, RunnerTotals>();
  for (const row of raw as Record<string, unknown>[]) {
    if (typeof row?.user_id !== 'string' || typeof row.days !== 'number') {
      throw new Error('local_leaders_runners: malformed row');
    }
    days.set(row.user_id, row.days);
    const runs = Number(row.runs);
    // Same rule as runnerTotals: a runner with no countable session has no
    // totals, never a row of zeros.
    if (runs > 0) {
      totals.set(row.user_id, {
        distanceM: Number(row.distance_m),
        durationS: Number(row.duration_s),
        laps: Number(row.laps),
        runs,
      });
    }
  }
  return { days, totals };
}

/** District prefixes per `local_leaders_cells` call — under the function's
 *  own cap of 2000. Districts are disjoint, so chunks never double-count. */
const PREFIXES_PER_CALL = 1000;

/**
 * Board 2 for one arena, scored on the server.
 *
 * Until 2026-10-23 this pulled every runner's raw `tile_visits` (route,
 * run and date for every 9 m cell) and rebuilt everyone's sessions on this
 * device. That read is what kept `tile_visits` world-readable. Now each
 * session's ground is stored once and Postgres decides the mayors with the
 * rule mayorship.ts still defines (test/local-leaders-sql.test.ts holds the
 * two equal), returning only what the board shows.
 *
 * Two calls, in order: the mayors under the arena's districts (cut to the
 * exact outline here, by `contains`, as before), then the numbers for the
 * mayors of exactly those cells. Either failing fails the board: a card
 * with mayors but no days would show everyone at "0 days".
 */
export async function fetchLocalLeaders(arena: {
  districts: string[];
  contains: (h3: string) => boolean;
}): Promise<Outcome<{ leaders: LocalLeaders }>> {
  return withSession<{ leaders: LocalLeaders }>(async () => {
    const prefixes = [...new Set(arena.districts.map(districtCellPattern))];
    const mayors: MayorMap = new Map();
    for (let i = 0; i < prefixes.length; i += PREFIXES_PER_CALL) {
      const { data, error } = await supabase.rpc('local_leaders_cells', {
        p_prefixes: prefixes.slice(i, i + PREFIXES_PER_CALL),
      });
      if (error) return { ok: false, reason: 'network' as const };
      for (const [h3, mayor] of parseMayorCells(data, arena.contains)) mayors.set(h3, mayor);
    }

    const empty = { days: new Map<string, number>(), totals: new Map<string, RunnerTotals>() };
    let numbers = empty;
    if (mayors.size > 0) {
      const { data, error } = await supabase.rpc('local_leaders_runners', { p_cells: [...mayors.keys()] });
      if (error) return { ok: false, reason: 'network' as const };
      numbers = parseRunnerRows(data);
    }

    // Names in one follow-up query, as fetchTileLeaderboard does. A failed
    // lookup leaves names null ("Anonymous"); the ranking is unaffected.
    const names = new Map<string, string | null>();
    const userIds = [...new Set([...mayors.values()].map((m) => m.userId))];
    if (userIds.length > 0) {
      const { data: profiles } = await supabase.from('profiles').select('id, display_name').in('id', userIds);
      if (profiles) for (const p of profiles) names.set(p.id, p.display_name ?? null);
    }

    return { ok: true, leaders: { mayors, names, ...numbers } };
  });
}

/**
 * Every tile the runner is Local Leaders mayor of, in EVERY place — for the
 * map's faded "your ground elsewhere" layer (Pedro, 2026-10-01). One RPC
 * now: mayorship of a cell depends only on the ground stored on it, so the
 * server takes the runner's own ground cells in the window and decides each
 * against everyone's. The district + ring gathering this used to need was
 * for rebuilding rivals' enclosure on device, which no longer happens.
 */
export async function fetchMyMayorCells(): Promise<Outcome<{ cells: string[] }>> {
  return withSession<{ cells: string[] }>(async () => {
    const { data, error } = await supabase.rpc('my_mayor_cells');
    if (error || !Array.isArray(data)) return { ok: false, reason: 'network' as const };
    return { ok: true, cells: data.filter((c): c is string => typeof c === 'string') };
  });
}
