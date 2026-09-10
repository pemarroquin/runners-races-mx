-- "You took N tiles" must mean N tiles taken FROM SOMEBODY. It didn't.
--
-- claim_run_tiles counted `taken` as every upserted row that was an UPDATE
-- rather than an INSERT (`(xmax = 0) as inserted`). An update happens
-- whenever the tile already existed and this run's claim is newer —
-- INCLUDING when the previous owner is the same runner. So re-running your
-- own ground reported "You took 5 tiles" while the holdings total below it
-- did not move: two numbers on one screen disagreeing, which reads as a bug
-- in whichever one you trust less.
--
-- Reproduced 2026-09-09 by running one loop twice as a single user: the
-- second run reported taken = 5 with holdings unchanged at 16.
--
-- The previous owner cannot be read out of `ON CONFLICT ... RETURNING` (that
-- returns the NEW row), so ownership is snapshotted before the upsert and
-- joined to afterwards. `taken` now counts only cells whose previous owner
-- was somebody else. Ground you re-ran (n_kept) is neither taken NOR
-- skipped — it was already yours, so it is subtracted out of skipped_older
-- rather than being reported as "someone else beat you here".
--
-- Replaces the function wholesale (plpgsql cannot be patched statement by
-- statement); everything outside the three marked changes is copied verbatim
-- from 20260908010000_conquest.sql, INCLUDING the future-date guard and the
-- CLAIM_TOO_OLD raise the client maps to its 'tooOld' reason.
--
-- APPLY BY HAND in the Supabase SQL editor — nothing in this repo runs
-- migrations. Verify AFTER applying, not before: a plpgsql body is planned
-- on first call, so a broken one installs perfectly cleanly.

create or replace function claim_run_tiles(
  p_run_id  uuid,
  p_visited text[],
  p_enclosed text[],
  p_region  text
)
returns table (claimed integer, taken integer, skipped_older integer)
language plpgsql
as $$
declare
  -- How stale an upload may be and still claim territory, measured from the
  -- RUN's end, not the upload's arrival.
  --
  -- Pedro's first instinct was 3 hours. Widened here, and the reasoning is
  -- worth keeping: ordering by ended_at already makes a stale upload
  -- self-correcting — a two-day-old run automatically loses every tile
  -- anyone has run since, and can only take ground nobody has touched. It
  -- also kills run-hoarding, because an old run can never beat a newer one.
  -- So this window is not a safety mechanism, it is a product choice about
  -- whether a run you could not upload in time counts at all. 12 h covers a
  -- dead battery or a canyon with no signal while keeping the client clock
  -- pinned to a narrow band (see the future check below).
  -- CHANGE THIS ONE CONSTANT to move it; nothing else depends on the value.
  claim_window interval := interval '12 hours';
  -- Area of one res-12 H3 cell, m². A published H3 constant, same "known
  -- constant" approach as the tile edge length in the plausibility guard.
  tile_area_m2 constant numeric := 307.1;
  r            record;
  all_cells    text[];
  max_claimable integer;
  n_claimed    integer := 0;
  n_taken      integer := 0;
  -- Cells this run re-claimed from ITSELF (see the counting below).
  n_kept       integer := 0;
begin
  select id, user_id, ended_at, distance_m into r from runs where id = p_run_id;
  if r.id is null then
    raise exception 'CLAIM: no such run %', p_run_id;
  end if;
  if r.user_id <> auth.uid() then
    raise exception 'CLAIM: run % does not belong to the caller', p_run_id;
  end if;

  -- A run cannot finish in the future. Without this the whole ordering rule
  -- inverts into a weapon: ended_at comes from the phone, so a client could
  -- stamp a run in the year 3000 and hold those tiles against every real
  -- run forever. This is the single most important line in the file.
  if r.ended_at > now() then
    raise exception 'CLAIM: run % claims to end in the future (%)', p_run_id, r.ended_at;
  end if;

  if now() - r.ended_at > claim_window then
    raise exception 'CLAIM_TOO_OLD: run % ended % ago, past the % window', p_run_id, now() - r.ended_at, claim_window;
  end if;

  all_cells := array(select distinct unnest(coalesce(p_visited, '{}') || coalesce(p_enclosed, '{}')));

  -- Nothing to claim is a normal outcome (a run too short to cover a cell,
  -- or one whose every cell is already held by a newer run). Returning early
  -- keeps array_length's NULL-for-empty out of the arithmetic below.
  if coalesce(array_length(all_cells, 1), 0) = 0 then
    return query select 0, 0, 0;
    return;
  end if;

  -- Bound on how much ONE run may claim. The hard geometric ceiling: no
  -- closed path encloses more area than a circle of the same perimeter, so
  -- for a run of distance d the enclosed area cannot exceed d^2/(4*pi). In
  -- tiles that is d^2/(4*pi*tile_area). Add the perimeter itself and a
  -- margin for tile granularity and GPS wander.
  --
  -- This does not catch a plausible forgery — a fabricated but realistic run
  -- passes. What it stops is scale: "claim half the city" cannot get through
  -- a legitimate-looking distance. A 10 km run is bounded near 39 000 tiles
  -- against a true maximum of about 25 900.
  max_claimable := greatest(
    64,
    ceil((r.distance_m * r.distance_m) / (4 * pi() * tile_area_m2) * 1.5)::integer
      + ceil(r.distance_m / 10.8)::integer
  );
  if array_length(all_cells, 1) > max_claimable then
    raise exception 'CLAIM_IMPLAUSIBLE: run % claims % tiles, above the bound of % for %m',
      p_run_id, array_length(all_cells, 1), max_claimable, r.distance_m;
  end if;

  -- Ground actually crossed goes to the visit log, and ONLY that. Enclosed
  -- tiles are owned, never visited: the plausibility trigger on tile_visits
  -- bounds a run's tiles against its distance, and enclosure deliberately
  -- claims far more than the distance covers, so logging them there would
  -- reject every loop run outright.
  if coalesce(array_length(p_visited, 1), 0) > 0 then
    insert into tile_visits (h3, user_id, run_id)
    select unnest(p_visited), r.user_id, r.id
    on conflict (h3, run_id) do nothing;
  end if;

  -- The claim itself. `where excluded.claimed_at > territory_tiles.claimed_at`
  -- is the conquest rule in one line, and the trigger above enforces the same
  -- thing for anything that does not come through here.
  -- Ownership as it stands BEFORE this claim. `as materialized` is
  -- load-bearing: inlined, this would be evaluated against the table the
  -- upsert beside it is writing, and read back the new owner it is supposed
  -- to be comparing against.
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
    count(*) filter (where not u.inserted and b.owner_id = r.user_id)
    into n_claimed, n_taken, n_kept
  from upserted u
  left join before b on b.h3 = u.h3;

  -- last_visited_at on every tile this run touched, including ones it did
  -- not win — the visit is real whatever the claim did.
  update territory_tiles set last_visited_at = now() where h3 = any(all_cells);

  -- skipped_older: cells this run touched but did NOT win, because the tile
  -- is already held by a run that finished later. Reported rather than
  -- swallowed — "you ran here and it is not yours" needs to be explainable.
  return query select
    coalesce(n_claimed, 0),
    coalesce(n_taken, 0),
    (array_length(all_cells, 1)
       - coalesce(n_claimed, 0)
       - coalesce(n_taken, 0)
       - coalesce(n_kept, 0))::integer;
end;
$$;
