# Changelog — race-research skill

Append a dated entry every time the methodology improves. Newest first.
Each entry: what changed, why, and the evidence.

## v1.3 — 2026-10-19 — distanceTags match the app

- **schema.md distanceTags mapping corrected.** It still documented an `Other`
  bucket that the app had since replaced with 3K/15K/30K/Ultra/TBD. A sweep
  following it would have tagged races `Other`, and `isValidRace()` silently
  DROPS those at runtime (verify-sweep fails on them). Found while writing the
  2027 cloud sweep prompt; the mapping is now derived from the live dataset.

## v1.2 — 2026-08-10 — a sweep writes the FIELD, not the prose

- **The rule:** a verification pass corrects the structured field first, and
  `statusNote` explains it. `status`/`statusNote`/`lastVerified` are the audit
  trail *for* a change — never the change itself. Added to the schema doc, the
  Phase 2 prompt, and a new `CLAUDE.md` at the running-app repo root (which the
  cloud routine loads on every run, and which previously did not exist).
- **Why:** v1.1 cleared the race-watch routine as a contributing cause because
  it "only touches `status`/`statusNote`/`lastVerified`". That restriction *is*
  the defect. An audit on 2026-08-10 found six records where a sweep proved
  something and wrote it only in prose:
  - **Carrera SABA Monterrey** — venue move to CU UANL confirmed in the note;
    `venue`, `city` and `start` left pointing at Parque Fundidora, ~4 km off.
  - **Medio Maratón Ensenada** — proved already run on 17 May via official
    `ensenada.gob.mx` start *and* results coverage; `date` left at `2026-08-17`,
    so the app advertised it as upcoming in 7 days with a live signup link and
    no checkout gate.
  Four more had venue/time confirmed in prose and left `null`.
- **Enforcement, not just instruction:** `scripts/verify-sweep.mjs` in the app
  repo now gates the data. Its sharpest check is diff-aware — a record that
  declares `status: 'changed'` and bumps `lastVerified` while no user-visible
  field differs from the base ref fails the build. Replayed against the
  2026-08-10 race-watch commit and its true base, it catches both incidents by
  name, plus `_meta.count` drift (114 vs 195 real records) and two orphan
  `statusNote`s written with no `status`, which could never render.
- **Also:** `statusNote` renders verbatim in the app's banner but was being
  written as maintainer prose (23 of 24 in English, in a Spanish-default app —
  the same class of bug as v1.1, one field over). Added `statusNoteEs` with the
  `notesEs` fallback pattern; the gate requires it on every `changed`/`canceled`
  record and warns when a `statusNote` grows long enough to be an audit
  paragraph.
- **A postponement is a `signupUrl` change, not just a status change.** The
  app's checkout gate only looks at `status === 'canceled'`, but sweeps flag
  postponements as `changed` — so three races that were not happening (Minions
  Run CDMX and Discovery Offroad Valle, both postponed with no announced date;
  Pandemia Run 5K, recorded date already passed) stayed purchasable. When a
  race is canceled or postponed indefinitely, **null its `signupUrl`** — that
  is what disables the CTA. The gate now fails `status: 'changed'` with a
  null-or-past date while a `signupUrl` is still present.
- **Cadence finding, not yet changed:** the routine verifies races due within
  ~7 days, so a race is first checked after most registrations have closed. On
  2026-08-10, 8 of 23 races inside 21 days had never been verified — and the
  wrong start time on the Maratón CDMX Telcel, the country's highest-traffic
  race, survived precisely because it sat outside that window. Widening to ~21
  days is the obvious next upgrade — measure before adopting.

## v1.1 — 2026-07-22 — split notes into user-facing vs internal

- Added `sourceNotes` to the schema (`references/schema.md`) for everything
  about *how* the data was gathered — conflicting sources, stale slugs, dates
  checked, unverifiable claims. `notes` is now strictly what a runner deciding
  whether to sign up would want to read; it renders verbatim in the app's UI.
- **Why:** an app-side audit found 103 of 195 races had research audit-trail
  text ("as of 2026-07-04", "could not verify", "single-calendar source")
  bleeding straight into the Notes field users see on the race detail screen —
  traced to the anti-hallucination contract's own instruction (item 4, and the
  old schema's `notes` doc) to "flag the conflict in notes." That instruction
  is what this version fixes.
- Updated `SKILL.md` item 4, `references/schema.md`'s field doc, and
  `workflows/sweep.md`'s contract line + checklist item accordingly. The
  weekly race-watch cloud routines were checked and don't touch `notes` (only
  `status`/`statusNote`/`lastVerified`), so they weren't a contributing cause.

## v1.0 — 2026-07-05 — initial method

- Established the **A-grade recommendation**: Methodology C (one combined
  discovery agent per city + mandatory flagship self-audit) + a targeted verify
  pass on flagship/high-traffic races + one shared route pass at the end.
- Codified the anti-hallucination contract, source taxonomy, per-city
  renderer-of-record concept, known traps, and the race schema.
- **Evidence:** A/B/C comparison across MTY, CDMX/EdoMex, Puebla, GDL, QRO
  (see `references/methodology-comparison.md`). C matched B's efficiency
  (~11 races/run vs A's ~6) with the evenest completeness and the best
  self-gap-catching (most conflict-notes, most local renderers discovered).
- **Operational lesson baked in:** batch ~3 agents and merge before the next
  batch — a 10-at-once run hit the account session limit and lost all 10
  outputs (research done, JSON never emitted).

### Known open items to revisit
- Time-of-day coverage is low across all methods (calendars publish dates first).
  Consider whether the targeted-verify pass should always capture start times.
- Route/map data is sparse because organizers publish courses late; the shared
  route pass may be worth re-running per-city ~3 weeks pre-race, or folding into
  the weekly race-watch routine.
- `soldOut` may deserve its own field (currently captured in `notes`) — big-city
  flagships sell out months early (G15K, Snoopy, Nike After Dark, Metepec).

