// My Achievements' map — NATIVE. See territories-map.web.tsx's header
// for the full spec (both visual states, the fit-to-all-bounds behaviour,
// the scaling caveat); this file mirrors it with react-native-maps instead
// of Mapbox GL.
//
// No fill-extrusion on this platform (react-native-maps has none — same
// accepted limitation fence-map.tsx and track-map.tsx already carry: a flat
// filled Polygon stands in for the wall). Tap targets are native Polygon
// onPress, one per feature — far simpler than web's layer-click plumbing.
import type { AndroidSymbol, SFSymbol } from 'expo-symbols';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import MapView, { Polygon, Polyline } from 'react-native-maps';
import type { MultiPolygon, Polygon as GeoPolygon } from 'geojson';

import { Icon } from '@/components/ui/icon';
import { Spacing } from '@/constants/theme';
import { assignFenceColors, GOOGLE_DARK_MAP_STYLE, withAlpha, ZOOM_STEP } from '@/constants/map';
import { gradientStrokeColors, polygonRings, ringToCoords, type MapCoord } from '@/lib/fence-draw';
import { outerRings, type LatLng } from '@/lib/territory';

const PENDING_COLOR = '#8E8E93';
const PENDING_FILL_ALPHA = 0.14;
const PENDING_STROKE_ALPHA = 0.7;
const SAVED_FILL_ALPHA = 0.3;
const SAVED_STROKE_ALPHA = 0.55;
const ROUTE_LINE_WIDTH = 5;
const FIT_PADDING = { top: 48, right: 48, bottom: 48, left: 48 };

export interface TerritoryFeature {
  id: string;
  kind: 'saved' | 'pending';
  geometry: GeoPolygon | MultiPolygon;
  route: LatLng[] | null;
  startedAtMs: number;
  /** H3 tile IDs — used on web only (merged dissolve fill); native renders
   *  each feature's geometry directly so this is accepted but ignored. */
  cells: string[];
}

interface TerritoriesMapProps {
  features: TerritoryFeature[];
  onSelect: (id: string, kind: 'saved' | 'pending') => void;
  /** See territories-map.web.tsx's matching prop doc — same reasoning,
   *  reported missing 2026-09-17. */
  controls?: { zoomInLabel: string; zoomOutLabel: string; refitLabel: string };
  /** See territories-map.web.tsx's matching prop doc for why this has to be
   *  the caller's call rather than a hard-coded constant. */
  controlsBottomOffset?: number;
  /** See territories-map.web.tsx's matching prop doc — accepted here only so
   *  the one call site (achievements-view.tsx) typechecks on both platforms.
   *  A no-op on native: this file has no continuous animation timer to gate
   *  (no fill-extrusion, no gradient flow — see this file's own header for
   *  why), so there is nothing for it to pause. */
  active?: boolean;
}

function boundsCoordsOf(features: TerritoryFeature[]): MapCoord[] {
  const coords: MapCoord[] = [];
  for (const f of features) {
    for (const ring of outerRings(f.geometry)) {
      for (const [lng, lat] of ring) coords.push({ latitude: lat, longitude: lng });
    }
  }
  return coords;
}

export function TerritoriesMap({
  features,
  onSelect,
  controls,
  controlsBottomOffset,
}: TerritoriesMapProps) {
  const mapRef = useRef<MapView | null>(null);

  const colorMap = useMemo(
    () =>
      assignFenceColors(
        features
          .filter((f) => f.kind === 'saved')
          .map((f) => ({ id: f.id, startedAtMs: f.startedAtMs })),
      ),
    [features],
  );

  const fitCoords = useMemo(() => boundsCoordsOf(features), [features]);
  useEffect(() => {
    if (fitCoords.length === 0) return;
    // Deferred a tick: fitToCoordinates before real layout silently no-ops
    // on Android — same guard fence-map.tsx uses.
    const id = setTimeout(() => {
      mapRef.current?.fitToCoordinates(fitCoords, { edgePadding: FIT_PADDING, animated: true });
    }, 350);
    return () => clearTimeout(id);
  }, [fitCoords]);

  // The "fit all" control's target — same fitToCoordinates call as the
  // mount effect above, callable again after a manual pan/zoom.
  const refit = useCallback(() => {
    mapRef.current?.fitToCoordinates(fitCoords, { edgePadding: FIT_PADDING, animated: true });
  }, [fitCoords]);

  const zoomBy = useCallback((delta: number) => {
    const map = mapRef.current;
    if (!map) return;
    void map.getCamera().then((camera) => {
      map.animateCamera({ ...camera, zoom: (camera.zoom ?? 15) + delta }, { duration: 300 });
    });
  }, []);

  const initialRegion = useMemo(() => regionAround(fitCoords), [fitCoords]);

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
        {features.map((f) => (
          <Feature
            key={`${f.kind}:${f.id}`}
            feature={f}
            color={colorMap.get(f.id)}
            onSelect={onSelect}
          />
        ))}
      </MapView>
      {controls && (
        <View
          style={[styles.mapControls, { bottom: controlsBottomOffset ?? Spacing.three }]}
          pointerEvents="box-none">
          <MapButton label={controls.refitLabel} onPress={refit} ios="map" android="map" />
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

// Byte-identical to fence-map.tsx's own MapButton — deliberately duplicated,
// matching this codebase's existing per-file convention.
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

function Feature({
  feature,
  color: colorProp,
  onSelect,
}: {
  feature: TerritoryFeature;
  color?: string;
  onSelect: (id: string, kind: 'saved' | 'pending') => void;
}) {
  const rings = useMemo(() => polygonRings(feature.geometry), [feature.geometry]);
  const color = feature.kind === 'saved' ? (colorProp ?? PENDING_COLOR) : PENDING_COLOR;
  const routeCoords = useMemo(
    (): MapCoord[] => (feature.route ?? []).map((p) => ({ latitude: p.lat, longitude: p.lng })),
    [feature.route],
  );
  const routeColors = useMemo(
    () => gradientStrokeColors(routeCoords.length),
    [routeCoords.length],
  );
  const press = () => onSelect(feature.id, feature.kind);

  return (
    <>
      {rings.map((ring, i) => (
        <Polygon
          key={i}
          coordinates={ringToCoords(ring[0])}
          holes={ring.slice(1).map(ringToCoords)}
          fillColor={withAlpha(color, feature.kind === 'saved' ? SAVED_FILL_ALPHA : PENDING_FILL_ALPHA)}
          strokeColor={withAlpha(color, feature.kind === 'saved' ? SAVED_STROKE_ALPHA : PENDING_STROKE_ALPHA)}
          strokeWidth={feature.kind === 'saved' ? 1.5 : 2}
          // iOS-only per react-native-maps — Android pending fences fall
          // back to a solid outline, an accepted platform difference (same
          // posture as this codebase's other native-vs-web gaps).
          lineDashPattern={feature.kind === 'pending' ? [4, 4] : undefined}
          tappable
          onPress={press}
        />
      ))}
      {feature.kind === 'saved' && routeCoords.length >= 2 && (
        // Decorative only, no onPress — the Polygon above is the real tap
        // target, matching fence-map.tsx's own route-vs-fence split.
        <Polyline
          coordinates={routeCoords}
          strokeWidth={ROUTE_LINE_WIDTH}
          strokeColors={routeColors}
          lineCap="round"
          lineJoin="round"
        />
      )}
    </>
  );
}

/** A Region loosely containing the coords — only the pre-fit first frame. */
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
  mapControls: {
    position: 'absolute',
    right: Spacing.three,
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
