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
import { cellToBoundary, cellsToMultiPolygon } from 'h3-js';
import type { Feature, FeatureCollection } from 'geojson';
import type { Map as MapboxMap } from 'mapbox-gl';
import mapboxGlPkg from 'mapbox-gl/package.json';
import type { AndroidSymbol, SFSymbol } from 'expo-symbols';
import { useCallback, useEffect, useRef } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Icon } from '@/components/ui/icon';
import { Spacing } from '@/constants/theme';
import { frameOf } from '@/lib/local-leaders';
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
}

export interface DistrictMapProps {
  /** The res-7 arena. Drawn as an outline so the contest has a visible edge
   *  — without it the fills float on an unbounded map and "share of this
   *  district" has no referent on screen. */
  district: string;
  holdings: DistrictHolding[];
  /** Full-bleed, pannable mode (Local Leaders). Omitted: the fixed 220 px
   *  non-interactive card Municipio uses. */
  full?: DistrictMapFull;
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

/** The district's own boundary, as a GeoJSON ring. cellToBoundary's
 *  `formatAsGeoJson` flag gives [lng, lat] and closes the ring. */
function districtOutline(district: string): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {},
        geometry: { type: 'Polygon', coordinates: [cellToBoundary(district, true)] },
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
          properties: { color: holding.color, isMe: holding.isMe },
          geometry: { type: 'Polygon', coordinates: ring as never },
        }),
      );
    }),
  };
}

export function DistrictMap({ district, holdings, full }: DistrictMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapboxMap | null>(null);
  const readyRef = useRef(false);
  // The freshest props for the async load callback — the map builds once, but
  // holdings usually arrive after the dynamic import has started. Written
  // from an effect rather than during render, same as fence-map.web.tsx.
  const dataRef = useRef({ district, holdings, full });
  useEffect(() => {
    dataRef.current = { district, holdings, full };
  }, [district, holdings, full]);
  // Full mode frames the held ground, which usually lands after the map has
  // loaded on the district alone. Refit once when it does, never again —
  // after that the camera is the runner's.
  const framedHoldingsRef = useRef(false);

  const refit = useCallback((animate: boolean) => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    const { district: d, holdings: h, full: f } = dataRef.current;
    const b = frameOf(d, h, !!f);
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
      const frame = frameOf(initial.district, initial.holdings, !!initial.full);
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
        const { district: d, holdings: h } = dataRef.current;

        map.addSource(OUTLINE_SRC, { type: 'geojson', data: districtOutline(d) });
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
            'fill-opacity': ['case', ['get', 'isMe'], 0.55, 0.3],
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
            'line-opacity': 0.8,
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
      refit(false);
    }
  }, [holdings, full, refit]);

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
