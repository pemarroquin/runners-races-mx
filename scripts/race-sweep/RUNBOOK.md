# 2027 Race Calendar Sweep — Cloud Runbook

Self-contained instructions for finishing the 2027 sweep in an unattended
cloud session. Everything needed is in this repo:

- `scripts/race-sweep/method/` — the method (SKILL.md, `workflows/sweep.md`,
  `references/sources.md`, `references/schema.md`). Read SKILL.md + sweep.md first.
- `scripts/race-sweep/BRIEF.md` — the discovery brief every state agent gets.
- `scripts/race-sweep/MERGE-BRIEF.md` — merge rules. **Overridden by this file
  where they disagree** (it was written for a local session: ignore its "do not
  commit" and branch-name lines; follow §Git below).
- `scripts/race-sweep/merge-template.mjs` — the batch-3 merge script. Copy it to
  `merge-batch<N>.mjs` and EMPTY every per-batch table (STATUS, REMOVE,
  NOTES_OVERRIDE, SAME_PLACE, ID_OVERRIDE, SOURCE_NOTES_OVERRIDE, NOTES_EN)
  before filling it for your batch. It throws on unused entries, on purpose.
- `scripts/race-sweep/integrity.mjs` — before/after check. Its diff check misses
  arrays that get shorter, so also read the `-` lines of `git diff`.

"Today" in BRIEF.md / the merge script's `TODAY` = the actual date you run.
Window = today through 2027-12-31.

## Status (as of 2026-10-20, main @ batch 3)

Done: batch 1 (CDMX, EdoMex, Querétaro), batch 2 (Baja California,
Guanajuato, Yucatán), batch 3 (Chihuahua, Nuevo León, Jalisco). 324 rows.

## Work, in order

1. **Batch 4: Puebla, Coahuila, San Luis Potosí.** One discovery agent per
   state, all three in parallel (`Agent`, general-purpose). Before launching,
   regenerate `scripts/race-sweep/existing/<State>.json` from
   `assets/data/races.json` (fields id/name/date/city/sourceUrl; spaces →
   underscores). Agents write `scripts/race-sweep/found/<State>.json`.
   Undated rows to try to date: Coahuila 1, SLP 1.
   Region metros: see `src/lib/regions.ts` (Puebla, Saltillo, San Luis Potosí).
2. Merge batch 4 (script + integrity + gates, §Gates). Open PR, §Git.
3. **Batch 5: Quintana Roo** (Cancún metro), same procedure. Merge, PR.
4. **Flagship verify pass** (sweep.md §2) across ALL 13 states' flagship rows
   in the window. Corrections only; merge via a script. PR.
5. **ONE shared route pass** (sweep.md §3) for rows added in batches 1–5 that
   lack `start` / route. PR.

Batches of ≤3 agents at a time. Merge each batch before launching the next.

## Known judgement traps (from batches 1–3)

- Agents often write Spanish into the English `notes` field (notes === notesEs).
  The merge script refuses that unless you add an English line to NOTES_EN.
- On in-place updates notes are ADDITIVE (MERGE-BRIEF); only drop a sentence
  that is now false, and say so in the PR.
- A correction whose venue text is refined but is the same place: add the id to
  SAME_PLACE so the existing `start` pin survives.
- Don't mark a race `canceled` without a cancellation notice; a race that never
  existed (a past year's date carried forward) is REMOVED instead, with the
  evidence in the PR body, and `grep -rn <id>` must show no other references.
- Never project a 2027 date from 2026. `null` is a valid finding.

## Gates (all must pass before each PR)

From the repo root: `npm ci` (once), then
`node scripts/race-sweep/integrity.mjs <before> assets/data/races.json scripts/race-sweep/found`
(before = `git show origin/main:assets/data/races.json > /tmp/before.json`),
`npm run verify-sweep -- --base origin/main`, `npx tsc --noEmit`, `npm run lint`,
`npm test`, `npx expo export -p web`.
Fix the data, never the gate.

## Git

- One branch + PR per step: `data/2027-sweep-batch4`, `…-batch5`,
  `…-flagship-verify`, `…-routes`, each off the latest `origin/main`.
- **Never push to `main`** (it auto-deploys). Open PRs; Pedro merges.
  Race-watch commits land on main on Mondays and touch races.json — rebase
  onto `origin/main` and re-run the merge script (not a hand-resolved conflict)
  if a PR goes stale.
- `found/` and `existing/` files are committed with each PR (they are the
  evidence for every row).
- PR body: per state added/updated/removed counts, rejected items, every
  judgement call, gate results.
