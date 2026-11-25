-- Persist the backgrounding-gap counters on each run, so the recorder's view
-- (tracking.ts: gapCount, gapDurationMs, gapChordM, creditedGapM) can be
-- reconciled with the tile builder's (tiles.ts: bridgesSkippedDistance,
-- bridgesSkippedSpeed) on real runs. Until now they lived in React state only.
--
-- All nullable, no default: NULL means "uploaded by a build that didn't send
-- them", which must stay distinguishable from a real 0.
-- `runs` is already select-own (RLS), so these inherit that policy.

alter table public.runs
  add column if not exists gap_count integer
    check (gap_count is null or gap_count >= 0),
  add column if not exists gap_duration_ms bigint
    check (gap_duration_ms is null or gap_duration_ms >= 0),
  add column if not exists gap_chord_m integer
    check (gap_chord_m is null or gap_chord_m >= 0),
  add column if not exists credited_gap_m integer
    check (credited_gap_m is null or credited_gap_m >= 0),
  add column if not exists bridges_skipped_distance integer
    check (bridges_skipped_distance is null or bridges_skipped_distance >= 0),
  add column if not exists bridges_skipped_speed integer
    check (bridges_skipped_speed is null or bridges_skipped_speed >= 0);

-- Verify after applying (expect 6 rows):
--   select column_name, data_type from information_schema.columns
--    where table_schema = 'public' and table_name = 'runs'
--      and column_name in ('gap_count','gap_duration_ms','gap_chord_m',
--        'credited_gap_m','bridges_skipped_distance','bridges_skipped_speed');
-- Reconcile once real runs exist:
--   select id, started_at, gap_count, bridges_skipped_distance,
--          gap_chord_m, credited_gap_m
--     from runs where gap_count is not null order by started_at desc;
