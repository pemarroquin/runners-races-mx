// Official course images under the race map, shared by route-map.tsx and
// route-map.web.tsx. Organizers publish one image per distance plus, often,
// an elevation chart — so each one gets a caption saying which it is, route
// maps first.
import { Image } from 'expo-image';
import { StyleSheet, Text, View } from 'react-native';

import { Spacing } from '@/constants/theme';
import { useI18n } from '@/lib/i18n';
import type { CourseMap } from '@/lib/races';

export function CourseMapImages({ maps, captionColor }: { maps: CourseMap[]; captionColor: string }) {
  const { t } = useI18n();
  if (maps.length === 0) return null;
  // A lone unlabelled route map needs no caption: the section is already
  // titled RUTA, exactly as it rendered before courseMaps existed.
  const captioned = maps.length > 1 || maps[0].distance !== null || maps[0].kind === 'elevation';

  return (
    <>
      {maps.map((m) => {
        const caption =
          m.kind === 'elevation'
            ? m.distance
              ? t('detail.elevationMapFor', { distance: m.distance })
              : t('detail.elevationMap')
            : m.distance
              ? t('detail.courseMapFor', { distance: m.distance })
              : t('detail.courseMap');
        return (
          <View key={m.url} style={styles.item}>
            {captioned && <Text style={[styles.caption, { color: captionColor }]}>{caption}</Text>}
            <Image source={{ uri: m.url }} style={styles.img} contentFit="contain" accessibilityLabel={caption} />
          </View>
        );
      })}
    </>
  );
}

const styles = StyleSheet.create({
  item: { gap: Spacing.half, marginTop: Spacing.one },
  caption: { fontSize: 12, fontWeight: '600' },
  img: { width: '100%', height: 220, borderRadius: Spacing.two },
});
