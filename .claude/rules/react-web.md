---
paths:
  - "src/**/*.tsx"
  - "src/lib/i18n.tsx"
---

# React, React Compiler and web

- **An impure function called during render gets its result CACHED by the
  React Compiler.** The i18n provider handed out
  `t: (key, options) => i18n.t(key, options)` — a closure over nothing
  reactive whose result depended on the mutable `i18n.locale` singleton. The
  compiler cached `t('settings.appearance')` across renders, so tapping
  ES/EN flipped `locale` state (the pills' `aria-checked` updated within
  500 ms) while every translated string on screen stayed in the old language
  until a full reload. The toggle was dead in production and no gate could
  see it. Fixed in PR #44 by threading the locale through the call
  (`i18n.t(key, { locale, ...options })`), which makes the translation pure
  in its arguments so the caching becomes correct. Rule: anything called
  during render must be a function of its arguments — if it reads mutable
  module state, pass that state in. Sibling of the updater-purity trap.

- **A ref cannot wake an effect.** `track-map.web.tsx` gated eight effects on
  a `readyRef`; two of them depended only on `active` and so never ran at all
  when a session started before the map loaded — silently removing the
  camera's browse hold. Readiness is state now. When gating an effect on
  readiness, ask what re-runs it.

- **A continuous animation timer inside a Tabs screen keeps running after
  you switch tabs away from it, because expo-router never unmounts a tab on
  switching away — it only stops reporting focus.** `TerritoriesMap.web.tsx`
  (My Achievements' map, `achievements-view.tsx`) runs two setInterval-driven
  loops whenever it has a saved territory — a gradient flow along each
  outline and a colour-shimmer on its fill wall — gated only on `hasSaved`,
  never on whether the screen was actually visible. Reported as the phone
  heating up during ordinary browsing (2026-09-17): once a runner opened
  Leaderboard even once (My Achievements became the DEFAULT sub-tab in the
  same nav restructure that surfaced this), both timers kept ticking and
  Mapbox kept repainting indefinitely in the background, on Run or Races,
  with nothing on screen to show for it. Fixed with an `active` prop on
  `TerritoriesMap`, threaded from `achievements-view.tsx`'s own
  `useIsFocused()` — same pattern `track-map.web.tsx`'s pre-existing `active`
  prop already used for its own shimmer, just never carried over here. Rule:
  any component that starts a `setInterval`/`requestAnimationFrame` loop and
  can be mounted inside a Tabs screen needs an explicit "is my own screen
  focused" gate — "does it have something to animate" is not the same
  question. `gradient-flow.ts`'s `startGradientFlow` already paused on a
  hidden BROWSER tab (`visibilitychange`); the shimmer's own raw
  `setInterval` had no such handling at all until this fix, which is a second,
  independent instance of the same class of gap.

- **Two Claude Code sessions can be editing this exact working directory at
  the same time, and their work lands in ONE shared commit.** During the
  2026-09-17 nav-restructure session, a second, independent agent was
  building the shareable route/stats sticker (`share-card.tsx`,
  `route-shape.ts`) in the same checkout concurrently — files the first
  session hadn't touched (and hadn't been told about) kept appearing
  fully-formed mid-read, and a file already read minutes earlier would come
  back changed on a later read. Neither session's `git status` showed
  anything odd because there was only ever one working tree; the two bodies
  of work were git-committed and PR'd together as one commit
  (`Co-Authored-By: Claude Sonnet 5`) without either session initiating that
  commit itself. Not a bug — just a fact about this workspace worth knowing
  before assuming an unexplained diff is your own mistake: re-read a file
  fresh before editing it if its content doesn't match what you last saw,
  and don't assume a repo's working tree reflects only your own session's
  changes.

- **A browser page zoom silently corrupts `useWindowDimensions()`, and the
  Track tab invites one.** Reported 2026-09-18 with screenshots: the bottom
  tab pill rendered at its designed ~246pt on one screenshot and stretched
  edge-to-edge on the next, same three tabs, same text size, same phone.
  Cause is two coordinate systems mixed in one calculation — the old
  `FloatingTabBar` sized itself with
  `sideMargin = max((windowWidth - barWidth) / 2, 16)` applied as
  `left`/`right`, where `windowWidth` came from `useWindowDimensions()` but
  `left`/`right` resolve against the real parent. react-native-web computes
  that width as `Math.round(visualViewport.width * visualViewport.scale)`
  (`node_modules/react-native-web/dist/exports/Dimensions/index.js`), a
  product that only equals the layout viewport while Safari's pinch-zoom
  state is settled. Once it under-reports, the `max()` clamps to its 16pt
  floor and the pill snaps to `screenWidth - 32` and STAYS there — no further
  resize event corrects it.
  The page zoom itself is not exotic on this app: mapbox-gl's stylesheet
  already sets `touch-action: none` on `.mapboxgl-canvas-container`, so a
  pinch on the MAP never page-zooms — but every RNW view layered on top of it
  (pause/stop, the timer, the tab bar) inherits no `touch-action`, so a pinch
  there is a plain document zoom. And it is near-impossible to undo by
  pinching back, because the fingers land on a canvas that consumes the
  gesture for its own zoom.
  Fixed on both ends, deliberately: `page-zoom-lock.web.tsx` removes the
  cause (`touch-action: manipulation` for double-tap, plus `preventDefault`
  on WebKit's `gesturestart`/`gesturechange`/`gestureend` — safe because
  mapbox-gl registers zero `gesture*` handlers, grepped across
  `dist/mapbox-gl.js` and `dist/mapbox-gl-dev.js`), and `FloatingTabBar` no
  longer measures anything at all (a full-width `dock` with
  `alignItems: 'center'` and `paddingHorizontal: 16`, holding a pill at
  `width: barWidth, maxWidth: '100%'` — Yoga resolves both against the same
  box). Rule: if a layout can be expressed in flex, do not compute it from a
  measured viewport.
  Where a NUMBER is genuinely unavoidable — `races.tsx`'s carousel card width
  feeds `snapToInterval`, which flex cannot express — measure the container
  with `onLayout` instead of reading the window. `onLayout` reports the real
  Yoga box, the same coordinate system the children lay out in, so it cannot
  disagree with them; a visual pinch-zoom leaves the layout viewport alone,
  doesn't fire it, and correctly doesn't need to. The one cost is that the
  measurement starts at 0 and lands on the first layout pass — fine there
  only because every carousel mounts inside `FadeInDown` (opacity 0 on frame
  one), so nothing is painted before the width is known. Check that a fade
  actually covers the first frame before copying the pattern.
  `filter-popover.tsx` (now `left`/`right` + `maxWidth`) and `buy-sheet.tsx`
  (percentage height, `onLayout` for the slide maths) were moved off it on
  2026-10-23, and `eslint.config.js` now bans importing `useWindowDimensions`
  or `Dimensions` from react-native outright.
