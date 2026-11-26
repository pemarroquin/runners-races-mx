---
paths:
  - "src/lib/tracking.ts"
  - "src/lib/geolocation*"
  - "src/lib/run-checkpoint.ts"
  - "src/lib/privacy-zone.ts"
  - "src/app/(tabs)/index.tsx"
---

# Tracking: GPS, duration, recovery

- **`duration_s` is running time, and pace divided by the wall clock until
  2026-10-25.** A run left recording for hours after a 6.9 km loop showed
  46 min/km on My Achievements, the share card and the leaderboard totals.
  `uploadRun` now writes `activeDurationS(points, wallClockS)`
  (gap-policy.ts): wall clock minus gaps over 60 s that `planGapClosures`
  won't bridge or that nobody moved across. `npm run
  backfill-active-duration` rewrote the old rows; it reads started_at/ended_at,
  so it is safe to re-run. Never feed it an existing `duration_s`: that
  subtracts the gaps twice. Separately, `distance_m` is LONGER than
  `raw_path` on any run that starts or ends at home, because the privacy zone
  trims the path but not the distance. That is by design, not drift.

- **Safari has no `geolocation` in the Permissions API, so every permission
  check is a real GPS probe.** `requestPermission()` (geolocation.web.ts)
  rejects out of `navigator.permissions.query` on Safari and falls through to
  `getCurrentPosition` — a native prompt plus up to a 10 s timeout. Anything
  awaiting it is frozen for that whole window, so NEVER put state the user
  is waiting to see behind it. Checkpoint recovery did exactly that and
  rendered a recovered 40-minute run as `0:00 | 0 m | Searching for GPS
  signal…` until the probe returned, which reads as "Resume did nothing"
  (reported on a real phone, fixed in PR #43 — restored values now go on
  screen before the await; only `legStartRef` waits, so the clock doesn't
  count time spent at a permission prompt).

- **Never drop the only offer of a recoverable run before the recovery
  succeeds.** `resumeCheckpoint` hid the Resume/Discard prompt on tap; when
  the permission probe then refused, the runner landed on "New session" with
  no way back, while the run sat untouched in localStorage. Losing the offer
  is indistinguishable to the runner from losing the run.
  `restoreFromCheckpoint` returns a boolean now and the offer is restored on
  false. The checkpoint on disk is only ever cleared by a successful save, a
  reset, or an explicit Discard — verify that stays true.
