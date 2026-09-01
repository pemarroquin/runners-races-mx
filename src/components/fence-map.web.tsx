// The end-of-session territory map — WEB. Mapbox GL JS, same split rationale
// as track-map.web.tsx (the custom Studio style only renders in GL). Fully
// interactive; every captured fence is drawn (muted, each in its run's own
// colour), the run just finished gets a stronger fill + a gradient outline,
// and the camera fits to it with an animated sweep.
//
// The new fence's fill fades in via a paint transition — GL interpolates
// fill-opacity on the GPU, same trick as the wall rise on the live map.
//
// Every custom layer sets a `slot` and `*-emissive-strength` — see
// track-map.web.tsx's header and constants/map.ts. The outline
// (NEW_LINE_SRC) also gets a fallback `line-color` and now stages its real
// data through setData() after an empty addSource(), same as the live
// route — it was rendering pure black (Mapbox's default line-color) despite
// line-gradient being set and lineMetrics being true (P3 §7c).
import type { GeoJSONSource, Map as MapboxMap } from 'mapbox-gl';
import mapboxGlPkg from 'mapbox-gl/package.json';
import { useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import type { Feature, MultiPolygon, Polygon as GeoPolygon } from 'geojson';

import {
  EMISSIVE_STRENGTH_FULL,
  fenceColorForRun,
  MAP_SLOT_FILL,
  MAP_SLOT_ROUTE,
  MAP_STYLE_GL,
  ROUTE_GRADIENT,
  ROUTE_LINE_WIDTH,
} from '@/constants/map';
import { outerRings } from '@/lib/territory';
import type { MyFence } from '@/lib/territory-sync';

const TOKEN = process.env.EXPO_PUBLIC_MAPBOX_TOKEN;
const MAPBOX_CSS_URL = `https://api.mapbox.com/mapbox-gl-js/v${mapboxGlPkg.version}/mapbox-gl.css`;
const NEW_SRC = 'fence-new';
const NEW_LINE_SRC = 'fence-new-line';
const PAST_SRC = 'fence-past';
const FIT_MS = 1600;

interface FenceMapProps {
  geometry: GeoPolygon | MultiPolygon;
  color: string;
  others: MyFence[];
  excludeId?: string | null;
}

function ensureMapboxCss() {
  if (document.getElementById('mapbox-gl-css')) return;
  const link = document.createElement('link');
  link.id = 'mapbox-gl-css';
  link.rel = 'stylesheet';
  link.href = MAPBOX_CSS_URL;
  document.head.appendChild(link);
}

function boundsOf(geometry: GeoPolygon | MultiPolygon): [[number, number], [number, number]] {
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  for (const ring of outerRings(geometry)) {
    for (const [lng, lat] of ring) {
      minLng = Math.min(minLng, lng);
      minLat = Math.min(minLat, lat);
      maxLng = Math.max(maxLng, lng);
      maxLat = Math.max(maxLat, lat);
    }
  }
  return [
    [minLng, minLat],
    [maxLng, maxLat],
  ];
}

export function FenceMap({ geometry, color, others, excludeId }: FenceMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapboxMap | null>(null);
  const readyRef = useRef(false);
  // The freshest props, for the load callback — the map builds once, but
  // fences/colour may have arrived after mount kicked off the async import.
  // Written from an effect, not during render (react-hooks/refs).
  const dataRef = useRef({ geometry, color, others, excludeId });
  useEffect(() => {
    dataRef.current = { geometry, color, others, excludeId };
  }, [geometry, color, others, excludeId]);

  useEffect(() => {
    if (!TOKEN || !containerRef.current) return;
    let cancelled = false;

    (async () => {
      ensureMapboxCss();
      const { default: mapboxgl } = await import('mapbox-gl');
      if (cancelled || !containerRef.current) return;

      mapboxgl.accessToken = TOKEN;
      const { geometry: geom } = dataRef.current;
      const map = new mapboxgl.Map({
        container: containerRef.current,
        style: MAP_STYLE_GL,
        bounds: boundsOf(geom),
        fitBoundsOptions: { padding: 80 },
        attributionControl: false,
      });
      mapRef.current = map;

      map.on('load', () => {
        if (cancelled) return;
        const { geometry: g, color: c, others: past, excludeId: skip } = dataRef.current;

        map.addSource(PAST_SRC, {
          type: 'geojson',
          data: {
            type: 'FeatureCollection',
            features: past
              .filter((f) => f.id !== skip && f.geometry !== null)
              .map(
                (f): Feature => ({
                  type: 'Feature',
                  properties: { color: fenceColorForRun(f.startedAtMs).color },
                  geometry: f.geometry!,
                }),
              ),
          },
        });
        map.addLayer({
          id: PAST_SRC,
          type: 'fill',
          source: PAST_SRC,
          slot: MAP_SLOT_FILL,
          paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.16, 'fill-emissive-strength': EMISSIVE_STRENGTH_FULL },
        });
        map.addLayer({
          id: `${PAST_SRC}-line`,
          type: 'line',
          source: PAST_SRC,
          slot: MAP_SLOT_ROUTE,
          paint: {
            'line-color': ['get', 'color'],
            'line-opacity': 0.5,
            'line-width': 1,
            'line-emissive-strength': EMISSIVE_STRENGTH_FULL,
          },
        });

        map.addSource(NEW_SRC, {
          type: 'geojson',
          data: { type: 'Feature', properties: {}, geometry: g },
        });
        map.addLayer({
          id: NEW_SRC,
          type: 'fill',
          source: NEW_SRC,
          slot: MAP_SLOT_FILL,
          paint: {
            'fill-color': c,
            'fill-opacity': 0,
            'fill-opacity-transition': { duration: 900, delay: 200 },
            'fill-emissive-strength': EMISSIVE_STRENGTH_FULL,
          },
        });
        // Kicked on the next frame so the transition actually runs — setting
        // the final value in the same frame the layer is added paints it
        // instantly instead.
        requestAnimationFrame(() => {
          if (!cancelled) map.setPaintProperty(NEW_SRC, 'fill-opacity', 0.3);
        });

        // Gradient outline: line-gradient needs lineMetrics, which only
        // applies to LineStrings — so the outline is its own source built
        // from the outer ring(s), not the polygon reused.
        //
        // Created EMPTY, then setData()'d on the next frame — mirroring
        // track-map.web.tsx's live route (the ONE call site where
        // line-gradient is confirmed working on device) rather than baking
        // the real FeatureCollection straight into addSource() as this used
        // to. The two call sites otherwise looked identical (same
        // lineMetrics:true, same flattened interpolate expression), so
        // whatever GL JS needs internally to compute line-progress
        // correctly, going through setData() is the one thing proven to
        // trigger it.
        map.addSource(NEW_LINE_SRC, {
          type: 'geojson',
          lineMetrics: true,
          data: { type: 'FeatureCollection', features: [] },
        });
        map.addLayer({
          id: NEW_LINE_SRC,
          type: 'line',
          source: NEW_LINE_SRC,
          slot: MAP_SLOT_ROUTE,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-width': ROUTE_LINE_WIDTH - 1,
            // Fallback for if line-gradient is ever rejected. Mapbox's
            // default line-color is #000000 — that default, rendering
            // silently instead of the gradient, is exactly what this whole
            // layer's outline used to look like (P3 §7c). An explicit
            // fallback means a rejected gradient is a visibly WRONG colour
            // rather than one that looks like a deliberate black outline.
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
        requestAnimationFrame(() => {
          if (cancelled) return;
          const lineSource = map.getSource(NEW_LINE_SRC) as GeoJSONSource | undefined;
          lineSource?.setData({
            type: 'FeatureCollection',
            features: outerRings(g).map(
              (ring): Feature => ({
                type: 'Feature',
                properties: {},
                geometry: { type: 'LineString', coordinates: ring },
              }),
            ),
          });
        });

        // The entrance sweep: constructed at the fitted bounds, then eased
        // out and back in. Cheaper to read than it sounds — one fitBounds
        // from a slightly wider camera.
        map.fitBounds(boundsOf(g), { padding: 80, duration: FIT_MS });
        readyRef.current = true;
      });
    })();

    return () => {
      cancelled = true;
      readyRef.current = false;
      mapRef.current?.remove();
      mapRef.current = null;
    };
    // Built once; data updates go through the sources below.
  }, []);

  // Past fences can finish loading after the map does.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    const src = map.getSource(PAST_SRC) as GeoJSONSource | undefined;
    src?.setData({
      type: 'FeatureCollection',
      features: others
        .filter((f) => f.id !== excludeId && f.geometry !== null)
        .map(
          (f): Feature => ({
            type: 'Feature',
            properties: { color: fenceColorForRun(f.startedAtMs).color },
            geometry: f.geometry!,
          }),
        ),
    });
  }, [others, excludeId]);

  if (!TOKEN) return null;

  return (
    <View style={[styles.wrap, StyleSheet.absoluteFill]}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { overflow: 'hidden' },
});
