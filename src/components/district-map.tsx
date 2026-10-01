// Who holds this district, drawn — NATIVE.
//
// react-native-maps rather than GL JS, for the same hard reason the Track and
// Fence maps split: the Static Images API cannot render Mapbox Standard
// styles and this platform has no GL JS. See track-map.web.tsx's header.
//
// One dissolved shape per OWNER, not one polygon per hexagon — see
// district-map.web.tsx for why that matters at enclosure scale (~26,000 cells
// for a 10 km loop). Holes are dropped: react-native-maps takes an outer ring
// plus a separate `holes` prop, and an enclosed region inside someone's
// territory is still their ground, so there is nothing to cut out. Same
// decision, same reasoning, as track-map.tsx's tile fill.
import { cellsToMultiPolygon } from 'h3-js';
import type { AndroidSymbol, SFSymbol } from 'expo-symbols';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import MapView, { Polygon, Polyline } from 'react-native-maps';

import type {
  DistrictHolding,
  DistrictMapArena,
  DistrictMapFull,
  DistrictMapProps,
} from '@/components/district-map.web';
import { Icon } from '@/components/ui/icon';
import { Spacing } from '@/constants/theme';
import { frameOf } from '@/lib/local-leaders';
import { zoomedCamera } from '@/lib/map-camera';

export type { DistrictHolding, DistrictMapArena, DistrictMapFull, DistrictMapProps };

const ZOOM_STEP = 1;

/** Padding on the district's own bounds, as a fraction of its span. The
 *  district IS the frame — a little air keeps its dashed edge off the corners
 *  of the card. */
const FRAME_PAD = 0.12;

export function DistrictMap({ arena, holdings, full, focusUserId }: DistrictMapProps) {
  const mapRef = useRef<MapView | null>(null);
  const readyRef = useRef(false);
  const framedHoldingsRef = useRef(false);
  const dataRef = useRef({ arena, holdings, full, focusUserId });
  useEffect(() => {
    dataRef.current = { arena, holdings, full, focusUserId };
  }, [arena, holdings, full, focusUserId]);

  const refit = useCallback((animated: boolean) => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    const { arena: a, holdings: h, full: f, focusUserId: focus } = dataRef.current;
    const focused = focus ? h.filter((x) => x.userId === focus) : [];
    const b = frameOf(a.bounds, focused.length > 0 ? focused : h, !!f);
    if (!b) return;
    map.fitToCoordinates(
      [
        { latitude: b.minLat, longitude: b.minLng },
        { latitude: b.maxLat, longitude: b.maxLng },
      ],
      { edgePadding: f?.padding ?? { top: 24, right: 24, bottom: 24, left: 24 }, animated },
    );
  }, []);

  const zoomBy = useCallback((delta: number) => {
    const map = mapRef.current;
    if (!map) return;
    // zoomedCamera sets altitude too: Apple Maps ignores `zoom` entirely.
    void map.getCamera().then((camera) => {
      map.animateCamera(zoomedCamera(camera, delta), { duration: 300 });
    });
  }, []);

  useEffect(() => {
    if (full) refit(true);
  }, [focusUserId, full, refit]);

  // Full mode frames the held ground, which usually arrives after the map is
  // ready. Refit once when it does; after that the camera is the runner's.
  useEffect(() => {
    if (!full || framedHoldingsRef.current || !readyRef.current) return;
    if (!holdings.some((h) => h.cells.length > 0)) return;
    framedHoldingsRef.current = true;
    refit(true);
  }, [holdings, full, refit]);

  // A new place, same map: fly there rather than remount (see the web map).
  const arenaRef = useRef(arena);
  useEffect(() => {
    if (arenaRef.current === arena) return;
    arenaRef.current = arena;
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    framedHoldingsRef.current = false;
    const b = arena.bounds;
    map.fitToCoordinates(
      [
        { latitude: b.minLat, longitude: b.minLng },
        { latitude: b.maxLat, longitude: b.maxLng },
      ],
      { edgePadding: full?.padding ?? { top: 24, right: 24, bottom: 24, left: 24 }, animated: true },
    );
  }, [arena, full]);

  // Every ring of the arena's outline, [lng, lat] flipped to
  // react-native-maps' { latitude, longitude }.
  const outlineRings = useMemo(
    () => arena.outline.flat().map((ring) => ring.map(([lng, lat]) => ({ latitude: lat, longitude: lng }))),
    [arena],
  );

  const region = useMemo(() => {
    const { minLat, maxLat, minLng, maxLng } = arena.bounds;
    return {
      latitude: (minLat + maxLat) / 2,
      longitude: (minLng + maxLng) / 2,
      latitudeDelta: (maxLat - minLat) * (1 + FRAME_PAD * 2),
      longitudeDelta: (maxLng - minLng) * (1 + FRAME_PAD * 2),
    };
  }, [arena]);

  const shapes = useMemo(
    () =>
      holdings.flatMap((holding) => {
        if (holding.cells.length === 0) return [];
        // Guarded for the same reason the web map guards: cellsToMultiPolygon
        // throws on a malformed cell, and one bad id must not take the board
        // down. A missing runner beats a blank card.
        let rings: number[][][][];
        try {
          rings = cellsToMultiPolygon(holding.cells);
        } catch {
          return [];
        }
        return rings.map((ring, i) => ({
          key: `${holding.userId}-${i}`,
          color: holding.color,
          isMe: holding.isMe,
          userId: holding.userId,
          coords: (ring[0] as unknown as [number, number][]).map(([lat, lng]) => ({
            latitude: lat,
            longitude: lng,
          })),
        }));
      }),
    [holdings],
  );

  return (
    <View style={full ? StyleSheet.absoluteFill : styles.wrap}>
      <MapView
        ref={mapRef}
        style={StyleSheet.absoluteFill}
        initialRegion={region}
        onMapReady={() => {
          readyRef.current = true;
          if (!full) return;
          // initialRegion can't account for the chrome floating over the
          // map, so full mode re-frames with padding once ready.
          if (holdings.some((h) => h.cells.length > 0)) framedHoldingsRef.current = true;
          refit(false);
        }}
        // Literal "dark", matching track-map.tsx and fence-map.tsx — the prop
        // takes a style name, not the MAP_ALWAYS_DARK boolean.
        userInterfaceStyle="dark"
        // The card is a summary, not a surface to explore — panning off the
        // district would show ground this board says nothing about. Full
        // mode IS the board, so it pans and zooms.
        scrollEnabled={!!full}
        zoomEnabled={!!full}
        rotateEnabled={false}
        pitchEnabled={false}
        toolbarEnabled={false}>
        {shapes.map((shape) => (
          <Polygon
            key={shape.key}
            coordinates={shape.coords}
            // Your own ground reads stronger than everyone else's, matching
            // the ring on your row and your slice of the share bar.
            fillColor={`${shape.color}${fillAlpha(shape, focusUserId)}`}
            strokeColor={focusUserId && shape.userId !== focusUserId ? `${shape.color}26` : shape.color}
            strokeWidth={1}
          />
        ))}
        {outlineRings.map((ring, i) => (
          <Polyline key={`outline:${i}`} coordinates={ring} strokeColor="rgba(255,255,255,0.35)" strokeWidth={1.5} />
        ))}
      </MapView>
      {full && (
        <View style={[styles.mapControls, { top: full.controlsTop }]} pointerEvents="box-none">
          <MapButton label={full.controls.refitLabel} onPress={() => refit(true)} ios="map" android="map" />
          <MapButton label={full.controls.zoomInLabel} onPress={() => zoomBy(ZOOM_STEP)} ios="plus" android="add" />
          <MapButton label={full.controls.zoomOutLabel} onPress={() => zoomBy(-ZOOM_STEP)} ios="minus" android="remove" />
        </View>
      )}
    </View>
  );
}

/** Hex alpha suffix, matching the web map's opacities: yours stronger with
 *  no focus; with a focus, theirs bright and everyone else faded back. */
function fillAlpha(shape: { isMe: boolean; userId: string }, focus: string | null | undefined): string {
  if (focus) return shape.userId === focus ? 'B3' : '14';
  return shape.isMe ? '8C' : '4D';
}

// Same MapButton as territories-map.tsx — duplicated per file, matching this
// codebase's existing convention.
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

const styles = StyleSheet.create({
  wrap: { height: 220, borderRadius: 16, overflow: 'hidden' },
  mapControls: {
    position: 'absolute',
    right: Spacing.three,
    alignItems: 'center',
    gap: Spacing.two,
  },
  mapButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(20,20,20,0.65)',
  },
});
