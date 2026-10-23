# Methodology Comparison (the evidence for the recommendation)

Measured across the first 5 cities (2026-07). Percentages are the fair signal —
raw counts conflate market size (MTY is a bigger running city than Querétaro).

| Methodology | Cities | Races | Agent-runs | Races/run | Link % | High-conf % | Time % | Venue % |
|---|---|---|---|---|---|---|---|---|
| **A** — 3-angle + audit + link-sweep + route | MTY | 41 | 7 | 5.9 | 63% | 73% | 31% | 75% |
| **B** — 3-angle fan-out, no audit | CDMX/EdoMex | 39 | 3 | 13.0 | 84% | 56% | 53% | 56% |
| **C** — 1 combined agent + self-audit | PUE, GDL, QRO | 34 | 3 | 11.3 | 58% | 58% | 61% | 61% |

Extra signals: A = 16 map pins (only cohort with a route pass); B flagged 2
postponed races; C produced the most conflict-notes (5) and the most distinct
source-hosts (11).

## What the deltas mean

- **A costs ~2× per race for diminishing returns.** The 4 extra passes (audit +
  two link-sweeps + route) dredged up a low-completeness tail — that's why A has
  the best venue depth (75%) but the WORST time coverage (31%): calendar-only
  municipal races with no published start time.
- **B is fast but shallow.** Best link coverage (84%) only because CDMX renderers
  expose signup links inline; lowest confidence/venue because nothing verified
  the tail. Breadth over accuracy.
- **C is the balance point** — near B's efficiency with the evenest completeness
  profile, and the self-audit is why it throws the most conflict-flags and
  discovers the most local renderers. It **catches its own gaps** — the direct
  fix for "we're missing data points."
- **Two gaps are method-independent:** maps (a separate one-off pass) and
  time-of-day (organizers publish dates before times; race-watch fills it near
  race day).

## The resulting recommendation (A-grade)

**C + targeted flagship verify + one shared route pass.** Get C's efficiency and
self-auditing breadth; add A-grade accuracy ONLY on the flagship/high-traffic
races (targeted, not blanket); run route-hunting once for the whole batch
instead of per city. See `../workflows/sweep.md`.

## If you re-measure

Add a row per new methodology tried, keep the percentage columns, and if the
winner changes, update `../SKILL.md` and `CHANGELOG.md`. Watch for confounds:
city size, season (more races publish in autumn), and how many national-brand
editions land in the window.
