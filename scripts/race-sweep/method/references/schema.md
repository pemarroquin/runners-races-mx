# Race Schema & Merge Rules

The object each agent returns and that lands in
`running-app/assets/data/races.json` (under `.races[]`).

## Agent output object

```json
{
  "name": "string — official race name incl. edition if known",
  "date": "YYYY-MM-DD | null",
  "time": "HH:MM | null (24h, start time)",
  "distances": ["5K","10K","21K", "..."],
  "city": "string — real municipality (not the brand's city)",
  "state": "string — MUST match src/lib/regions.ts exactly",
  "venue": "string | null",
  "organizer": "string | null",
  "signupUrl": "string | null — current-edition registration, verified",
  "sourceUrl": "string — REQUIRED, the page actually fetched",
  "confidence": "high | medium | low",
  "notes": "string | null — USER-FACING ONLY: theme, format, cause, cap, price, schedule conflicts with other races. Never mention sources, calendars, verification dates, or research methodology here — it renders verbatim in the app's UI.",
  "sourceNotes": "string | null — internal: date/venue/edition conflicts, which calendar/source was used, stale slugs, unverifiable claims, anything about HOW the data was gathered. Never shown to users."
}
```

**`notes` vs `sourceNotes` — the test:** would a runner deciding whether to sign up care about this sentence? If yes → `notes`. If it's about which website you checked, whether two calendars agree, or why you couldn't verify something → `sourceNotes`. A `notes` field cross-checked against 2026-07-22's `runningapp` cleanup: 103 of 195 races had research audit-trail ("as of 2026-07-04", "could not verify", "single-calendar source") bleeding into the user-facing field — that's the failure mode this split exists to prevent.

## Fields the merge step adds / the app also reads

- `id` — kebab-slug of `name`, truncated ~48 chars. On collision, disambiguate
  (append a token); NEVER silently skip.
- `distanceTags` — derived filter buckets (below).
- `start` `{lat, lng, approx?}` — from the route pass; `approx:true` = venue
  centroid, not the official start line.
- `routeCoords` — `[[lat,lng], ...]` polyline (rare).
- `courseMapUrl` — official course-map image.
- `status` `"ok"|"changed"|"canceled"`, `statusNote`, `statusNoteEs`,
  `lastVerified` — written by the weekly race-watch routine; a
  `changed`/`canceled` value drives the orange banner in the app. The sweep may
  also set these when a source says postponed.

  **These three are the audit trail FOR a change — never the change itself.**
  Correct the structured field first (`date`, `time`, `venue`, `city`, `start`,
  `signupUrl`), *then* explain it in `statusNote`. A finding written only in
  prose does not reach the user: the app renders `venue` and `date`, not your
  paragraph about them. v1.2 of this skill exists because six records shipped
  that way — including a race whose start had moved to another municipality
  (map pin ~4 km off) and one that had already been run but still showed as
  upcoming with a live signup link. `scripts/verify-sweep.mjs` in the app repo
  now fails the build on it.

  `statusNote` is **user-facing** — a few plain sentences a runner can act on.
  Verification mechanics (blocked fetches, disagreeing calendars, confidence
  changes) go in `sourceNotes`. Spanish is the app's default locale, so every
  `changed`/`canceled` record needs `statusNoteEs`.
  When a race is `canceled`, also null its `signupUrl` — that gates checkout.

## distanceTags mapping

Valid tags are EXACTLY the app's `DistanceTag` union (`src/lib/races.ts`):
`3K`, `5K`, `10K`, `15K`, `Half`, `30K`, `Full`, `Ultra`, `TBD`. Any other
value (the old `Other` bucket included) makes `isValidRace()` DROP the whole
race at runtime, and `scripts/verify-sweep.mjs` fails on it. Map each
distance to its nearest bucket:

| Distance | Tag |
|---|---|
| under 4K (1K, 2K, 2.5K, 3K, kids/infantil, caminata) | `3K` |
| 4–7K (5K, 5.7K, 6K) | `5K` |
| 7–11.5K (8K, 10K, 11K) | `10K` |
| 11.5–18K (12K, 15K, 16K) | `15K` |
| 18–25K (`21K` / `21.1K` / `21.0975K`) | `Half` |
| 25–38K (30K, 33K) | `30K` |
| 38–45K (`42K` / `42.195K`) | `Full` |
| over 45K, trail ultra, vertical | `Ultra` |
| `distances` empty (not yet published) | `TBD` |

`distanceTags` is the deduped set, in the order above. Never empty.

## The state-string contract

`state` is the app's region filter key (`raceInRegion` matches on it). A typo
hides the whole city. Canonical values in `src/lib/regions.ts` today:
`Nuevo León`, `Ciudad de México`, `Estado de México`, `Jalisco`, `Querétaro`,
`Puebla`, `Yucatán`, `Baja California`, `Guanajuato`, `Quintana Roo`,
`San Luis Potosí`, `Coahuila`, `Chihuahua`. Add the region to `regions.ts`
BEFORE sweeping a state not listed here.
