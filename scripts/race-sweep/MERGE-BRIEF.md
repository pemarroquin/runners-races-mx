# 2027 Calendar Sweep — Merge Brief

You merge discovery-agent output into the Running App's race seed. Merge **in
code** (a Node script you write and keep under `scripts/` in this sweep folder),
never by hand-editing the JSON, so every count is reproducible.

- App repo: the repo root
  on branch `data/2027-calendar-sweep` (already checked out — do NOT switch
  branches, commit, or push; the main session reviews and commits).
- Target: `assets/data/races.json` → `.races[]` (keep `_meta`; append one
  sentence to `_meta.description` per batch: "2027 calendar sweep 2026-10-20:
  <states>").
- Input: `found/<State>.json` files named in your prompt (this folder).
  Item shape: schema.md object + `notesEs`, `kind`, `existingId`.
- Read first: `scripts/race-sweep/method/references/schema.md`
  and `workflows/sweep.md` §Merge in the same skill.

## Rules per `kind`

- `new` → append a row. `id` = kebab-slug of name (strip accents, ~48 chars).
  If the name has no year and the date does, that's fine — don't add one.
  On collision with ANY existing id, disambiguate (append year or city token);
  NEVER skip silently.
- `next-edition` → append a NEW row (the past row stays as history). Id as
  above; it must differ from `existingId` — if the slug collides, append the
  edition year (`-2027`).
- `date-undated` → update the existing row `existingId` in place: write the
  fields the agent supplied that are non-null (date, time, distances, venue,
  signupUrl, sourceUrl, confidence, notes/notesEs, sourceNotes). Never
  overwrite an existing non-null value with null. Keep the id.
- `correction` → update `existingId` in place, structured fields FIRST (date,
  time, venue, city, signupUrl). Then set `status: "changed"`, a short
  user-facing `statusNote` + `statusNoteEs` (Spanish, tú, no exclamation
  marks), `lastVerified: "2026-10-20"`. If the row has `start` and the venue
  moved, drop `start` (stale pin) rather than keep a wrong one.
- An `existingId` that doesn't exist → report it, don't guess a match.

**Notes are additive (lesson from batch 2).** On any in-place update, never
replace an existing `notes`/`notesEs` with the agent's text. Keep the old
facts (crowd size, price, cap, prize purse) and add the new ones; drop an old
sentence only when it is now FALSE (e.g. it names the previous edition's
venue), and say so in your report. Don't repeat a fact both texts state.
Keep `distances` in ascending order like the rest of the dataset.

## Every row you write

- `distanceTags` recomputed from `distances` per schema.md's table (empty → `["TBD"]`).
- Strip `utm_*`, `fbclid`, `gclid` params from `signupUrl`.
- Drop the internal `kind` / `existingId` fields before writing.
- `state` must be exactly the string the file is for.
- Keep field order consistent with existing rows (id, name, date, time,
  distances, distanceTags, city, state, venue, organizer, signupUrl,
  sourceUrl, confidence, notes, notesEs, sourceNotes, …rest).
- `notes` must be user-facing only. If an agent leaked research talk into
  `notes` ("según el calendario", "could not verify", "as of", "source"),
  move that sentence to `sourceNotes`.
- Dedupe within the batch on (normalized name + date + state).

## Gates (run all, from the app repo, and report results)

1. `npm run verify-sweep -- --base main`
2. `npx vitest run` (or `npm test`)
3. A one-off check: every id unique; every row `isSafeUrl(sourceUrl)`; count
   of rows before → after equals `new + next-edition` added.

If a gate fails, fix the data (not the gate) and re-run.

## Report back (short, no JSON dumps)

Per state: added (new / next-edition), updated (date-undated / correction),
rejected (with reason), collisions disambiguated. Total rows before → after.
Gate results. Any judgement calls you made.
