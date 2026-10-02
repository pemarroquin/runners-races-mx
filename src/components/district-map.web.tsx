// THE MAP IS THE BOARD — who holds this district, drawn.
//
// The share bar above it says how the district is divided; this says WHERE.
// Together they are the leaderboard, and the ranked lists below are the
// detail rather than the headline ("having leaderboard with only cards is
// boring and i do not like it at all").
//
// COSTS NO NEW QUERIES, which is why it can exist at all. fetchTileLeaderboard
// already pulls `h3 + owner_id` for every tile — the h3 was being fetched,
// filtered on for resolution, and then thrown away before this needed it.
// So every polygon here comes from data the screen had in memory anyway.
//
// One dissolved shape per OWNER, not one polygon per hexagon. Enclosure
// changed the scale of that decision: a 10 km loop claims ~26,000 cells, and
// handing Mapbox 26,000 separate polygons per owner is a lot of geometry for
// something that reads as one region. cellsToMultiPolygon merges each
// owner's set and drops the internal edges, so a territory reads as an area
// rather than a quilt — the same call, for the same reason, as the Track
// map's live fill and enclosure.ts's own hole detection, which is what keeps
// all three from ever disagreeing about where a boundary is.
import { cellsToMultiPolygon } from 'h3-js';
import type { Feature, FeatureCollection } from 'geojson';
import type { Map as MapboxMap } from 'mapbox-gl';
import mapboxGlPkg from 'mapbox-gl/package.json';
import type { AndroidSymbol, SFSymbol } from 'expo-symbols';
import { useCallback, useEffect, useRef } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Icon } from '@/components/ui/icon';
import { Spacing } from '@/constants/theme';
import { frameOf, type CellBounds } from '@/lib/local-leaders';
import { EMISSIVE_STRENGTH_FULL, MAP_SLOT_FILL, MAP_SLOT_ROUTE, MAP_STYLE_GL } from '@/constants/map';

const TOKEN = process.env.EXPO_PUBLIC_MAPBOX_TOKEN;
const MAPBOX_CSS_URL = `https://api.mapbox.com/mapbox-gl-js/v${mapboxGlPkg.version}/mapbox-gl.css`;

const HOLDINGS_SRC = 'district-holdings';
const OUTLINE_SRC = 'district-outline';

/** One runner's ground in this district, already tinted by the caller so the
 *  colour matches their row and their slice of the share bar. */
export interface DistrictHolding {
  userId: string;
  cells: string[];
  color: string;
  isMe: boolean;
  /** The runner's own ground OUTSIDE the selected place — drawn dimmer, so
   *  the contest inside the place stands out (Pedro, 2026-10-01). */
  faded?: boolean;
}

/** Where the board is: a subdivision's real outline, or a district's
 *  hexagon (subdivisions.ts's Arena carries both shapes of it). */
export interface DistrictMapArena {
  /** Outline as MultiPolygon coordinates, [lng, lat]. */
  outline: number[][][][];
  bounds: CellBounds;
}

export interface DistrictMapProps {
  /** Drawn as a dashed edge so the contest has a visible edge — without it
   *  the fills float on an unbounded map and "share of this place" has no
   *  referent on screen. */
  arena: DistrictMapArena;
  holdings: DistrictHolding[];
  /** Full-bleed, pannable mode (Local Leaders). Omitted: the fixed 220 px
   *  non-interactive card Municipio uses. */
  full?: DistrictMapFull;
  /** Full mode: one runner picked from the ranking card. Their ground reads
   *  bright, everyone else's dims, and the camera flies to them. */
  focusUserId?: string | null;
  /** What the camera frames (no focus): e.g. all of the runner's ground on
   *  opening. Omitted: every holding. */
  frameCells?: string[];
  /** Changes when the caller wants a fresh framing (a new target landed). */
  frameKey?: string;
}

export interface DistrictMapFull {
  /** Screen chrome floating over the map. The camera frames the ground
   *  inside what is left visible, not behind the capsule or the card. */
  padding: { top: number; right: number; bottom: number; left: number };
  /** Where the zoom/refit stack starts, below the top chrome. */
  controlsTop: number;
  controls: { zoomInLabel: string; zoomOutLabel: string; refitLabel: string };
}

const ZOOM_STEP = 1;


function ensureMapboxCss() {
  if (document.getElementById('mapbox-gl-css')) return;
  const link = document.createElement('link');
  link.id = 'mapbox-gl-css';
  link.rel = 'stylesheet';
  link.href = MAPBOX_CSS_URL;
  document.head.appendChild(link);
}

/** The arena's boundary, every ring of it, as lines. */
function arenaOutline(arena: DistrictMapArena): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {},
        geometry: { type: 'MultiLineString', coordinates: arena.outline.flat() },
      },
    ],
  };
}

function holdingsCollection(holdings: DistrictHolding[]): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: holdings.flatMap((holding): Feature[] => {
      if (holding.cells.length === 0) return [];
      // Guarded: cellsToMultiPolygon throws on a malformed cell, and one bad
      // id must not take the whole map down — a missing runner is far better
      // than a blank screen where the board used to be.
      let rings: number[][][][];
      try {
        rings = cellsToMultiPolygon(holding.cells, true);
      } catch {
        return [];
      }
      return rings.map(
        (ring): Feature => ({
          type: 'Feature',
          // Colour travels as a data property so ALL owners render from one
          // layer. A layer per owner would mean adding and removing layers
          // every time the board refreshes, which is style churn on a live
          // map for no gain.
          properties: { color: holding.color, isMe: holding.isMe, userId: holding.userId, faded: holding.faded === true },
          geometry: { type: 'Polygon', coordinates: ring as never },
        }),
      );
    }),
  };
}

/** Fill opacity with nobody focused: your own ground stronger than the rest
 *  (the map's version of the ring on your row); with a focus, theirs bright
 *  and everyone else's faded back. */
function fillOpacity(focus: string | null | undefined) {
  const base = ['case', ['get', 'isMe'], 0.55, 0.3];
  const bright = focus ? ['case', ['==', ['get', 'userId'], focus], 0.7, 0.08] : base;
  // Ground outside the selected place: dimmer, brighter only when focused.
  const faded = focus ? ['case', ['==', ['get', 'userId'], focus], 0.3, 0.05] : 0.16;
  return ['case', ['==', ['get', 'faded'], true], faded, bright];
}

function lineOpacity(focus: string | null | undefined) {
  const bright = focus ? ['case', ['==', ['get', 'userId'], focus], 1, 0.15] : 0.8;
  return ['case', ['==', ['get', 'faded'], true], 0.3, bright];
}

export function DistrictMap({ arena, holdings, full, focusUserId, frameCells, frameKey }: DistrictMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapboxMap | null>(null);
  const readyRef = useRef(false);
  // The freshest props for the async load callback — the map builds once, but
  // holdings usually arrive after the dynamic import has started. Written
  // from an effect rather than during render, same as fence-map.web.tsx.
  const dataRef = useRef({ arena, holdings, full, focusUserId, frameCells });
  useEffect(() => {
    dataRef.current = { arena, holdings, full, focusUserId, frameCells };
  }, [arena, holdings, full, focusUserId, frameCells]);
  // Full mode frames the held ground, which usually lands after the map has
  // loaded on the district alone. Refit once when it does, never again —
  // after that the camera is the runner's.
  const framedHoldingsRef = useRef(false);

  const refit = useCallback((animate: boolean) => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    const { arena: a, holdings: h, full: f, focusUserId: focus, frameCells: fc } = dataRef.current;
    const focused = focus ? h.filter((x) => x.userId === focus) : [];
    const target = focused.length > 0 ? focused : fc && fc.length > 0 ? [{ cells: fc }] : h;
    const b = frameOf(a.bounds, target, !!f);
    if (!b) return;
    map.fitBounds(
      [
        [b.minLng, b.minLat],
        [b.maxLng, b.maxLat],
      ],
      { padding: f?.padding ?? 24, duration: animate ? 900 : 0, maxZoom: 16 },
    );
  }, []);

  const zoomBy = useCallback((delta: number) => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    map.easeTo({ zoom: map.getZoom() + delta, duration: 300 });
  }, []);

  useEffect(() => {
    if (!TOKEN || !containerRef.current) return;
    let cancelled = false;

    (async () => {
      ensureMapboxCss();
      const { default: mapboxgl } = await import('mapbox-gl');
      if (cancelled || !containerRef.current) return;
      mapboxgl.accessToken = TOKEN;

      const initial = dataRef.current;
      const frame = frameOf(initial.arena.bounds, initial.holdings, !!initial.full);
      if (!frame) return;
      const { minLng, minLat, maxLng, maxLat } = frame;

      const map = new mapboxgl.Map({
        container: containerRef.current,
        style: MAP_STYLE_GL,
        bounds: [
          [minLng, minLat],
          [maxLng, maxLat],
        ],
        fitBoundsOptions: { padding: initial.full?.padding ?? 24, maxZoom: 16 },
        attributionControl: false,
        // The card is a summary, not a surface to explore: the district is
        // the frame and panning off it would show ground this board says
        // nothing about. Full-bleed mode IS the board, so it pans and zooms.
        interactive: !!initial.full,
      });
      if (initial.full && initial.holdings.some((h) => h.cells.length > 0)) {
        framedHoldingsRef.current = true;
      }
      mapRef.current = map;

      map.on('load', () => {
        if (cancelled) return;
        const { arena: a, holdings: h } = dataRef.current;

        map.addSource(OUTLINE_SRC, { type: 'geojson', data: arenaOutline(a) });
        map.addLayer({
          id: `${OUTLINE_SRC}-line`,
          type: 'line',
          source: OUTLINE_SRC,
          slot: MAP_SLOT_ROUTE,
          paint: {
            'line-color': '#ffffff',
            'line-opacity': 0.35,
            'line-width': 1.5,
            'line-dasharray': [3, 3],
            'line-emissive-strength': EMISSIVE_STRENGTH_FULL,
          },
        });

        map.addSource(HOLDINGS_SRC, { type: 'geojson', data: holdingsCollection(h) });
        map.addLayer({
          id: HOLDINGS_SRC,
          type: 'fill',
          source: HOLDINGS_SRC,
          slot: MAP_SLOT_FILL,
          paint: {
            'fill-color': ['get', 'color'],
            // Your own ground reads stronger than everyone else's. This is
            // the map's version of the ring on your row and your slice of
            // the share bar — one runner, three places, one visual language.
            'fill-opacity': fillOpacity(dataRef.current.focusUserId) as never,
            'fill-emissive-strength': EMISSIVE_STRENGTH_FULL,
          },
        });
        map.addLayer({
          id: `${HOLDINGS_SRC}-line`,
          type: 'line',
          source: HOLDINGS_SRC,
          slot: MAP_SLOT_ROUTE,
          paint: {
            'line-color': ['get', 'color'],
            'line-width': 1,
            'line-opacity': lineOpacity(dataRef.current.focusUserId) as never,
            'line-emissive-strength': EMISSIVE_STRENGTH_FULL,
          },
        });

        readyRef.current = true;
      });
    })();

    return () => {
      cancelled = true;
      readyRef.current = false;
      mapRef.current?.remove();
      mapRef.current = null;
    };
    // Mount-only, and it needs no deps-disable: every prop this effect reads
    // comes through dataRef, so the linter is satisfied on its own. The
    // district changing is handled by the caller remounting on `key`, because
    // a new arena means a new camera frame — cheaper and less error-prone
    // than animating a fitBounds and re-deriving the outline in place.
  }, []);

  // setData on the existing source, never a layer rebuild: pull-to-refresh
  // and a focus refetch both land here, and re-adding layers would flash the
  // map on every one.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    const source = map.getSource(HOLDINGS_SRC);
    if (source && 'setData' in source) {
      (source as { setData: (d: FeatureCollection) => void }).setData(
        holdingsCollection(holdings),
      );
    }
    if (full && !framedHoldingsRef.current && holdings.some((h) => h.cells.length > 0)) {
      framedHoldingsRef.current = true;
      refit(true);
    }
  }, [holdings, full, refit]);

  // The caller asked for a fresh framing (e.g. all the runner's ground just
  // loaded). Skipped until ready; the load handler frames whatever is
  // current then.
  const frameKeyRef = useRef(frameKey);
  useEffect(() => {
    if (frameKeyRef.current === frameKey) return;
    frameKeyRef.current = frameKey;
    if (full) refit(true);
  }, [frameKey, full, refit]);

  // A new place, same map: redraw the outline and fly there, instead of
  // tearing the map down and building another (which flashed on every
  // arrow tap). Frames the place itself first; the held ground, when its
  // rows land, gets one more framing through the effect above. Skipped
  // until ready — the load handler frames whatever arena is current then.
  const arenaRef = useRef(arena);
  useEffect(() => {
    if (arenaRef.current === arena) return;
    arenaRef.current = arena;
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    const source = map.getSource(OUTLINE_SRC);
    if (source && 'setData' in source) {
      (source as { setData: (d: FeatureCollection) => void }).setData(arenaOutline(arena));
    }
    framedHoldingsRef.current = false;
    const b = arena.bounds;
    map.fitBounds(
      [
        [b.minLng, b.minLat],
        [b.maxLng, b.maxLat],
      ],
      { padding: full?.padding ?? 24, duration: 1200, maxZoom: 16, essential: true },
    );
  }, [arena, full]);

  // A focus change repaints and re-frames. Skipped until the map is ready:
  // the load handler reads the same focus through dataRef, so nothing is
  // lost if a row is tapped mid-load.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current || !map.getLayer(HOLDINGS_SRC)) return;
    map.setPaintProperty(HOLDINGS_SRC, 'fill-opacity', fillOpacity(focusUserId) as never);
    map.setPaintProperty(`${HOLDINGS_SRC}-line`, 'line-opacity', lineOpacity(focusUserId) as never);
    if (full) refit(true);
  }, [focusUserId, full, refit]);

  if (!TOKEN) return null;

  return (
    <View style={full ? StyleSheet.absoluteFill : styles.wrap}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
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

// Same MapButton as territories-map.web.tsx — duplicated per file, matching
// this codebase's existing convention.
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
    boxShadow: '0px 3px 8px rgba(0,0,0,0.3)',
  },
});
