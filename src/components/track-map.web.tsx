// Track tab map — WEB. A real Mapbox GL JS map, not the static image the
// native file uses.
//
// This split exists because of a hard API limit, not preference: the Static
// Images API cannot render Mapbox Standard styles (the `imports`-based kind
// Studio creates by default) — it returns a blank image, no error. GL JS
// renders them fine, so the custom Studio style can only be used here. See
// constants/map.ts.
//
// GL JS also buys what a baked PNG structurally cannot: a gradient route
// line, an extruded 3D fence, and a camera that moves. The route renders in
// two pieces while running — see fence-3d.ts for the split.
//
// mapbox-gl is loaded by dynamic import and its CSS by a runtime <link>, both
// copied from route-map.web.tsx — see that file's header for why the CSS
// cannot be a JS import (Metro hoists every CSS module into one global,
// render-blocking stylesheet regardless of the import being dynamic).
import type { GeoJSONSource, Map as MapboxMap, Marker } from 'mapbox-gl';
import mapboxGlPkg from 'mapbox-gl/package.json';
import { useEffect, useRef } from 'react';
import { StyleSheet, Text, View, type ColorValue } from 'react-native';

import {
  FENCE_LAG_M,
  FENCE_RISE_MS,
  FENCE_WALL_COLOR,
  FENCE_WALL_HEIGHT_M,
  FENCE_WALL_OPACITY,
  FENCE_WALL_WIDTH_M,
  MAP_DEFAULT_ZOOM,
  MAP_STYLE_GL,
  ROUTE_GLOW_BLUR,
  ROUTE_GLOW_OPACITY,
  ROUTE_GLOW_WIDTH,
  ROUTE_GRADIENT,
  ROUTE_LINE_COLOR,
  ROUTE_LINE_WIDTH,
  SESSION_FLY_MS,
  SESSION_PITCH,
  SESSION_ZOOM,
} from '@/constants/map';
import { buildWallPolygon, splitTrailing } from '@/lib/fence-3d';
import { useRegion } from '@/lib/region-context';
import type { LatLng } from '@/lib/territory';

const TOKEN = process.env.EXPO_PUBLIC_MAPBOX_TOKEN;
const MAPBOX_CSS_URL = `https://api.mapbox.com/mapbox-gl-js/v${mapboxGlPkg.version}/mapbox-gl.css`;
const ROUTE_SRC = 'run-route';
const WALL_SRC = 'run-wall';
const PULSE_STYLE_ID = 'track-pulse-style';

interface TrackMapProps {
  points: LatLng[];
  running: boolean;
  /** A real fix, or null. Never a fallback — see use-current-location.ts. */
  here: LatLng | null;
  /** True once a session is live: drives the fly-in and the 3D framing. */
  active: boolean;
  /** This run's fence colour ('#rrggbb') — see FENCE_COLOR_SETS. */
  fenceColor: string;
  dark: boolean;
  color: ColorValue;
  placeholder: string;
  placeholderColor: ColorValue;
  unavailable: string;
}

function ensureMapboxCss() {
  if (document.getElementById('mapbox-gl-css')) return;
  const link = document.createElement('link');
  link.id = 'mapbox-gl-css';
  link.rel = 'stylesheet';
  link.href = MAPBOX_CSS_URL;
  document.head.appendChild(link);
}

// The "you are here" pulse. A keyframed DOM element rather than a GL layer:
// GL has no repeating animation primitive, so driving one would mean a
// requestAnimationFrame loop repainting the map every frame for the whole
// run — this costs nothing and the compositor handles it.
function ensurePulseStyle() {
  if (document.getElementById(PULSE_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = PULSE_STYLE_ID;
  style.textContent = `
@keyframes track-pulse {
  0%   { transform: scale(1);   opacity: 0.55; }
  70%  { transform: scale(3.2); opacity: 0;    }
  100% { transform: scale(3.2); opacity: 0;    }
}
.track-dot { position: relative; width: 16px; height: 16px; }
.track-dot__core {
  position: absolute; inset: 0; border-radius: 50%;
  background: ${ROUTE_LINE_COLOR};
  border: 2.5px solid #fff;
  box-shadow: 0 1px 6px rgba(0,0,0,0.45);
}
.track-dot__halo {
  position: absolute; inset: 0; border-radius: 50%;
  background: ${ROUTE_LINE_COLOR};
  animation: track-pulse 2s ease-out infinite;
}
@media (prefers-reduced-motion: reduce) {
  .track-dot__halo { animation: none; opacity: 0; }
}`;
  document.head.appendChild(style);
}

export function TrackMap({
  points,
  running,
  here,
  active,
  fenceColor,
  placeholder,
  placeholderColor,
  unavailable,
}: TrackMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapboxMap | null>(null);
  const markerRef = useRef<Marker | null>(null);
  const readyRef = useRef(false);
  const flownRef = useRef(false);
  const { region } = useRegion();

  // Only ever a fallback for the *initial* camera, and only while no real fix
  // exists. The marker is a separate decision below — it is never placed on a
  // city centre, because a pin is a claim about where you are.
  const initialLat = here?.lat ?? region.lat;
  const initialLng = here?.lng ?? region.lng;

  // Built once. Re-creating the map when points change would tear down and
  // re-instantiate a WebGL context on every GPS fix.
  useEffect(() => {
    if (!TOKEN || !containerRef.current) return;
    let cancelled = false;

    (async () => {
      ensureMapboxCss();
      ensurePulseStyle();
      const { default: mapboxgl } = await import('mapbox-gl');
      if (cancelled || !containerRef.current) return;

      mapboxgl.accessToken = TOKEN;
      const map = new mapboxgl.Map({
        container: containerRef.current,
        style: MAP_STYLE_GL,
        center: [initialLng, initialLat],
        zoom: MAP_DEFAULT_ZOOM,
        attributionControl: false,
      });
      mapRef.current = map;

      map.on('load', () => {
        if (cancelled) return;

        // lineMetrics is REQUIRED for line-gradient. Without it the paint
        // property is ignored silently and the line renders flat — which
        // looks like a styling mistake rather than a missing source option.
        map.addSource(ROUTE_SRC, {
          type: 'geojson',
          lineMetrics: true,
          data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [] } },
        });
        map.addSource(WALL_SRC, {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        });

        map.addLayer({
          id: `${ROUTE_SRC}-glow`,
          type: 'line',
          source: ROUTE_SRC,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color': ROUTE_LINE_COLOR,
            'line-width': ROUTE_GLOW_WIDTH,
            'line-blur': ROUTE_GLOW_BLUR,
            'line-opacity': ROUTE_GLOW_OPACITY,
          },
        });
        map.addLayer({
          id: ROUTE_SRC,
          type: 'line',
          source: ROUTE_SRC,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-width': ROUTE_LINE_WIDTH,
            // Flattened [offset, color, ...] — the expression form
            // line-gradient requires.
            'line-gradient': [
              'interpolate',
              ['linear'],
              ['line-progress'],
              ...ROUTE_GRADIENT.flat(),
            ] as unknown as string,
          },
        });

        // The fence. Height is animated per-feature via a paint transition
        // rather than a rAF loop: GL interpolates fill-extrusion-height on
        // the GPU, so the rise costs nothing on the main thread.
        map.addLayer({
          id: WALL_SRC,
          type: 'fill-extrusion',
          source: WALL_SRC,
          paint: {
            'fill-extrusion-color': FENCE_WALL_COLOR,
            'fill-extrusion-opacity': FENCE_WALL_OPACITY,
            'fill-extrusion-height': FENCE_WALL_HEIGHT_M,
            'fill-extrusion-base': 0,
            'fill-extrusion-height-transition': { duration: FENCE_RISE_MS, delay: 0 },
          },
        });

        const el = document.createElement('div');
        el.className = 'track-dot';
        el.innerHTML = '<div class="track-dot__halo"></div><div class="track-dot__core"></div>';
        markerRef.current = new mapboxgl.Marker({ element: el });
        readyRef.current = true;
      });
    })();

    return () => {
      cancelled = true;
      readyRef.current = false;
      flownRef.current = false;
      markerRef.current?.remove();
      markerRef.current = null;
      mapRef.current?.remove();
      mapRef.current = null;
    };
    // Mount-only: later camera/marker changes move the existing map rather
    // than rebuilding it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Marker placement is deliberately gated on a REAL fix. Showing the pin at
  // the region fallback is what made it look like the location was wrong —
  // it was a city centre being presented as the runner's position.
  useEffect(() => {
    const map = mapRef.current;
    const marker = markerRef.current;
    if (!map || !readyRef.current || !marker) return;

    // `here` first: during a session it's the tracker's RAW fix stream, which
    // stays fresh even while fixes are rejected for accuracy — the accepted
    // point list is only the fallback for the moment before any raw fix.
    const head = here ?? (points.length > 0 ? points[points.length - 1] : null);
    if (!head) {
      marker.remove();
      return;
    }
    marker.setLngLat([head.lng, head.lat]).addTo(map);
  }, [points, here]);

  // Idle: keep the camera over the runner as they move, so the map isn't
  // still framing wherever they were when the tab opened. Skipped during a
  // session — the fly-in and follow below own the camera then.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current || active || !here) return;
    map.easeTo({ center: [here.lng, here.lat], duration: 600 });
  }, [here, active]);

  // Fly in when a session starts: tilt into 3D and close on the runner. Runs
  // once per session (flownRef), so a later GPS fix doesn't re-trigger it.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;

    if (!active) {
      flownRef.current = false;
      return;
    }
    if (flownRef.current) return;

    const target = points.length > 0 ? points[points.length - 1] : here;
    if (!target) return; // wait for a real position rather than flying to a city centre

    flownRef.current = true;
    map.flyTo({
      center: [target.lng, target.lat],
      zoom: SESSION_ZOOM,
      pitch: SESSION_PITCH,
      duration: SESSION_FLY_MS,
      essential: true,
    });
  }, [active, points, here]);

  // Per-run fence colour. The wall layer is created once at mount (before
  // any session exists) with the default FENCE_WALL_COLOR, so the run's own
  // colour is applied as a paint update — cheap, no layer churn.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    map.setPaintProperty(WALL_SRC, 'fill-extrusion-color', fenceColor);
  }, [fenceColor, active]);

  // Feed coordinates in. setData on an existing source is the cheap path —
  // no layer or style churn, so the line simply extends.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;

    const { settled, active: liveEdge } = splitTrailing(points, FENCE_LAG_M);

    const routeSource = map.getSource(ROUTE_SRC) as GeoJSONSource | undefined;
    routeSource?.setData({
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'LineString',
        coordinates: liveEdge.map((p) => [p.lng, p.lat] as [number, number]),
      },
    });

    const wall = buildWallPolygon(settled, FENCE_WALL_WIDTH_M);
    const wallSource = map.getSource(WALL_SRC) as GeoJSONSource | undefined;
    wallSource?.setData(
      wall ? { type: 'FeatureCollection', features: [wall] } : { type: 'FeatureCollection', features: [] },
    );

    // Follow only while recording: panning the camera under someone reading
    // their finished route would fight them. Follows the raw fix (`here`)
    // when there is one, for the same reason as the marker above.
    const head = here ?? points[points.length - 1];
    if (head && running && flownRef.current) {
      map.easeTo({ center: [head.lng, head.lat], duration: 900 });
    }
  }, [points, running, here]);

  if (!TOKEN) {
    return (
      <View style={[styles.wrap, StyleSheet.absoluteFill, styles.centre]}>
        <Text style={[styles.placeholderText, { color: placeholderColor }]}>{unavailable}</Text>
      </View>
    );
  }

  return (
    <View style={[styles.wrap, StyleSheet.absoluteFill]}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
      {points.length === 0 && running && (
        <View style={styles.waiting}>
          <Text style={[styles.placeholderText, { color: placeholderColor }]}>{placeholder}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { overflow: 'hidden' },
  centre: { alignItems: 'center', justifyContent: 'center', padding: 16 },
  waiting: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 24,
    alignItems: 'center',
    pointerEvents: 'none',
  },
  placeholderText: { fontSize: 14, textAlign: 'center' },
});
