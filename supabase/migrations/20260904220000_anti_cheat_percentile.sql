-- Territory Mode — repair the anti-cheat speed trigger
--
-- Apply with `supabase db push --linked`. NOT run by any tooling in this
-- repo — an unapplied migration here fails silently, and the failure looks
-- exactly like "no cheating happened".
--
-- WHY. On 2026-09-03 a car was driven around a loop and saved 3 299 m /
-- 977 565 m2 of territory. The trigger from 20260827_anti_cheat_flag.sql was
-- already live and did not flag it. Neither did it flag a second drive the
-- day before. Measured against the real rows, all three of its checks miss:
--
--   CHECK 1 (claimed avg)  drive A 21.8 km/h, drive B 24.3 — both under the
--                          25 km/h bar, because a drive around town includes
--                          junctions, lights and turns that average it down.
--   CHECK 2 (path avg)     same figures, same miss, by construction.
--   CHECK 3 (worst burst)  evaluated to 0.0 on BOTH drives. It only considers
--                          segments spanning `min_segment_s = 20` or more,
--                          and both drives sampled about once a second, so no
--                          segment was ever eligible. The check is inert on
--                          any densely-sampled track — which is every track a
--                          modern phone records. It could only ever have
--                          fired on sparse GPS.
--
-- That last one is the important lesson: the check was not too lenient, it
-- was structurally dead, and `flagged = false` across the whole table read
-- as "clean" for weeks.
--
-- THE REPLACEMENT. The 90th-percentile segment speed across the run.
-- Measured on all nine runs in the table (dt >= 1s, the same filter used
-- below):
--
--   drive A            55.9 km/h        real run  11.3 km/h
--   drive B            58.8 km/h        real run  10.7 km/h
--                                       real run  11.3 km/h
--                                       real run  11.0 km/h
--
-- A percentile is what makes this safe. A single GPS fix can jump hundreds
-- of metres — one genuine run in this table contains a 171 km/h segment —
-- and a max-based rule fires on that. One bad fix in a thousand cannot move
-- a p90. It also still catches the run-a-bit-drive-a-bit shape CHECK 3 was
-- aiming at: ten minutes of driving inside an hour of running is well over
-- 10% of the segments, so it lands above the 90th percentile.
--
-- The min_segments floor exists because short, near-stationary runs have
-- noisy percentiles: a 277 m run recorded over 87 minutes (mostly standing
-- still, pure jitter) has a p90 of 26.8 km/h with only 57 segments. Below
-- the floor this check abstains and CHECKs 1 and 2 still apply.
--
-- WHAT THIS STILL CANNOT DO, unchanged from the original: every input is
-- attacker-supplied. A fabricated raw_path with plausible timestamps passes
-- everything here. `flagged = true` means "worth a look", never proof;
-- `flagged = false` means "nothing obvious", never "clean".

create or replace function flag_implausible_speed()
returns trigger
language plpgsql
as $$
declare
  max_kmh constant numeric := 25;
  -- p90 bar. Honest runs above the segment floor top out at 11.3 km/h here,
  -- so this sits at roughly 2.6x the worst real observation while both
  -- drives are near 56-59. Tighten only against new measurements.
  p90_max_kmh constant numeric := 30;
  -- Sub-second segments are mostly receiver noise; 1s matches the sampling
  -- rate the drives actually recorded at, so it excludes jitter without
  -- excluding the thing being detected.
  min_segment_s constant numeric := 1;
  -- Below this the percentile is not a meaningful statistic — see above.
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

  -- CHECK 2 — the run as its own GPS trace describes it. distance_m and
  -- duration_s are attacker-controlled; the path has to agree with the
  -- story. Compares RATES, never raw totals, so a privacy-masked run (which
  -- loses distance and time together) does not look like a cheating one.
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
      ST_Distance(
        ST_MakePoint(lag(lng) over w, lag(lat) over w)::geography,
        ST_MakePoint(lng, lat)::geography
      ) as d_m,
      (ts_ms - lag(ts_ms) over w) / 1000.0 as dt_s
    from pts
    window w as (order by i)
  )
  -- Totals over every real segment, and the percentile over the subset that
  -- clears min_segment_s. Split into two scans rather than one with a CASE
  -- inside the ORDER BY: whether an ordered-set aggregate ignores NULLs
  -- produced by that CASE is exactly the kind of detail that would silently
  -- shift the percentile, and this leaves nothing to interpret.
  select coalesce(sum(d_m), 0), coalesce(sum(dt_s), 0)
  into path_m, path_s
  from segs
  where dt_s > 0;

  select
    coalesce(percentile_cont(0.9) within group (order by (d_m / dt_s) * 3.6), 0),
    count(*)
  into p90_kmh, segment_count
  from segs
  where dt_s >= min_segment_s;

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
  -- inert on densely-sampled tracks (see the header).
  if segment_count >= min_segments and p90_kmh > p90_max_kmh then
    new.flagged := true;
    new.flag_reason := 'speed:p90';
    return new;
  end if;

  return new;
end;
$$;

-- The trigger itself is unchanged (BEFORE INSERT, from the original
-- migration) — only the function body it calls is replaced, so it keeps
-- working across this deploy with no window where runs insert unchecked.
