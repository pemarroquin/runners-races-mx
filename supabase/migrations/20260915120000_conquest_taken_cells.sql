-- The "You took N tiles" banner only ever had a COUNT of taken tiles, never
-- which cells they were, so the summary map could say "you took 598 tiles"
-- but never show WHERE. The reference UX Pedro wants (small "+N" bubbles
-- dropped on the map at each area conquered, like a delivery app's per-stop
-- badge) needs the actual h3 ids.
--
-- Those ids only exist inside this function's own claim transaction: the
-- upsert below overwrites territory_tiles.owner_id in place, so by the time
-- the client could read it back, the previous owner is already gone. A
-- client-side "query territory_tiles after the claim" cannot reconstruct
-- this — there is nothing left to distinguish a taken cell from a
-- newly-claimed one once ownership has flipped. This has to be computed here,
-- in the same query that already knows the pre-claim owner (`before`), and
-- returned alongside the counts — one RPC call, no extra round trip, and no
-- race with a concurrent claim.
--
-- Replaces the function wholesale (plpgsql cannot be patched statement by
-- statement); everything outside the two marked changes is copied verbatim
-- from 20260909230000_conquest_taken_excludes_self.sql.
--
-- APPLY BY HAND in the Supabase SQL editor — nothing in this repo runs
-- migrations. Verify AFTER applying, not before: a plpgsql body is planned
-- on first call, so a broken one installs perfectly cleanly.
--
-- DROP first, unlike every prior claim_run_tiles migration: this one changes
-- the OUT parameter list (adds taken_cells), and Postgres refuses that under
-- CREATE OR REPLACE — "cannot change return type of existing function"
-- (42P13). Reproduced 2026-09-15 applying this by hand; Postgres's own hint
-- names the exact fix.
drop function if exists claim_run_tiles(uuid, text[], text[], text);

create function claim_run_tiles(
  p_run_id  uuid,
  p_visited text[],
  p_enclosed text[],
  p_region  text
)
-- CHANGE 1: taken_cells added to the return shape.
returns table (claimed integer, taken integer, skipped_older integer, taken_cells text[])
language plpgsql
as $$
declare
  claim_window interval := interval '12 hours';
  tile_area_m2 constant numeric := 307.1;
  r            record;
  all_cells    text[];
  max_claimable integer;
  n_claimed    integer := 0;
  n_taken      integer := 0;
  n_kept       integer := 0;
  -- CHANGE 2: the h3 ids behind n_taken, not just the count.
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

  max_claimable := greatest(
    64,
    ceil((r.distance_m * r.distance_m) / (4 * pi() * tile_area_m2) * 1.5)::integer
      + ceil(r.distance_m / 10.8)::integer
  );
  if array_length(all_cells, 1) > max_claimable then
    raise exception 'CLAIM_IMPLAUSIBLE: run % claims % tiles, above the bound of % for %m',
      p_run_id, array_length(all_cells, 1), max_claimable, r.distance_m;
  end if;

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
          claim_run_id    = excluded.claim_run_id,
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
    -- CHANGE 2 (cont'd): same filter as n_taken's count, aggregated instead.
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
