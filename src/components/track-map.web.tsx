// Track tab map — WEB. A real Mapbox GL JS map, not the static image the
// native file uses.
//
// This split exists because of a hard API limit, not preference: the Static
// Images API cannot render Mapbox Standard styles (the `imports`-based kind
// Studio creates by default) — it returns a blank image, no error. GL JS
// renders them fine, so the custom Studio style can only be used here. See
// constants/map.ts.
//
// GL JS also buys the two things a baked PNG structurally cannot do: a route
// line whose colour/width/glow are ours to set, and animation. Coordinates
// are pushed into a GeoJSON source as they arrive, so the line grows in real
// time instead of being re-fetched every few seconds.
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
  MAP_DEFAULT_ZOOM,
  MAP_STYLE_GL,
  ROUTE_GLOW_BLUR,
  ROUTE_GLOW_OPACITY,
  ROUTE_GLOW_WIDTH,
  ROUTE_LINE_COLOR,
  ROUTE_LINE_WIDTH,
} from '@/constants/map';
import { useRegion } from '@/lib/region-context';
import type { LatLng } from '@/lib/territory';

const TOKEN = process.env.EXPO_PUBLIC_MAPBOX_TOKEN;
const MAPBOX_CSS_URL = `https://api.mapbox.com/mapbox-gl-js/v${mapboxGlPkg.version}/mapbox-gl.css`;
const SOURCE_ID = 'run-route';
const PULSE_STYLE_ID = 'track-pulse-style';

interface TrackMapProps {
  points: LatLng[];
  running: boolean;
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
/* Respect a reduced-motion preference — the dot stays, it just stops pulsing. */
@media (prefers-reduced-motion: reduce) {
  .track-dot__halo { animation: none; opacity: 0; }
}`;
  document.head.appendChild(style);
}

export function TrackMap({ points, running, placeholder, placeholderColor, unavailable }: TrackMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapboxMap | null>(null);
  const markerRef = useRef<Marker | null>(null);
  const readyRef = useRef(false);
  const { region } = useRegion();

  const first = points.length > 0 ? points[0] : null;
  const centreLat = first?.lat ?? region.lat;
  const centreLng = first?.lng ?? region.lng;

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
        center: [centreLng, centreLat],
        zoom: MAP_DEFAULT_ZOOM,
        attributionControl: false,
      });
      mapRef.current = map;

      map.on('load', () => {
        if (cancelled) return;
        map.addSource(SOURCE_ID, {
          type: 'geojson',
          data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [] } },
        });
        // Two layers, wide-blurred under narrow-solid: on a dark basemap a
        // single flat line reads as a sticker sitting on top of the map.
        map.addLayer({
          id: `${SOURCE_ID}-glow`,
          type: 'line',
          source: SOURCE_ID,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color': ROUTE_LINE_COLOR,
            'line-width': ROUTE_GLOW_WIDTH,
            'line-blur': ROUTE_GLOW_BLUR,
            'line-opacity': ROUTE_GLOW_OPACITY,
          },
        });
        map.addLayer({
          id: SOURCE_ID,
          type: 'line',
          source: SOURCE_ID,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': ROUTE_LINE_COLOR, 'line-width': ROUTE_LINE_WIDTH },
        });

        const el = document.createElement('div');
        el.className = 'track-dot';
        el.innerHTML = '<div class="track-dot__halo"></div><div class="track-dot__core"></div>';
        markerRef.current = new mapboxgl.Marker({ element: el })
          .setLngLat([centreLng, centreLat])
          .addTo(map);

        readyRef.current = true;
      });
    })();

    return () => {
      cancelled = true;
      readyRef.current = false;
      markerRef.current?.remove();
      markerRef.current = null;
      mapRef.current?.remove();
      mapRef.current = null;
    };
    // Mount-only: centre/zoom updates are handled by the effect below, which
    // moves the existing map instead of rebuilding it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Feed new coordinates in. setData on an existing source is the cheap path
  // — no layer or style churn, so the line simply extends.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;

    const coords = points.map((p) => [p.lng, p.lat] as [number, number]);
    const source = map.getSource(SOURCE_ID) as GeoJSONSource | undefined;
    source?.setData({
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: coords },
    });

    const head = coords[coords.length - 1];
    if (head) {
      markerRef.current?.setLngLat(head);
      // Follow only while recording: panning the camera under someone who is
      // reading their finished route would fight them.
      if (running) map.easeTo({ center: head, duration: 900 });
    }
  }, [points, running]);

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
        <View style={styles.waiting} pointerEvents="none">
          <Text style={[styles.placeholderText, { color: placeholderColor }]}>{placeholder}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { overflow: 'hidden' },
  centre: { alignItems: 'center', justifyContent: 'center', padding: 16 },
  waiting: { position: 'absolute', left: 0, right: 0, bottom: 24, alignItems: 'center' },
  placeholderText: { fontSize: 14, textAlign: 'center' },
});
