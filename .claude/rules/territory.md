---
paths:
  - "src/lib/territory*.ts"
  - "src/lib/leaderboard*.ts"
  - "src/lib/mayorship.ts"
  - "src/lib/local-leaders.ts"
  - "src/lib/subdivisions.ts"
  - "src/lib/enclosure.ts"
  - "src/lib/gap-policy.ts"
  - "src/lib/tiles.ts"
  - "src/lib/live-territory.ts"
  - "supabase/**"
  - "scripts/*.ts"
  - "src/app/(tabs)/leaderboard.tsx"
---

## Territory Mode — the two boards

Two leaderboards, and they measure different things on purpose. Do not merge
them.

**The arena is a city's real subdivision where one is mapped, else an H3
res-7 district** (changed 2026-09-30, Pedro's call). `src/lib/subdivisions.ts`
holds each city's 10 most populated subdivisions (municipios in Monterrey;
arrondissements/boroughs elsewhere) from `assets/data/subdivisions.json`,
extracted by `npm run extract-subdivisions` and refreshed from GitHub like
races. A tile counts in the ONE subdivision its centre falls in (first
outline wins; slivers between simplified outlines go to the nearest within
40 m) — tested so no tile counts twice. The `‹ name ›` pill steps through
them, starting where you stand. Outside every subdivision the arena falls
back to the district (`districtArena`), ~5.16 km², resolved locally.

This REVERSES the old "NOT a municipio" rule, and the reason it's safe: what
was measured and rejected (21.3% ambiguous) was GUESSING a municipio from
park cells truncated to a coarse hexagon. Real boundary polygons with a
point-in-polygon test don't guess. Do not go back to a district-only arena.

Reads are scoped server-side by the districts covering the arena, plus one
ring (a tile's district is its TRUNCATION parent, which near an edge isn't
the hexagon under it), sent as a chunked PostgREST `or=(h3.like.…*)` filter
(verified live 2026-09-30: counts add exactly). `arena.contains` makes the
exact cut on device.

`districtOf()` truncates the position's own tile; it must NEVER call
`latLngToCell(lat, lng, 7)` directly. H3's hierarchy is index truncation, not
geometry, so those differ near a boundary and a runner would be shown a
district their own tiles fall outside of. Monterrey happens to agree either
way, so this only shows up in other cities — a test asserts it across eight
base cells worldwide.

- **Board 1, CONQUEST** (`districtConquest`) — share of the ground *anyone
  holds* in the arena. Changes hands the moment somebody else runs there.
  Ranked by cells held. The denominator is claimed ground, not the district's
  own 16 807 cells: that was measured at 0.02-2.39% for every real runner and
  never moves. How much of the district is untouched is a separate caption.
- **Board 2, LOCAL LEADERS** (`src/lib/mayorship.ts`) — mayorship per CELL,
  by distinct days present in a trailing 30. **Enclosure counts** (Pedro,
  2026-09-30): each session's GROUND — tiles crossed plus the inside of loops
  that same session closed (`sessionGroundVisits`, enclosure.ts's
  `groundOfRun`) — is stamped with the session's day. **Scored on the
  SERVER since 2026-10-23** (`20261023120000_local_leaders_server_side.sql`):
  each session's ground is stored once in `run_sessions` + `run_ground`
  (crossed tiles mirrored from `tile_visits` by a trigger; the enclosed ones
  computed by the runner's own device and sent via `record_run_ground`,
  bounded like a claim and filtered to the loop's res-6 region), and
  `local_leaders_cells` / `local_leaders_runners` / `my_mayor_cells` return
  only mayors and per-mayor numbers. mayorship.ts + local-leaders.ts stay as
  the REFERENCE: `test/local-leaders-sql.test.ts` runs the migration in
  PGlite and holds the SQL equal to them on random data, so change the rule
  in both or the test fails. Never go back to reading other runners'
  `tile_visits` on device: that read is what kept location history public. Both
  boards enclose; Leaderboard's ground goes to whoever ran it last, Local
  Leaders' to whoever keeps coming back. One day per session. One point per day, so nobody
  buys a title with one huge Sunday. Ties on days go to more laps in the
  runs through that cell (whole-run laps — per-cell laps aren't stored),
  then more distance, then the incumbent (Pedro, 2026-09-30); pace is
  shown, never ranked. Run numbers are joined server-side (flagged runs add
  no effort but still count their day) — `runs` stays select-own. Cannot be
  taken in a single visit.

**Live updates are a broadcast, not a table stream** (`live-territory.ts`).
Streaming `territory_tiles` changes would push ~26,000 messages per 10 km
loop to every open phone. Instead a successful claim sends ONE Realtime
broadcast (`territory-claims`, district ids only, no user id) via
`httpSend`; a board whose arena overlaps refetches, at most every 15 s, and
subscribes only while its tab is focused. A lost or forged message costs a
refetch at worst — the database stays the truth. `announceClaim` must never
throw into `uploadRun` (a test holds it to that).

**Nothing is ever named.** User-created `areas` were deleted outright — the
prompt, the overlap-suggest, the delete window, every string. Board 2's unit
is the grid, so a park and "a street block near my house" work through the
same code with no special case, and areas EMERGE from contiguous held cells.
Do not revive `areas` in any form.

**The leaderboard depends on no hand-applied migration, deliberately.** See
`leaderboard.ts`'s header: a board reading 0% because nobody ran the SQL is
indistinguishable from one reading 0% because nobody ran.

## Gotchas this repo has shipped (territory)



- **A data migration can be too big for the SQL editor.** `park_path_cells`
  sat empty for a day after the schema shipped because
  `20260908211500_park_paths_data.sql` is 1.4 MB and the Supabase SQL editor
  refuses anything near ~1 MB ("Query is too large to be run via the SQL
  Editor") — so "Park-path progress per municipio" rendered nothing, the RPC
  returning `[]` rather than an error. Loaded 2026-09-09 (36,193 cells, every
  municipio matching its `park_path_stats` denominator). Re-split a refreshed
  extraction with `node scripts/split-park-paths-sql.mjs [--bytes N]`: it
  emits ~300 KB chunks into the gitignored
  `supabase/generated/park-paths-chunks/` as `unnest(array[...])` (~2.3x
  denser than one tuple per row), idempotent and order-independent. Confirm
  with a live count — this is the standing failure mode here: an unapplied
  migration reads as an honest `0`.

- **`npm run measure-holes`** — read-only, reads every runner's
  `tile_visits` with the SECRET key (`SUPABASE_SERVICE_KEY`, an
  `sb_secret_...` in `.env.local`; `verify-claims` and `backfill-run-ground`
  use it too). The publishable key sees no other runner since
  `tile_visits` went select-own, and a script reading with it reports
  "nothing found" about nothing. Needs `vite-node` (a devDependency again:
  the vitest 5 bump dropped it and broke every `vite-node` script). Reports the size
  distribution of holes in every runner's covered ground and what the shipped
  `noiseHoles()` would fill. Run it before changing `MAX_NOISE_HOLE_CELLS`;
  the cap sits in a measured gap (nothing between 3 cells / 56 m and 9 cells
  / 110 m) and a different city could move it.

- **`holesOf()` is the ONE hole pipeline.** `enclosedCells` is it flattened,
  `noiseHoles` is it capped, `measure-holes` reports on it. Three copies
  existed briefly; `gap-policy.ts` exists only because two places once
  applied the same caps themselves and disagreed.

- **Measure a denominator against production before shipping a percentage.**
  Two denominators for one number were written down as decided and then
  measured to be unusable. A percentage is a claim about a denominator.
