// One shared "where is the runner right now" hook for the Track tab's map.
//
// This exists because of a real bug: the web map never asked for a location
// at all, and the native map only used a permission that happened to be
// granted already — so before a run started, BOTH platforms fell back to the
// selected city's centre coordinate from regions.ts and dropped the pin
// there. That's a real place on the map, several km from the runner, which
// is why it looked like a wrong position rather than a missing one.
//
// The fallback still exists (a map has to render something), but it's now
// clearly separated: `coords` is a real fix or null, and callers decide what
// to show when it's null instead of being handed a city centre that is
// indistinguishable from a GPS result.
import * as Location from 'expo-location';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { LatLng } from '@/lib/territory';

export type LocationStatus = 'idle' | 'locating' | 'ready' | 'denied' | 'unavailable';

export interface CurrentLocation {
  /** A real GPS/browser fix, or null if we don't have one. Never a fallback. */
  coords: LatLng | null;
  status: LocationStatus;
  /** Ask for permission and a fix. Safe to call repeatedly. */
  request: () => Promise<LatLng | null>;
}

export interface CurrentLocationOptions {
  /** Ask for a fix on mount. */
  autoRequest?: boolean;
  /**
   * Keep `coords` updated as the device moves, instead of taking a single
   * fix and freezing. Off by default because a watcher holds the GPS on.
   *
   * The single-fix behaviour was a real bug: the map pin was placed once and
   * then never moved while the runner did, which reads as a broken pin
   * rather than a stale one.
   */
  watch?: boolean;
}

export function useCurrentLocation({
  autoRequest = true,
  watch = false,
}: CurrentLocationOptions = {}): CurrentLocation {
  const [coords, setCoords] = useState<LatLng | null>(null);
  const [status, setStatus] = useState<LocationStatus>('idle');
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const request = useCallback(async (): Promise<LatLng | null> => {
    try {
      // The permission call comes FIRST, before any setState, so that calling
      // this from an effect never updates state synchronously within the
      // effect body — the React Compiler rules this project lints with
      // reject that, and it causes a cascading render. It also reads more
      // truthfully: we aren't locating until we're allowed to.
      //
      // requestForegroundPermissionsAsync (not getForegroundPermissionsAsync):
      // the earlier version only *read* the existing grant, so a user who had
      // never been asked never got a prompt and never got a position.
      const { status: permission } = await Location.requestForegroundPermissionsAsync();
      if (permission !== 'granted') {
        if (mounted.current) setStatus('denied');
        return null;
      }
      if (mounted.current) setStatus('locating');
      const pos = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      const next: LatLng = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      if (mounted.current) {
        setCoords(next);
        setStatus('ready');
      }
      return next;
    } catch {
      if (mounted.current) setStatus('unavailable');
      return null;
    }
  }, []);

  // Continuous updates while `watch` is on. Balanced accuracy and a 10m
  // distance filter: this only has to keep a map pin honest, so it doesn't
  // need the BestForNavigation power draw the run tracker asks for.
  useEffect(() => {
    if (!watch) return;
    let sub: Location.LocationSubscription | null = null;
    let cancelled = false;

    (async () => {
      try {
        const { status: permission } = await Location.getForegroundPermissionsAsync();
        if (permission !== 'granted' || cancelled) return;
        sub = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.Balanced, distanceInterval: 10, timeInterval: 4000 },
          (pos) => {
            if (cancelled) return;
            setCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude });
            setStatus('ready');
          },
        );
        if (cancelled) sub.remove();
      } catch {
        // A failed watcher just means the pin stops updating; the one-shot
        // fix above still gave us something to show.
      }
    })();

    return () => {
      cancelled = true;
      sub?.remove();
    };
  }, [watch]);

  useEffect(() => {
    if (!autoRequest) return;
    // Kicked off from a timer callback rather than called straight from the
    // effect body: the lint rule traces the call through and treats any
    // setState it can reach as a synchronous effect update. Deferring by a
    // tick makes that impossible in fact as well as to the analyser — the
    // same deferred-callback shape the run tracker's clock uses.
    const id = setTimeout(() => {
      void request();
    }, 0);
    return () => clearTimeout(id);
  }, [autoRequest, request]);

  return { coords, status, request };
}
