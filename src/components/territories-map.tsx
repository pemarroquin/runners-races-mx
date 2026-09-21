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
import MapView, { Polygon } from 'react-native-maps';
import type { MultiPolygon, Polygon as GeoPolygon } from 'geojson';

import { Icon } from '@/components/ui/icon';
import { Spacing } from '@/constants/theme';
import { assignFenceColors, GOOGLE_DARK_MAP_STYLE, withAlpha, ZOOM_STEP } from '@/constants/map';
import { polygonRings, ringToCoords, type MapCoord } from '@/lib/fence-draw';
import { buildMergedTerritories } from '@/lib/merged-territory';
import { outerRings, type LatLng } from '@/lib/territory';

const PENDING_COLOR = '#8E8E93';

interface MergedGroup {
  id: string;
  geometry: MultiPolygon;
  color: string;
}

// The dissolve itself (cell -> owning run by last-write-wins, cluster by H3
// adjacency, most-recent-run-per-cluster for colour + click routing) now
// lives in src/lib/merged-territory.ts, shared with territories-map.web.tsx
// — see that module's header for why. This just adapts its platform-neutral
// output into this file's own MergedGroup shape for react-native-maps.
function buildMergedGroups(
  features: TerritoryFeature[],
  colorMap: Map<string, string>,
): MergedGroup[] {
  return buildMergedTerritories(features, colorMap, PENDING_COLOR).map((t) => ({
    id: t.id,
    geometry: { type: 'MultiPolygon', coordinates: t.coordinates },
    color: t.color,
  }));
}
const PENDING_FILL_ALPHA = 0.14;
const PENDING_STROKE_ALPHA = 0.7;
const SAVED_FILL_ALPHA = 0.3;
const SAVED_STROKE_ALPHA = 0.55;
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

  const mergedGroups = useMemo(
    () => buildMergedGroups(features, colorMap),
    [features, colorMap],
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
        {/* Merged fills: adjacent tiles from different runs dissolve into one
            polygon per connected component. Click routes to the most-recent
            run in that component (matches web's MERGED_FILLS_SRC behaviour). */}
        {mergedGroups.map((group, i) => (
          <MergedFill key={`merged:${i}`} group={group} onSelect={onSelect} />
        ))}
        {/* Pending features — their own polygon fill + dashed outline. */}
        {features
          .filter((f) => f.kind === 'pending')
          .map((f) => (
            <Feature key={`pending:${f.id}`} feature={f} color={undefined} onSelect={onSelect} />
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

function MergedFill({
  group,
  onSelect,
}: {
  group: MergedGroup;
  onSelect: (id: string, kind: 'saved' | 'pending') => void;
}) {
  const rings = useMemo(() => polygonRings(group.geometry), [group.geometry]);
  const press = () => onSelect(group.id, 'saved');
  return (
    <>
      {rings.map((ring, i) => (
        <Polygon
          key={i}
          coordinates={ringToCoords(ring[0])}
          holes={ring.slice(1).map(ringToCoords)}
          fillColor={withAlpha(group.color, SAVED_FILL_ALPHA)}
          strokeColor={withAlpha(group.color, SAVED_STROKE_ALPHA)}
          strokeWidth={1.5}
          tappable
          onPress={press}
        />
      ))}
    </>
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
  const color = PENDING_COLOR;
  const press = () => onSelect(feature.id, feature.kind);

  return (
    <>
      {rings.map((ring, i) => (
        <Polygon
          key={i}
          coordinates={ringToCoords(ring[0])}
          holes={ring.slice(1).map(ringToCoords)}
          fillColor={withAlpha(color, PENDING_FILL_ALPHA)}
          strokeColor={withAlpha(color, PENDING_STROKE_ALPHA)}
          strokeWidth={2}
          lineDashPattern={[4, 4]}
          tappable
          onPress={press}
        />
      ))}
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
