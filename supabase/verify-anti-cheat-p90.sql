-- Verification for the REPAIRED anti-cheat trigger
-- (20260904220000_anti_cheat_percentile.sql). NOT a migration — paste into
-- the SQL editor. Rolls itself back; nothing persists.
--
-- Case 2 is the one that matters most: it is the exact shape of the drive
-- that got through on 2026-09-03 — a ~22 km/h average (UNDER the 25 km/h
-- bar that CHECK 1 and 2 use) sampled about once a second (so the old
-- CHECK 3, which needed a segment spanning 20s or more, could never see it).
-- If case 2 comes back flagged=false, the repair did not take.
--
-- Case 4 is the false-positive guard: an honest run carrying one wild GPS
-- fix. A real run in this table contains a 171 km/h segment, and a
-- max-based rule would end it. A p90 must not move.
--
-- Case 5 is the fail-open guard, added after a bug in this very trigger took
-- down every run upload on 2026-09-04. Its raw_path is deliberately
-- malformed so the check throws; the row appearing in the results at all is
-- the proof that a broken check no longer costs anyone their run.
begin;

insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at)
values ('dddddddd-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000000',
        'authenticated', 'authenticated', 'test-d@example.invalid', now(), now());
insert into profiles (id, display_name) values
  ('dddddddd-0000-4000-8000-000000000004', 'Test D');

-- Straight-line path: `n` points, `step_m` apart, `step_s` apart.
create or replace function _mkpath2(n int, step_m float8, step_s float8)
returns jsonb language sql as $f$
  select jsonb_agg(jsonb_build_array(
           25.68 + (i * step_m) / 111320.0,
           -100.32,
           1756300000000::float8 + (i * step_s * 1000)))
  from generate_series(0, n - 1) as g(i);
$f$;

-- Same, but point `spike_at` is displaced `spike_m` sideways — one bad fix.
create or replace function _mkpath2_spike(n int, step_m float8, step_s float8,
                                          spike_at int, spike_m float8)
returns jsonb language sql as $f$
  select jsonb_agg(jsonb_build_array(
           25.68 + (i * step_m) / 111320.0,
           -100.32 + case when i = spike_at then spike_m / 100340.0 else 0 end,
           1756300000000::float8 + (i * step_s * 1000)))
  from generate_series(0, n - 1) as g(i);
$f$;

-- STOP-AND-GO, the shape a car in traffic actually records: it advances
-- `step_m` on 2 ticks out of every 5 and sits still on the other 3. That is
-- what let the real drive average 21.8 km/h — under the 25 km/h bar CHECKs 1
-- and 2 use — while actually moving at ~58 km/h whenever it moved.
-- Reproducing it matters: a constant-speed fast path is caught by CHECK 2 on
-- its average alone, and would prove nothing about the new check.
create or replace function _mkpath2_stopgo(n int, step_m float8, step_s float8)
returns jsonb language sql as $f$
  select jsonb_agg(jsonb_build_array(
           -- Cumulative distance: only ticks where (i mod 5) < 2 advance.
           25.68 + (((i / 5) * 2 + least(i % 5, 2)) * step_m) / 111320.0,
           -100.32,
           1756300000000::float8 + (i * step_s * 1000)))
  from generate_series(0, n - 1) as g(i);
$f$;

insert into runs (id, user_id, region, started_at, ended_at, distance_m, duration_s, raw_path, fence, area_m2)
values
  -- 1. HONEST 10 km/h, 300 points 1s apart (2.78 m each) = 831 m / 299 s.
  --    p90 = 10 km/h. Must NOT flag.
  ('22222222-0000-4000-8000-000000000001', 'dddddddd-0000-4000-8000-000000000004',
   'mty', now(), now(), 831, 299, _mkpath2(300, 2.78, 1), null, 0),

  -- 2. THE DRIVE THAT GOT THROUGH — stop-and-go, 300 points 1s apart.
  --    ~120 of the 299 segments move 16.1 m (58 km/h); the rest are
  --    stationary. Average ~23 km/h, so CHECKs 1 and 2 both PASS, and every
  --    segment is 1s long so the old CHECK 3 (segments >= 20s) saw nothing.
  --    p90 = 58 km/h. Must flag, reason 'speed:p90'. If this row comes back
  --    unflagged, the repair did not take.
  ('22222222-0000-4000-8000-000000000002', 'dddddddd-0000-4000-8000-000000000004',
   'mty', now(), now(), 1932, 299, _mkpath2_stopgo(300, 16.1, 1), null, 0),

  -- 3. THE min_segments FLOOR: the identical stop-and-go shape, but only 80
  --    points, so 79 segments — under the 100 a percentile needs to mean
  --    anything. The check must ABSTAIN (CHECKs 1 and 2 still apply and both
  --    pass here). This is the near-stationary short run whose p90 is pure
  --    jitter; must NOT flag.
  --
  --    duration_s is 79, deliberately: at 59 it would fall under the
  --    trigger's own `duration_s < 60` early return and prove nothing about
  --    the floor at all.
  ('22222222-0000-4000-8000-000000000003', 'dddddddd-0000-4000-8000-000000000004',
   'mty', now(), now(), 515, 79, _mkpath2_stopgo(80, 16.1, 1), null, 0),

  -- 4. FALSE-POSITIVE GUARD: honest 10 km/h with ONE fix 300 m off course.
  --    That single segment reads about 1 080 km/h. A p90 over 299 segments
  --    cannot be moved by two of them. Must NOT flag.
  ('22222222-0000-4000-8000-000000000004', 'dddddddd-0000-4000-8000-000000000004',
   'mty', now(), now(), 831, 299, _mkpath2_spike(300, 2.78, 1, 150, 300), null, 0),

  -- 5. FAIL-OPEN. raw_path is an object, not an array, so
  --    jsonb_array_elements raises inside the trigger. The run must still
  --    INSERT (this row existing at all is the proof), unflagged, carrying
  --    flag_reason 'error:speed_check' so a silently-broken check is
  --    visible in the data instead of looking like "nothing suspicious".
  --    A bug in anti-cheat must never cost someone the run they did.
  ('22222222-0000-4000-8000-000000000005', 'dddddddd-0000-4000-8000-000000000004',
   'mty', now(), now(), 831, 299, '{"not":"an array"}'::jsonb, null, 0);

select
  right(id::text, 1) as case_no,
  flagged,
  coalesce(flag_reason, '-') as reason,
  case right(id::text, 1)
    when '1' then 'expect: false  -'
    when '2' then 'expect: TRUE   speed:p90'
    when '3' then 'expect: false  -'
    when '4' then 'expect: false  -'
    when '5' then 'expect: false  error:speed_check'
  end as expected
from runs
where user_id = 'dddddddd-0000-4000-8000-000000000004'
order by id;

rollback;
