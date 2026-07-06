// Race route/start map — NATIVE. Uses the same Mapbox static image as web
// (route-map.web.tsx) instead of react-native-maps, which needs a Google Maps
// API key on Android and renders grey tiles without one. Tapping the map opens
// the device's Maps app. Falls back to just the course-map image if no token.
import { Image } from 'expo-image';
import { Linking, Platform, Pressable, StyleSheet, Text, View, useColorScheme } from 'react-native';

import { Colors, Spacing } from '@/constants/theme';
import { useI18n } from '@/lib/i18n';
import { buildStaticMapUrl } from '@/lib/mapbox';
import type { Race } from '@/lib/races';

function openInMaps(lat: number, lng: number, label: string) {
  const url = Platform.select({
    ios: `maps:0,0?q=${encodeURIComponent(label)}@${lat},${lng}`,
    default: `geo:${lat},${lng}?q=${lat},${lng}(${encodeURIComponent(label)})`,
  });
  Linking.openURL(url as string);
}

export function RouteMap({ race }: { race: Race }) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = Colors[scheme];
  const { t } = useI18n();

  const start = race.start ?? null;
  const courseMapUrl = race.courseMapUrl ?? null;
  const mapUrl = buildStaticMapUrl(race, scheme === 'dark');
  if (!start && !courseMapUrl) return null;

  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: c.textSecondary }]}>
        {t('common.route').toUpperCase()}
      </Text>

      {mapUrl && start && (
        <Pressable
          style={styles.mapWrap}
          accessibilityLabel={t('detail.openMaps')}
          onPress={() => openInMaps(start.lat, start.lng, race.name)}>
          <Image source={{ uri: mapUrl }} style={styles.map} contentFit="cover" />
        </Pressable>
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
  mapWrap: { borderRadius: Spacing.two, overflow: 'hidden', height: 200 },
  map: { width: '100%', height: '100%' },
  hint: { fontSize: 12 },
  courseImg: { width: '100%', height: 220, borderRadius: Spacing.two, marginTop: Spacing.one },
});
