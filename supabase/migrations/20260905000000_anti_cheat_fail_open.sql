-- Territory Mode — make the speed trigger FAIL OPEN
--
-- Apply with `supabase db push --linked`, then run
-- supabase/verify-anti-cheat-p90.sql AFTER the push (not before — a verify
-- run against the previous function returns plausible rows that prove
-- nothing).
--
-- WHY. On 2026-09-04 a bug in this function's own body took down every run
-- upload: it referenced a CTE that was out of scope, which plpgsql does not
-- catch at CREATE time, so the migration applied cleanly and each INSERT
-- then raised `relation "segs" does not exist`. Because the trigger is
-- BEFORE INSERT on `runs`, a defect in the anti-cheat check cost runners
-- their runs.
--
-- That is the wrong failure direction. Missing a flag costs a leaderboard
-- position that flagged runs currently keep anyway (flagging is still
-- cosmetic); rejecting an insert costs someone the run they actually did,
-- with no recovery — the upload queue retries, hits the same trigger, and
-- fails again. And the client-side pace guard (src/lib/pace-guard.ts) is
-- already the first line against the case this catches.
--
-- WHAT CHANGES. Only the path-parsing and percentile work is wrapped. It is
-- the part that touches attacker-supplied JSON, does geography maths and
-- runs an ordered-set aggregate — i.e. everything that can actually throw.
-- CHECK 1 stays outside: it is scalar arithmetic on two columns and cannot
-- raise (a null distance_m yields a null comparison, which simply does not
-- flag).
--
-- FAILING OPEN MUST NOT BE SILENT. An empty `flagged` column already reads
-- exactly like "no cheating happened" — that is the trap this whole feature
-- kept falling into. So a swallowed error records `flag_reason =
-- 'error:speed_check'` with `flagged = false`, and raises a WARNING into the
-- Postgres logs. Nothing in the app renders flag_reason (it is carried on
-- MyFence and never displayed), so this is invisible to runners and
-- greppable for us:
--
--   select count(*), min(created_at), max(created_at)
--   from runs where flag_reason = 'error:speed_check';
--
-- Any non-zero result there means the check has been quietly not running.
-- `npm run audit-territories` reports it too.

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

  -- CHECK 1 — the run as the client describes it. Scalar arithmetic only;
  -- deliberately outside the guarded block below.
  claimed_kmh := (new.distance_m / new.duration_s) * 3.6;
  if claimed_kmh > max_kmh then
    new.flagged := true;
    new.flag_reason := 'speed:claimed';
    return new;
  end if;

  -- Everything that can throw, guarded. A plpgsql BEGIN/EXCEPTION block is
  -- a subtransaction — one per run insert, which is not a hot path.
  begin
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
      -- min_segment_s reach the percentile, so no NULLs are ordered and
      -- there is nothing to interpret. Keep this as ONE statement — the
      -- previous version split it and the CTE went out of scope.
      coalesce(
        percentile_cont(0.9) within group (order by kmh)
          filter (where dt_s >= min_segment_s),
        0
      ),
      count(*) filter (where dt_s >= min_segment_s)
    into path_m, path_s, p90_kmh, segment_count
    from segs;
  exception
    when others then
      -- Let the run through. Malformed raw_path, a PostGIS error, or a bug
      -- in the query above must never cost someone their run.
      new.flagged := false;
      new.flag_reason := 'error:speed_check';
      raise warning 'flag_implausible_speed failed, run allowed through unchecked: % (%)',
        sqlerrm, sqlstate;
      return new;
  end;

  -- CHECK 2 — the run as its own GPS trace describes it. Compares RATES,
  -- never raw totals, so a privacy-masked run (which loses distance and
  -- elapsed time together) does not look like a cheating one.
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
