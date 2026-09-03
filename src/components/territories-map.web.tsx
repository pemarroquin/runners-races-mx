// The Territories tab's map — WEB. Every saved territory at once, fit to
// bounds around all of them (Pedro's call, 2026-09-02: "a single map view",
// however far the spread — no per-city scoping). Replaces myraces.tsx's old
// FlatList of fence-card rows.
//
// Two visual states, matching Pedro's explicit spec:
//   SAVED — full treatment, same as the just-finished-run map (fence-map.
//   web.tsx): this run's own colour (fenceColorForRun), a vertical
//   fill-extrusion wall with opacity (matching the live Track map's fence
//   wall — see constants/map.ts's FENCE_WALL_HEIGHT_M/OPACITY), and the
//   vibrant per-vertex route gradient.
//   PENDING (queued, not yet uploaded — see upload-queue.ts) — flat, no
//   extrusion, a single desaturated grey, dashed outline, no gradient. Reads
//   at a glance as "not confirmed yet" without inventing new iconography.
//   Promotes to SAVED automatically the moment its upload succeeds (the
//   caller just stops passing it in `queued` and starts passing it in
//   `fences` — this component has no idea a promotion happened, it just
//   re-renders from new props).
//
// Tapping either kind's fill fires onSelect(id, kind) — the caller (myraces.
// tsx) owns the detail bubble/card, this component only owns the map.
//
// SCALING CAVEAT, deliberate simplification: each fence gets its OWN
// Mapbox source + 2-3 layers (mirroring fence-map.web.tsx's per-feature
// gradient-route technique, looped) rather than one shared source for all
// of them — Mapbox's line-gradient needs per-feature `line-progress` via
// lineMetrics, which does not compose cleanly across a FeatureCollection of
// many LineStrings sharing one source. Fine for the tens of territories a
// runner accumulates early on; would need revisiting if that count grows
// into the hundreds (batch into a shared source, drop the per-run gradient
// in favour of a single flat colour per run).
import type { Map as MapboxMap, MapMouseEvent } from 'mapbox-gl';
import mapboxGlPkg from 'mapbox-gl/package.json';
import { useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import type { MultiPolygon, Polygon as GeoPolygon } from 'geojson';

import {
  EMISSIVE_STRENGTH_FULL,
  FENCE_WALL_HEIGHT_M,
  FENCE_WALL_OPACITY,
  fenceColorForRun,
  MAP_SLOT_FILL,
  MAP_SLOT_ROUTE,
  MAP_STYLE_GL,
  ROUTE_GRADIENT,
  ROUTE_LINE_WIDTH,
} from '@/constants/map';
import { outerRings, type LatLng } from '@/lib/territory';

const TOKEN = process.env.EXPO_PUBLIC_MAPBOX_TOKEN;
const MAPBOX_CSS_URL = `https://api.mapbox.com/mapbox-gl-js/v${mapboxGlPkg.version}/mapbox-gl.css`;
const PENDING_COLOR = '#8E8E93'; // neutral grey — deliberately NOT one of FENCE_COLOR_SETS, so a pending item never reads as a confusing 7th run colour.
const PENDING_FILL_OPACITY = 0.14;
const PENDING_LINE_OPACITY = 0.7;

export interface TerritoryFeature {
  id: string;
  kind: 'saved' | 'pending';
  geometry: GeoPolygon | MultiPolygon;
  route: LatLng[] | null;
  /** Only used for SAVED (fenceColorForRun) — ignored for pending, which is
   *  always PENDING_COLOR regardless of startedAtMs. */
  startedAtMs: number;
}

interface TerritoriesMapProps {
  features: TerritoryFeature[];
  onSelect: (id: string, kind: 'saved' | 'pending') => void;
}

function ensureMapboxCss() {
  if (document.getElementById('mapbox-gl-css')) return;
  const link = document.createElement('link');
  link.id = 'mapbox-gl-css';
  link.rel = 'stylesheet';
  link.href = MAPBOX_CSS_URL;
  document.head.appendChild(link);
}

function boundsOfAll(features: TerritoryFeature[]): [[number, number], [number, number]] | null {
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  let any = false;
  for (const f of features) {
    for (const ring of outerRings(f.geometry)) {
      for (const [lng, lat] of ring) {
        any = true;
        minLng = Math.min(minLng, lng);
        minLat = Math.min(minLat, lat);
        maxLng = Math.max(maxLng, lng);
        maxLat = Math.max(maxLat, lat);
      }
    }
  }
  if (!any) return null;
  return [
    [minLng, minLat],
    [maxLng, maxLat],
  ];
}

export function TerritoriesMap({ features, onSelect }: TerritoriesMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapboxMap | null>(null);
  const readyRef = useRef(false);
  // The freshest onSelect, so click handlers registered once at layer-add
  // time never close over a stale callback — same reasoning as fence-map.
  // web.tsx's dataRef, narrower because only the callback identity can go
  // stale here (feature data flows through setData() below, not closures).
  const onSelectRef = useRef(onSelect);
  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);
  // Which fence/pending ids currently have layers on the map — so the data
  // effect (below) can add layers for NEW ids and remove layers for ids
  // that dropped out (a delete, or a promotion from pending to saved swaps
  // one id's kind, which this treats as remove-then-add since the layer
  // IDs are kind-scoped).
  const mountedIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!TOKEN || !containerRef.current) return;
    let cancelled = false;

    (async () => {
      ensureMapboxCss();
      const { default: mapboxgl } = await import('mapbox-gl');
      if (cancelled || !containerRef.current) return;

      mapboxgl.accessToken = TOKEN;
      const map = new mapboxgl.Map({
        container: containerRef.current,
        style: MAP_STYLE_GL,
        center: [-100.3, 25.67], // Monterrey-ish fallback; refit() below corrects it the instant data loads.
        zoom: 10,
        pitch: 0,
        bearing: 0,
        attributionControl: false,
      });
      mapRef.current = map;
      map.on('load', () => {
        if (!cancelled) readyRef.current = true;
      });
    })();

    return () => {
      cancelled = true;
      readyRef.current = false;
      mapRef.current?.remove();
      mapRef.current = null;
      mountedIdsRef.current = new Set();
    };
    // Built once. All data flows through the sync effect below.
  }, []);

  // Adds/removes/updates per-feature sources+layers to match `features`,
  // then refits. Runs once the map is ready AND whenever the feature list
  // changes (a fetch completing, a delete, a retry succeeding).
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const sync = () => {
      if (!readyRef.current) return;
      const nextIds = new Set(features.map((f) => `${f.kind}:${f.id}`));

      // Remove layers/sources for anything no longer present.
      for (const key of mountedIdsRef.current) {
        if (nextIds.has(key)) continue;
        removeFeatureLayers(map, key);
        mountedIdsRef.current.delete(key);
      }

      // Add layers/sources for anything new. Existing ones are left alone —
      // this component doesn't support editing a feature in place, only
      // add/remove, which matches every real change (a fetch/refetch always
      // hands back a fresh list; nothing mutates a fence's own geometry).
      for (const f of features) {
        const key = `${f.kind}:${f.id}`;
        if (mountedIdsRef.current.has(key)) continue;
        addFeatureLayers(map, f, key, (id, kind) => onSelectRef.current(id, kind));
        mountedIdsRef.current.add(key);
      }

      const bounds = boundsOfAll(features);
      if (bounds) map.fitBounds(bounds, { padding: 64, duration: 900 });
    };

    if (readyRef.current) sync();
    else map.once('load', sync);
  }, [features]);

  if (!TOKEN) return null;

  return (
    <View style={[styles.wrap, StyleSheet.absoluteFill]}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
    </View>
  );
}

function addFeatureLayers(
  map: MapboxMap,
  f: TerritoryFeature,
  key: string,
  onSelect: (id: string, kind: 'saved' | 'pending') => void,
) {
  const fillSrc = `terr-fill-${key}`;
  const routeSrc = `terr-route-${key}`;
  const color = f.kind === 'saved' ? fenceColorForRun(f.startedAtMs).color : PENDING_COLOR;

  map.addSource(fillSrc, {
    type: 'geojson',
    data: { type: 'Feature', properties: { id: f.id, kind: f.kind }, geometry: f.geometry },
  });

  if (f.kind === 'saved') {
    // Vertical wall with opacity — matches the live Track map's fence
    // (track-map.web.tsx's WALL_SRC) and the just-finished-run map (fence-
    // map.web.tsx), per Pedro's explicit ask: a saved territory should look
    // "exactly the same as when it shows when run session is recorded".
    map.addLayer({
      id: `${fillSrc}-extrusion`,
      type: 'fill-extrusion',
      source: fillSrc,
      slot: MAP_SLOT_FILL,
      paint: {
        'fill-extrusion-color': color,
        'fill-extrusion-height': FENCE_WALL_HEIGHT_M,
        'fill-extrusion-opacity': FENCE_WALL_OPACITY,
        'fill-extrusion-emissive-strength': EMISSIVE_STRENGTH_FULL,
      },
    });
  } else {
    // Pending: flat, low-opacity fill + dashed outline. No extrusion, no
    // per-run colour — deliberately reads as "not confirmed" rather than as
    // a 7th entry in the fence-colour rotation.
    map.addLayer({
      id: `${fillSrc}-fill`,
      type: 'fill',
      source: fillSrc,
      slot: MAP_SLOT_FILL,
      paint: { 'fill-color': color, 'fill-opacity': PENDING_FILL_OPACITY },
    });
    map.addLayer({
      id: `${fillSrc}-dash`,
      type: 'line',
      source: fillSrc,
      slot: MAP_SLOT_ROUTE,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': color,
        'line-opacity': PENDING_LINE_OPACITY,
        'line-width': 2,
        'line-dasharray': [2, 2],
      },
    });
  }

  map.on('click', `${fillSrc}-${f.kind === 'saved' ? 'extrusion' : 'fill'}`, (e: MapMouseEvent) => {
    const feature = e.features?.[0];
    const id = feature?.properties?.id as string | undefined;
    const kind = feature?.properties?.kind as 'saved' | 'pending' | undefined;
    if (id && kind) onSelect(id, kind);
  });

  // The route — saved gets the full vibrant gradient (fence-map.web.tsx's
  // technique, one feature per source so line-progress is well-defined);
  // pending gets nothing extra beyond the dashed outline above, since a
  // route that hasn't even finished uploading reads as more confirmed than
  // it should if it were drawn with the same vibrant treatment as a real one.
  if (f.kind === 'saved' && f.route && f.route.length >= 2) {
    map.addSource(routeSrc, {
      type: 'geojson',
      lineMetrics: true,
      data: {
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: f.route.map(({ lng, lat }) => [lng, lat]) },
      },
    });
    map.addLayer({
      id: routeSrc,
      type: 'line',
      source: routeSrc,
      slot: MAP_SLOT_ROUTE,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-width': ROUTE_LINE_WIDTH,
        'line-color': ROUTE_GRADIENT[0][1],
        'line-gradient': [
          'interpolate',
          ['linear'],
          ['line-progress'],
          ...ROUTE_GRADIENT.flat(),
        ] as unknown as string,
        'line-emissive-strength': EMISSIVE_STRENGTH_FULL,
      },
    });
  }
}

function removeFeatureLayers(map: MapboxMap, key: string) {
  const fillSrc = `terr-fill-${key}`;
  const routeSrc = `terr-route-${key}`;
  for (const id of [`${fillSrc}-extrusion`, `${fillSrc}-fill`, `${fillSrc}-dash`, routeSrc]) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  for (const src of [fillSrc, routeSrc]) {
    if (map.getSource(src)) map.removeSource(src);
  }
}

const styles = StyleSheet.create({
  wrap: { overflow: 'hidden' },
});
