# 2027 Calendar Sweep — Discovery Brief (shared by every state agent)

Today is 2026-10-24. Window: **2026-10-24 through 2027-12-31**.

Read first (method + traps):
- scripts/race-sweep/method/references/sources.md
- scripts/race-sweep/method/references/schema.md

Your state's EXISTING races (id, name, date, city, sourceUrl) are in
`existing/<State>.json` next to this file. Your job has three parts:

1. **Date the undated.** Every existing race with `date: null` — find its date
   if it's now published (for the next edition inside the window).
2. **Next editions.** Every existing race whose date is already PAST
   (before 2026-10-24): find its next edition (usually 2027) if a date, page
   or registration is published. If nothing is published yet, skip it — do not
   project a date from last year's.
3. **New races.** Races in the window that aren't in the existing list at all.

METHOD (follow the ORDER):
1. ENUMERATE (list every row, don't summarize) the national calendars filtered
   to the metro: runera.mx (server-rendered detail pages), tritour.org city
   pages, asdeporte.com/eventos + /evento/<slug>/datos-del-evento, runmx.com,
   carrerasmexico.com, emociondeportiva.com, marcate.com.mx, plus the local
   timing company / renderer-of-record from sources.md.
2. VERIFY each race on its own event page (date, time, distances, venue,
   price, registration status).
3. SELF-AUDIT before returning: explicitly recall the metro's biggest races
   (marathon, medio maratón, brand/university/nocturna races, trail series).
   For EACH, state whether you found its current/next edition. If a famous race
   is missing, do ONE more targeted search. Missing an obvious flagship = failure.

ANTI-HALLUCINATION CONTRACT (strict, non-negotiable):
1. No race without a fetched source. Every race carries a `sourceUrl` you
   actually loaded. "I'm sure it exists" is not evidence.
2. Never invent dates, times, prices, venues, or URLs. Unknown → `null`. A
   `null` is a valid, useful finding; a plausible guess is data poisoning.
   Never project a 2027 date from the 2026 date.
3. Only publish a `signupUrl` confirmed tied to the CURRENT edition on a
   rendered page. Stale prior-year slugs/GUIDs from search results are a trap.
4. Conflicts are recorded in `sourceNotes`, never in `notes` (user-facing,
   renders verbatim in the app). Never resolve silently.
5. Confidence per race: high = official event page or two independent
   calendars agree; medium = one calendar; low = aggregator mention only.
6. Exclude private/corporate-internal events and races outside the metro/window.
7. `state` MUST be exactly the string given in your prompt.

## Output

Write a JSON array (no prose) to `found/<State>.json` next to this file
(spaces in the state name → underscores, e.g. `found/Ciudad_de_México.json`).
Each item is the schema.md agent object PLUS:

```
"notesEs": "Spanish version of notes, or null. Mexican Spanish, tú, no exclamation marks.",
"kind": "new" | "date-undated" | "next-edition" | "correction",
"existingId": "id from existing/<State>.json this relates to, or null for new"
```

- `date-undated`: same edition as an existing undated row; fills its fields.
- `next-edition`: a later edition of an existing (past) row → becomes a new row.
- `correction`: an existing UPCOMING row whose date/venue/time/signup is now
  wrong — give the corrected values and explain in sourceNotes.
- Do not return existing upcoming rows that are still correct.

Then reply with a SHORT summary only (the JSON lives in the file): counts per
`kind`, the self-audit result (each flagship → found / not published / missing),
and any undated existing races you could not date. Do NOT paste the JSON back.
