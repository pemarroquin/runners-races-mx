-- HOTFIX for 20260904220000_anti_cheat_percentile.sql — that migration
-- applies cleanly and then makes EVERY run upload fail.
--
-- Apply immediately with `supabase db push --linked`.
--
-- THE BUG. The previous version split its work into two statements:
--
--   with pts as (...), segs as (...)
--   select ... into path_m, path_s from segs where dt_s > 0;
--
--   select ... into p90_kmh, segment_count from segs where dt_s >= 1;   -- <—
--
-- A WITH clause belongs to ONE statement. `segs` does not exist in the
-- second, so it raises `relation "segs" does not exist` — and because the
-- trigger is BEFORE INSERT on `runs`, every upload errors out. Territory
-- Mode stops saving anything at all.
--
-- WHY IT GOT PAST `db push`. plpgsql only syntax-checks a function body at
-- CREATE time; the SQL statements inside are planned on first execution. So
-- the migration reports success and the failure surfaces later, on the next
-- insert. A migration "running successfully" says nothing about whether the
-- function it installed can run — the verify script is what proves that, and
-- it must be run AFTER the push, not before.
--
-- THE FIX. One statement again, with the NULL ambiguity that prompted the
-- split removed properly: FILTER (which ordered-set aggregates support)
-- restricts the percentile to qualifying segments, so no CASE is needed
-- inside ORDER BY and there is nothing to interpret about NULL ordering.

create or replace function flag_implausible_speed()
returns trigger
language plpgsql
as $$
declare
  max_kmh constant numeric := 25;
  p90_max_kmh constant numeric := 30;
  min_segment_s constant numeric := 1;
  min_segments constant integer := 100;
  claimed_kmh numeric;
  path_kmh numeric;
  path_m numeric;
  path_s numeric;
  p90_kmh numeric;
  segment_count integer;
begin
  if new.duration_s is null or new.duration_s < 60 then
    return new;
  end if;

  -- CHECK 1 — the run as the client describes it.
  claimed_kmh := (new.distance_m / new.duration_s) * 3.6;
  if claimed_kmh > max_kmh then
    new.flagged := true;
    new.flag_reason := 'speed:claimed';
    return new;
  end if;

  -- Totals AND the percentile, in ONE statement so the CTE stays in scope.
  -- Compares rates, never raw totals, so a privacy-masked run (which loses
  -- distance and elapsed time together) does not look like a cheating one.
  with pts as (
    select
      ordinality as i,
      (elem->>0)::float8 as lat,
      (elem->>1)::float8 as lng,
      (elem->>2)::float8 as ts_ms
    from jsonb_array_elements(new.raw_path) with ordinality as t(elem, ordinality)
  ),
  segs as (
    select
      d_m,
      dt_s,
      case when dt_s > 0 then (d_m / dt_s) * 3.6 end as kmh
    from (
      select
        ST_Distance(
          ST_MakePoint(lag(lng) over w, lag(lat) over w)::geography,
          ST_MakePoint(lng, lat)::geography
        ) as d_m,
        (ts_ms - lag(ts_ms) over w) / 1000.0 as dt_s
      from pts
      window w as (order by i)
    ) raw_segs
  )
  select
    coalesce(sum(d_m) filter (where dt_s > 0), 0),
    coalesce(sum(dt_s) filter (where dt_s > 0), 0),
    -- FILTER on an ordered-set aggregate: only segments at or above
    -- min_segment_s reach the percentile at all, so no NULLs are ordered
    -- and no CASE is needed inside ORDER BY.
    coalesce(
      percentile_cont(0.9) within group (order by kmh)
        filter (where dt_s >= min_segment_s),
      0
    ),
    count(*) filter (where dt_s >= min_segment_s)
  into path_m, path_s, p90_kmh, segment_count
  from segs;

  -- CHECK 2 — the run as its own GPS trace describes it.
  if path_s >= 60 then
    path_kmh := (path_m / path_s) * 3.6;
    if path_kmh > max_kmh then
      new.flagged := true;
      new.flag_reason := 'speed:path';
      return new;
    end if;
  end if;

  -- CHECK 3 — most of the run moving faster than anyone runs, even when the
  -- average is innocent. Replaces the max-of-long-segments test that was
  -- inert on densely-sampled tracks (see 20260904220000's header).
  if segment_count >= min_segments and p90_kmh > p90_max_kmh then
    new.flagged := true;
    new.flag_reason := 'speed:p90';
    return new;
  end if;

  return new;
end;
$$;
