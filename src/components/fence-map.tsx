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
import { cellToBoundary, cellsToMultiPolygon } from 'h3-js';
import type { AndroidSymbol, SFSymbol } from 'expo-symbols';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import MapView, { Marker, Polygon, Polyline } from 'react-native-maps';
import Svg, { Rect as SvgRect } from 'react-native-svg';
import type { MultiPolygon, Polygon as GeoPolygon } from 'geojson';

import { ConquestMarker } from '@/components/conquest-marker';
import { CycleBonusMarker } from '@/components/cycle-bonus-marker';
import { Icon } from '@/components/ui/icon';
import { BottomTabInset, Spacing } from '@/constants/theme';
import { conquestMarkerGeometry, cycleBonusMarkerGeometry } from '@/lib/conquest-marker';
import { splitLegs, type TimedPoint } from '@/lib/gap-policy';
import {
  fenceColorForRun,
  GOOGLE_DARK_MAP_STYLE,
  ROUTE_LINE_COLOR,
  ROUTE_LINE_WIDTH,
  TILE_DISSOLVE_THRESHOLD,
  TILE_FILL_OPACITY,
  TILE_RIVAL_COLOR,
  TILE_RIVAL_FILL_OPACITY,
  withAlpha,
  ZOOM_STEP,
} from '@/constants/map';
import { gradientStrokeColors, polygonRings, ringToCoords, type MapCoord } from '@/lib/fence-draw';
import type { MyFence } from '@/lib/territory-sync';

interface FenceMapProps {
  /** The fence just captured — no longer filled (see the `tiles` prop
   *  below, brief §6 step 4), but still used for its outline and to frame
   *  the camera. Still required, not optional: buildFence isn't deleted
   *  this pass (brief §4) and this is what the outline/fitBounds read. */
  geometry: GeoPolygon | MultiPolygon;
  /** The recorded route, MASKED (privacy-zone.ts) — never the raw path. This
   *  is a shareable surface; the whole reason privacy-zone trimming exists
   *  is so start/end aren't exposed here.
   *
   *  Timestamped, and that is load-bearing: a saved run keeps the gaps it
   *  was recorded with, and the caps deciding where this path must NOT be
   *  drawn as one continuous line are a function of elapsed time as well as
   *  distance (see splitLegs). */
  path: TimedPoint[];
  /** Tile Coverage brief §6 step 4 — this run's covered H3 cells (DEFAULT_TILE_RES,
   *  tiles.ts's pathToTiles), rendered as the fill that used to be the
   *  enclosure polygon's. This is what actually reads as "your territory"
   *  now; the polygon above is demoted to a thin outline (see the render
   *  below) precisely because a giant enclosure fill next to a small tile
   *  cluster is the exact visual this whole brief exists to stop showing
   *  (see index.tsx's legacyArea line for where the old number still lives
   *  on this screen). */
  tiles: string[];
  /** Tile Coverage brief §5 — cells this run crossed that were already
   *  someone else's by claim time (territory-sync.ts's claimTiles;
   *  TileClaimResult.rivalCells). Rendered in TILE_RIVAL_COLOR, muted, so
   *  contested ground reads at a glance. Empty until the upload resolves —
   *  see index.tsx's `tileClaim` state, which is null (so this is `[]`)
   *  while a save is still in flight. */
  rivalTiles: string[];
  /** Single consolidated "+N" conquest bubble (index.tsx's takenClusters is
   *  now one weighted-centroid item, not one per cluster). `label` is
   *  pre-translated. Empty until the upload resolves. */
  takenClusters: { center: { lat: number; lng: number }; count: number; label: string }[];
  /** Blue cycle-bonus marker — present when this run's path significantly
   *  re-covered the runner's own territory (≥ 50 tiles). Absent until the
   *  upload resolves; null/undefined when no qualifying overlap. */
  cycleBonus?: { pts: number; center: { lat: number; lng: number } } | null;
  /** Its colour ('#rrggbb'), derived from the session's startedAt. */
  color: string;
  /** Previously-captured fences, rendered muted in their own colours. May
   *  include the just-saved run itself after a successful upload — pass its
   *  id via `excludeId` so it isn't drawn twice. */
  others: MyFence[];
  excludeId?: string | null;
  /** Zoom +/- and re-fit controls, bottom-right — see fence-map.web.tsx's
   *  own doc comment on the same prop. */
  controls?: { zoomInLabel: string; zoomOutLabel: string; recenterLabel: string };
}

const FIT_PADDING = { top: 48, right: 48, bottom: 48, left: 48 };
// The fence boundary's subordinate weight, now that the route carries the
// gradient — mirrors the muted "past fence" outline treatment (strokeWidth
// 1, alpha 0.5) so the just-finished fence's boundary reads as claimed
// territory, not as the run.
const OUTLINE_WIDTH = 1.5;
const OUTLINE_ALPHA = 0.55;

/** An h3 ring as react-native-maps coordinates. Both h3-js calls this file
 *  makes — cellToBoundary and cellsToMultiPolygon — return [lat, lng] pairs
 *  in their DEFAULT (non-GeoJSON) form, which is already this order once
 *  mapped: no [lng, lat] flip here, unlike the web/GL version. */
function toMapCoords(ring: [number, number][]): MapCoord[] {
  return ring.map(([lat, lng]) => ({ latitude: lat, longitude: lng }));
}

export function FenceMap({
  geometry,
  path,
  tiles,
  rivalTiles,
  takenClusters,
  cycleBonus,
  color,
  others,
  excludeId,
  controls,
}: FenceMapProps) {
  const mapRef = useRef<MapView | null>(null);
  // react-native-maps snapshots a custom marker view into a bitmap once
  // `tracksViewChanges` goes false. The old "+N" bubble was plain Views, which
  // are laid out by the time the marker mounts; the replacement is an <Svg>,
  // whose native view reports its content a frame or two later — snapshot it
  // too early on Android and the marker is a blank rectangle for good. So
  // track briefly, then stop (tracking every frame is the documented cause of
  // map jank, which is why this isn't simply left on).
  // Starts true and only ever goes false: `takenClusters` resolves once, on
  // the single claimTiles() round trip after the run saved, and never changes
  // again on this screen — so there is nothing to re-arm for, and flipping it
  // back here would be a setState in an effect body (the cascading-render
  // lint). The window opens when the markers actually exist, not at mount.
  const [trackTakenMarkers, setTrackTakenMarkers] = useState(true);
  useEffect(() => {
    if (takenClusters.length === 0) return;
    const id = setTimeout(() => setTrackTakenMarkers(false), 800);
    return () => clearTimeout(id);
  }, [takenClusters]);

  const highlightRings = useMemo(() => polygonRings(geometry), [geometry]);
  const highlightPolys = useMemo(
    () =>
      highlightRings.map((rings) => ({
        outer: ringToCoords(rings[0]),
        holes: rings.slice(1).map(ringToCoords),
      })),
    [highlightRings],
  );
  // Tile Coverage brief §6 step 4/§5.
  // Individual hexagons up to TILE_DISSOLVE_THRESHOLD, then the dissolved
  // form — the summary is where the tiles ARE the score and worth seeing
  // one by one, but a large loop must not turn it into a slideshow. Native
  // matters more here than web: this mounts a <Polygon> COMPONENT per
  // feature rather than handing a layer one collection.
  //
  // Holes are dropped when dissolving: react-native-maps takes them as a
  // separate prop, and enclosed ground is claimed ground here anyway.
  const tilePolys = useMemo(
    () =>
      tiles.length > TILE_DISSOLVE_THRESHOLD
        ? cellsToMultiPolygon(tiles).map((rings, i) => ({
            h3: `region-${i}`,
            coords: toMapCoords(rings[0]),
          }))
        : tiles.map((h3) => ({ h3, coords: toMapCoords(cellToBoundary(h3)) })),
    [tiles],
  );
  // Same TILE_DISSOLVE_THRESHOLD ceiling as tilePolys above, and for the
  // same reason: this still mounts one <Polygon> per cell below it. Web's
  // shared tileFeatureCollection already applies the threshold to both sets;
  // native previously only bounded the owner's own tiles, leaving rivals
  // unbounded.
  const rivalTilePolys = useMemo(
    () =>
      rivalTiles.length > TILE_DISSOLVE_THRESHOLD
        ? cellsToMultiPolygon(rivalTiles).map((rings, i) => ({
            h3: `rival-region-${i}`,
            coords: toMapCoords(rings[0]),
          }))
        : rivalTiles.map((h3) => ({ h3, coords: toMapCoords(cellToBoundary(h3)) })),
    [rivalTiles],
  );
  // The ROUTE — the actual recorded path, not the fence boundary. Same
  // per-vertex gradient sampling as the live map's edge (track-map.tsx),
  // so the two screens agree.
  // One polyline per leg, not one across the whole path: a saved run keeps
  // its unrecorded gaps, and a single line joins both sides of one with a
  // straight chord across ground the runner never recorded (see splitLegs).
  const routeLegs = useMemo(
    () =>
      splitLegs(path)
        .filter((leg) => leg.length >= 2)
        .map((leg): MapCoord[] => leg.map((pt) => ({ latitude: pt.lat, longitude: pt.lng }))),
    [path],
  );

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

  // The fixed pivot every zoom step uses, so the conquered area's own
  // center stays put instead of the camera's current (possibly panned-away,
  // off-center) center. Same fix as fence-map.web.tsx's `centerOf`.
  const highlightCenter = useMemo(() => {
    if (allHighlightCoords.length === 0) return null;
    let minLat = Infinity;
    let minLng = Infinity;
    let maxLat = -Infinity;
    let maxLng = -Infinity;
    for (const { latitude, longitude } of allHighlightCoords) {
      minLat = Math.min(minLat, latitude);
      minLng = Math.min(minLng, longitude);
      maxLat = Math.max(maxLat, latitude);
      maxLng = Math.max(maxLng, longitude);
    }
    return { latitude: (minLat + maxLat) / 2, longitude: (minLng + maxLng) / 2 };
  }, [allHighlightCoords]);
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

  // The "recenter" control's target — same fitToCoordinates call as the
  // mount effect above, callable again after a manual pan/zoom.
  const refit = useCallback(() => {
    mapRef.current?.fitToCoordinates(allHighlightCoords, {
      edgePadding: FIT_PADDING,
      animated: true,
    });
  }, [allHighlightCoords]);

  // Pivots on the conquered area's own center (highlightCenter), not
  // whatever `camera.center` currently is — that drifts away from the
  // fence's own center after any manual pan, and made the "+N" conquest
  // bubble visibly walk across the screen on every zoom press since it
  // isn't necessarily AT that arbitrary center itself (reported by Pedro,
  // 2026-09-20: "as I zoom in and out the bubble moves").
  const zoomBy = useCallback(
    (delta: number) => {
      const map = mapRef.current;
      if (!map) return;
      void map.getCamera().then((camera) => {
        map.animateCamera(
          { ...camera, center: highlightCenter ?? camera.center, zoom: (camera.zoom ?? 15) + delta },
          { duration: 300 },
        );
      });
    },
    [highlightCenter],
  );

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
        {/* Tile Coverage brief §6 step 4 — this run's real, honest fill.
            Replaces the enclosure polygon's fill (used to render here as a
            plain, uniform Polygon over `highlightPolys` — see the removed
            code this replaces in git history) precisely so a giant
            enclosure shape never again reads as "your territory" next to
            a small, real tile cluster. One Polygon per cell rather than
            one merged shape: react-native-maps has no fill-union
            primitive, and at this scale (a single run, typically well
            under a few hundred cells — see the §2.5 forgery guard's own
            bound) that's cheap. */}
        {tilePolys.map((p) => (
          <Polygon
            key={`tile-${p.h3}`}
            coordinates={p.coords}
            fillColor={withAlpha(color, TILE_FILL_OPACITY)}
            strokeColor={withAlpha(color, 0.0)}
            strokeWidth={0}
          />
        ))}
        {/* Rival tiles (brief §5) — cells this run crossed but couldn't
            claim. Muted neutral, never a FENCE_COLOR_SETS colour, so
            contested ground reads at a glance without a legend. */}
        {rivalTilePolys.map((p) => (
          <Polygon
            key={`rival-${p.h3}`}
            coordinates={p.coords}
            fillColor={withAlpha(TILE_RIVAL_COLOR, TILE_RIVAL_FILL_OPACITY)}
            strokeColor={withAlpha(TILE_RIVAL_COLOR, 0.0)}
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
        {routeLegs.map((coords, i) => (
          // The ROUTE — the actual recorded (masked) path, drawn after the
          // outline so it renders on top wherever the two overlap. Each leg
          // gets its own gradient run, same as the web map's per-feature
          // line-progress.
          <Polyline
            key={`route-leg-${i}`}
            coordinates={coords}
            strokeWidth={ROUTE_LINE_WIDTH}
            strokeColor={ROUTE_LINE_COLOR}
            strokeColors={gradientStrokeColors(coords.length)}
            lineCap="round"
            lineJoin="round"
          />
        ))}
        {/* Start/finish pins at the ends of the masked path — path[0] is
            already the trimmed start (privacy-zone.ts), not the runner's
            real front door, so marking it reveals nothing the route line
            itself doesn't already show. Web equivalent: fence-map.web.tsx's
            DOM markers. */}
        {path.length > 0 && (
          <Marker
            coordinate={{ latitude: path[0].lat, longitude: path[0].lng }}
            anchor={{ x: 0.5, y: 0.5 }}
            tracksViewChanges={false}>
            <View style={styles.startBar} />
          </Marker>
        )}
        {path.length > 1 && (
          <Marker
            coordinate={{ latitude: path[path.length - 1].lat, longitude: path[path.length - 1].lng }}
            anchor={{ x: 0.5, y: 0.5 }}
            tracksViewChanges={false}>
            <View style={styles.finishIcon}>
              <Svg width={20} height={20} viewBox="0 0 20 20">
                {/* pole */}
                <SvgRect x={4.1} y={2} width={1.8} height={16} rx={0.9} fill="#fff" />
                {/* 3×3 checker grid — row 1 */}
                <SvgRect x={5.5} y={2.5} width={4} height={3.5} fill="#1a1a1a" />
                <SvgRect x={9.5} y={2.5} width={4} height={3.5} fill="#fff" />
                <SvgRect x={13.5} y={2.5} width={4} height={3.5} fill="#1a1a1a" />
                {/* row 2 */}
                <SvgRect x={5.5} y={6} width={4} height={3.5} fill="#fff" />
                <SvgRect x={9.5} y={6} width={4} height={3.5} fill="#1a1a1a" />
                <SvgRect x={13.5} y={6} width={4} height={3.5} fill="#fff" />
                {/* row 3 */}
                <SvgRect x={5.5} y={9.5} width={4} height={3.5} fill="#1a1a1a" />
                <SvgRect x={9.5} y={9.5} width={4} height={3.5} fill="#fff" />
                <SvgRect x={13.5} y={9.5} width={4} height={3.5} fill="#1a1a1a" />
                {/* flag border */}
                <SvgRect x={5.5} y={2.5} width={12} height={10.5} fill="none" stroke="#fff" strokeWidth={1} />
              </Svg>
            </View>
          </Marker>
        )}
        {/* Per-area "+N" conquest bubbles (clusterCells, tiles.ts) — replaces
            the old single aggregate "You took N tiles" banner, which said
            THAT ground was won but never WHERE. Web equivalent:
            fence-map.web.tsx's DOM markers with the same visual language. */}
        {takenClusters.map((cluster, i) => (
          <Marker
            key={`taken-${i}`}
            coordinate={{ latitude: cluster.center.lat, longitude: cluster.center.lng }}
            // Not `y: 1`: the marker's drawing surface carries a margin for
            // the blurred shadow, so the tip is above the view's bottom edge.
            // anchorY is where the tip actually falls (lib/conquest-marker).
            anchor={{ x: 0.5, y: conquestMarkerGeometry(cluster.count).anchorY }}
            accessibilityLabel={cluster.label}
            tracksViewChanges={trackTakenMarkers}>
            <ConquestMarker count={cluster.count} />
          </Marker>
        ))}
        {cycleBonus && (
          <Marker
            coordinate={{ latitude: cycleBonus.center.lat, longitude: cycleBonus.center.lng }}
            anchor={{ x: 0.5, y: cycleBonusMarkerGeometry(cycleBonus.pts).anchorY }}
            tracksViewChanges={false}>
            <CycleBonusMarker pts={cycleBonus.pts} />
          </Marker>
        )}
      </MapView>
      {controls && (
        <View style={styles.mapControls} pointerEvents="box-none">
          <MapButton
            label={controls.recenterLabel}
            onPress={refit}
            ios="map"
            android="map"
          />
          <MapButton
            label={controls.zoomInLabel}
            onPress={() => zoomBy(ZOOM_STEP)}
            ios="plus"
            android="add"
          />
          <MapButton
            label={controls.zoomOutLabel}
            onPress={() => zoomBy(-ZOOM_STEP)}
            ios="minus"
            android="remove"
          />
        </View>
      )}
    </View>
  );
}

// Byte-identical to track-map.tsx's own MapButton — see fence-map.web.tsx's
// matching comment on why this is duplicated rather than shared.
function MapButton({
  label,
  onPress,
  ios,
  android,
}: {
  label: string;
  onPress: () => void;
  ios: SFSymbol;
  android: AndroidSymbol;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={8}
      style={({ pressed }) => [styles.mapButton, { opacity: pressed ? 0.85 : 1 }]}>
      <Icon ios={ios} android={android} size={20} color="#FFFFFF" />
    </Pressable>
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
  startBar: {
    width: 3,
    height: 20,
    borderRadius: 1.5,
    backgroundColor: '#fff',
    shadowColor: '#000',
    shadowOpacity: 0.45,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 },
    elevation: 3,
  },
  finishIcon: {
    shadowColor: '#000',
    shadowOpacity: 0.45,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 },
    elevation: 3,
  },
  mapControls: {
    position: 'absolute',
    right: Spacing.three,
    // Clears the floating pill tab bar, exactly as track-map's own
    // cameraControls does. A raw `bottom: 16` put the LOWEST button in this
    // column — zoom out — entirely inside the tab bar's 96px band, so on the
    // run-summary screen (this component's only caller, a tab screen) it read
    // as simply missing. Reported 2026-09-07.
    bottom: BottomTabInset + Spacing.three,
    alignItems: 'center',
    gap: Spacing.two,
  },
  mapButton: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(20,20,20,0.65)',
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 6,
  },
});
