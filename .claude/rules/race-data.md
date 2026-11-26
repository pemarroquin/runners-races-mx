---
paths:
  - "assets/data/**"
  - "scripts/verify-sweep.mjs"
  - "scripts/fetch-course-maps.mjs"
  - "scripts/import-route-kml.mjs"
  - "scripts/derive-platform.mjs"
  - "scripts/lib/**"
---

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
| Course map / elevation chart found | `courseMaps` (append `{ url, distance, kind }`) | note it in `sourceNotes` |
| Course line found (Google My Maps) | `routeCoords` via `npm run import-route` | the script notes it |
| Nothing changed | `status: 'ok'` | short note |

`platform` (asdeporte, tritour, ...) is DERIVED from `signupUrl`/`sourceUrl`,
never typed. After adding a race or changing a URL, run
`npm run derive-platform`; `verify-sweep` fails when they disagree.

### Course maps and route lines

`courseMaps: [{ url, distance, kind: 'route' | 'elevation' }]` holds every
official course image, one per distance (`distance` is the organizer's label,
"5K" or "5K/10K", or `null`). It replaced the single `courseMapUrl`, which is
now a `verify-sweep` error: it couldn't hold a second map, so Verano
Monterrey's 5K map ended up as a link in `notes`. A course-image or My Maps
link in `notes`/`notesEs` is an error too: write the field, and put the link
in `sourceNotes` if it's worth keeping.

- **Asdeporte races are covered by a script, not by you.**
  `npm run course-maps` reads each upcoming race's `/evento/<slug>/ruta` page
  and appends new maps (never removes one). `.github/workflows/course-maps.yml`
  runs it every Wednesday and opens a PR on `bot/course-maps`. A sweep doesn't
  need to hunt Asdeporte maps by hand: the 2026-10-24 agent pass read
  `datos-del-evento` instead of `/ruta` and missed all 8 that existed.
- **Other sites:** add the map to `courseMaps` yourself, with the distance the
  image is labelled for.
- **A Google My Maps course** becomes a real line with
  `npm run import-route -- <raceId> <my-maps-url>`. It refuses to write when
  the line's length is more than 3% off the advertised distance (that's the
  wrong line), and moves an approx `start` to the line's first point only when
  it's within 300 m.

### `statusNote` is user-facing

It renders verbatim in the orange banner on the race detail screen, for
`changed` and `canceled` only. Max 400 chars (`statusNote` and `statusNoteEs`),
a hard error in `verify-sweep` since 2026-10-23 — an `ok` record's note is
invisible today and on screen the moment its status flips. Keep it to a few plain sentences a runner can
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
