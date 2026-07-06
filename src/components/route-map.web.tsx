// Race route/start map — web implementation.
// react-native-maps has no web support, so on web we render an interactive
// Mapbox GL JS map that mirrors the native preview: a start-line marker plus the
// route polyline when we have one, auto-fit to the course. Requires a public
// token in EXPO_PUBLIC_MAPBOX_TOKEN; without it the map cleanly no-ops and only
// the official course-map image (if any) is shown. mapbox-gl is only pulled into
// the web bundle — Metro never loads this file on native.
import 'mapbox-gl/dist/mapbox-gl.css';

import { Image } from 'expo-image';
import mapboxgl from 'mapbox-gl';
import { useEffect, useRef } from 'react';
import { StyleSheet, Text, View, useColorScheme } from 'react-native';

import { Colors, Spacing } from '@/constants/theme';
import { useI18n } from '@/lib/i18n';
import type { Race } from '@/lib/races';

const TOKEN = process.env.EXPO_PUBLIC_MAPBOX_TOKEN;
const ROUTE_COLOR = '#E4572E'; // matches native ROUTE_COLOR
const MARKER_ZOOM = 14; // used when there's only a start point (no route to fit)

if (TOKEN) mapboxgl.accessToken = TOKEN;

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

    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: scheme === 'dark' ? 'mapbox://styles/mapbox/dark-v11' : 'mapbox://styles/mapbox/streets-v12',
      center: [start.lng, start.lat],
      zoom: MARKER_ZOOM,
      cooperativeGestures: true, // ctrl/⌘+scroll to zoom, so it never hijacks page scroll
    });
    map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'top-right');

    new mapboxgl.Marker({ color: ROUTE_COLOR }).setLngLat([start.lng, start.lat]).addTo(map);

    map.on('load', () => {
      if (!route) return;
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

    return () => map.remove();
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
