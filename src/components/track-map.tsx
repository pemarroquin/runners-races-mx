// The Track tab's map. Shows real streets from the moment the tab opens —
// centred on where you are before a run, then your route drawn over them
// while it's in progress.
//
// The route is baked into the Mapbox image rather than drawn as SVG on top
// of a basemap. Overlaying would mean reproducing Mapbox's Web Mercator
// framing exactly to keep the line on the right streets, and any drift
// there reads as a broken map; letting Mapbox draw both makes misalignment
// impossible. The trade is a network round-trip, so the image is throttled
// (REFRESH_MS) instead of rebuilt per GPS fix — the numbers above it still
// update every second, which is the feedback that actually matters mid-run.
//
// When that image can't load (no signal on a trail, no token configured),
// RouteTrace takes over: no network, no key, instant. It replaces the map
// rather than sitting on top of it, so the alignment problem never arises.
import { Image } from 'expo-image';
import { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View, type ColorValue } from 'react-native';

import { RouteTrace } from '@/components/route-trace';
import { buildPathMapUrl, buildPinMapUrl } from '@/lib/mapbox';
import { useRegion } from '@/lib/region-context';
import type { LatLng } from '@/lib/territory';

const REFRESH_MS = 8000;

interface TrackMapProps {
  points: LatLng[];
  running: boolean;
  /** A real fix, or null. Never a fallback — see use-current-location.ts. */
  here: LatLng | null;
  /** True once a session is live. The static-image path can't fly a camera
   *  or extrude a wall (see track-map.web.tsx for the platform split), so
   *  this is accepted and unused rather than making callers branch. */
  active: boolean;
  dark: boolean;
  color: ColorValue;
  placeholder: string;
  placeholderColor: ColorValue;
  /** Shown when the basemap can't be fetched at all (bad/missing Mapbox
   *  token, or offline before any route exists). */
  unavailable: string;
}

export function TrackMap({
  points,
  running,
  here,
  dark,
  color,
  placeholder,
  placeholderColor,
  unavailable,
}: TrackMapProps) {
  // Measured rather than passed in: the map fills whatever area the screen
  // gives it, but RouteTrace needs a concrete pixel height to project into.
  const [height, setHeight] = useState(0);
  const [imageFailed, setImageFailed] = useState(false);


  // The route the *map image* is built from, which deliberately lags the
  // live point list. Refreshing per GPS fix would be a network request every
  // couple of seconds; the numbers on screen carry the live feedback instead.
  const [snapshot, setSnapshot] = useState<LatLng[]>([]);
  const pointsRef = useRef(points);
  useEffect(() => {
    pointsRef.current = points;
  }, [points]);

  // Sampling happens in the interval callback, never in the effect body:
  // setState called directly during an effect is forbidden by the React
  // Compiler rules this project lints with, and it's the same deferred
  // pattern the run tracker's elapsed clock uses.
  useEffect(() => {
    if (!running) return;
    setSnapshot(pointsRef.current);
    const id = setInterval(() => setSnapshot(pointsRef.current), REFRESH_MS);
    return () => clearInterval(id);
  }, [running]);

  const hasRoute = snapshot.length >= 2;
  // Falls back to the city the runner has selected, so there is always a map
  // to look at. A precise fix replaces it the moment one is available; before
  // that, a map of your metro beats an empty grey rectangle, and it needs no
  // location permission at all.
  const { region } = useRegion();
  const first = points.length > 0 ? points[0] : null;
  // Memoised on primitives: a fresh object literal here would change the
  // memo deps below every render, rebuilding the URL string each time and
  // making the <Image> refetch continuously.
  const centreLat = here?.lat ?? first?.lat ?? region.lat;
  const centreLng = here?.lng ?? first?.lng ?? region.lng;
  // Only claim a position when we actually have one — the region centre is
  // a framing fallback, never something to drop a "you are here" pin on.
  const hasRealFix = here !== null || first !== null;

  const mapUrl = useMemo(
    () => (hasRoute
        ? buildPathMapUrl(snapshot, dark)
        : buildPinMapUrl(centreLat, centreLng, dark, hasRealFix)),
    [hasRoute, snapshot, centreLat, centreLng, dark, hasRealFix],
  );

  // A route that can't be drawn by Mapbox still has to be visible, so the
  // SVG trace replaces the image rather than layering over it.
  const showFallback = (mapUrl === null || imageFailed) && points.length >= 2;

  return (
    <View
      style={[styles.wrap, StyleSheet.absoluteFill]}
      onLayout={(e) => setHeight(e.nativeEvent.layout.height)}>
      {mapUrl && !imageFailed && (
        <Image
          source={{ uri: mapUrl }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          transition={200}
          onError={() => setImageFailed(true)}
        />
      )}

      {showFallback && height > 0 && (
        <RouteTrace points={points} color={color} height={height} />
      )}

      {/* Say WHY there's no map rather than showing a blank rectangle: a
          missing token and "still waiting for GPS" look identical otherwise,
          and the first one is a configuration problem nobody would guess. */}
      {!showFallback && (mapUrl === null || imageFailed) && (
        <View style={styles.placeholderWrap}>
          <Text style={[styles.placeholderText, { color: placeholderColor }]}>
            {mapUrl === null && !imageFailed ? placeholder : unavailable}
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { overflow: 'hidden' },
  placeholderWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 16 },
  placeholderText: { fontSize: 14, textAlign: 'center' },
});
