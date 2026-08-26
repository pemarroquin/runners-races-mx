// Foreground GPS run recorder for Territory Mode. Owns the expo-location
// subscription and the growing point list; the fence geometry itself is
// computed separately by territory.ts (pure, tested) once the run stops.
//
// Foreground-only on purpose: background location needs an entitlement Expo
// Go can't grant, which would force a custom dev client and break this
// project's "Expo Go on device" testing workflow. See the feature plan's
// "Tracking mode" decision. Practical consequence: the run screen has to
// stay open, and the OS may throttle fixes when the screen locks.
import * as Location from 'expo-location';
import { useCallback, useEffect, useRef, useState } from 'react';

import { haversineM, type LatLng } from '@/lib/territory';

export interface TrackPoint extends LatLng {
  ts: number;
}

export type TrackStatus = 'idle' | 'starting' | 'running' | 'finished';
export type TrackError = 'permission' | 'unavailable' | null;

// Fixes worse than this are dropped rather than recorded. Indoors and in
// street canyons expo-location happily reports 100m+ accuracy fixes that
// jump across blocks — those don't just add noise, they inflate both the
// distance total and the fence area with movement that never happened.
const MIN_ACCURACY_M = 50;
const TIME_INTERVAL_MS = 2000;
const DISTANCE_INTERVAL_M = 5;

export interface RunTracker {
  status: TrackStatus;
  points: TrackPoint[];
  distanceM: number;
  elapsedS: number;
  error: TrackError;
  startedAt: number | null;
  endedAt: number | null;
  start: () => Promise<void>;
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

  useEffect(() => {
    if (status !== 'running' || startedAt === null) return;
    const id = setInterval(() => setElapsedS(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(id);
  }, [status, startedAt]);

  const onFix = useCallback((loc: Location.LocationObject) => {
    const accuracy = loc.coords.accuracy;
    if (accuracy !== null && accuracy !== undefined && accuracy > MIN_ACCURACY_M) return;

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
      setPoints([]);
      setDistanceM(0);
      setElapsedS(0);
      setEndedAt(null);
      setStartedAt(Date.now());

      subRef.current = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.BestForNavigation,
          timeInterval: TIME_INTERVAL_MS,
          distanceInterval: DISTANCE_INTERVAL_M,
        },
        onFix,
      );
      setStatus('running');
    } catch {
      // Covers the web permission rejection path and any platform where the
      // location provider simply isn't there — neither should crash the tab.
      setError('unavailable');
      setStatus('idle');
    }
  }, [clearSub, onFix]);

  const stop = useCallback(() => {
    clearSub();
    setEndedAt(Date.now());
    setStatus('finished');
  }, [clearSub]);

  const reset = useCallback(() => {
    clearSub();
    lastRef.current = null;
    setPoints([]);
    setDistanceM(0);
    setElapsedS(0);
    setStartedAt(null);
    setEndedAt(null);
    setError(null);
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
    start,
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
