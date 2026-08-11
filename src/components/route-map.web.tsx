// Race route/start map — web implementation.
// react-native-maps has no web support, so on web we render an interactive
// Mapbox GL JS map that mirrors the native preview: a start-line marker plus the
// route polyline when we have one, auto-fit to the course. Requires a public
// token in EXPO_PUBLIC_MAPBOX_TOKEN; without it the map cleanly no-ops and only
// the official course-map image (if any) is shown. mapbox-gl is only pulled into
// the web bundle — Metro never loads this file on native.
//
// mapbox-gl JS is loaded via a dynamic import inside the effect below, not a
// static top-level import. Metro splits that into its own async chunk, so
// the ~1MB+ library only downloads when a race with a start point actually
// renders this component — every other route (feed, settings, races with no
// start coords) never pays for it. See PageSpeed diagnostic: mapbox-gl was
// previously ~140 references baked into the single ~4.6MB web entry bundle,
// flagged as unused JS on every non-map page load.
//
// mapbox-gl's CSS is handled separately, via ensureMapboxCss() below, NOT a
// JS import (dynamic or otherwise). Verified live against a PSI run
// (2026-08-11): `import('mapbox-gl/dist/mapbox-gl.css')` still showed up as
// a render-blocking stylesheet on the home feed, because Metro's web CSS
// handling extracts every CSS module it finds anywhere in the dependency
// graph into one shared output stylesheet, linked in <head> for every page
// — it doesn't respect the JS import being dynamic the way code-splitting
// does. A runtime <link> tag, added to the document only when this
// component actually mounts, is the one path that keeps the CSS out of that
// global bundle entirely.
import { Image } from 'expo-image';
import type { Map as MapboxMap } from 'mapbox-gl';
import mapboxGlPkg from 'mapbox-gl/package.json';
import { useEffect, useRef } from 'react';
import { StyleSheet, Text, View, useColorScheme } from 'react-native';

import { Colors, Spacing } from '@/constants/theme';
import { useI18n } from '@/lib/i18n';
import type { Race } from '@/lib/races';

const TOKEN = process.env.EXPO_PUBLIC_MAPBOX_TOKEN;
const ROUTE_COLOR = '#E4572E'; // matches native ROUTE_COLOR
const MARKER_ZOOM = 14; // used when there's only a start point (no route to fit)

// Version-pinned to the installed npm package (not hand-maintained) so a
// `mapbox-gl` bump can't silently drift the CDN CSS out of sync with the JS.
const MAPBOX_CSS_URL = `https://api.mapbox.com/mapbox-gl-js/v${mapboxGlPkg.version}/mapbox-gl.css`;

function ensureMapboxCss() {
  const id = 'mapbox-gl-css';
  if (document.getElementById(id)) return;
  const link = document.createElement('link');
  link.id = id;
  link.rel = 'stylesheet';
  link.href = MAPBOX_CSS_URL;
  document.head.appendChild(link);
}

export function RouteMap({ race }: { race: Race }) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = Colors[scheme];
  const { t } = useI18n();

  const containerRef = useRef<HTMLDivElement | null>(null);

  const start = race.start ?? null;
  const courseMapUrl = race.courseMapUrl ?? null;
  const route = race.routeCoords && race.routeCoords.length > 1 ? race.routeCoords : null;

  useEffect(() => {
    if (!TOKEN || !start || !containerRef.current) return;

    let cancelled = false;
    let map: MapboxMap | undefined;

    (async () => {
      ensureMapboxCss();
      const { default: mapboxgl } = await import('mapbox-gl');
      if (cancelled || !containerRef.current) return;

      mapboxgl.accessToken = TOKEN;

      map = new mapboxgl.Map({
        container: containerRef.current,
        style: scheme === 'dark' ? 'mapbox://styles/mapbox/dark-v11' : 'mapbox://styles/mapbox/streets-v12',
        center: [start.lng, start.lat],
        zoom: MARKER_ZOOM,
        cooperativeGestures: true, // ctrl/⌘+scroll to zoom, so it never hijacks page scroll
      });
      map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'top-right');

      new mapboxgl.Marker({ color: ROUTE_COLOR }).setLngLat([start.lng, start.lat]).addTo(map);

      map.on('load', () => {
        if (!route || !map) return;
        // GeoJSON is [lng, lat]; race.routeCoords is [lat, lng].
        const coords = route.map(([lat, lng]) => [lng, lat] as [number, number]);
        map.addSource('route', {
          type: 'geojson',
          data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } },
        });
        map.addLayer({
          id: 'route',
          type: 'line',
          source: 'route',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': ROUTE_COLOR, 'line-width': 4 },
        });
        const bounds = coords.reduce(
          (b, coord) => b.extend(coord),
          new mapboxgl.LngLatBounds(coords[0], coords[0]),
        );
        map.fitBounds(bounds, { padding: 40, duration: 0 });
      });
    })();

    return () => {
      cancelled = true;
      map?.remove();
    };
    // Re-init on race change or light/dark switch.
  }, [race.id, scheme, start, route]);

  if (!start && !courseMapUrl) return null;

  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: c.textSecondary }]}>
        {t('common.route').toUpperCase()}
      </Text>

      {TOKEN && start && (
        <View style={styles.mapWrap}>
          <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
        </View>
      )}

      {start?.approx && (
        <Text style={[styles.hint, { color: c.textSecondary }]}>{t('detail.approxLocation')}</Text>
      )}

      {courseMapUrl && (
        <Image
          source={{ uri: courseMapUrl }}
          style={styles.courseImg}
          contentFit="contain"
          accessibilityLabel={t('common.route')}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  field: { gap: Spacing.one, marginTop: Spacing.two },
  label: { fontSize: 12, fontWeight: '600', letterSpacing: 0.5 },
  mapWrap: { borderRadius: Spacing.two, overflow: 'hidden', height: 220 },
  hint: { fontSize: 12 },
  courseImg: { width: '100%', height: 220, borderRadius: Spacing.two, marginTop: Spacing.one },
});
