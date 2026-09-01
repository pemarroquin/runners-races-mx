// The end-of-session territory map — NATIVE. A fully interactive MapView
// (pan/zoom) showing every fence this runner has captured, with the run just
// finished highlighted: its own colour set, the ACTUAL RECORDED PATH as a
// gradient route, and the camera animating to frame it. Replaces the static
// Mapbox fence image the summary screen shipped with.
//
// The route line used to be the fence POLYGON's boundary (polygonRings(g)),
// not the path — structurally wrong two ways, both visible on a real out-
// and-back run (Web-First Pilot follow-up, reported by Pedro): a thin sliver
// polygon's boundary is two roughly-parallel strands that read as two
// unrelated routes, and buildFence's unkink/union step can return a
// MultiPolygon for any self-crossing run, which polygonRings then emits as
// one ring PER LOBE — literally disconnected segments. The route is now
// drawn from the masked path (never the raw one — see index.tsx) as its own
// Polyline, and the polygon's boundary is demoted to a thin, translucent,
// flat-coloured outline that still communicates the claimed shape without
// competing with the route for "this is where I ran".
//
// Past fences render muted, each in ITS run's colour (fenceColorForRun of
// its stored started_at — the same derivation every other screen uses), so
// territories stay tellable apart without a legend.
import { useEffect, useMemo, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import MapView, { Polygon, Polyline } from 'react-native-maps';
import type { MultiPolygon, Polygon as GeoPolygon } from 'geojson';

import {
  fenceColorForRun,
  GOOGLE_DARK_MAP_STYLE,
  ROUTE_LINE_COLOR,
  ROUTE_LINE_WIDTH,
  withAlpha,
} from '@/constants/map';
import { gradientStrokeColors, polygonRings, ringToCoords, type MapCoord } from '@/lib/fence-draw';
import type { LatLng } from '@/lib/territory';
import type { MyFence } from '@/lib/territory-sync';

interface FenceMapProps {
  /** The fence just captured — highlighted and framed. */
  geometry: GeoPolygon | MultiPolygon;
  /** The recorded route, MASKED (privacy-zone.ts) — never the raw path. This
   *  is a shareable surface; the whole reason privacy-zone trimming exists
   *  is so start/end aren't exposed here. */
  path: LatLng[];
  /** Its colour ('#rrggbb'), derived from the session's startedAt. */
  color: string;
  /** Previously-captured fences, rendered muted in their own colours. May
   *  include the just-saved run itself after a successful upload — pass its
   *  id via `excludeId` so it isn't drawn twice. */
  others: MyFence[];
  excludeId?: string | null;
}

const FIT_PADDING = { top: 48, right: 48, bottom: 48, left: 48 };
// The fence boundary's subordinate weight, now that the route carries the
// gradient — mirrors the muted "past fence" outline treatment (strokeWidth
// 1, alpha 0.5) so the just-finished fence's boundary reads as claimed
// territory, not as the run.
const OUTLINE_WIDTH = 1.5;
const OUTLINE_ALPHA = 0.55;

export function FenceMap({ geometry, path, color, others, excludeId }: FenceMapProps) {
  const mapRef = useRef<MapView | null>(null);

  const highlightRings = useMemo(() => polygonRings(geometry), [geometry]);
  const highlightPolys = useMemo(
    () =>
      highlightRings.map((rings) => ({
        outer: ringToCoords(rings[0]),
        holes: rings.slice(1).map(ringToCoords),
      })),
    [highlightRings],
  );
  // The ROUTE — the actual recorded path, not the fence boundary. Same
  // per-vertex gradient sampling as the live map's edge (track-map.tsx),
  // so the two screens agree.
  const routeCoords = useMemo(
    (): MapCoord[] => path.map((pt) => ({ latitude: pt.lat, longitude: pt.lng })),
    [path],
  );
  const routeColors = useMemo(() => gradientStrokeColors(routeCoords.length), [routeCoords.length]);

  const pastPolys = useMemo(
    () =>
      others
        // A null geometry is a fully-overtaken run — real history, but
        // there is no ground left to draw.
        .filter((f) => f.id !== excludeId && f.geometry !== null)
        .flatMap((f) => {
          const tint = fenceColorForRun(f.startedAtMs).color;
          return polygonRings(f.geometry!).map((rings, i) => ({
            key: `${f.id}:${i}`,
            outer: ringToCoords(rings[0]),
            holes: rings.slice(1).map(ringToCoords),
            tint,
          }));
        }),
    [others, excludeId],
  );

  // Frame the new fence once the map is laid out. fitToCoordinates with
  // animation doubles as the entrance move — the camera sweeping in on the
  // captured shape.
  const allHighlightCoords = useMemo(
    () => highlightPolys.flatMap((p) => p.outer),
    [highlightPolys],
  );
  useEffect(() => {
    // Deferred a tick: fitToCoordinates before the MapView has real layout
    // silently no-ops on Android.
    const id = setTimeout(() => {
      mapRef.current?.fitToCoordinates(allHighlightCoords, {
        edgePadding: FIT_PADDING,
        animated: true,
      });
    }, 350);
    return () => clearTimeout(id);
  }, [allHighlightCoords]);

  const initialRegion = useMemo(() => regionAround(allHighlightCoords), [allHighlightCoords]);

  return (
    <View style={styles.wrap}>
      <MapView
        ref={mapRef}
        style={StyleSheet.absoluteFill}
        initialRegion={initialRegion}
        showsUserLocation={false}
        showsMyLocationButton={false}
        showsCompass={false}
        toolbarEnabled={false}
        userInterfaceStyle="dark"
        customMapStyle={GOOGLE_DARK_MAP_STYLE}
      >
        {pastPolys.map((p) => (
          <Polygon
            key={p.key}
            coordinates={p.outer}
            holes={p.holes.length > 0 ? p.holes : undefined}
            fillColor={withAlpha(p.tint, 0.16)}
            strokeColor={withAlpha(p.tint, 0.5)}
            strokeWidth={1}
          />
        ))}
        {highlightPolys.map((p, i) => (
          <Polygon
            key={`new-${i}`}
            coordinates={p.outer}
            holes={p.holes.length > 0 ? p.holes : undefined}
            fillColor={withAlpha(color, 0.3)}
            strokeColor={withAlpha(color, 0.0)}
            strokeWidth={0}
          />
        ))}
        {highlightPolys.map((p, i) => (
          // The fence BOUNDARY — subordinate now that the route (below)
          // carries the gradient: thin, translucent, flat colour. Still
          // communicates the claimed shape; must never again read as the
          // route.
          <Polyline
            key={`outline-${i}`}
            coordinates={p.outer}
            strokeWidth={OUTLINE_WIDTH}
            strokeColor={withAlpha(color, OUTLINE_ALPHA)}
            lineCap="round"
            lineJoin="round"
          />
        ))}
        {routeCoords.length >= 2 && (
          // The ROUTE — the actual recorded (masked) path, drawn after the
          // outline so it renders on top wherever the two overlap.
          <Polyline
            coordinates={routeCoords}
            strokeWidth={ROUTE_LINE_WIDTH}
            strokeColor={ROUTE_LINE_COLOR}
            strokeColors={routeColors}
            lineCap="round"
            lineJoin="round"
          />
        )}
      </MapView>
    </View>
  );
}

/** A Region loosely containing the coords — only the pre-fit first frame;
 *  fitToCoordinates supplies the real framing right after. */
function regionAround(coords: MapCoord[]) {
  if (coords.length === 0) {
    return { latitude: 0, longitude: 0, latitudeDelta: 0.05, longitudeDelta: 0.05 };
  }
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const c of coords) {
    minLat = Math.min(minLat, c.latitude);
    maxLat = Math.max(maxLat, c.latitude);
    minLng = Math.min(minLng, c.longitude);
    maxLng = Math.max(maxLng, c.longitude);
  }
  return {
    latitude: (minLat + maxLat) / 2,
    longitude: (minLng + maxLng) / 2,
    latitudeDelta: Math.max((maxLat - minLat) * 1.6, 0.005),
    longitudeDelta: Math.max((maxLng - minLng) * 1.6, 0.005),
  };
}

const styles = StyleSheet.create({
  wrap: { flex: 1, overflow: 'hidden' },
});
