-- tile_visits: close the SESSIONLESS read. Step 1 of 2 — the other step is
-- NOT in this file, and the gap is stated here so nobody reads this as "fixed".
--
-- THE PROBLEM. "tile_visits: read all" (20260903120000) is `using (true)` for
-- every role, so the publishable key alone, with no session, returns every
-- runner's (h3, user_id, run_id, visited_at) rows: each run's route shape at
-- ~9 m. privacy-zone.ts trims each run's ends before tiling; that is the only
-- mitigation.
--
-- WHY NOT select-own YET. Local Leaders rebuilds each session's ground ON THE
-- DEVICE from other runners' rows (fetchRunVisits -> sessionGroundVisits ->
-- enclosure.ts groundOfRun). That is cellsToMultiPolygon + polygonToCells —
-- H3 geometry that Postgres here has no equivalent of (no h3 extension on
-- Supabase). A select-own policy, or an RPC that stops returning per-run
-- cells, blanks or changes Board 2 for everyone. Moving it server-side is a
-- design change (persist each session's ground at claim time + backfill), not
-- a migration; see the PR description.
--
-- WHAT THIS DOES. Restricts the policy to the `authenticated` role. The app
-- reads this table only after withSession(), which signs in anonymously, and
-- anonymous users carry role `authenticated` — so every shipped client, old or
-- new, reads exactly what it read before. Board results are identical.
--
-- WHAT IT DOES NOT DO. Anonymous sign-in is open to anyone holding the
-- publishable key (the app depends on it), so a scraper can mint a session
-- and read the same rows. This removes the zero-effort curl; it is not an
-- access control against a determined one.
--
-- SAFE FOR OLD CLIENTS: apply at any time, before or after any deploy. Nothing
-- in this change needs a client change. Idempotent.
--
-- ROLLBACK:
--   drop policy "tile_visits: read authenticated" on public.tile_visits;
--   create policy "tile_visits: read all" on public.tile_visits for select using (true);

begin;

drop policy if exists "tile_visits: read all" on public.tile_visits;
drop policy if exists "tile_visits: read authenticated" on public.tile_visits;

create policy "tile_visits: read authenticated" on public.tile_visits
  for select to authenticated using (true);

commit;

-- VERIFY after applying (read-only). No function is created here, so there is
-- no lazily-planned body to break; the checks are on the policy itself.
--   select policyname, roles, cmd from pg_policies where tablename = 'tile_visits';
--   -- expect: "tile_visits: insert own" | {public} | INSERT
--   --         "tile_visits: read authenticated" | {authenticated} | SELECT
--   -- and NO row named "tile_visits: read all".
