// The Track tab's map — NATIVE. A live react-native-maps MapView (Apple Maps
// on iOS, Google on Android; both ship inside Expo Go), replacing the static
// Mapbox image this file used to render.
//
// The static image was why the tab felt broken on device: it had no camera —
// no fly-in when a session started, no follow while running — and the pin
// only moved when a whole new image URL was fetched, throttled and quantised,
// so on a phone it read as frozen on the first fix. A real MapView fixes all
// of that, and `showsUserLocation` adds the OS's own blue dot, which tracks
// the device continuously and independently of our JS fix stream.
//
// What this deliberately does NOT have, versus track-map.web.tsx: the custom
// Mapbox Studio style (a Mapbox GL SDK needs a dev client, which would break
// the Expo Go testing workflow), and the extruded 3D fence wall — no
// fill-extrusion primitive here, so the settled fence renders as a flat
// filled ribbon in the run's colour instead. The camera choreography — idle
// follow,
// fly-in to a tilted close-up on start, follow while running — uses the same
// constants as web so both platforms feel like the same feature.
import { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View, type ColorValue } from 'react-native';
import MapView, { Polygon, Polyline } from 'react-native-maps';

import {
  FENCE_LAG_M,
  FENCE_RIBBON_WIDTH_M,
  FENCE_WALL_OPACITY,
  GOOGLE_DARK_MAP_STYLE,
  MAP_DEFAULT_ZOOM,
  ROUTE_LINE_COLOR,
  ROUTE_LINE_WIDTH,
  SESSION_FLY_MS,
  SESSION_PITCH,
  SESSION_ZOOM,
  withAlpha,
} from '@/constants/map';
import { buildWallPolygon, splitTrailing } from '@/lib/fence-3d';
import { gradientStrokeColors, ringToCoords } from '@/lib/fence-draw';
import { useRegion } from '@/lib/region-context';
import type { LatLng } from '@/lib/territory';

interface TrackMapProps {
  points: LatLng[];
  running: boolean;
  /** A real fix, or null. Never a fallback — see use-current-location.ts. */
  here: LatLng | null;
  /** True once a session is live: drives the fly-in and the tilted framing. */
  active: boolean;
  /** This run's fence colour ('#rrggbb') — see FENCE_COLOR_SETS. */
  fenceColor: string;
  /** Accepted for interface parity with track-map.web.tsx; the map is always
   *  dark here (MAP_ALWAYS_DARK) regardless. */
  dark: boolean;
  color: ColorValue;
  placeholder: string;
  placeholderColor: ColorValue;
  /** Web-only concern (missing Mapbox token); a MapView needs no token. */
  unavailable: string;
}

// react-native-maps reads `zoom` on Google and `altitude` on Apple, and each
// platform ignores the other's field — so every camera carries both. The
// mapping is empirical, tuned to visually match the web map's zoom levels on
// a phone viewport: z15 ≈ 960m (neighbourhood), z17.5 ≈ 170m (street).
function altitudeForZoom(zoom: number): number {
  return 60 * Math.pow(2, 19 - zoom);
}

function cameraFor(center: LatLng, zoom: number, pitch: number) {
  return {
    center: { latitude: center.lat, longitude: center.lng },
    zoom,
    altitude: altitudeForZoom(zoom),
    pitch,
    heading: 0,
  };
}

export function TrackMap({
  points,
  running,
  here,
  active,
  fenceColor,
  placeholder,
  placeholderColor,
}: TrackMapProps) {
  const mapRef = useRef<MapView | null>(null);
  const readyRef = useRef(false);
  const flownRef = useRef(false);
  const { region } = useRegion();

  // Only ever a fallback for the *initial* camera, and only while no real
  // fix exists — a map of your metro beats an empty rectangle, and it needs
  // no location permission. Nothing is ever pinned on it: the position dot
  // is the OS's own (showsUserLocation), which only renders on a real fix.
  const initial = here ?? { lat: region.lat, lng: region.lng };
  // Lazy state, not a ref: `initialCamera` is only read by MapView at mount,
  // but a ref can't be read during render (react-hooks/refs). The lazy
  // initializer freezes the mount-time framing; later camera moves go
  // through animateCamera, never through this value.
  const [initialCamera] = useState(() => cameraFor(initial, MAP_DEFAULT_ZOOM, 0));

  // Idle: keep the camera over the runner as they move, so the map isn't
  // still framing wherever they were when the tab opened. Skipped during a
  // session — the fly-in and follow below own the camera then.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current || active || !here) return;
    map.animateCamera(cameraFor(here, MAP_DEFAULT_ZOOM, 0), { duration: 600 });
  }, [here, active]);

  // Fly in when a session starts: tilt and close on the runner. Runs once
  // per session (flownRef), so a later GPS fix doesn't re-trigger it.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;

    if (!active) {
      flownRef.current = false;
      return;
    }
    if (flownRef.current) return;

    const target = points.length > 0 ? points[points.length - 1] : here;
    if (!target) return; // wait for a real position rather than flying to a city centre

    flownRef.current = true;
    map.animateCamera(cameraFor(target, SESSION_ZOOM, SESSION_PITCH), {
      duration: SESSION_FLY_MS,
    });
  }, [active, points, here]);

  // Follow while recording. Driven by `here` (the tracker's RAW fix stream),
  // not by the accepted point list: the camera should stay on the runner
  // even while fixes are being rejected for accuracy.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current || !running || !flownRef.current || !here) return;
    map.animateCamera(cameraFor(here, SESSION_ZOOM, SESSION_PITCH), { duration: 900 });
  }, [here, running]);

  // Same split as web (fence-3d.ts): everything older than the trailing
  // FENCE_LAG_M "sets" into the fence — here a flat filled ribbon in this
  // run's colour, since react-native-maps has no fill-extrusion — while the
  // newest stretch stays the vibrant gradient line. The two share their join
  // point, so the line feeds visually into the fence.
  const { settled, active: liveEdge } = useMemo(
    () => splitTrailing(points, FENCE_LAG_M),
    [points],
  );
  const ribbonCoords = useMemo(() => {
    const wall = buildWallPolygon(settled, FENCE_RIBBON_WIDTH_M);
    return wall ? ringToCoords(wall.geometry.coordinates[0]) : null;
  }, [settled]);
  const edgeCoords = useMemo(
    () => liveEdge.map((p) => ({ latitude: p.lat, longitude: p.lng })),
    [liveEdge],
  );
  const edgeColors = useMemo(() => gradientStrokeColors(liveEdge.length), [liveEdge.length]);

  return (
    <View style={[styles.wrap, StyleSheet.absoluteFill]}>
      <MapView
        ref={mapRef}
        style={StyleSheet.absoluteFill}
        initialCamera={initialCamera}
        onMapReady={() => {
          readyRef.current = true;
        }}
        showsUserLocation
        showsMyLocationButton={false}
        showsCompass={false}
        toolbarEnabled={false}
        pitchEnabled
        userInterfaceStyle="dark"
        customMapStyle={GOOGLE_DARK_MAP_STYLE}
      >
        {ribbonCoords && (
          <Polygon
            coordinates={ribbonCoords}
            fillColor={withAlpha(fenceColor, FENCE_WALL_OPACITY)}
            strokeColor={withAlpha(fenceColor, 0.9)}
            strokeWidth={1}
          />
        )}
        {edgeCoords.length >= 2 && (
          <Polyline
            coordinates={edgeCoords}
            strokeWidth={ROUTE_LINE_WIDTH}
            strokeColor={ROUTE_LINE_COLOR}
            strokeColors={edgeColors}
            lineCap="round"
            lineJoin="round"
          />
        )}
      </MapView>

      {running && points.length === 0 && (
        <View style={styles.waiting}>
          <Text style={[styles.placeholderText, { color: placeholderColor }]}>{placeholder}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { overflow: 'hidden' },
  waiting: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 24,
    alignItems: 'center',
    pointerEvents: 'none',
  },
  placeholderText: { fontSize: 14, textAlign: 'center' },
});
