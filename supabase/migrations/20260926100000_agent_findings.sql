-- Internal agent findings table.
-- The territory-analysis cron (territory-analysis+api.ts) writes here every Monday.
-- Read via the Supabase dashboard with the secret key; no anon/user reads needed.
create table if not exists agent_findings (
  id          uuid        primary key default gen_random_uuid(),
  week_of     date        not null,
  category    text        not null check (category in (
                'gps_quality', 'fence_shapes', 'anti_cheat',
                'coverage', 'h3_fit', 'summary'
              )),
  severity    text        not null check (severity in ('info', 'warning', 'critical')),
  finding     text        not null,
  recommendation text     not null,
  evidence    jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists agent_findings_week_category
  on agent_findings (week_of desc, category);

alter table agent_findings enable row level security;
-- No SELECT/INSERT policies → only the secret key (bypasses RLS) can read or write.
