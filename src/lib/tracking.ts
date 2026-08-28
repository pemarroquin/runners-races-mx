// Foreground GPS run recorder for Territory Mode. Owns the expo-location
// subscription and the growing point list; the fence geometry itself is
// computed separately by territory.ts (pure, tested) once the run stops.
//
// Foreground-only on purpose: background location needs an entitlement Expo
// Go can't grant, which would force a custom dev client and break this
// project's "Expo Go on device" testing workflow. See the feature plan's
// "Tracking mode" decision. Practical consequence: the run screen has to
// stay open, and the OS may throttle fixes when the screen locks.
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import * as Location from 'expo-location';
import { useCallback, useEffect, useRef, useState } from 'react';

import { haversineM, type LatLng } from '@/lib/territory';

export interface TrackPoint extends LatLng {
  ts: number;
}

export type TrackStatus = 'idle' | 'starting' | 'running' | 'paused' | 'finished';
export type TrackError = 'permission' | 'unavailable' | null;

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
  start: () => Promise<void>;
  pause: () => void;
  resume: () => Promise<void>;
  stop: () => void;
  reset: () => void;
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
  // A ref, not state: onFix must read the CURRENT count synchronously, and a
  // state value captured in the callback would be stale.
  const consecutiveRejectsRef = useRef(0);

  const subRef = useRef<Location.LocationSubscription | null>(null);
  const lastRef = useRef<TrackPoint | null>(null);

  const clearSub = useCallback(() => {
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
  useEffect(() => {
    if (status !== 'running' && status !== 'paused') return;
    void activateKeepAwakeAsync(KEEP_AWAKE_TAG);
    return () => {
      // Wrapped rather than returned directly: deactivateKeepAwake returns a
      // promise, and an effect cleanup must return void.
      deactivateKeepAwake(KEEP_AWAKE_TAG);
    };
  }, [status]);

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

  const onFix = useCallback((loc: Location.LocationObject) => {
    const accuracy = loc.coords.accuracy ?? null;
    setLastAccuracyM(accuracy);
    // Raw position, before ANY filtering — the map follows this. See the
    // interface comment on lastFix.
    setLastFix({ lat: loc.coords.latitude, lng: loc.coords.longitude });

    // Out-of-order guard: the fresh-fix seed in start()/resume() runs in
    // parallel with the watcher rather than blocking it, so a slow
    // getCurrentPositionAsync can resolve AFTER the watcher has already
    // delivered newer fixes. Appending it would draw the route backwards.
    if (lastRef.current !== null && loc.timestamp < lastRef.current.ts) return;

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
      lat: loc.coords.latitude,
      lng: loc.coords.longitude,
      ts: loc.timestamp,
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
  //   1. Instant origin from the OS's cached position (getLastKnownPosition
  //      resolves immediately) — the route has a starting point at once.
  //   2. Watcher starts — recording is live from here, unconditionally.
  //   3. A fresh precise fix is requested in PARALLEL, never awaited; if it
  //      resolves it refines things, if it hangs nothing is waiting on it.
  //      onFix's timestamp guard drops it if the watcher has moved on.
  const beginRecording = useCallback(async () => {
    try {
      const cached = await Location.getLastKnownPositionAsync({
        maxAge: LAST_KNOWN_MAX_AGE_MS,
      });
      if (cached) onFix(cached);
    } catch {
      // No cached position — the watcher or the parallel fix supplies one.
    }

    subRef.current = await Location.watchPositionAsync(
      {
        accuracy: Location.Accuracy.BestForNavigation,
        timeInterval: TIME_INTERVAL_MS,
        distanceInterval: DISTANCE_INTERVAL_M,
      },
      onFix,
    );

    Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.BestForNavigation })
      .then(onFix)
      .catch(() => {
        // Fine — the watcher is already delivering.
      });
  }, [onFix]);

  const start = useCallback(async () => {
    setError(null);
    setStatus('starting');
    try {
      const { status: permission } = await Location.requestForegroundPermissionsAsync();
      if (permission !== 'granted') {
        setError('permission');
        setStatus('idle');
        return;
      }

      clearSub();
      lastRef.current = null;
      consecutiveRejectsRef.current = 0;
      accumulatedRef.current = 0;
      legStartRef.current = Date.now();
      setPoints([]);
      setDistanceM(0);
      setElapsedS(0);
      setEndedAt(null);
      setRejectedFixes(0);
      setStartedAt(Date.now());

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
    setStatus('paused');
  }, [clearSub]);

  const resume = useCallback(async () => {
    try {
      clearSub();
      // Cleared so the first fix after resuming doesn't draw a straight line
      // (and add distance) across wherever the runner moved while paused.
      lastRef.current = null;
      consecutiveRejectsRef.current = 0;
      legStartRef.current = Date.now();
      await beginRecording();
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
    consecutiveRejectsRef.current = 0;
    setStatus('idle');
  }, [clearSub]);

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
    start,
    pause,
    resume,
    stop,
    reset,
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
