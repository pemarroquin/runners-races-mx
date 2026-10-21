---
name: race-research
description: "Compile or expand verified, source-cited race/event listings for a city or region — built for the Running App (running-app/assets/data/races.json) but general to any geographically-scoped event dataset. Use when adding a new city, refreshing an existing city's calendar, filling missing data points, or auditing race data for completeness/accuracy. Encodes the A-grade methodology proven across Monterrey, CDMX, Guadalajara, Puebla, and Querétaro: one combined discovery agent per city with a MANDATORY flagship self-audit, a targeted verify pass on high-traffic races, and one shared route/map pass — all under a strict anti-hallucination contract (every race carries a fetched sourceUrl, unknowns stay null, conflicts are recorded not resolved). Mexico-scoped by default. Trigger phrases: 'add races for <city>', 'sweep <city>', 'scrape races', 'expand to <city>', 'compile the race calendar', 'refresh race data', 'why are we missing races'."
---

# Race Research

Repeatable method for building a verified race/event calendar for a city, one
that survives contact with real-world data sources (SPAs that render nothing,
stale prior-year links, calendars that list dates but not times, brands that
run the same-named race in five cities). Everything here was learned by doing
it — the traps are traps we actually hit.

**Origin narrative & full field notes:** `Source Data/Outputs/Running App/Race
Research Playbook — City Expansion.md` in Pedro's workspace. This skill is the
executable distillation; the playbook is the story. Keep them in sync when you
upgrade either.

---

## The A-grade recommendation (what this skill does)

Three methodologies were measured across 5 cities (see `references/methodology-comparison.md`).
The winner — best accuracy per unit cost — is **C + targeted verify + route**:

1. **Discovery (Methodology C):** ONE combined agent per city that enumerates
   the national calendars, verifies each race on its own page, and runs a
   **mandatory flagship self-audit** before returning. → `workflows/sweep.md` §1
2. **Targeted verify pass:** a second, cheap agent that deep-verifies ONLY the
   flagship / high-traffic races (date, start time, venue, signup link tied to
   the *current* edition, cancellation status). Not a blanket audit — that's
   Methodology A's mistake (2× cost for a low-completeness tail). → §2
3. **Shared route pass:** ONE agent, run once after all cities are merged, that
   hunts course maps + start coordinates for the whole new batch. → §3

Do NOT run a blanket audit pass on every race, and do NOT run route-hunting
per-city — both were shown to be poor cost trades.

---

## The anti-hallucination contract (non-negotiable, every agent gets it verbatim)

1. **No race without a fetched source.** Every race carries a `sourceUrl` the
   agent actually loaded. "I'm sure it exists" is not evidence.
2. **Never invent** dates, times, prices, venues, or URLs. Unknown → `null`. A
   `null` is a valid, useful finding; a plausible guess is data poisoning.
3. **Only publish a `signupUrl` confirmed tied to the CURRENT edition** on a
   rendered page. Stale prior-year slugs/GUIDs from search results are a known
   trap — see `references/sources.md`.
4. **Conflicts are recorded, not resolved silently.** Two sources disagree on
   date/venue/edition → keep the better-evidenced value, flag the conflict in
   `sourceNotes` — never in `notes`, which is user-facing and renders verbatim
   in the app. `notes` is for facts a runner deciding whether to sign up would
   care about (theme, cause, cap, price, schedule conflicts with other races);
   `sourceNotes` is for everything about how the data was gathered.
5. **Confidence per race** (`high`/`medium`/`low`): high = official event page
   or two independent calendars agree; medium = one calendar; low = aggregator
   mention only / date unpublished.
6. **Exclude** private/corporate-internal events and races outside the target
   metro or date window.

---

## When to use / not use

- **Use** for: adding a new city, refreshing a city near race season, filling
  missing fields, or investigating "why are we missing races."
- **Don't use** for: the weekly pre-race verification of imminent races — that's
  the separate race-watch cloud routine (status/statusNote/lastVerified fields).
  This skill is discovery + enrichment; race-watch is ongoing monitoring.

## Scale to the ask

- One city → run §1 (+ §2 if flagships matter). Batch the route pass (§3) if the
  city added map-worthy races.
- Many cities → **run in batches of ~3 agents**, merge each batch before
  launching the next. The account session limit has killed 10-at-once runs;
  3-at-a-time never loses more than one batch, and already-merged data is safe.

## Reference & workflow index

| File | Contents |
|------|----------|
| `workflows/sweep.md` | The 3-phase procedure, with the exact agent prompt templates |
| `references/sources.md` | Source taxonomy (national backbone + per-city renderer-of-record) and every known scraping trap |
| `references/schema.md` | The `races.json` race schema, id/slug rules, and distanceTag mapping |
| `references/methodology-comparison.md` | The measured A/B/C data that justifies the recommendation |
| `CHANGELOG.md` | Version history — **append here every time the method improves** |

## Upgrade protocol (this skill is meant to evolve)

When a run teaches you something better:
1. Change the method in `workflows/sweep.md` (or the traps in `references/`).
2. Add a dated entry to `CHANGELOG.md` explaining what changed and the evidence.
3. If it changes the headline recommendation, update the "A-grade" section above
   and mirror the change into the workspace playbook doc.
Treat the recommendation as the current best, not gospel — measure, then upgrade.
