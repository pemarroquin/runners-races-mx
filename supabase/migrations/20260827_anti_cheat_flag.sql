-- Territory Mode — anti-cheat speed flagging
--
-- Apply with `supabase db push --linked`.
--
-- Flags runs whose speed is not humanly possible. Flagged runs still SAVE
-- and still HOLD TERRITORY (Pedro's call, 2026-08-27) — they are marked, not
-- punished. That asymmetry is deliberate: a GPS glitch must never cost
-- someone a real run, and the false-positive rate is unknown until this has
-- seen live data. Tighten once there is evidence, not before.
--
-- WHY THIS IS SERVER-SIDE. The Supabase anon key is an EXPO_PUBLIC_*
-- variable, so it ships in the app bundle and anyone can write runs with a
-- modified client. A check living in the app is theatre — the attacker owns
-- the app. A BEFORE INSERT trigger cannot be skipped by any client.
--
-- WHAT IT CANNOT DO. Every input here is still attacker-supplied: a
-- determined cheater can fabricate a raw_path with plausible timestamps and
-- pass all three checks. This raises the cost of casual cheating (drive the
-- loop, spoof with a mock-location app); it does not make the data
-- trustworthy. Treat `flagged = true` as "worth a look", never as proof, and
-- `flagged = false` as "nothing obvious", never as "clean".

alter table runs add column if not exists flagged boolean not null default false;
-- Machine-readable reason, so the UI can explain WHICH check tripped rather
-- than showing an unexplained warning icon.
alter table runs add column if not exists flag_reason text;

-- Fastest sustained human running speed is ~21 km/h (marathon world record
-- pace) and ~23-24 km/h over 5k. 25 km/h sustained across an entire run is
-- beyond any human, so this bar should essentially never fire on a real
-- runner — which is what makes it safe to apply automatically.
create or replace function flag_implausible_speed()
returns trigger
language plpgsql
as $$
declare
  max_kmh constant numeric := 25;
  -- A single GPS fix can jump hundreds of metres; over a short interval that
  -- reads as an absurd speed. Only segments spanning a real stretch of time
  -- are considered, which is what separates a jitter spike from a car.
  min_segment_s constant numeric := 20;
  segment_max_kmh constant numeric := 60;
  claimed_kmh numeric;
  path_kmh numeric;
  path_m numeric;
  path_s numeric;
  worst_segment_kmh numeric;
begin
  -- Too short to say anything meaningful: a 30-second run has too little
  -- signal, and dividing by a tiny duration produces nonsense.
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

  -- CHECK 2 — the run as its own GPS trace describes it. This exists
  -- because distance_m and duration_s are attacker-controlled: understating
  -- distance or overstating duration would slip past CHECK 1 alone. The
  -- path has to agree with the story.
  --
  -- Note this reads the UPLOADED path, which privacy masking has already
  -- trimmed at both ends (src/lib/privacy-zone.ts). That shortens distance
  -- and elapsed time together, so the derived SPEED stays right — which is
  -- exactly why this compares rates and never raw totals against
  -- distance_m. A masked run must not look like a cheating one.
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
  select
    coalesce(sum(d_m), 0),
    coalesce(sum(dt_s), 0),
    coalesce(max(case when dt_s >= min_segment_s then (d_m / dt_s) * 3.6 end), 0)
  into path_m, path_s, worst_segment_kmh
  from segs
  where dt_s > 0;

  if path_s >= 60 then
    path_kmh := (path_m / path_s) * 3.6;
    if path_kmh > max_kmh then
      new.flagged := true;
      new.flag_reason := 'speed:path';
      return new;
    end if;
  end if;

  -- CHECK 3 — a sustained burst well past running speed, even if the
  -- average is innocent. Catches the run-a-bit-drive-a-bit shape, where
  -- the driving is averaged away by the walking.
  if worst_segment_kmh > segment_max_kmh then
    new.flagged := true;
    new.flag_reason := 'speed:segment';
    return new;
  end if;

  return new;
end;
$$;

-- BEFORE INSERT so the verdict is written as part of the row itself. An
-- AFTER trigger would need a second UPDATE, and would briefly publish the
-- run unflagged.
drop trigger if exists runs_flag_speed on runs;
create trigger runs_flag_speed
  before insert on runs
  for each row
  execute function flag_implausible_speed();

-- Partial index: the only query that cares is "show me the flagged ones",
-- and flagged runs should stay a tiny minority of the table.
create index if not exists runs_flagged_idx on runs (flagged) where flagged;
