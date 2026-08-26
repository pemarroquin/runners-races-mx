-- Territory Mode — Phase 1 schema
-- See: Source Data/Outputs/Running App/Territory Mode — Feature Plan.md
--
-- Applied 2026-08-26 via `supabase db push --linked` — unlike Radial/
-- wedding-invites, this project's migrations ARE CLI-managed (confirmed
-- working against project ref hkqwvzhoopoxocdtzgik). Keep using
-- `supabase db push` for future changes here rather than hand-pasting into
-- the SQL editor — check `supabase migration list --linked` if a change
-- ever looks like it didn't take.

create extension if not exists postgis;

create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  home_point geography(Point, 4326),   -- optional, for Phase 3 privacy zone
  created_at timestamptz default now()
);

create table if not exists runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  region text,                          -- matches src/lib/regions.ts keys
  started_at timestamptz not null,
  ended_at timestamptz not null,
  distance_m numeric not null,
  duration_s integer not null,
  raw_path jsonb not null,              -- [[lat,lng,ts], ...] as recorded
  fence geometry(Geometry, 4326),        -- Polygon or MultiPolygon after
                                         -- Phase-3 differencing splits it
  area_m2 numeric,                      -- ST_Area(fence::geography)
  created_at timestamptz default now()
);

create index if not exists runs_fence_gix on runs using gist (fence);
create index if not exists runs_user_id_idx on runs (user_id);

-- Phase 3 only — table created now so Phase 3 doesn't need its own migration.
-- Nothing writes to this yet.
create table if not exists territory_events (
  id uuid primary key default gen_random_uuid(),
  winner_run_id uuid references runs(id) on delete cascade,
  loser_run_id uuid references runs(id) on delete cascade,
  area_taken_m2 numeric not null,
  created_at timestamptz default now()
);

-- RLS
alter table profiles enable row level security;
alter table runs enable row level security;
alter table territory_events enable row level security;

create policy "profiles: read all" on profiles
  for select using (true);

create policy "profiles: insert own" on profiles
  for insert with check (auth.uid() = id);

create policy "profiles: update own" on profiles
  for update using (auth.uid() = id);

create policy "runs: read all" on runs
  for select using (true);

create policy "runs: insert own" on runs
  for insert with check (auth.uid() = user_id);

create policy "territory_events: read all" on territory_events
  for select using (true);
-- No insert policy yet — Phase 3's server-side function will need a
-- service-role key (bypasses RLS) or a dedicated policy when it's built.
