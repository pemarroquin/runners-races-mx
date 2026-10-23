# Workflow: City Sweep (A-grade)

Three phases. Phase 1 is always run; Phase 2 when flagship accuracy matters;
Phase 3 once per batch of cities. Read `../references/sources.md` and
`../references/schema.md` before writing prompts.

---

## Phase 1 — Discovery (one combined agent per city)

Launch ONE `general-purpose` agent per city (batch ~3 in parallel; merge each
batch before the next). The prompt MUST contain, in this order:

1. **Target + window:** the metro's municipalities, the state string EXACTLY as
   it appears in `src/lib/regions.ts` (this is the app's filter key — getting it
   wrong hides the whole city), and the date window (today → mid next year).
2. **Enumerate, don't summarize:** name the national calendars (see sources.md)
   and instruct the agent to list EVERY row filtered to the city, then verify
   each race on its own event page.
3. **Mandatory flagship self-audit** (this is the fix for "we missed obvious
   races"): before returning, the agent must explicitly recall the city's
   biggest races by name (marathon, medio maratón, brand/university/nocturna,
   local trail series) and confirm it found each; if a famous one is missing, do
   one more targeted search before finalizing. "Missing an obvious flagship =
   failure."
4. **The anti-hallucination contract** (copy verbatim from SKILL.md).
5. **Output:** ONLY a JSON array, one object per race in the schema
   (schema.md), no prose/fences.

### Prompt template

```
Research REAL running races in the <METRO> (<municipalities>), <STATE>, Mexico,
dated <TODAY> through mid-<NEXT YEAR>. Today is <TODAY>.

METHOD (follow the ORDER):
1. ENUMERATE (list every row, don't summarize) these national calendars filtered
   to <CITY>: runera.mx (server-rendered detail pages), tritour.org city pages,
   asdeporte.com/eventos + /evento/<slug>/datos-del-evento (server-rendered),
   runmx.com, carrerasmexico.com, emociondeportiva.com. Also try the city's own
   timing company (see the renderer-of-record note below).
2. VERIFY each race on its own event page (date, time, distances, venue, price,
   registration status).
3. SELF-AUDIT before returning: explicitly recall the biggest, most obvious
   <CITY> races (<name the marathon, medio, brand, university, trail series>).
   For EACH, did you find it? If a famous race is missing, do ONE more targeted
   search before finalizing. Missing an obvious flagship = failure.

RENDERER-OF-RECORD HINT: <the city's local timing SPA + its server-rendered
mirror, if known — see sources.md; e.g. Trotime→runera, or chronostart/xtrail/
aqsports which render their own pages>.

ANTI-HALLUCINATION CONTRACT (strict):
- Every race MUST have a sourceUrl you actually fetched. Never invent
  dates/times/prices/URLs — unknown → null.
- Only report a signupUrl confirmed tied to the CURRENT (<year>) edition on a
  rendered page. Stale prior-year slugs/GUIDs are a known trap.
- Record date/venue/edition conflicts in sourceNotes (not notes — notes is
  user-facing and renders verbatim in the app); never resolve silently.
- "state" MUST be exactly "<STATE>".

Aim for <N> races (calibrate to city size — a major running city under 10 means
you under-enumerated; go back to the calendars). Return ONLY a JSON array, each
item exactly: <paste schema.md object>. No prose, no fences.
```

### Merge (after each batch)

Consolidate in code, not by another agent:
- Assign `id` = kebab-slug of name (truncate ~48 chars); on a slug collision,
  DISAMBIGUATE (append a distinguishing token) — never silently skip, that's
  data loss. Log every add count and cross-check it equals the agent's count.
- Strip `utm_*`/tracking params from `signupUrl`.
- Compute `distanceTags` from `distances` (schema.md mapping).
- Dedupe loosely on name across cities, but keep national-brand races that run
  as separate local editions (Barbie Run MTY vs CDMX vs GDL are distinct rows).
- Validate: unique ids, every `sourceUrl` non-empty, `state` matches regions.ts.

---

## Phase 2 — Targeted flagship verify (optional, cheap)

Only the races that matter most (the marathon, the medios, the biggest brand
races, anything a user is most likely to open). One agent, given the shortlist,
that deep-verifies each: exact date, start time, venue + start coordinates if
the page states them, a signup link tied to the current edition, and
cancellation/postponement status.

**Where a change is found, write the CORRECTED FIELD first** — `date`, `time`,
`venue`, `city`, `start`, `signupUrl` — and only then record `status`,
`statusNote` (+ `statusNoteEs`) and `lastVerified` explaining it. Those three
are the audit trail for a change, never the change itself; the app renders the
fields, not your paragraph about them. See v1.2 in `../CHANGELOG.md` for the
six records that shipped wrong because a sweep narrated instead of applying,
and run `npm run verify-sweep` in the app repo before committing — it fails the
build on exactly this.

This buys Methodology-A accuracy on the high-value tail WITHOUT A's 2× blanket
cost. Skip it for long-tail community races — their completeness naturally fills
in via the weekly race-watch closer to race day.

---

## Phase 3 — Shared route pass (once per batch, at the end)

ONE agent across all newly-added races that plausibly have route data. It hunts,
per race: an official course-map image (`courseMapUrl`), a start coordinate
(`start{lat,lng}` — only if a source STATES it; never geocode by guessing), and
a route polyline (`routeCoords`, rare). Reality: most 2026 organizers publish
route maps only weeks before the race, so expect many `routeAvailable:false` —
that is a valid finding. Seed `start.approx=true` centroids only for famous
landmark venues; replace with exact coords when a page provides them.

Do NOT run this per-city — it's the same handful of sources every time.

---

## Success criteria

- [ ] Every race source-cited; unknowns null; no invented data
- [ ] Flagship self-audit performed and its result stated
- [ ] `state` strings exactly match `src/lib/regions.ts`
- [ ] Merge counts reconcile (no silently skipped slug collisions)
- [ ] Conflicts recorded in sourceNotes (not notes), not silently resolved
- [ ] Batches of ~3; each merged before the next launches
