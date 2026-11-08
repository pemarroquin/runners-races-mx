# CLAUDE.md — Runners' Races MX

Race discovery plus Territory Mode (record a run, claim H3 tiles). Read
`../Source Data/Outputs/Running App/BACKLOG.md` and `Design Decisions.md`
before any work.

**Race-watch routine / any data sweep: read `.claude/rules/race-data.md`
first** (the sweep contract, the gate, the race-watch conflicts). It loads by
itself when `assets/data/` is touched, but read it before the first edit.

Feature rules load by path from `.claude/rules/`: `race-data`, `navigation`,
`territory` (the two boards, scoring, Supabase), `tracking` (GPS,
recovery), `maps` (Mapbox), `react-web` (render purity, timers, page zoom).
Read the matching file before changing a feature.

## Validate (fastest first)

`npx tsc --noEmit` → `npm run lint` → `npm test` → `npx expo export -p web`;
data changes also `npm run verify-sweep`. Vitest runs in `node` with no React
renderer: hook effects and `.web.tsx` maps are not covered.

## Rules that apply everywhere

- Spanish default with *tú*, no exclamation marks; EN toggle (`src/lib/i18n.tsx`).
- Anything that moves data off-device updates the privacy copy in
  `settings.tsx` in the same change.
- New per-user tables get a select-own RLS policy, checked with a no-session
  request after applying.
- GPS tuning (accuracy threshold 100, permission checks) was tuned on real
  phones: don't "correct" it without re-testing on a device.
- Locked-screen recording and native map parity need an EAS dev client
  (beyond Expo Go): say so before starting such work.

## Project shape

React Native + Expo (SDK 57, expo-router, TypeScript). `npx expo start`, then
Expo Go on device — no store builds. Bilingual, Spanish default
(`src/lib/i18n.tsx`). Race data is local-first: bundled seed refreshed from
GitHub on open, SQLite saved list (`src/lib/db.ts`), `expo-calendar`,
`react-native-webview` for sponsor checkout. Territory Mode is NOT: runs,
tiles and visits live in Supabase (anonymous auth, publishable key). `runs`
is select-own since 2026-09-20; `tile_visits` goes select-own with
`20261023130000` (applied only after the client scoring Local Leaders
server-side is live; check BACKLOG.md for whether it has been).
`npm run verify-tile-visits-closed` is the live check, with no session AND
a fresh anonymous one. Web preview auto-deploys to runningapp.pmarroquin.com on push to
`main`.

Race-card art is 75 bundled WebP scenes in `src/lib/region-art.ts`
(sport-first, warm, no blue — PR #71). Settled in Design Decisions.md; read
it before regenerating. Encode new art at WebP q72, keep filenames, and give
only the first visible hero `priorityImage` (every other card stays lazy).

For discovery of *new* races (adding a city, refreshing a calendar), use the
`race-research` skill — that's a different job from this pre-race verification.
