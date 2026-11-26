---
paths:
  - "src/app/**"
  - "src/components/profile-pill.tsx"
---

## Nav restructure (2026-09-17) — three tabs, Profile as a floating pill

Bottom nav dropped from five tabs to three: **Run** (`index.tsx`),
**Leaderboard** (`leaderboard.tsx`), **Races** (`races.tsx`). Two things had
to move because of it:

- **Saved races** folded into Races as a "Discover/Saved" segmented toggle
  at the top of that screen (`races.tsx`), reusing the same `RaceCard` and
  the same upcoming/past section logic the old `myraces.tsx` had.
- **Conquered Areas** (the old Saved tab's territory map) moved into
  Leaderboard as a new first sub-tab, **My Achievements**
  (`achievements-view.tsx`) — same map/detail-bubble/fetch logic the deleted
  `myraces.tsx`'s `FencesView` used, but self-contained (owns its own
  fetch/focus/signal wiring) rather than sharing Leaderboard's other two
  boards' effects. It needs no location/district at all, unlike its two
  sibling sub-tabs (Municipio, Local Leaders — see below), and
  `leaderboard.tsx`'s `useCurrentLocation({ autoRequest: activeBoard !==
  'mine' })` is what keeps opening the app from prompting for location just
  because My Achievements happens to be the default sub-tab.
- Its detail bubble gained Distance/Pace/Time/Tiles stats — `duration_s` was
  already stored on every run (`territory-sync.ts`'s `MyFence.durationS`)
  but never read back before this; `formatPace()` (`tracking.ts`) is new.

**Profile dropped off the tab bar entirely.** It's a root Stack push at
`/profile` (`src/app/profile/`, moved out of `(tabs)/settings/` — the old
`settings/profile.tsx` sub-page is now `profile/account.tsx`, to avoid a
`/profile/profile` route), reached via a floating avatar pill
(`profile-pill.tsx`) rendered on all three main tabs. Being a root push
(same level as `race/[id]`) means it has no bottom tab bar to fall back on,
so its own back chevron checks `router.canGoBack()` and falls back to
`router.replace('/')` — a direct reload or a shared link to `/profile`
arrives with no history, and a bare `router.back()` would silently strand
the runner there.
