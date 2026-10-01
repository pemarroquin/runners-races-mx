-- APPLIED by hand and VERIFIED 2026-10-01: late_cap_installed = false,
-- visits_stamped_with_ended_at = false, twelve_hour_window = true.
--
-- REVERT of 20261001120000_late_claims_within_7_days (Pedro, 2026-10-01):
-- Leaderboard territory goes back to the 12-hour claim window. Late runs are
-- kept, without restriction, in Profile › Places I've been instead — that
-- screen now draws every saved run from its own stored route, claimed or not
-- (client change in the same branch), so nothing a runner ran is lost from
-- their history.
--
-- This is the function body of 20260920160000 VERBATIM — the documented
-- rollback for 20261001120000. It also restores tile_visits.visited_at to
-- the upload time (column default), which inside a 12 h window differs from
-- the run's end time by hours at most.
--
-- APPLY by hand in the SQL editor, then VERIFY — both must be FALSE:
--   select position('late_cap' in pg_get_functiondef('claim_run_tiles(uuid,text[],text[],text)'::regprocedure)) > 0 as late_cap_installed,
--          position('select unnest(p_visited), r.user_id, r.id, r.ended_at' in pg_get_functiondef('claim_run_tiles(uuid,text[],text[],text)'::regprocedure)) > 0 as visits_stamped_with_ended_at;
-- and this must be TRUE (the 12-hour refusal is back):
--   select position('if now() - r.ended_at > claim_window then' in pg_get_functiondef('claim_run_tiles(uuid,text[],text[],text)'::regprocedure)) > 0 as twelve_hour_window;
-- Applied by hand: run `supabase migration repair --status applied
-- 20261001120000 20261001130000` before any `db push`.

create or replace function claim_run_tiles(
  p_run_id  uuid,
  p_visited text[],
  p_enclosed text[],
  p_region  text
)
returns table (claimed integer, taken integer, skipped_older integer, taken_cells text[])
language plpgsql
as $$
declare
  claim_window interval := interval '12 hours';
  tile_area_m2 constant numeric := 307.1;
  r            record;
  all_cells    text[];
  max_claimable integer;
  -- THE SPLIT: three new locals. Nothing else in this block changed.
  n_visited        integer;
  n_enclosed       integer;
  owned_tiles      integer;
  enclosed_ceiling integer;
  n_claimed    integer := 0;
  n_taken      integer := 0;
  n_kept       integer := 0;
  n_taken_cells text[] := '{}';
begin
  select id, user_id, ended_at, distance_m into r from runs where id = p_run_id;
  if r.id is null then
    raise exception 'CLAIM: no such run %', p_run_id;
  end if;
  if r.user_id <> auth.uid() then
    raise exception 'CLAIM: run % does not belong to the caller', p_run_id;
  end if;

  if r.ended_at > now() then
    raise exception 'CLAIM: run % claims to end in the future (%)', p_run_id, r.ended_at;
  end if;

  if now() - r.ended_at > claim_window then
    raise exception 'CLAIM_TOO_OLD: run % ended % ago, past the % window', p_run_id, now() - r.ended_at, claim_window;
  end if;

  all_cells := array(select distinct unnest(coalesce(p_visited, '{}') || coalesce(p_enclosed, '{}')));

  if coalesce(array_length(all_cells, 1), 0) = 0 then
    return query select 0, 0, 0, '{}'::text[];
    return;
  end if;

  -- ==========================================================================
  -- THE CHANGE, and the only one in this file: ONE bound over the combined
  -- array becomes TWO bounds over the two halves. See the header.
  -- ==========================================================================
  n_visited  := coalesce(array_length(array(select distinct unnest(coalesce(p_visited,  '{}'))), 1), 0);
  n_enclosed := coalesce(array_length(array(select distinct unnest(coalesce(p_enclosed, '{}'))), 1), 0);

  -- Unchanged, digit for digit, from every version since 20260908010000.
  max_claimable := greatest(
    64,
    ceil((r.distance_m * r.distance_m) / (4 * pi() * tile_area_m2) * 1.5)::integer
      + ceil(r.distance_m / 10.8)::integer
  );

  -- BOUND 1 — ground actually run over, against this run's own distance.
  -- The anti-forgery guard. Not weakened; only its subject narrowed from
  -- (visited + enclosed) to visited, which can never reject more than before.
  if n_visited > max_claimable then
    raise exception
      'CLAIM_IMPLAUSIBLE: run % claims % VISITED tiles, above the visited bound of % for a %m run',
      p_run_id, n_visited, max_claimable, r.distance_m;
  end if;

  -- BOUND 2 — ground surrounded but not crossed, against what this runner's
  -- existing territory could bound plus this run's own reach. Indexed count
  -- on territory_tiles_owner_idx. Read BEFORE any write below, so it is the
  -- pre-run holding, never inflated by this claim.
  select count(*) into owned_tiles from territory_tiles where owner_id = r.user_id;
  enclosed_ceiling := coalesce(owned_tiles, 0) + max_claimable;

  if n_enclosed > enclosed_ceiling then
    raise exception
      'CLAIM_IMPLAUSIBLE: run % claims % ENCLOSED tiles, above the enclosed ceiling of % (% tiles already owned + % for a %m run)',
      p_run_id, n_enclosed, enclosed_ceiling, coalesce(owned_tiles, 0), max_claimable, r.distance_m;
  end if;
  -- ==========================================================================
  -- END OF THE CHANGE. Everything below is verbatim from 20260920140000.
  -- ==========================================================================

  if coalesce(array_length(p_visited, 1), 0) > 0 then
    insert into tile_visits (h3, user_id, run_id)
    select unnest(p_visited), r.user_id, r.id
    on conflict (h3, run_id) do nothing;
  end if;

  with before as materialized (
    select h3, owner_id from territory_tiles where h3 = any(all_cells)
  ),
  upserted as (
    insert into territory_tiles as t (h3, owner_id, first_claimed_at, claim_run_id, claimed_at, last_visited_at, region_id)
    select unnest(all_cells), r.user_id, r.ended_at, r.id, r.ended_at, now(), p_region
    on conflict (h3) do update
      set owner_id        = excluded.owner_id,
          -- Provenance moves ONLY when the tile actually changes hands. A
          -- re-run over ground you already hold keeps pointing at the run
          -- that won it. Carried forward verbatim from 20260920140000 —
          -- that migration is applied to production and rewriting this
          -- expression would silently revert it.
          claim_run_id    = case
                              when t.owner_id is distinct from excluded.owner_id
                                then excluded.claim_run_id
                              else t.claim_run_id
                            end,
          claimed_at      = excluded.claimed_at,
          last_visited_at = now(),
          region_id       = coalesce(excluded.region_id, t.region_id)
      where excluded.claimed_at > t.claimed_at
    returning t.h3, (xmax = 0) as inserted
  )
  select
    count(*) filter (where u.inserted),
    count(*) filter (where not u.inserted and b.owner_id is distinct from r.user_id),
    count(*) filter (where not u.inserted and b.owner_id = r.user_id),
    coalesce(array_agg(u.h3) filter (where not u.inserted and b.owner_id is distinct from r.user_id), '{}')
    into n_claimed, n_taken, n_kept, n_taken_cells
  from upserted u
  left join before b on b.h3 = u.h3;

  update territory_tiles set last_visited_at = now() where h3 = any(all_cells);

  return query select
    coalesce(n_claimed, 0),
    coalesce(n_taken, 0),
    (array_length(all_cells, 1)
       - coalesce(n_claimed, 0)
       - coalesce(n_taken, 0)
       - coalesce(n_kept, 0))::integer,
    coalesce(n_taken_cells, '{}');
end;
$$;
