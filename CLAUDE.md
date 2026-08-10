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
| Postponed, new date unknown | `date: null`, `status: 'changed'` | note it |
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

## Project shape

React Native + Expo (SDK 57, expo-router, TypeScript). `npx expo start`, then
Expo Go on device — no store builds. Bilingual, Spanish default
(`src/lib/i18n.tsx`). Local-first, no backend: bundled seed refreshed from
GitHub on open, SQLite saved list (`src/lib/db.ts`), `expo-calendar`,
`react-native-webview` for sponsor checkout. Web preview auto-deploys to
runningapp.pmarroquin.com on push to `main`.

For discovery of *new* races (adding a city, refreshing a calendar), use the
`race-research` skill — that's a different job from this pre-race verification.
