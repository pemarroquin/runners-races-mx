// Web GPS access — talks to navigator.geolocation directly instead of going
// through expo-location's web shim. Metro picks this file automatically on
// web; native uses geolocation.ts instead. Same convention as db.ts /
// db.web.ts and track-map.tsx / track-map.web.tsx.
//
// Why this file exists: `expo-location`'s web shim
// (node_modules/expo-location/build/ExpoLocation.web.js) has three defects,
// all in the watch path, diagnosed against a real 60s screen recording where
// the map never moved for a full minute (Web-First Pilot P0 brief, §1-§2):
//
// (a) Watch-id mismatch — the shim emits under the BROWSER's watchPosition
//     id, but LocationSubscribers.js registers callbacks under Expo's own
//     counter. When the idle watcher's freed browser id gets recycled by a
//     later watch, every emit arrives keyed wrong, finds no callback, and
//     the subscriber's `else` branch calls removeWatchAsync() on that id —
//     which can tear down a DIFFERENT, live watch (ours). One seed fix
//     lands, then permanent silence.
// (b) `enableHighAccuracy` (and timeout/maximumAge) are never mapped for
//     watches — the shim forwards `{ accuracy, timeInterval,
//     distanceInterval }` raw into watchPosition, which the browser doesn't
//     understand, so they're silently discarded.
// (c) The error callback passed to watchPosition is `undefined`, so
//     PERMISSION_DENIED / POSITION_UNAVAILABLE / TIMEOUT are swallowed —  a
//     dead watch looks identical to a working one.
//
// The fix for all three is the same: own the browser watch id directly,
// never round-trip through the shim's registry.
import { haversineM } from '@/lib/territory';

export interface GeoFix {
  lat: number;
  lng: number;
  accuracyM: number | null;
  ts: number; // epoch ms
}
export interface GeoWatchOptions {
  timeIntervalMs: number;
  distanceIntervalM: number;
}
export interface GeoWatch {
  remove(): void;
}
export type GeoPermission = 'granted' | 'denied' | 'unavailable';
export type GeoErrorKind = 'permission' | 'unavailable' | 'timeout';

// Options for both the one-shot calls and the watch. maximumAge: 0 so a
// stale OS-cached fix never masquerades as fresh — staleness is handled
// explicitly by getLastKnown() below instead.
const POSITION_OPTIONS: PositionOptions = {
  enableHighAccuracy: true,
  maximumAge: 0,
  timeout: 30_000,
};

function toFix(position: GeolocationPosition): GeoFix {
  return {
    lat: position.coords.latitude,
    lng: position.coords.longitude,
    accuracyM: position.coords.accuracy ?? null,
    ts: position.timestamp,
  };
}

function mapError(err: GeolocationPositionError): GeoErrorKind {
  switch (err.code) {
    case err.PERMISSION_DENIED:
      return 'permission';
    case err.TIMEOUT:
      return 'timeout';
    case err.POSITION_UNAVAILABLE:
    default:
      return 'unavailable';
  }
}

// Updated by EVERY successful fix, from the watch path or either one-shot
// call. This matters because bypassing the shim means the shim's own
// `lastKnownPosition` cache is never written — without this,
// getLastKnown() would return null forever and a run would lose its instant
// origin (the cached-position seed in tracking.ts's beginRecording()).
let lastKnown: GeoFix | null = null;

export async function requestPermission(): Promise<GeoPermission> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) return 'unavailable';

  if (navigator.permissions?.query) {
    try {
      const status = await navigator.permissions.query({ name: 'geolocation' });
      if (status.state === 'granted') return 'granted';
      if (status.state === 'denied') return 'denied';
      // 'prompt' falls through to the probe below, which is what actually
      // triggers the browser's permission dialog.
    } catch {
      // Permissions API present but this query unsupported (older Safari) —
      // fall through to the probe.
    }
  }

  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        lastKnown = toFix(position);
        resolve('granted');
      },
      (err) => resolve(err.code === err.PERMISSION_DENIED ? 'denied' : 'unavailable'),
      POSITION_OPTIONS,
    );
  });
}

export async function getLastKnown(maxAgeMs: number): Promise<GeoFix | null> {
  if (!lastKnown) return null;
  if (Date.now() - lastKnown.ts > maxAgeMs) return null;
  return lastKnown;
}

export async function getCurrent(): Promise<GeoFix | null> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) return null;
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const fix = toFix(position);
        lastKnown = fix;
        resolve(fix);
      },
      () => resolve(null),
      POSITION_OPTIONS,
    );
  });
}

export async function watch(
  opts: GeoWatchOptions,
  onFix: (fix: GeoFix) => void,
  onError: (kind: GeoErrorKind) => void,
): Promise<GeoWatch> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) {
    onError('unavailable');
    return { remove: () => {} };
  }

  // Own the numeric id directly — never the shim's registry (defect a).
  let removed = false;
  // The last fix actually EMITTED (post-throttle), used to decide whether
  // the next raw callback should be let through. Distinct from `lastKnown`,
  // which is updated on every raw fix regardless of throttling.
  let lastEmitted: GeoFix | null = null;

  const id = navigator.geolocation.watchPosition(
    (position) => {
      if (removed) return; // late callback after remove() — ignore (defect a)
      const fix = toFix(position);
      lastKnown = fix;

      // Throttling the browser doesn't do natively (defect b: the shim
      // forwarded timeInterval/distanceInterval, which the browser ignores).
      // The first fix of a watch always emits — a cold receiver's first
      // reading is often the only thing available for a while.
      if (lastEmitted) {
        const elapsedMs = fix.ts - lastEmitted.ts;
        const movedM = haversineM(lastEmitted, fix);
        if (elapsedMs < opts.timeIntervalMs && movedM < opts.distanceIntervalM) {
          return;
        }
      }
      lastEmitted = fix;
      onFix(fix);
    },
    (err) => {
      if (removed) return;
      onError(mapError(err)); // defect c: the shim never wired this at all
    },
    POSITION_OPTIONS, // defect b: enableHighAccuracy now actually reaches the browser
  );

  return {
    remove: () => {
      removed = true;
      navigator.geolocation.clearWatch(id);
    },
  };
}
