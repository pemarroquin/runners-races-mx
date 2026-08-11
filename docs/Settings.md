# Settings screen

`src/app/(tabs)/settings.tsx` — the app's only settings/about surface (no
accounts, no backend, nothing else to configure). Holds three things:

## Support email — source of truth

**support@racesmx.com**

This is the canonical value. If it changes, edit it here first, then mirror
it into `SUPPORT_EMAIL` in `src/app/(tabs)/settings.tsx` (it's a plain string
constant with a comment pointing back to this doc — there's no build step in
this Expo project that reads Markdown at runtime, so the two have to be kept
in sync by hand). It renders as a tappable `mailto:` row.

## App version

Read live from `Constants.expoConfig?.version` (`expo-constants`), which
mirrors whatever `app.json`'s `expo.version` says — never hardcode a version
string in the screen itself. `app.json` and `package.json` should carry the
same value; bump both together.

Versioning follows the Notion Changelog page (Runners' Races MX → Changelog),
which is the actual source of version history — the repo has no git tags.
When that page's latest entry moves (e.g. v0.4 → v0.5), bump `version` in
both `app.json` and `package.json` to match as part of the same change.

## Privacy notice

Plain-language, Spanish primary (LFPDPPP — this ships to Mexican consumers).
Discloses the app's only two data flows:

- **Location** — GPS (device-only, never leaves the phone) with an IP
  fallback via ipapi.co (only fires when GPS is unavailable; the IP is the
  only thing that ever leaves the device). See `src/lib/location.ts`.
- **Saved races** — race IDs only, local SQLite (native) / localStorage
  (web), never synced anywhere. See `src/lib/db.ts` / `src/lib/db.web.ts`.

No accounts, no tracking, no analytics, nothing sold or shared. No data
deletion flow is offered beyond "delete the app" — stated plainly, since
nothing is stored server-side to delete.

## Appearance

Light / Dark / System, via `src/lib/theme-mode.tsx`'s `ThemeModeProvider`.
Persisted the same way the language toggle is (a pref key through
`src/lib/db.ts` / `db.web.ts`), and applied app-wide with
`Appearance.setColorScheme()` — every screen already keys its colors off
`useColorScheme()`, so no other screen needs to know this exists.
