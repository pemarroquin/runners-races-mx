# Source Taxonomy & Traps

## The national backbone (reusable in every Mexican city)

These render server-side and cover the whole country — they make each new city
cheap. Filter by city and enumerate:

| Source | What it's good for | Notes |
|--------|--------------------|-------|
| **asdeporte.com** | Event pages `/evento/<slug>/datos-del-evento` and `/ruta` | Server-rendered with full pricing, start times, sold-out state, and a "¿Cómo llegar?" Google-Maps link that carries **exact start coordinates**. |
| **runera.mx** | `runera.mx/carreras/<city>` + `/detalle/<slug>` | Server-rendered; the reliable **mirror** for SPA timing platforms (esp. Trotime). Carries the correct current-edition registration link + "inscripciones abiertas/agotadas". |
| **tritour.org** | City + trail calendars | Best for exhaustive enumeration; rows link to registration platforms. |
| **runmx.com** | Event pages + city calendars | Good flagship coverage. |
| **carrerasmexico.com** | Registration platform | Pages load details via JS — treat links as leads, verify elsewhere. |
| **emociondeportiva.com** | Emoción Deportiva events | Server-rendered, full pricing; the renderer-of-record in CDMX. |

## Renderer-of-record — differs by city (find it first)

A "renderer-of-record" is a server-rendered page that exposes a JS/SPA timing
platform's data (date, current-edition signup link, status). Identify the local
one before deep verification:

| City / region | Timing platform (often a SPA) | Renderer-of-record |
|---|---|---|
| Monterrey (NL) | **Trotime** (Angular SPA — raw fetch returns only the title), Idemsport | **runera.mx** detail pages |
| CDMX / EdoMex | Emoción Deportiva, Asdeporte | **emociondeportiva.com**, **runmx.com** |
| Puebla | **Chronostart** | chronostart.com.mx renders its own registration pages |
| Guadalajara | **Márcate**, COMUDE gov portal | asdeporte / runera; marcate.com.mx event pages |
| Querétaro | **Xtrail México**, **AQ Sports**, Emoción Deportiva | the organizers' own pages render; queretaromaraton.com for the flagship |

Also seen: government race portals (21k.cdmx.gob.mx, comudeguadalajara.gob.mx),
dashport.run (JS-rendered — same caveat as Trotime), entusmarcas, liebresmx,
running.life, finishers.com (international listings).

## Known traps (all cost us real time)

- **Client-rendered SPAs return empty shells.** Trotime, dashport, carrerasmexico
  give you a page title and nothing else on raw fetch. Use the renderer-of-record
  or the organizer's rendered page; never publish a link scraped from the SPA URL
  bar.
- **The stale-GUID / stale-slug trap.** Search engines index prior-year
  registration URLs. A `?edicionEventoId=<GUID>` or `-slug-2025` from search
  results can point to a finished edition (hit on Súper Héroes Run, Terra Regia,
  Rosa Fuerte, adidas GDL Shrek slug). ONLY publish a `signupUrl` confirmed on a
  rendered page tied to the current edition.
- **Generic city-center coordinates.** Asdeporte pages with an unconfirmed venue
  embed a placeholder Monterrey/CDMX centroid in the maps link. Discard coords
  that equal the city centroid.
- **Stale calendar links.** A calendar row's link is a *lead*, not confirmation
  (Idemsport's 2026 calendar linked 2025 slugs and even the wrong event).
- **Facebook/Instagram: don't scrape, search.** FB blocks anonymous fetch, but
  organizer posts surface via web search — the earliest signal for a
  change/cancellation (how we caught the Duendes registration opening).
- **Same-named national brand races are separate local editions.** Barbie Run,
  Bimbo Global Race, Simicarrera, Snoopy Run each run in multiple cities on
  different dates — keep them as distinct rows, do not dedupe across cities.
- **Branding ≠ location.** GDL races branded "Guadalajara" are physically in
  Zapopan; set `city` to the real municipality but `state` stays the region key.
- **Dates before times.** Calendars publish the date months out but the start
  time only weeks out. Low `time` coverage is expected, not a failure; the
  weekly race-watch fills it in near race day.
