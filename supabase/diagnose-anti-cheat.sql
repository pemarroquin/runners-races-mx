-- Why did case 2 come back unflagged? Read-only, changes nothing, no
-- transaction needed. Paste and run.
--
-- Case 2 returning flagged=false is ambiguous on its own: the OLD trigger
-- produces exactly that result too (its CHECK 3 is inert on 1s sampling and
-- both averages pass), so "false" cannot distinguish "migration not applied"
-- from "new check is broken". These three queries separate them.

-- 1. WHICH FUNCTION BODY IS LIVE. `repaired` must be true. If it is false,
--    the migration has not been applied and nothing else here matters —
--    run `supabase db push --linked` first.
select
  position('p90_max_kmh' in pg_get_functiondef('flag_implausible_speed'::regproc)) > 0
    as repaired,
  position('min_segment_s constant numeric := 20' in pg_get_functiondef('flag_implausible_speed'::regproc)) > 0
    as still_the_old_dead_check;

-- 2. IS THE TRIGGER STILL ATTACHED. Replacing a function body does not
--    re-attach a dropped trigger; `enabled` should be 'O' (origin).
select tgname, tgenabled as enabled
from pg_trigger
where tgrelid = 'runs'::regclass and not tgisinternal;

-- 3. WHAT THE NEW CHECK WOULD COMPUTE for case 2's exact path. Expect
--    segment_count = 299 and p90_kmh ~= 58, which is >= 100 and > 30, so
--    the check should fire. If p90_kmh comes back near 0 or 23, the
--    percentile is reading something other than per-segment speeds.
with pts as (
  select
    ordinality as i,
    (elem->>0)::float8 as lat,
    (elem->>1)::float8 as lng,
    (elem->>2)::float8 as ts_ms
  from jsonb_array_elements(
    (select jsonb_agg(jsonb_build_array(
       25.68 + (((g.i / 5) * 2 + least(g.i % 5, 2)) * 16.1) / 111320.0,
       -100.32,
       1756300000000::float8 + (g.i * 1000)))
     from generate_series(0, 299) as g(i))
  ) with ordinality as t(elem, ordinality)
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
select
  count(*) filter (where dt_s > 0)                                as total_segments,
  count(*) filter (where dt_s >= 1)                               as segments_counted,
  round((sum(d_m) / sum(dt_s) * 3.6)::numeric, 1)                 as path_avg_kmh,
  round(percentile_cont(0.9) within group (
          order by case when dt_s >= 1 then (d_m / dt_s) * 3.6 end)::numeric, 1)
                                                                  as p90_kmh
from segs
where dt_s > 0;
