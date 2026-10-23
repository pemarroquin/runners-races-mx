-- Local Leaders moves server-side, so `tile_visits` can stop being
-- world-readable. STEP 1 OF 2 — this file narrows NOTHING.
--
-- WHY. "tile_visits: read all" (20260903120000) serves every runner's every
-- session as a set of 9 m cells, grouped by run and dated: the route and the
-- schedule, to anyone holding the publishable key (an anonymous session is
-- one call away, so "authenticated only" is not a fix). The read-all was
-- load-bearing: Local Leaders rebuilt each session's GROUND (crossed tiles
-- plus the inside of loops it closed, local-leaders.ts sessionGroundVisits)
-- on every reader's device from other runners' raw visits.
--
-- THE SHAPE (Pedro, 2026-10-23: "deeply fix all this"):
--   1. each session's ground is STORED, once — `run_sessions` + `run_ground`.
--      The crossed tiles are mirrored from tile_visits by a trigger (and
--      backfilled below). The enclosed tiles need H3 polygon maths that this
--      instance does not have (no h3 extension, see supabase/blocked/), so
--      the runner's own device computes them from its own run and records
--      them through `record_run_ground`, bounded like a claim.
--   2. Local Leaders is scored HERE (`local_leaders_cells`,
--      `local_leaders_runners`, `my_mayor_cells`), returning what the board
--      displays — the mayor of each cell, and per-mayor days/totals — never
--      a run id, a per-session cell set or a timestamp.
--   3. 20261023130000 then narrows tile_visits to select-own. Apply it only
--      AFTER the client that reads these functions is live (guard first,
--      then data, then deploy, then narrow).
--
-- THE ONE MAYOR RULE lives in `local_leader_mayors`, and it is
-- mayorship.ts's mayorByCell transcribed: per cell, per runner, distinct UTC
-- days of sessions in the trailing 30 days; ties on days go to more laps in
-- those sessions, then more distance (flagged runs add no effort but still
-- count their day, exactly as run_stats left them out), then the earliest
-- session (incumbency), then the lower user id. src/lib/local-leaders-sql
-- .test.ts runs this file in an embedded Postgres and holds it equal to the
-- TypeScript on random data.
--
-- RESIDUAL, stated: local_leaders_runners aggregates over a cell list the
-- caller chooses, and returns rows only for runners who are mayor of one of
-- those cells. A caller can still pair a mayor's cell with another cell and
-- see whether that runner's day count moves. That is an inference about a
-- runner whose ground the board already shows, not a feed of everyone's
-- dated routes, which is what this replaces.
--
-- APPLY by hand in the SQL editor (or `supabase db push` after a
-- `migration repair`, see the drift memory), then VERIFY with the queries at
-- the bottom. Applying is not verifying: plpgsql plans lazily.

-- ============================================================================
-- 1. Stored ground
-- ============================================================================

create table if not exists public.run_sessions (
  run_id             uuid primary key references public.runs(id) on delete cascade,
  user_id            uuid not null references auth.users(id),
  -- The session's day: its EARLIEST visit, as sessionGroundVisits stamped
  -- every ground tile with. One day per session, so a run across UTC
  -- midnight counts once.
  session_at         timestamptz not null,
  -- Whether the runner's device has recorded this session's enclosure.
  -- Separate from "has enclosed rows": most sessions honestly enclose
  -- nothing, and the device must not ask again for those.
  enclosure_recorded boolean not null default false
);

create index if not exists run_sessions_window_idx on public.run_sessions (session_at);
create index if not exists run_sessions_user_idx on public.run_sessions (user_id);

create table if not exists public.run_ground (
  run_id   uuid not null references public.run_sessions(run_id) on delete cascade,
  h3       text not null,
  -- true = surrounded, not crossed. Display-only distinction; both count.
  enclosed boolean not null default false,
  primary key (run_id, h3)
);

-- Prefix reads (a district is a fixed-length prefix of its res-12 cells,
-- district.ts districtCellPattern) and exact-cell reads.
create index if not exists run_ground_h3_idx on public.run_ground (h3 text_pattern_ops);

alter table public.run_sessions enable row level security;
alter table public.run_ground enable row level security;

-- Own rows only, and no write policies at all: only the security definer
-- functions below write, so a client cannot hand itself ground.
drop policy if exists "run_sessions: select own" on public.run_sessions;
create policy "run_sessions: select own" on public.run_sessions
  for select using (auth.uid() = user_id);

drop policy if exists "run_ground: select own" on public.run_ground;
create policy "run_ground: select own" on public.run_ground
  for select using (
    exists (select 1 from public.run_sessions s where s.run_id = run_ground.run_id and s.user_id = auth.uid())
  );

-- ============================================================================
-- 2. Crossed tiles mirror tile_visits
-- ============================================================================

-- Writes the session and its crossed tiles from whatever tile_visits rows a
-- claim just inserted. Shared by the trigger and by record_run_ground's
-- repair, so the two can't disagree about what a session's ground is.
create or replace function public.mirror_run_visits(p_run_ids uuid[])
returns void
language sql
security definer
set search_path = public
as $$
  insert into run_sessions (run_id, user_id, session_at)
  select v.run_id, (array_agg(v.user_id))[1], min(v.visited_at)
  from tile_visits v
  where v.run_id = any (p_run_ids)
  group by v.run_id
  on conflict (run_id) do update
    set session_at = least(run_sessions.session_at, excluded.session_at);

  insert into run_ground (run_id, h3, enclosed)
  select v.run_id, v.h3, false
  from tile_visits v
  where v.run_id = any (p_run_ids)
  -- Crossed beats surrounded: a later partial claim that crosses a tile an
  -- earlier record called enclosed makes it crossed.
  on conflict (run_id, h3) do update set enclosed = false where run_ground.enclosed;
$$;

revoke execute on function public.mirror_run_visits(uuid[]) from public, anon, authenticated;

create or replace function public.tile_visits_mirror_ground()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform mirror_run_visits(array(select distinct run_id from new_rows));
  return null;
exception when others then
  -- A failure here must not cost the runner their CLAIM (this fires inside
  -- claim_run_tiles' insert). It is not swallowed either: the warning lands
  -- in the Postgres log, and the session is repaired the next time its
  -- device calls record_run_ground (boards' recordMissingGround), which
  -- re-mirrors from tile_visits before anything else.
  raise warning 'RUN_GROUND_MIRROR: % (%)', sqlerrm, sqlstate;
  return null;
end;
$$;

drop trigger if exists tile_visits_mirror_ground on public.tile_visits;
create trigger tile_visits_mirror_ground
  after insert on public.tile_visits
  referencing new table as new_rows
  for each statement
  execute function public.tile_visits_mirror_ground();

-- Backfill every session that already exists. Enclosure for them arrives
-- from each runner's device (recordMissingGround) or from
-- scripts/backfill-run-ground.ts.
select public.mirror_run_visits(array(select distinct run_id from public.tile_visits));

-- ============================================================================
-- 3. Enclosure, recorded by the runner's own device
-- ============================================================================

-- A res-12 cell's res-6 ancestor, as a grouping key: the index with its
-- digits 7..15 shifted off. H3's hierarchy IS index truncation, so this is
-- exact without the h3 extension, and every cell compared here is res 12.
create or replace function public.h3_res6_key(p_h3 text)
returns bigint
language sql
immutable
as $$
  select (('x' || lpad(p_h3, 16, '0'))::bit(64)::bigint) >> 27;
$$;

create or replace function public.record_run_ground(p_run_id uuid, p_enclosed text[])
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  tile_area_m2 constant numeric := 307.1;
  r            record;
  s            record;
  n_enclosed   integer;
  max_enclosed integer;
  n_recorded   integer;
begin
  select id, user_id, distance_m into r from runs where id = p_run_id;
  if r.id is null then
    raise exception 'GROUND: no such run %', p_run_id;
  end if;
  if r.user_id is distinct from auth.uid() then
    raise exception 'GROUND: run % does not belong to the caller', p_run_id;
  end if;

  -- Repair first: whatever the trigger missed, tile_visits still has.
  perform mirror_run_visits(array[p_run_id]);

  select * into s from run_sessions where run_id = p_run_id;
  -- Never claimed (no visits): no ground to add enclosure to.
  if s.run_id is null then
    return 0;
  end if;
  -- Once per session, so a client can't keep topping a session up past the
  -- bound below.
  if s.enclosure_recorded then
    return 0;
  end if;

  if exists (
    select 1 from unnest(coalesce(p_enclosed, '{}')) c where c !~ '^8c[0-9a-f]{13}$'
  ) then
    raise exception 'GROUND_IMPLAUSIBLE: run % sent a cell that is not a res-12 H3 index', p_run_id;
  end if;

  n_enclosed := coalesce(array_length(array(select distinct unnest(coalesce(p_enclosed, '{}'))), 1), 0);
  -- claim_run_tiles' own max_claimable, digit for digit. groundOfRun only
  -- encloses the session's OWN loop, so the isoperimetric term is the right
  -- bound, with no "already owned" allowance.
  max_enclosed := greatest(
    64,
    ceil((r.distance_m * r.distance_m) / (4 * pi() * tile_area_m2) * 1.5)::integer
      + ceil(r.distance_m / 10.8)::integer
  );
  if n_enclosed > max_enclosed then
    raise exception
      'GROUND_IMPLAUSIBLE: run % encloses % tiles, above the bound of % for a %m run',
      p_run_id, n_enclosed, max_enclosed, r.distance_m;
  end if;

  -- Locality: an enclosed cell must share a res-6 ancestor (~36 km²) with a
  -- cell this session actually crossed. Filtered, not rejected: an honest
  -- loop only fails this by surrounding a WHOLE res-6 region (a 20 km+
  -- loop), and then it keeps everything but that interior.
  insert into run_ground (run_id, h3, enclosed)
  select p_run_id, e.c, true
  from (select distinct unnest(coalesce(p_enclosed, '{}')) as c) e
  where h3_res6_key(e.c) in (
    select h3_res6_key(g.h3) from run_ground g where g.run_id = p_run_id and not g.enclosed
  )
  on conflict (run_id, h3) do nothing;
  get diagnostics n_recorded = row_count;

  update run_sessions set enclosure_recorded = true where run_id = p_run_id;
  return n_recorded;
end;
$$;

revoke execute on function public.record_run_ground(uuid, text[]) from public, anon;
grant execute on function public.record_run_ground(uuid, text[]) to authenticated;

-- ============================================================================
-- 4. Scoring
-- ============================================================================

-- THE mayor rule. Internal: it takes either district prefixes or exact
-- cells and returns per-cell winners; the three public functions below are
-- the only ways in, and each returns less than this does.
create or replace function public.local_leader_mayors(p_prefixes text[], p_cells text[])
returns table (h3 text, user_id uuid, days integer)
language sql
stable
security definer
set search_path = public
as $$
  -- Two ways in, one rule. Cells are JOINED, not matched with = any():
  -- an arena's cell list runs to thousands, and = any() scans the whole
  -- array once per ground row.
  with wanted as (
    select distinct c as h3 from unnest(p_cells) c
  ),
  ground as (
    select g.h3, s.user_id, s.run_id, s.session_at
    from run_sessions s
    join run_ground g on g.run_id = s.run_id
    where p_prefixes is not null
      and s.session_at >= now() - interval '30 days'
      and s.session_at <= now()
      and g.h3 like any (array(select p || '%' from unnest(p_prefixes) p))
    union
    select g.h3, s.user_id, s.run_id, s.session_at
    from wanted w
    join run_ground g on g.h3 = w.h3
    join run_sessions s on s.run_id = g.run_id
    where s.session_at >= now() - interval '30 days'
      and s.session_at <= now()
  ),
  per_runner as (
    select gr.h3, gr.user_id,
           count(distinct (gr.session_at at time zone 'utc')::date)::integer as days,
           coalesce(sum(r.laps) filter (where not r.flagged), 0) as laps,
           coalesce(sum(r.distance_m) filter (where not r.flagged), 0) as distance_m,
           min(gr.session_at) as first_at
    from ground gr
    left join runs r on r.id = gr.run_id
    group by gr.h3, gr.user_id
  )
  select distinct on (pr.h3) pr.h3, pr.user_id, pr.days
  from per_runner pr
  order by pr.h3, pr.days desc, pr.laps desc, pr.distance_m desc, pr.first_at asc,
           pr.user_id::text collate "C" asc;
$$;

revoke execute on function public.local_leader_mayors(text[], text[]) from public, anon, authenticated;

-- An arena's mayors: [[h3, user_id, days], ...] for every cell with ground
-- in the window under the given district prefixes. The device cuts the
-- exact subdivision outline afterwards (subdivisions.ts), as it always did.
-- jsonb, not a set: PostgREST caps a set-returning RPC at 1000 rows, and this
-- repo has shipped that truncation twice already.
create or replace function public.local_leaders_cells(p_prefixes text[])
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if coalesce(array_length(p_prefixes, 1), 0) > 2000 then
    raise exception 'LOCAL_LEADERS: at most 2000 districts per call';
  end if;
  -- Exactly a district's prefix (district.ts districtCellPattern: '8c' +
  -- DISTRICT_RES digits). A shorter one would ask for a whole country.
  if exists (select 1 from unnest(coalesce(p_prefixes, '{}')) p where p !~ '^8c[0-9a-f]{7}$') then
    raise exception 'LOCAL_LEADERS: a prefix must be one district''s 9-character cell prefix';
  end if;
  return coalesce(
    (select jsonb_agg(jsonb_build_array(m.h3, m.user_id, m.days) order by m.h3)
     from local_leader_mayors(coalesce(p_prefixes, '{}'), null) m),
    '[]'::jsonb
  );
end;
$$;

revoke execute on function public.local_leaders_cells(text[]) from public, anon;
grant execute on function public.local_leaders_cells(text[]) to authenticated;

-- What each MAYOR among the given cells did there over the window: distinct
-- days present, and the totals of their sessions touching those cells
-- (local-leaders.ts daysPresent + runnerTotals). A session counts once and
-- whole; a flagged run adds no totals; `runs` counts the sessions that did.
create or replace function public.local_leaders_runners(p_cells text[])
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if coalesce(array_length(p_cells, 1), 0) > 200000 then
    raise exception 'LOCAL_LEADERS: at most 200000 cells per call';
  end if;
  return coalesce((
    with mayors as (
      select distinct m.user_id from local_leader_mayors(null, coalesce(p_cells, '{}')) m
    ),
    wanted as (
      select distinct c as h3 from unnest(coalesce(p_cells, '{}')) c
    ),
    ground as (
      select distinct s.user_id, s.run_id, s.session_at
      from wanted w
      join run_ground g on g.h3 = w.h3
      join run_sessions s on s.run_id = g.run_id
      join mayors my on my.user_id = s.user_id
      where s.session_at >= now() - interval '30 days'
        and s.session_at <= now()
    ),
    per_runner as (
      select gr.user_id,
             count(distinct (gr.session_at at time zone 'utc')::date)::integer as days,
             count(r.id)::integer as runs,
             coalesce(sum(r.distance_m), 0) as distance_m,
             coalesce(sum(r.duration_s), 0)::integer as duration_s,
             coalesce(sum(r.laps), 0)::integer as laps
      from ground gr
      left join runs r on r.id = gr.run_id and not r.flagged
      group by gr.user_id
    )
    select jsonb_agg(jsonb_build_object(
      'user_id', pr.user_id, 'days', pr.days, 'runs', pr.runs,
      'distance_m', pr.distance_m, 'duration_s', pr.duration_s, 'laps', pr.laps
    ) order by pr.user_id)
    from per_runner pr
  ), '[]'::jsonb);
end;
$$;

revoke execute on function public.local_leaders_runners(text[]) from public, anon;
grant execute on function public.local_leaders_runners(text[]) to authenticated;

-- Every cell the caller is mayor of, anywhere (the map's faded "your ground
-- elsewhere" layer). Mayorship of a cell depends only on the ground stored
-- on that cell, so this is the caller's own ground cells in the window,
-- decided against everyone's ground there.
create or replace function public.my_mayor_cells()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(m.h3 order by m.h3), '[]'::jsonb)
  from local_leader_mayors(
    null,
    array(
      select distinct g.h3
      from run_sessions s
      join run_ground g on g.run_id = s.run_id
      where s.user_id = auth.uid()
        and s.session_at >= now() - interval '30 days'
        and s.session_at <= now()
    )
  ) m
  where m.user_id = auth.uid();
$$;

revoke execute on function public.my_mayor_cells() from public, anon;
grant execute on function public.my_mayor_cells() to authenticated;

-- ============================================================================
-- VERIFY after applying (SQL editor, read-only):
--   select (select count(distinct run_id) from tile_visits) as sessions_in_visits,
--          (select count(*) from run_sessions)              as sessions_mirrored,
--          (select count(*) from tile_visits)               as visits,
--          (select count(*) from run_ground where not enclosed) as crossed_mirrored;
--   -- expect sessions_in_visits = sessions_mirrored and visits = crossed_mirrored
--   select jsonb_array_length(local_leaders_cells(array['8c48a2a1a']));
--   -- expect a number (0 is honest only if nobody ran there in 30 days)
--   select tgname from pg_trigger where tgrelid = 'tile_visits'::regclass and not tgisinternal;
--   -- expect tile_visits_mirror_ground AND tile_visits_plausibility_guard
-- And with the publishable key, no session (expect 401/permission errors,
-- never rows):
--   POST /rest/v1/rpc/local_leaders_cells  {"p_prefixes":["8c48a2a1a"]}
--   GET  /rest/v1/run_ground?select=*&limit=1   -> []
-- ============================================================================
