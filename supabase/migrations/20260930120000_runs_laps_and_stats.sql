-- Laps per run, and the narrow read Local Leaders' tiebreakers need.
--
-- Local Leaders (mayorship per cell) is decided by days present. Pedro's
-- 2026-09-30 call: when two runners have the same days on a cell, more laps
-- there wins, then more distance, then whoever held it first. Pace is shown,
-- never ranked (it rewards speed, where GPS glitches and cheating show up
-- first).
--
-- APPLY BY HAND in the SQL editor, BEFORE merging the branch that writes
-- `laps`. A client sending a column the table doesn't have fails the whole
-- insert. The client only sends `laps` for a run that genuinely looped, which
-- limits the damage, but the order still matters. Then VERIFY (see bottom):
-- applying is not the same as working.

-- 1. The count itself. Computed on the device from the UNMASKED path
--    (laps.ts, detectLaps), and only the number leaves the phone. 0 unless
--    the run qualified as a real loop.
alter table public.runs add column if not exists laps integer not null default 0;

-- Client-supplied, so bounded by the run's own distance: a lap needs at least
-- MIN_SEPARATION_CELLS (~190 m) of other ground between visits, so a run
-- can't honestly have more than one lap per 150 m. A forged `laps` can only
-- ever break a tie on days, never buy a title.
alter table public.runs drop constraint if exists runs_laps_plausible;
alter table public.runs
  add constraint runs_laps_plausible check (laps >= 0 and laps <= 1 + floor(distance_m / 150));

-- 2. Other runners' run numbers, without opening `runs`. Since
--    20260920120000_runs_select_own a runner can read only their own runs,
--    which is right: `raw_path` is a full GPS trace. The tiebreakers need
--    distance, duration and laps of the runs behind other people's visits,
--    and nothing else — no path, no start or end time, no area, and nothing
--    at all for a flagged run. Run ids come from tile_visits, which is
--    already readable.
create or replace function public.run_stats(p_run_ids uuid[])
returns table (id uuid, distance_m numeric, duration_s integer, laps integer)
language sql
stable
security definer
set search_path = public
as $$
  select r.id, r.distance_m, r.duration_s, r.laps
  from public.runs r
  -- Capped so one call can't be used to sweep the table.
  where r.id = any (p_run_ids[1:2000])
    and not r.flagged;
$$;

revoke execute on function public.run_stats(uuid[]) from public;
revoke execute on function public.run_stats(uuid[]) from anon;
grant execute on function public.run_stats(uuid[]) to authenticated;

-- VERIFY after applying (read-only):
--   select column_name, data_type, column_default from information_schema.columns
--    where table_name = 'runs' and column_name = 'laps';
--   -- expect: laps | integer | 0
--   select count(*) from runs where laps <> 0;
--   -- expect: 0 until a looped run uploads
--   select * from run_stats(array(select id from runs order by started_at desc limit 3));
--   -- expect: up to 3 rows of numbers, never raw_path
