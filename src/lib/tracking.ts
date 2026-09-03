// Foreground GPS run recorder for Territory Mode. Owns the geolocation
// subscription (src/lib/geolocation.ts / geolocation.web.ts — never
// expo-location directly, see that module's header) and the growing point
// list; the fence geometry itself is computed separately by territory.ts
// (pure, tested) once the run stops.
//
// Foreground-only on purpose: background location needs an entitlement Expo
// Go can't grant, which would force a custom dev client and break this
// project's "Expo Go on device" testing workflow. See the feature plan's
// "Tracking mode" decision. Practical consequence: the run screen has to
// stay open, and the OS may throttle fixes when the screen locks.
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useCallback, useEffect, useRef, useState } from 'react';

import { evaluateGap } from '@/lib/gap-policy';
import {
  getCurrent,
  getLastKnown,
  requestPermission,
  watch as watchPosition,
  type GeoErrorKind,
  type GeoFix,
  type GeoWatch,
} from '@/lib/geolocation';
import { incrementPilotCounter } from '@/lib/pilot-instrumentation';
import { clearCheckpoint, saveCheckpoint, type RunCheckpoint } from '@/lib/run-checkpoint';
import { haversineM, type LatLng } from '@/lib/territory';

export interface TrackPoint extends LatLng {
  ts: number;
}

export type TrackStatus = 'idle' | 'starting' | 'running' | 'paused' | 'finished';
export type TrackError = 'permission' | 'unavailable' | null;

// GeoErrorKind carries a 'timeout' case the UI has no separate copy for yet
// (see track.permission / track.unavailable in i18n.tsx) — surfacing a
// denied or dead watch matters more than distinguishing "the receiver never
// answered" from "it's not there at all", so timeout folds into the same
// bucket as unavailable rather than looking like a working watch.
function toTrackError(kind: GeoErrorKind): TrackError {
  return kind === 'permission' ? 'permission' : 'unavailable';
}

// Fixes worse than this are dropped rather than recorded: a wild fix doesn't
// just add noise, it inflates the distance total and the fence area with
// movement that never happened.
//
// This was 50m and it was far too strict — phones routinely report 60-90m
// accuracy at cold start, indoors, or between buildings, so on a real device
// EVERY fix was rejected: no points, distance stuck at 0, and nothing on
// screen to distinguish it from a denied permission. The threshold is now
// generous enough to only exclude genuinely useless fixes, the first fix is
// never rejected (see onFix), and the numbers behind the decision are
// exposed so this can be diagnosed on a device instead of guessed at.
const MIN_ACCURACY_M = 100;
const TIME_INTERVAL_MS = 2000;
// How stale a cached position may be and still serve as the run's instant
// origin. Kept short so the worst-case phantom first segment (device moved
// since the cache) stays a few metres; in practice the Track tab's idle
// watcher was feeding fixes seconds before Start, so the cache is fresh.
const LAST_KNOWN_MAX_AGE_MS = 10_000;
// Consecutive poor fixes tolerated before the accuracy filter gives up and
// records one anyway.
//
// An accuracy filter's job is to reject OUTLIERS — the occasional wild fix
// that would inflate distance and area with movement that never happened.
// It is NOT supposed to reject the environment. Between office buildings a
// phone can honestly report >100m accuracy on every fix for minutes at a
// time, and the old unconditional filter then dropped EVERY fix after the
// first, so the route never grew past its origin point and no line was ever
// drawn (reported on device, 2026-08-27).
//
// What made that so confusing to diagnose: resume() clears `lastRef`, which
// makes the next fix count as "first" — and the first fix is always kept.
// So pausing and resuming was the only way to get a point in, and tracking
// appeared to work only when the runner poked it.
//
// Failing open after a few rejections keeps outlier rejection working while
// guaranteeing the track can never starve: a degraded route beats no route.
const MAX_CONSECUTIVE_REJECTS = 3;
// 3m, not 5: this gates when iOS delivers a callback at all (it maps to
// CLLocationManager's distanceFilter), so a larger value means a walker sees
// nothing happen for an uncomfortably long time at the start of a session.
const DISTANCE_INTERVAL_M = 3;
const KEEP_AWAKE_TAG = 'territory-session';
// Checkpoint write throttle — see run-checkpoint.ts. Whichever trips first:
// 10 accepted points, or 15s since the last write.
const CHECKPOINT_POINTS_INTERVAL = 10;
const CHECKPOINT_MS_INTERVAL = 15_000;

/**
 * Whether a fix should be recorded. Pure, so the rule can be tested without
 * a device or a React renderer — see test/tracking.test.ts.
 *
 * - The first fix of a leg is always kept (a cold receiver's first reading
 *   is often poor, and rejecting it leaves the run with no origin).
 * - An isolated poor fix is dropped.
 * - A SUSTAINED run of poor fixes is accepted, because that is a weak-signal
 *   environment rather than an outlier, and refusing to record anything is
 *   worse than recording something imprecise.
 */
export function shouldAcceptFix(params: {
  isFirst: boolean;
  accuracyM: number | null;
  consecutiveRejects: number;
  maxAccuracyM?: number;
}): boolean {
  const { isFirst, accuracyM, consecutiveRejects, maxAccuracyM = MIN_ACCURACY_M } = params;
  if (isFirst) return true;
  if (accuracyM === null) return true; // no accuracy reported — nothing to judge on
  if (accuracyM <= maxAccuracyM) return true;
  return consecutiveRejects >= MAX_CONSECUTIVE_REJECTS;
}

export interface RunTracker {
  status: TrackStatus;
  points: TrackPoint[];
  distanceM: number;
  elapsedS: number;
  error: TrackError;
  startedAt: number | null;
  endedAt: number | null;
  /** Reported accuracy of the most recent fix, in metres. Null before any
   *  fix arrives. Surfaced in the UI so "weak GPS" is visibly different from
   *  "no permission". */
  lastAccuracyM: number | null;
  /** Fixes discarded for poor accuracy. If this climbs while points stay at
   *  zero, the filter is the problem — not permissions. */
  rejectedFixes: number;
  /** True while the filter is failing open — the signal is poor enough that
   *  fixes are being recorded despite failing the accuracy bar. Surfaced so
   *  a degraded track says so instead of quietly looking like a good one. */
  degradedSignal: boolean;
  /** The most recent RAW fix, before any accuracy filtering. This is what
   *  the map pin/camera should follow during a session: recording quality
   *  and "where is the runner" are different questions, and answering the
   *  second with the filtered list froze the pin on the first fix whenever
   *  the filter was rejecting everything after it. */
  lastFix: LatLng | null;
  /** True if the screen wake lock failed to acquire (or was refused) for the
   *  current session. navigator.wakeLock.request() rejects when the document
   *  isn't visible, and a swallowed rejection here looks identical to a held
   *  lock — this is the workspace's "never report unverified success" rule
   *  applied to the screen staying on. */
  keepAwakeFailed: boolean;
  /** Times this session has survived a background/foreground cycle while
   *  running. Ground covered during a gap is real (the runner kept moving)
   *  — unlike a deliberate pause, this is not "they stopped" — but it goes
   *  untracked while the app is hidden. Surfaced so the runner knows
   *  recording paused rather than silently dropping a stretch of the route,
   *  and so a real run's numbers can confirm or rule out the background-gap
   *  hypothesis for a reported distance discrepancy (2026-08-31: Pedro's
   *  app read ~10m low vs. an Apple Watch, then stepped to ~20m low in the
   *  last stretch — a step, not drift, points at one discrete gap). */
  gapCount: number;
  /** Total wall-clock time spent backgrounded across every gap this
   *  session, ms. */
  gapDurationMs: number;
  /** Sum of the straight-line distance between the last point recorded
   *  before each gap and the first point recorded after it, metres, for
   *  EVERY gap regardless of plausibility. Instrumentation: the raw
   *  measurement, not a claim about what's been credited to distanceM — see
   *  creditedGapM for the credited subset. The 2026-09-02 geometry audit
   *  (Source Data/Outputs/Running App/Geometry Audit — Saved Runs vs
   *  Recomputed (2026-09-02).md) confirmed this is where a real run's
   *  distance shortfall against `raw_path` came from. */
  gapChordM: number;
  /** Subset of gapChordM already added to distanceM, under the shared gap
   *  policy in src/lib/gap-policy.ts — the SAME distance/speed caps the
   *  tile builder (tiles.ts) uses to decide whether to bridge a gap into
   *  contiguous tiles, so the two subsystems can never independently decide
   *  a gap "happened" for one purpose but not the other. A gap that fails
   *  either cap still counts in gapChordM above but not here and not in
   *  distanceM — the hole stays a hole, exactly as before this existed. */
  creditedGapM: number;
  start: () => Promise<void>;
  pause: () => void;
  resume: () => Promise<void>;
  stop: () => void;
  reset: () => void;
  /** Continues a run recovered from run-checkpoint.ts after a reload —
   *  restores the recorded points/distance/elapsed time and reconnects the
   *  watch. The first live fix after reconnecting is treated as a leg break
   *  (see resume()): the gap between the checkpoint's last point and wherever
   *  the runner is now was never recorded, so drawing a straight line across
   *  it would be a phantom distance, not a real one. */
  restoreFromCheckpoint: (checkpoint: RunCheckpoint) => Promise<void>;
}

export function useRunTracker(): RunTracker {
  const [status, setStatus] = useState<TrackStatus>('idle');
  const [points, setPoints] = useState<TrackPoint[]>([]);
  const [distanceM, setDistanceM] = useState(0);
  const [elapsedS, setElapsedS] = useState(0);
  const [error, setError] = useState<TrackError>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [endedAt, setEndedAt] = useState<number | null>(null);
  const [lastAccuracyM, setLastAccuracyM] = useState<number | null>(null);
  const [rejectedFixes, setRejectedFixes] = useState(0);
  const [lastFix, setLastFix] = useState<LatLng | null>(null);
  const [degradedSignal, setDegradedSignal] = useState(false);
  const [keepAwakeFailed, setKeepAwakeFailed] = useState(false);
  const [gapCount, setGapCount] = useState(0);
  const [gapDurationMs, setGapDurationMs] = useState(0);
  const [gapChordM, setGapChordM] = useState(0);
  const [creditedGapM, setCreditedGapM] = useState(0);
  // The point + wall-clock time when the document was last hidden while
  // running, and a flag telling onFix its NEXT fix is the far end of an
  // open gap's chord. Refs: onFix reads/sets them synchronously in the
  // event handler, same reasoning as lastRef — a state value captured in
  // the callback would be stale.
  const gapStartRef = useRef<{ atMs: number; lastPoint: TrackPoint | null } | null>(null);
  const awaitingGapChordRef = useRef(false);
  // A ref, not state: onFix must read the CURRENT count synchronously, and a
  // state value captured in the callback would be stale.
  const consecutiveRejectsRef = useRef(0);
  // Checkpoint write throttle: last wall-clock write time and the points
  // count as of that write. Refs, not state — advancing them must not
  // itself trigger a re-render/effect loop.
  const lastCheckpointAtRef = useRef(0);
  const lastCheckpointPointCountRef = useRef(0);

  const subRef = useRef<GeoWatch | null>(null);
  const lastRef = useRef<TrackPoint | null>(null);
  // Guards beginRecording() against overlapping calls. watchPosition() is
  // async and only assigns subRef.current once it resolves — with no guard,
  // two calls to clearSub()+beginRecording() close together (visibilitychange
  // fires more than once in quick succession on iOS around lock/unlock and
  // app switching — this is not a hypothetical) race: the SECOND call's watch
  // overwrites subRef.current before the FIRST's resolves, so when the first
  // finally resolves it installs a watch that clearSub() can never reach
  // again — nothing still references it. That watch keeps feeding onFix for
  // the rest of the run: two watches, duplicated points, inflated distanceM,
  // inflated fence area. Bumped by clearSub() (invalidates anything in
  // flight) and by beginRecording() itself (claims a fresh generation);
  // beginRecording() then checks its captured value is still current before
  // installing anything.
  const recordingEpochRef = useRef(0);

  const clearSub = useCallback(() => {
    recordingEpochRef.current += 1;
    subRef.current?.remove();
    subRef.current = null;
  }, []);

  // Dropping the subscription on unmount matters more than usual here: the
  // GPS stays powered otherwise, and a stale callback would keep pushing
  // fixes into a dead component's state.
  useEffect(() => clearSub, [clearSub]);

  // Elapsed is accumulated from the current leg's start, not from the run's
  // startedAt: deriving it from startedAt would keep counting through a
  // pause and then jump forward on resume.
  const legStartRef = useRef<number | null>(null);
  const accumulatedRef = useRef(0);

  // Recording is foreground-only (Expo Go can't hold the background-location
  // entitlement), so the OS auto-locking the screen would silently end the
  // run. This doesn't defeat a manual lock — nothing available in Expo Go
  // can — but it does stop the most common way a run dies: the display
  // simply timing out in the runner's pocket.
  //
  // Wrapped in .then/.catch rather than the old bare `void` — a floating
  // promise with no catch means a refused lock (navigator.wakeLock.request()
  // REJECTS when the document isn't visible) was invisible, and the screen
  // dimmed mid-run with nothing on screen to explain why. Shared with the
  // visibilitychange handler below (Task 1.2), which needs the exact same
  // acquire-and-report behaviour when re-requesting the lock after a
  // background/foreground cycle.
  const tryKeepAwake = useCallback(() => {
    activateKeepAwakeAsync(KEEP_AWAKE_TAG)
      .then(() => setKeepAwakeFailed(false))
      .catch(() => setKeepAwakeFailed(true));
  }, []);

  useEffect(() => {
    if (status !== 'running' && status !== 'paused') return;
    tryKeepAwake();
    return () => {
      // Wrapped rather than returned directly: deactivateKeepAwake returns a
      // promise, and an effect cleanup must return void.
      deactivateKeepAwake(KEEP_AWAKE_TAG);
    };
  }, [status, tryKeepAwake]);

  useEffect(() => {
    if (status !== 'running') return;
    const tick = () => {
      const legStart = legStartRef.current;
      const legMs = legStart === null ? 0 : Date.now() - legStart;
      setElapsedS(Math.floor((accumulatedRef.current + legMs) / 1000));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [status]);

  // Checkpoints the in-progress run against a backgrounded-tab eviction — see
  // run-checkpoint.ts's header. Throttled to every 10 accepted points or 15s,
  // whichever comes first: NOT on every fix, which would serialise the whole
  // growing point array on every 2s tick. Reacting to `points`/`distanceM`
  // rather than writing inside onFix keeps this effect the only place that
  // decides WHEN to persist, while still always seeing the up-to-date values
  // (onFix's own setState calls are async/batched, so reading them there
  // would risk a stale array or total).
  useEffect(() => {
    if (status !== 'running' && status !== 'paused') return;
    if (points.length === 0 || startedAt === null) return;
    const now = Date.now();
    const pointsSinceLast = points.length - lastCheckpointPointCountRef.current;
    const msSinceLast = now - lastCheckpointAtRef.current;
    if (pointsSinceLast < CHECKPOINT_POINTS_INTERVAL && msSinceLast < CHECKPOINT_MS_INTERVAL) {
      return;
    }
    const legStart = legStartRef.current;
    const legMs = legStart === null ? 0 : now - legStart;
    const ok = saveCheckpoint({
      startedAt,
      points,
      distanceM,
      accumulatedMs: accumulatedRef.current + legMs,
      savedAt: now,
    });
    if (ok) {
      lastCheckpointAtRef.current = now;
      lastCheckpointPointCountRef.current = points.length;
    }
    // A failed write just means the checkpoint is stale until the next
    // threshold trips — the run itself is unaffected, only its crash
    // recovery is degraded. Nothing to surface here that the runner could
    // act on mid-run.
  }, [status, points, distanceM, startedAt]);

  const onFix = useCallback((fix: GeoFix) => {
    // Clear a stale error the moment a fix arrives. Per the W3C Geolocation
    // spec, watchPosition's error callback fires on TIMEOUT WITHOUT tearing
    // down the watch — so a runner passing under a bridge saw "location
    // unavailable" and it never left for the rest of an otherwise fine run
    // (Web-First Pilot P0.1, bug 2). Functional form: avoids capturing a
    // stale `error` (keeps this callback's deps at []) and returning the
    // same reference when already null lets React bail the re-render.
    setError((cur) => (cur === null ? cur : null));

    const accuracy = fix.accuracyM;
    setLastAccuracyM(accuracy);
    // Raw position, before ANY filtering — the map follows this. See the
    // interface comment on lastFix.
    setLastFix({ lat: fix.lat, lng: fix.lng });

    // Gap-chord instrumentation and credit (Task B → the 2026-09-02 gap
    // policy). This fix is the far end of an open gap — the visibilitychange
    // handler set the flag and captured the near end (gapStartRef.lastPoint)
    // before clearing lastRef for the leg break. Uses the RAW fix, same as
    // lastFix above: recording quality and "how far did the gap actually
    // span" are different questions.
    if (awaitingGapChordRef.current) {
      awaitingGapChordRef.current = false;
      const gapStart = gapStartRef.current;
      gapStartRef.current = null;
      const gap = evaluateGap({
        from: gapStart?.lastPoint ?? null,
        to: { lat: fix.lat, lng: fix.lng },
        // Duration from the two RECORDED fixes' own timestamps, not
        // wall-clock hidden-time — this is what tiles.ts's own gap check
        // uses when it recomputes from raw_path later, so a gap's
        // plausibility reads the same way from both directions.
        dtMs: gapStart?.lastPoint ? fix.ts - gapStart.lastPoint.ts : 0,
      });
      if (gap) {
        setGapChordM((cur) => cur + gap.chordM);
        if (gap.credited) {
          // Only the credited subset reaches distanceM. A gap that fails
          // either shared cap is left out exactly as before this existed —
          // see creditedGapM's own interface doc.
          setCreditedGapM((cur) => cur + gap.chordM);
          setDistanceM((cur) => cur + gap.chordM);
        }
      }
    }

    // Out-of-order guard: the fresh-fix seed in start()/resume() runs in
    // parallel with the watcher rather than blocking it, so a slow
    // getCurrent() can resolve AFTER the watcher has already delivered newer
    // fixes. Appending it would draw the route backwards.
    if (lastRef.current !== null && fix.ts < lastRef.current.ts) return;

    const isFirst = lastRef.current === null;
    if (
      !shouldAcceptFix({
        isFirst,
        accuracyM: accuracy,
        consecutiveRejects: consecutiveRejectsRef.current,
      })
    ) {
      consecutiveRejectsRef.current += 1;
      setRejectedFixes((n) => n + 1);
      return;
    }
    // Accepted despite failing the accuracy bar — the filter has failed open
    // rather than let the track starve. Worth saying out loud in the UI.
    const failedOpen =
      !isFirst && accuracy !== null && accuracy > MIN_ACCURACY_M;
    setDegradedSignal(failedOpen);
    consecutiveRejectsRef.current = 0;

    const point: TrackPoint = {
      lat: fix.lat,
      lng: fix.lng,
      ts: fix.ts,
    };
    // The ref is advanced HERE, in the event handler — never inside a
    // setState updater. React can re-run an updater (StrictMode, and the
    // React Compiler is on in this project), and a mutation hidden inside
    // one silently double-counts or no-ops.
    const prev = lastRef.current;
    lastRef.current = point;

    setPoints((cur) => [...cur, point]);
    if (prev) {
      const step = haversineM(prev, point);
      setDistanceM((cur) => cur + step);
    }
  }, []);

  // A denied or dead watch used to be invisible — see geolocation.web.ts's
  // header for why a web watch could silently stop delivering fixes forever.
  // Surfacing it here means a mid-run failure looks like a failure, not like
  // a working (if quiet) recording.
  const onWatchError = useCallback((kind: GeoErrorKind) => {
    setError(toTrackError(kind));
  }, []);

  // Shared by start() and resume(): get the watcher live, seeded with an
  // origin, WITHOUT ever blocking on a slow GPS one-shot.
  //
  // The previous version awaited getCurrentPositionAsync(BestForNavigation)
  // BEFORE starting the watcher. That call has no timeout and can sit for a
  // long time (or forever) waiting for the receiver to reach the requested
  // accuracy — during which the session was stuck at 'starting' with no
  // subscription, no clock, and no fixes: an entire walk could pass with
  // nothing tracked. Order is now:
  //
  //   1. Instant origin from the OS's cached position (getLastKnown()
  //      resolves immediately) — the route has a starting point at once.
  //   2. Watcher starts — recording is live from here, unconditionally.
  //   3. A fresh precise fix is requested in PARALLEL, never awaited; if it
  //      resolves it refines things, if it hangs nothing is waiting on it.
  //      onFix's timestamp guard drops it if the watcher has moved on.
  const beginRecording = useCallback(async () => {
    // Claim a generation. If clearSub() (or another beginRecording()) runs
    // before this one finishes, recordingEpochRef.current moves past this
    // value, and every step below becomes a no-op instead of installing a
    // subscription or fix nothing still wants — see recordingEpochRef.
    const epoch = ++recordingEpochRef.current;

    const cached = await getLastKnown(LAST_KNOWN_MAX_AGE_MS);
    if (cached && epoch === recordingEpochRef.current) onFix(cached);

    const sub = await watchPosition(
      { timeIntervalMs: TIME_INTERVAL_MS, distanceIntervalM: DISTANCE_INTERVAL_M, highAccuracy: true },
      onFix,
      onWatchError,
    );
    if (epoch !== recordingEpochRef.current) {
      // Superseded while the watch was being set up. This is the exact leak
      // the epoch guard exists for: without removing it here, this watch
      // would live on with nothing referencing it and keep calling onFix
      // for the rest of the run.
      sub.remove();
      return;
    }
    subRef.current = sub;

    getCurrent()
      .then((fix) => {
        if (fix && epoch === recordingEpochRef.current) onFix(fix);
      })
      .catch(() => {
        // Fine — the watcher is already delivering.
      });
  }, [onFix, onWatchError]);

  // Survives backgrounding. The Screen Wake Lock spec releases the sentinel
  // whenever the document is hidden, and — on web specifically — there is no
  // guarantee the old watch subscription is still alive when the tab comes
  // back (iOS Safari can suspend or evict a backgrounded tab outright). Only
  // web has a `document.visibilitychange` event at all; on native this
  // effect is a no-op (foreground-only recording already means the run ends
  // if the OS backgrounds the app, which is the accepted limitation the file
  // header documents — this task is scoped to the web pilot).
  useEffect(() => {
    if (status !== 'running') return;
    if (typeof document === 'undefined') return;

    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        // Only the gap's START TIME is captured here — never the chord's
        // near end. The old code read lastRef.current at this point and
        // used it as the chord's near end once we came back, which is
        // wrong whenever the watch survives backgrounding: this file's own
        // comment above admits "there is no guarantee the old watch
        // subscription is still alive... OR dead" — desktop Chrome in
        // particular keeps a background tab's geolocation watch running.
        // When that happens, onFix has no visibility guard, so it keeps
        // accepting fixes and adding them to distanceM/points for the
        // WHOLE hidden period, same as if the tab were foregrounded. A
        // chord computed from the point captured HERE (before any of that
        // hidden-period accumulation) back to wherever the runner is once
        // visible again would double-count every fix that arrived while
        // hidden — inflating distanceM rather than correcting it. Reading
        // lastRef.current fresh at 'visible' below, right before the
        // leg-break null, always reflects the true last recorded point
        // whether the watch died (unchanged since this event) or survived
        // (a point from seconds into the hidden period) — so the credited
        // chord can never overlap ground distanceM already has.
        gapStartRef.current = { atMs: Date.now(), lastPoint: null };
        return;
      }
      if (document.visibilityState !== 'visible') return;

      tryKeepAwake();
      // Restart the watch rather than trust the old subscription: same
      // reasoning as resume() — never assume a subscription survived
      // something that can tear it down.
      clearSub();
      // The chord's true near end — see the 'hidden' branch's comment.
      // Read BEFORE the leg-break null below, whatever it currently holds.
      const chordNearEnd = lastRef.current;
      // Leg break, exactly like resume(): the gap while hidden was never
      // recorded, so the first fix after reconnecting must not draw a
      // straight-line distance back to wherever the runner is now.
      lastRef.current = null;
      consecutiveRejectsRef.current = 0;
      void beginRecording();
      // A restart of an already-running session's watch — never a fresh
      // run's first start(). See pilot-instrumentation.ts.
      incrementPilotCounter('watchRestarts');

      const gapStart = gapStartRef.current;
      if (gapStart) {
        setGapCount((n) => n + 1);
        // Cross-run persisted total — see pilot-instrumentation.ts. Shares
        // this trigger point with gapCount above (a real backgrounding gap
        // during an active run) rather than a new one.
        incrementPilotCounter('backgroundEvents');
        setGapDurationMs((ms) => ms + (Date.now() - gapStart.atMs));
        if (chordNearEnd) {
          // There's something to chord against — onFix computes it and
          // clears both refs when the next fix lands.
          gapStartRef.current = { atMs: gapStart.atMs, lastPoint: chordNearEnd };
          awaitingGapChordRef.current = true;
        } else {
          // Gap started before any point had ever been recorded (e.g. right
          // after Start, before the first fix arrived) — nothing to chord
          // against, so there is nothing left for onFix to do here.
          gapStartRef.current = null;
        }
      }
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [status, clearSub, beginRecording, tryKeepAwake]);

  const start = useCallback(async () => {
    setError(null);
    setStatus('starting');
    try {
      const permission = await requestPermission();
      if (permission !== 'granted') {
        setError(permission === 'denied' ? 'permission' : 'unavailable');
        setStatus('idle');
        return;
      }

      clearSub();
      lastRef.current = null;
      consecutiveRejectsRef.current = 0;
      accumulatedRef.current = 0;
      legStartRef.current = Date.now();
      lastCheckpointAtRef.current = 0;
      lastCheckpointPointCountRef.current = 0;
      setPoints([]);
      setDistanceM(0);
      setElapsedS(0);
      setEndedAt(null);
      setRejectedFixes(0);
      setStartedAt(Date.now());
      setGapCount(0);
      setGapDurationMs(0);
      setGapChordM(0);
      setCreditedGapM(0);
      gapStartRef.current = null;
      awaitingGapChordRef.current = false;

      await beginRecording();
      setStatus('running');
    } catch {
      // Covers the web permission rejection path and any platform where the
      // location provider simply isn't there — neither should crash the tab.
      setError('unavailable');
      setStatus('idle');
    }
  }, [clearSub, beginRecording]);

  /** Banks the current leg's time and drops the GPS subscription — a paused
   *  run shouldn't keep the receiver powered or record movement. */
  const pause = useCallback(() => {
    clearSub();
    const legStart = legStartRef.current;
    if (legStart !== null) accumulatedRef.current += Date.now() - legStart;
    legStartRef.current = null;
    // Cancel any gap chord still awaiting the next fix. Without this, a
    // runner who backgrounds (opening a gap) and then explicitly pauses
    // BEFORE any new fix arrives keeps that pending chord alive across the
    // pause — resume()'s first fix would then credit distance spanning the
    // paused time too, violating the DECIDED rule that a manually paused
    // runner is legitimately stopped, not backgrounded. A pause always ends
    // any in-flight gap the same way start()/reset() do.
    gapStartRef.current = null;
    awaitingGapChordRef.current = false;
    setStatus('paused');
  }, [clearSub]);

  const resume = useCallback(async () => {
    try {
      clearSub();
      // Cleared so the first fix after resuming doesn't draw a straight line
      // (and add distance) across wherever the runner moved while paused.
      lastRef.current = null;
      // Same reasoning as pause() above — belt-and-suspenders in case
      // something set these between pause() and here (there shouldn't be
      // anything that can, but a stale await surviving into a resumed run
      // is exactly the class of bug this file exists to avoid).
      gapStartRef.current = null;
      awaitingGapChordRef.current = false;
      consecutiveRejectsRef.current = 0;
      legStartRef.current = Date.now();
      await beginRecording();
      // Restarting the watch after a pause — see pilot-instrumentation.ts.
      incrementPilotCounter('watchRestarts');
      setStatus('running');
    } catch {
      setError('unavailable');
    }
  }, [clearSub, beginRecording]);

  const stop = useCallback(() => {
    clearSub();
    const legStart = legStartRef.current;
    if (legStart !== null) accumulatedRef.current += Date.now() - legStart;
    legStartRef.current = null;
    setEndedAt(Date.now());
    setStatus('finished');
  }, [clearSub]);

  const reset = useCallback(() => {
    clearSub();
    lastRef.current = null;
    accumulatedRef.current = 0;
    legStartRef.current = null;
    lastCheckpointAtRef.current = 0;
    lastCheckpointPointCountRef.current = 0;
    setPoints([]);
    setDistanceM(0);
    setElapsedS(0);
    setStartedAt(null);
    setEndedAt(null);
    setError(null);
    setLastAccuracyM(null);
    setRejectedFixes(0);
    // Cleared so a later idle screen doesn't prefer a minutes-old session
    // fix over the live idle watcher's fresh one.
    setLastFix(null);
    setDegradedSignal(false);
    setKeepAwakeFailed(false);
    setGapCount(0);
    setGapDurationMs(0);
    setGapChordM(0);
    setCreditedGapM(0);
    gapStartRef.current = null;
    awaitingGapChordRef.current = false;
    consecutiveRejectsRef.current = 0;
    setStatus('idle');
    // Always, not conditionally: reset() runs on discard AND is the general
    // return-to-idle path, and a stale checkpoint from a run that's no
    // longer live must never be offered for recovery later.
    clearCheckpoint();
  }, [clearSub]);

  /**
   * Continues a run recovered from run-checkpoint.ts after a reload. Mirrors
   * start(), except the origin is the checkpoint's own last point/distance/
   * elapsed time rather than a fresh zero — and the reconnect is treated as
   * a leg break (see restoreFromCheckpoint's interface doc / the
   * visibilitychange handler above), so the untracked gap between the
   * checkpoint and now never becomes a phantom straight-line distance.
   */
  const restoreFromCheckpoint = useCallback(
    async (checkpoint: RunCheckpoint) => {
      setError(null);
      setStatus('starting');
      try {
        const permission = await requestPermission();
        if (permission !== 'granted') {
          setError(permission === 'denied' ? 'permission' : 'unavailable');
          setStatus('idle');
          return;
        }

        clearSub();
        // Leg break: NOT seeded with the checkpoint's last point, so the
        // next live fix starts a fresh leg instead of drawing a straight
        // line across the untracked gap.
        lastRef.current = null;
        consecutiveRejectsRef.current = 0;
        accumulatedRef.current = checkpoint.accumulatedMs;
        legStartRef.current = Date.now();
        lastCheckpointAtRef.current = Date.now();
        lastCheckpointPointCountRef.current = checkpoint.points.length;
        setPoints(checkpoint.points);
        setDistanceM(checkpoint.distanceM);
        setElapsedS(Math.floor(checkpoint.accumulatedMs / 1000));
        setEndedAt(null);
        setRejectedFixes(0);
        setStartedAt(checkpoint.startedAt);
        // Zeroed, not carried over or counted as a gap itself: a checkpoint
        // recovery is a full tab reload, a different (and less precisely
        // measurable — there's no visibilitychange timestamp for it) event
        // than the backgrounding gaps this instrumentation targets. Mixing
        // the two into one metric would muddy the specific hypothesis this
        // exists to test.
        setGapCount(0);
        setGapDurationMs(0);
        setGapChordM(0);
        setCreditedGapM(0);
        gapStartRef.current = null;
        awaitingGapChordRef.current = false;

        await beginRecording();
        // Restarting the watch after a checkpoint recovery — see
        // pilot-instrumentation.ts.
        incrementPilotCounter('watchRestarts');
        setStatus('running');
      } catch {
        setError('unavailable');
        setStatus('idle');
      }
    },
    [clearSub, beginRecording],
  );

  return {
    status,
    points,
    distanceM,
    elapsedS,
    error,
    startedAt,
    endedAt,
    lastAccuracyM,
    rejectedFixes,
    lastFix,
    degradedSignal,
    keepAwakeFailed,
    gapCount,
    gapDurationMs,
    gapChordM,
    creditedGapM,
    start,
    pause,
    resume,
    stop,
    reset,
    restoreFromCheckpoint,
  };
}

/** m → "5.42 km" / "840 m", locale-agnostic (digits only, unit appended). */
export function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(2)} km`;
}

/** seconds → "H:MM:SS" or "M:SS". */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/** m² → "1.24 km²" / "8,400 m²". Territory areas span a huge range, so the
 *  unit has to switch or a first run reads as an unintelligible 0.00. */
export function formatArea(squareMeters: number): string {
  if (squareMeters >= 1_000_000) return `${(squareMeters / 1_000_000).toFixed(2)} km²`;
  return `${Math.round(squareMeters).toLocaleString('en-US')} m²`;
}
