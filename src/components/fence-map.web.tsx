// The end-of-session territory map — WEB. Mapbox GL JS, same split rationale
// as track-map.web.tsx (the custom Studio style only renders in GL). Fully
// interactive; every captured fence is drawn (muted, each in its run's own
// colour), the run just finished gets a stronger fill, the ACTUAL RECORDED
// PATH is drawn as the vibrant gradient line, and the camera fits to it with
// an animated sweep.
//
// The route line used to be the fence POLYGON's boundary (outerRings(g)),
// not the path — structurally wrong two ways, both visible on a real out-
// and-back run (Web-First Pilot follow-up, reported by Pedro): a thin sliver
// polygon's boundary is two roughly-parallel strands that read as two
// unrelated routes, and buildFence's unkink/union step can return a
// MultiPolygon for any self-crossing run, which outerRings then emits as one
// LineString PER LOBE — literally disconnected segments. The route is now
// its OWN source/layer, drawn from the masked path (never the raw one — see
// index.tsx), and the polygon's boundary is demoted to a thin, low-opacity
// line that still communicates the claimed shape without competing with the
// route for "this is where I ran".
//
// The new fence's fill fades in via a paint transition — GL interpolates
// fill-opacity on the GPU, same trick as the wall rise on the live map.
//
// Every custom layer sets a `slot` and `*-emissive-strength` — see
// track-map.web.tsx's header and constants/map.ts. The gradient layers also
// get a fallback `line-color` and stage their real data through setData()
// after an empty addSource(), same as the live route — it was rendering pure
// black (Mapbox's default line-color) despite line-gradient being set and
// lineMetrics being true (P3 §7c).
import type { GeoJSONSource, Map as MapboxMap } from 'mapbox-gl';
import mapboxGlPkg from 'mapbox-gl/package.json';
import type { AndroidSymbol, SFSymbol } from 'expo-symbols';
import { useCallback, useEffect, useRef } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import type { Feature, MultiPolygon, Polygon as GeoPolygon } from 'geojson';

import { Icon } from '@/components/ui/icon';
import {
  EMISSIVE_STRENGTH_FULL,
  fenceColorForRun,
  MAP_SLOT_FILL,
  MAP_SLOT_ROUTE,
  MAP_STYLE_GL,
  ROUTE_GLOW_BLUR,
  ROUTE_GLOW_OPACITY,
  ROUTE_GLOW_WIDTH,
  ROUTE_GRADIENT,
  ROUTE_LINE_COLOR,
  ROUTE_LINE_WIDTH,
  ZOOM_STEP,
} from '@/constants/map';
import { outerRings, type LatLng } from '@/lib/territory';
import type { MyFence } from '@/lib/territory-sync';

const TOKEN = process.env.EXPO_PUBLIC_MAPBOX_TOKEN;
const MAPBOX_CSS_URL = `https://api.mapbox.com/mapbox-gl-js/v${mapboxGlPkg.version}/mapbox-gl.css`;
const NEW_SRC = 'fence-new';
const NEW_OUTLINE_SRC = 'fence-new-outline';
const NEW_ROUTE_SRC = 'fence-new-route';
const PAST_SRC = 'fence-past';
const FIT_MS = 1600;
// The fence boundary's subordinate weight, now that the route carries the
// gradient — thin and translucent so it reads as "this is the claimed
// shape" without ever being mistaken for the route.
const OUTLINE_WIDTH = 1.5;
const OUTLINE_OPACITY = 0.55;

interface FenceMapProps {
  geometry: GeoPolygon | MultiPolygon;
  /** The recorded route, MASKED (privacy-zone.ts) — never the raw path. This
   *  is a shareable surface; the whole reason privacy-zone trimming exists
   *  is so start/end aren't exposed here. */
  path: LatLng[];
  color: string;
  others: MyFence[];
  excludeId?: string | null;
  /** Zoom +/- and re-fit controls, bottom-right — same visual language as
   *  the live Track map's camera controls (track-map.web.tsx's MapButton).
   *  Optional: the Territories map (a future caller showing every fence at
   *  once) may not want a single "recenter on THIS fence" button the same
   *  way the just-finished-run screen does. */
  controls?: { zoomInLabel: string; zoomOutLabel: string; recenterLabel: string };
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

export function FenceMap({ geometry, path, color, others, excludeId, controls }: FenceMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapboxMap | null>(null);
  const readyRef = useRef(false);
  // The freshest props, for the load callback — the map builds once, but
  // fences/colour may have arrived after mount kicked off the async import.
  // Written from an effect, not during render (react-hooks/refs).
  const dataRef = useRef({ geometry, path, color, others, excludeId });
  useEffect(() => {
    dataRef.current = { geometry, path, color, others, excludeId };
  }, [geometry, path, color, others, excludeId]);

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
        const { geometry: g, path: p, color: c, others: past, excludeId: skip } = dataRef.current;

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

        // The fence BOUNDARY — subordinate now that the route (below) carries
        // the gradient: thin, translucent, this run's flat fence colour. It
        // still communicates the claimed shape; it must never again be
        // mistaken for where the runner actually went. No line-gradient here
        // (no lineMetrics need either), so this can bake its real data
        // straight into addSource() — the setData()-after-empty-source dance
        // below is specifically for the gradient layers.
        map.addSource(NEW_OUTLINE_SRC, {
          type: 'geojson',
          data: {
            type: 'FeatureCollection',
            features: outerRings(g).map(
              (ring): Feature => ({
                type: 'Feature',
                properties: {},
                geometry: { type: 'LineString', coordinates: ring },
              }),
            ),
          },
        });
        map.addLayer({
          id: NEW_OUTLINE_SRC,
          type: 'line',
          source: NEW_OUTLINE_SRC,
          slot: MAP_SLOT_ROUTE,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-width': OUTLINE_WIDTH,
            'line-color': c,
            'line-opacity': OUTLINE_OPACITY,
            'line-emissive-strength': EMISSIVE_STRENGTH_FULL,
          },
        });

        // The ROUTE — the actual recorded (masked) path, not the fence
        // boundary. Same two-layer treatment as the live map's ROUTE_SRC
        // (track-map.web.tsx) so the two screens agree: a soft glow under a
        // sharp gradient line. Added AFTER the outline so it draws on top of
        // it within MAP_SLOT_ROUTE wherever the two overlap.
        map.addSource(NEW_ROUTE_SRC, {
          type: 'geojson',
          lineMetrics: true,
          data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [] } },
        });
        map.addLayer({
          id: `${NEW_ROUTE_SRC}-glow`,
          type: 'line',
          source: NEW_ROUTE_SRC,
          slot: MAP_SLOT_ROUTE,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color': ROUTE_LINE_COLOR,
            'line-width': ROUTE_GLOW_WIDTH,
            'line-blur': ROUTE_GLOW_BLUR,
            'line-opacity': ROUTE_GLOW_OPACITY,
            'line-emissive-strength': EMISSIVE_STRENGTH_FULL,
          },
        });
        map.addLayer({
          id: NEW_ROUTE_SRC,
          type: 'line',
          source: NEW_ROUTE_SRC,
          slot: MAP_SLOT_ROUTE,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-width': ROUTE_LINE_WIDTH,
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
        // Created EMPTY above, then setData()'d on the next frame — mirroring
        // track-map.web.tsx's live route (the ONE call site where
        // line-gradient is confirmed working on device) rather than baking
        // the real Feature straight into addSource(). The two call sites
        // otherwise looked identical (same lineMetrics:true, same flattened
        // interpolate expression), so whatever GL JS needs internally to
        // compute line-progress correctly, going through setData() is the
        // one thing proven to trigger it.
        requestAnimationFrame(() => {
          if (cancelled) return;
          const routeSource = map.getSource(NEW_ROUTE_SRC) as GeoJSONSource | undefined;
          routeSource?.setData({
            type: 'Feature',
            properties: {},
            geometry: { type: 'LineString', coordinates: p.map(({ lng, lat }) => [lng, lat]) },
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

  // The "recenter" control's target — re-fit to the highlighted fence,
  // shorter/snappier than the mount effect's entrance sweep (that one is a
  // deliberate reveal; this is a correction after a manual pan/zoom, same
  // duration as track-map.web.tsx's own camera moves).
  const refit = useCallback(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    map.fitBounds(boundsOf(dataRef.current.geometry), { padding: 80, duration: 900 });
  }, []);

  const zoomBy = useCallback((delta: number) => {
    const map = mapRef.current;
    if (!map) return;
    map.easeTo({ zoom: map.getZoom() + delta, duration: 300 });
  }, []);

  if (!TOKEN) return null;

  return (
    <View style={[styles.wrap, StyleSheet.absoluteFill]}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
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

// Byte-identical to track-map.web.tsx's own MapButton (same circular dark
// chrome, same size) — deliberately duplicated rather than shared, matching
// this codebase's existing per-platform-file convention (track-map.tsx has
// its own copy too) rather than introducing a new shared import for one
// small component.
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
  wrap: { overflow: 'hidden' },
  mapControls: {
    position: 'absolute',
    right: 16,
    bottom: 16,
    alignItems: 'center',
    gap: 10,
  },
  mapButton: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(20,20,20,0.65)',
    boxShadow: '0px 3px 8px rgba(0,0,0,0.3)',
  },
});
