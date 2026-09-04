# Settings

`src/app/(tabs)/settings/` — a nested expo-router **stack**, not a single
screen. It was one 697-line scroll until 2026-09-03; each section is now its
own pushed sub-page, reached from a list of rows.

| Route | File | Holds |
|---|---|---|
| `/settings` | `index.tsx` | The list of rows. Configures nothing itself. |
| `/settings/profile` | `profile.tsx` | Leaderboard display name (`territory-sync.ts`). |
| `/settings/account` | `account.tsx` | Email OTP link / sign-in (`components/account-link.tsx`, `lib/account.ts`). |
| `/settings/preferences` | `preferences.tsx` | Appearance, language, race reminders. |
| `/settings/location` | `location.tsx` | Privacy zone + OS location permission. |
| `/settings/privacy` | `privacy.tsx` | The privacy notice (below). |
| `/settings/about` | `about.tsx` | Version, support, the long-press diagnostic. |

Two things to know before editing it:

- The stack is nested **inside** `(tabs)`, not at the root next to
  `race/[id]`, because a root-level `settings/` directory would collide with
  this tab's own `/settings` route. The consequence is that the floating pill
  tab bar stays visible over a pushed sub-page, so every sub-page pads its
  scroll content with `BottomTabInset` — that's what `SettingsPage` in
  `src/components/settings-ui.tsx` is for.
- The **Account group is hidden entirely** when `TERRITORY_ENABLED` is false
  (no Supabase env vars). That preserves what the old screen did via
  `fetchMyProfile()`'s `reason: 'disabled'`, without a round trip and without
  a row leading to an empty page.

## Support email — source of truth

**support@racesmx.com**

This is the canonical value. If it changes, edit it here first, then mirror
it into `SUPPORT_EMAIL` in `src/app/(tabs)/settings/about.tsx` (it's a plain
string constant with a comment pointing back to this doc — there's no build
step in this Expo project that reads Markdown at runtime, so the two have to
be kept in sync by hand). It renders as a tappable `mailto:` row.

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
Lives at `/settings/privacy`; the strings are the `privacy.*` keys in
`src/lib/i18n.tsx`, which are the source of truth — **this section is a map
to them, not a summary that can be trusted on its own.**

> **This section was stale until 2026-09-03** and is called out here so the
> next reader doesn't trust it the way the last one did. It still described
> the app as having "only two data flows", "no accounts", and "nothing
> stored server-side to delete" long after Territory Mode began uploading
> runs to Supabase and `lib/account.ts` added email sign-in. The i18n copy
> had kept up; this doc had not. **Anything that moves data off-device must
> update the `privacy.*` strings in the same change** — see the
> "privacy copy follows the data" rule.

The flows disclosed, and where each lives:

- **Location** — GPS (device-only for race discovery) with an IP fallback via
  ipapi.co (only fires when GPS is unavailable). See `src/lib/location.ts`.
- **Saved races** — race IDs only, local SQLite (native) / localStorage
  (web), never synced. See `src/lib/db.ts` / `src/lib/db.web.ts`.
- **Territory** — recorded runs (route + claimed tiles) ARE uploaded to
  Supabase, and are visible to other runners on the leaderboard. See
  `src/lib/territory-sync.ts`.
- **Identity** — an anonymous per-device Supabase account, optionally linked
  to an email from `/settings/account`. See `src/lib/account.ts`.
- **On-device at rest** — the upload queue, the in-progress run checkpoint,
  and the last-run diagnostic each store a raw (untrimmed) route. See
  `upload-queue.ts`, `run-checkpoint.ts`, `last-run-debug.ts`.
- **Privacy zone** — the home point that trims each session's start and end
  before upload. Never leaves the device. See `privacy-zone.ts`.

Deletion: local data goes with the app / site data; uploaded territory is
deleted by writing to the support address, which is stated in the notice.

## Appearance

Light / Dark / System, via `src/lib/theme-mode.tsx`'s `ThemeModeProvider`.
Persisted the same way the language toggle is (a pref key through
`src/lib/db.ts` / `db.web.ts`), and applied app-wide with
`Appearance.setColorScheme()` — every screen already keys its colors off
`useColorScheme()`, so no other screen needs to know this exists.
