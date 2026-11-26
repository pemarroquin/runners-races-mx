---
paths:
  - "**/*map*.web.tsx"
  - "**/*map*.tsx"
  - "src/components/**"
---

# Maps (Mapbox)

- **A cleanup that touches the map runs AFTER the map is destroyed.** On
  unmount React runs effect cleanups in declaration order, so the mount
  effect's `map.remove()` goes first and mapbox-gl leaves `style` undefined
  behind it. `track-map.web.tsx`'s shimmer cleanup then called
  `if (map.getLayer(...))` on that corpse — and `getLayer` is itself what
  throws on a removed map, so the guard written to make the call safe WAS
  the crash. With no error boundary anywhere, React unmounted the whole tree:
  a blank white page on every single tap of Finish, holding the only copy of
  a finished run. Any cleanup touching a captured `map` must first ask
  whether it is still the live one (`mapRef.current === map &&
  readyRef.current`) — never rely on cleanup order, and never assume a
  Mapbox getter is safe on a destroyed map. Fixed 2026-09-09 (PR #41), which
  also added `MapErrorBoundary` around the maps so a map crash can never
  again cost a run.

- **Reproducing a web-only crash: drive real Chrome over CDP with a
  synthetic `navigator.geolocation`.** A phone gives you a blank screen and
  no stack. `--headless=new --use-gl=angle --use-angle=swiftshader
  --enable-unsafe-swiftshader` (Mapbox needs WebGL), install the stub via
  `Page.addScriptToEvaluateOnNewDocument`, and define it with
  `Object.defineProperty(navigator, 'geolocation', ...)` — a plain
  assignment gets replaced and reads back as PERMISSION_DENIED. Move the
  fake runner at ~3.3 m/s: faster than a real pace and every fix is
  correctly rejected, so the run records 0 m and you debug your own harness.
  Note Chrome REPLAYS a previous page's console errors when you re-attach,
  so confirm a fix in a FRESH profile before believing the exception is gone.

- **Don't "fix" a lost-fetched-state regression by hiding a live Mapbox
  surface with `display: 'none'` instead of unmounting it — tried and
  reverted, 2026-09-17.** Once My Achievements got its own `active`-gated
  timers (above), switching Leaderboard's sub-tabs still fully unmounts/
  remounts `AchievementsView` (it's an early-return branch keyed on
  `activeBoard`), so toggling away and back re-fetches and briefly flashes a
  loading spinner — a real, minor regression from when Conquered Areas was
  its own top-level tab (which expo-router never unmounts on tab-switch, so
  it never lost state). The fix attempted was keeping `AchievementsView`
  permanently mounted and toggling `display:'none'` on its wrapper instead.
  Reverted before shipping: none of this codebase's Mapbox components
  (`territories-map.web.tsx`, `fence-map.web.tsx`, `track-map.web.tsx`) call
  `.resize()` on their container, because until this attempt none of them
  had ever needed to survive a hidden-then-shown container — going from
  `display:'none'` (0×0) back to visible is a known way to leave a Mapbox GL
  canvas blank or misaligned until something else forces a resize, and this
  session cannot drive a real browser to verify it (see the no-self-visual-QA
  memory). Left as the accepted tradeoff: a brief refetch-flash on sub-tab
  toggle, not an unverifiable maybe-broken map. If this is revisited, it
  needs either an explicit `map.resize()` wired to the visibility toggle, or
  real device/browser verification before it ships — not both skipped again.
