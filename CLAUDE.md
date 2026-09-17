# CLAUDE.md — Runners' Races MX

Guidance for Claude Code working in this repo, including the Mon+Fri
**race-watch** cloud routine. Read this before touching
`assets/data/races.json`.

## The sweep contract (read this first)

A verification sweep's job is to **correct the data**, not to describe what it
found. The three fields `status` / `statusNote` / `lastVerified` are the *audit
trail for a change* — they are never the change itself.

**Write the corrected field first. Then explain it in `statusNote`.**

This is not a style preference. On 2026-08-10 an audit found six records where
a sweep had proved something and written it only in prose:

- **Carrera SABA Monterrey** — the sweep confirmed the start had moved to Av.
  Pedro de Alba, Ciudad Universitaria UANL, and wrote that in `statusNote`.
  `venue` still said `Parque Fundidora`, `city` still said Monterrey (the new
  venue is in San Nicolás), and `start` still pinned the map ~4 km away. The
  app showed runners the wrong start line.
- **Medio Maratón Ensenada** — the sweep proved, with official `ensenada.gob.mx`
  start *and* results coverage, that the race had already been run on 17 May.
  `date` stayed `2026-08-17`, so the app kept advertising it as upcoming in
  seven days, with a live signup link and no checkout gate.

So, when a sweep finds something:

| Finding | Field to write | Then |
|---|---|---|
| Venue moved | `venue`, and `city`/`start` if the municipality or coordinates changed | note it |
| Date wrong / race already run | `date` | note it |
| Race canceled | `status: 'canceled'` **and** `signupUrl: null` | note it |
| Postponed, new date unknown | `date: null`, `status: 'changed'` **and** `signupUrl: null` | note it |
| Start time found or corrected | `time` | note it |
| Current-edition registration found | `signupUrl` | note it |
| Nothing changed | `status: 'ok'` | short note |

### `statusNote` is user-facing

It renders verbatim in the orange banner on the race detail screen, for
`changed` and `canceled` only. Keep it to a few plain sentences a runner can
act on. Everything about *how* you verified — which site was blocked, which
calendars disagreed, confidence changes — goes in `sourceNotes`, which users
never see. Same split as `notes` vs `sourceNotes`.

**Spanish is the app's default locale.** Every `changed`/`canceled` record must
carry a `statusNoteEs`. `notes` has the same rule via `notesEs`.

### Conflicts are recorded, not resolved silently

Two sources disagree → keep the better-evidenced value, write the conflict in
`sourceNotes`. Never guess. Unknown stays `null` — a `null` is a valid finding,
a plausible guess is data poisoning.

## Validate before committing

```bash
npm run verify-sweep                          # static invariants
node scripts/verify-sweep.mjs --base main     # + "narrated but not applied"
npx tsc --noEmit
npx expo export -p web
```

`scripts/verify-sweep.mjs` enforces the contract above. Its sharpest check is
diff-aware: if a record declares `status: 'changed'` and bumps `lastVerified`
but no user-visible field differs from the base ref, that is the exact defect
described here and it fails the build. Run against the pre-fix data, it catches
both incidents above by name.

CI runs it on every pull request and every push to main
(`.github/workflows/data-check.yml`).

## Repo gotchas

- **`deploy.yml` is push-to-main only.** Before `data-check.yml` existed, pull
  requests ran *no checks at all* and a green PR proved nothing. Data and type
  checks now run on PRs; the deploy still only runs on main.
- **The race-watch routine commits to `main` every Mon + Fri**, touching only
  `races.json`. Any branch editing that file will conflict on rebase — resolve
  per hunk (keep upstream's `status`/`statusNote`/`lastVerified`, keep the
  branch's other fields). Never blanket `--ours` / `--theirs`.
- **The bundled seed is not what users see.** The app fetches
  `assets/data/races.json` from `main` on every open and replaces its in-memory
  copy wholesale (`REMOTE_RACES_URL` in `src/lib/races.ts`). Data edited on a
  branch reaches nobody until that branch merges to `main`.
- A record that fails `isValidRace()` in `src/lib/races.ts` is silently
  **dropped** at runtime, so a schema slip reads as "races disappeared", not as
  an error. `verify-sweep.mjs` mirrors that validator.
- `_meta.count` is not read by the app, but it drifted to 114 against 195 real
  records because sweeps never touched it. The gate now checks it.

## Nav restructure (2026-09-17) — three tabs, Profile as a floating pill

Bottom nav dropped from five tabs to three: **Run** (`index.tsx`),
**Leaderboard** (`leaderboard.tsx`), **Races** (`races.tsx`). Two things had
to move because of it:

- **Saved races** folded into Races as a "Discover/Saved" segmented toggle
  at the top of that screen (`races.tsx`), reusing the same `RaceCard` and
  the same upcoming/past section logic the old `myraces.tsx` had.
- **Conquered Areas** (the old Saved tab's territory map) moved into
  Leaderboard as a new first sub-tab, **My Achievements**
  (`achievements-view.tsx`) — same map/detail-bubble/fetch logic the deleted
  `myraces.tsx`'s `FencesView` used, but self-contained (owns its own
  fetch/focus/signal wiring) rather than sharing Leaderboard's other two
  boards' effects. It needs no location/district at all, unlike its two
  sibling sub-tabs (Municipio, Local Leaders — see below), and
  `leaderboard.tsx`'s `useCurrentLocation({ autoRequest: activeBoard !==
  'mine' })` is what keeps opening the app from prompting for location just
  because My Achievements happens to be the default sub-tab.
- Its detail bubble gained Distance/Pace/Time/Tiles stats — `duration_s` was
  already stored on every run (`territory-sync.ts`'s `MyFence.durationS`)
  but never read back before this; `formatPace()` (`tracking.ts`) is new.

**Profile dropped off the tab bar entirely.** It's a root Stack push at
`/profile` (`src/app/profile/`, moved out of `(tabs)/settings/` — the old
`settings/profile.tsx` sub-page is now `profile/account.tsx`, to avoid a
`/profile/profile` route), reached via a floating avatar pill
(`profile-pill.tsx`) rendered on all three main tabs. Being a root push
(same level as `race/[id]`) means it has no bottom tab bar to fall back on,
so its own back chevron checks `router.canGoBack()` and falls back to
`router.replace('/')` — a direct reload or a shared link to `/profile`
arrives with no history, and a bare `router.back()` would silently strand
the runner there.

## Territory Mode — the two boards

Two leaderboards, and they measure different things on purpose. Do not merge
them, and do not add a scope picker to either.

**The arena is an H3 res-7 district** (`src/lib/district.ts`), ~5.16 km² and
~2.8 km across — the ground you are standing in, resolved locally with no
table, no migration and no round trip. It is NOT a municipio: nothing here
can resolve a lat/lng to one, and deriving it from park cells was measured at
21.3% ambiguous. This is the Pokémon GO / Ingress answer — the grid IS the
region.

`districtOf()` truncates the position's own tile; it must NEVER call
`latLngToCell(lat, lng, 7)` directly. H3's hierarchy is index truncation, not
geometry, so those differ near a boundary and a runner would be shown a
district their own tiles fall outside of. Monterrey happens to agree either
way, so this only shows up in other cities — a test asserts it across eight
base cells worldwide.

- **Board 1, CONQUEST** (`districtConquest`) — share of the ground *anyone
  holds* in the district. Changes hands the moment somebody else runs there.
  Ranked by cells held. The denominator is claimed ground, not the district's
  own 16 807 cells: that was measured at 0.02-2.39% for every real runner and
  never moves. How much of the district is untouched is a separate caption.
- **Board 2, LOCAL LEADERS** (`src/lib/mayorship.ts`) — mayorship per CELL,
  by distinct days present in a trailing 30. One point per day, so nobody
  buys a title with one huge Sunday; ties hold with the incumbent. Cannot be
  taken in a single visit.

**Nothing is ever named.** User-created `areas` were deleted outright — the
prompt, the overlap-suggest, the delete window, every string. Board 2's unit
is the grid, so a park and "a street block near my house" work through the
same code with no special case, and areas EMERGE from contiguous held cells.
Do not revive `areas` in any form.

**The leaderboard depends on no hand-applied migration, deliberately.** See
`leaderboard.ts`'s header: a board reading 0% because nobody ran the SQL is
indistinguishable from one reading 0% because nobody ran.

## Gotchas this repo has actually shipped

- **An impure function called during render gets its result CACHED by the
  React Compiler.** The i18n provider handed out
  `t: (key, options) => i18n.t(key, options)` — a closure over nothing
  reactive whose result depended on the mutable `i18n.locale` singleton. The
  compiler cached `t('settings.appearance')` across renders, so tapping
  ES/EN flipped `locale` state (the pills' `aria-checked` updated within
  500 ms) while every translated string on screen stayed in the old language
  until a full reload. The toggle was dead in production and no gate could
  see it. Fixed in PR #44 by threading the locale through the call
  (`i18n.t(key, { locale, ...options })`), which makes the translation pure
  in its arguments so the caching becomes correct. Rule: anything called
  during render must be a function of its arguments — if it reads mutable
  module state, pass that state in. Sibling of the updater-purity trap.

- **Safari has no `geolocation` in the Permissions API, so every permission
  check is a real GPS probe.** `requestPermission()` (geolocation.web.ts)
  rejects out of `navigator.permissions.query` on Safari and falls through to
  `getCurrentPosition` — a native prompt plus up to a 10 s timeout. Anything
  awaiting it is frozen for that whole window, so NEVER put state the user
  is waiting to see behind it. Checkpoint recovery did exactly that and
  rendered a recovered 40-minute run as `0:00 | 0 m | Searching for GPS
  signal…` until the probe returned, which reads as "Resume did nothing"
  (reported on a real phone, fixed in PR #43 — restored values now go on
  screen before the await; only `legStartRef` waits, so the clock doesn't
  count time spent at a permission prompt).
- **Never drop the only offer of a recoverable run before the recovery
  succeeds.** `resumeCheckpoint` hid the Resume/Discard prompt on tap; when
  the permission probe then refused, the runner landed on "New session" with
  no way back, while the run sat untouched in localStorage. Losing the offer
  is indistinguishable to the runner from losing the run.
  `restoreFromCheckpoint` returns a boolean now and the offer is restored on
  false. The checkpoint on disk is only ever cleared by a successful save, a
  reset, or an explicit Discard — verify that stays true.

- **A cleanup that touches the map runs AFTER the map is destroyed.** On
  unmount React runs effect cleanups in declaration order, so the mount
  effect's `map.remove()` goes first and mapbox-gl leaves `style` undefined
  behind it. `track-map.web.tsx`'s shimmer cleanup then called
  `if (map.getLayer(...))` on that corpse — and `getLayer` is itself what
  throws on a removed map, so the guard written to make the call safe WAS
  the crash. With no error boundary anywhere, React unmounted the whole tree:
  a blank white page on every single tap of Finish, holding the only copy of
  a finished run. Any cleanup touching a captured `map` must first ask
  whether it is still the live one (`mapRef.current === map &&
  readyRef.current`) — never rely on cleanup order, and never assume a
  Mapbox getter is safe on a destroyed map. Fixed 2026-09-09 (PR #41), which
  also added `MapErrorBoundary` around the maps so a map crash can never
  again cost a run.
- **Reproducing a web-only crash: drive real Chrome over CDP with a
  synthetic `navigator.geolocation`.** A phone gives you a blank screen and
  no stack. `--headless=new --use-gl=angle --use-angle=swiftshader
  --enable-unsafe-swiftshader` (Mapbox needs WebGL), install the stub via
  `Page.addScriptToEvaluateOnNewDocument`, and define it with
  `Object.defineProperty(navigator, 'geolocation', ...)` — a plain
  assignment gets replaced and reads back as PERMISSION_DENIED. Move the
  fake runner at ~3.3 m/s: faster than a real pace and every fix is
  correctly rejected, so the run records 0 m and you debug your own harness.
  Note Chrome REPLAYS a previous page's console errors when you re-attach,
  so confirm a fix in a FRESH profile before believing the exception is gone.

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
- **A ref cannot wake an effect.** `track-map.web.tsx` gated eight effects on
  a `readyRef`; two of them depended only on `active` and so never ran at all
  when a session started before the map loaded — silently removing the
  camera's browse hold. Readiness is state now. When gating an effect on
  readiness, ask what re-runs it.
- **`npm run measure-holes`** — read-only, anon key. Reports the size
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

- **A continuous animation timer inside a Tabs screen keeps running after
  you switch tabs away from it, because expo-router never unmounts a tab on
  switching away — it only stops reporting focus.** `TerritoriesMap.web.tsx`
  (My Achievements' map, `achievements-view.tsx`) runs two setInterval-driven
  loops whenever it has a saved territory — a gradient flow along each
  outline and a colour-shimmer on its fill wall — gated only on `hasSaved`,
  never on whether the screen was actually visible. Reported as the phone
  heating up during ordinary browsing (2026-09-17): once a runner opened
  Leaderboard even once (My Achievements became the DEFAULT sub-tab in the
  same nav restructure that surfaced this), both timers kept ticking and
  Mapbox kept repainting indefinitely in the background, on Run or Races,
  with nothing on screen to show for it. Fixed with an `active` prop on
  `TerritoriesMap`, threaded from `achievements-view.tsx`'s own
  `useIsFocused()` — same pattern `track-map.web.tsx`'s pre-existing `active`
  prop already used for its own shimmer, just never carried over here. Rule:
  any component that starts a `setInterval`/`requestAnimationFrame` loop and
  can be mounted inside a Tabs screen needs an explicit "is my own screen
  focused" gate — "does it have something to animate" is not the same
  question. `gradient-flow.ts`'s `startGradientFlow` already paused on a
  hidden BROWSER tab (`visibilitychange`); the shimmer's own raw
  `setInterval` had no such handling at all until this fix, which is a second,
  independent instance of the same class of gap.

- **Don't "fix" a lost-fetched-state regression by hiding a live Mapbox
  surface with `display: 'none'` instead of unmounting it — tried and
  reverted, 2026-09-17.** Once My Achievements got its own `active`-gated
  timers (above), switching Leaderboard's sub-tabs still fully unmounts/
  remounts `AchievementsView` (it's an early-return branch keyed on
  `activeBoard`), so toggling away and back re-fetches and briefly flashes a
  loading spinner — a real, minor regression from when Conquered Areas was
  its own top-level tab (which expo-router never unmounts on tab-switch, so
  it never lost state). The fix attempted was keeping `AchievementsView`
  permanently mounted and toggling `display:'none'` on its wrapper instead.
  Reverted before shipping: none of this codebase's Mapbox components
  (`territories-map.web.tsx`, `fence-map.web.tsx`, `track-map.web.tsx`) call
  `.resize()` on their container, because until this attempt none of them
  had ever needed to survive a hidden-then-shown container — going from
  `display:'none'` (0×0) back to visible is a known way to leave a Mapbox GL
  canvas blank or misaligned until something else forces a resize, and this
  session cannot drive a real browser to verify it (see the no-self-visual-QA
  memory). Left as the accepted tradeoff: a brief refetch-flash on sub-tab
  toggle, not an unverifiable maybe-broken map. If this is revisited, it
  needs either an explicit `map.resize()` wired to the visibility toggle, or
  real device/browser verification before it ships — not both skipped again.

- **Two Claude Code sessions can be editing this exact working directory at
  the same time, and their work lands in ONE shared commit.** During the
  2026-09-17 nav-restructure session, a second, independent agent was
  building the shareable route/stats sticker (`share-card.tsx`,
  `route-shape.ts`) in the same checkout concurrently — files the first
  session hadn't touched (and hadn't been told about) kept appearing
  fully-formed mid-read, and a file already read minutes earlier would come
  back changed on a later read. Neither session's `git status` showed
  anything odd because there was only ever one working tree; the two bodies
  of work were git-committed and PR'd together as one commit
  (`Co-Authored-By: Claude Sonnet 5`) without either session initiating that
  commit itself. Not a bug — just a fact about this workspace worth knowing
  before assuming an unexplained diff is your own mistake: re-read a file
  fresh before editing it if its content doesn't match what you last saw,
  and don't assume a repo's working tree reflects only your own session's
  changes.

## Project shape

React Native + Expo (SDK 57, expo-router, TypeScript). `npx expo start`, then
Expo Go on device — no store builds. Bilingual, Spanish default
(`src/lib/i18n.tsx`). Local-first, no backend: bundled seed refreshed from
GitHub on open, SQLite saved list (`src/lib/db.ts`), `expo-calendar`,
`react-native-webview` for sponsor checkout. Web preview auto-deploys to
runningapp.pmarroquin.com on push to `main`.

For discovery of *new* races (adding a city, refreshing a calendar), use the
`race-research` skill — that's a different job from this pre-race verification.
