import { useRouter } from 'expo-router';
import { useMemo } from 'react';
import { FlatList, StyleSheet, Text, View, useColorScheme } from 'react-native';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { RaceCard } from '@/components/race-card';
import { Colors, Spacing } from '@/constants/theme';
import { useI18n } from '@/lib/i18n';
import { getRaces } from '@/lib/races';
import { useRacesVersion } from '@/lib/races-provider';
import { useSaved } from '@/lib/saved';

export default function MyRacesScreen() {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = Colors[scheme];
  const router = useRouter();
  const { t } = useI18n();
  const { savedIds } = useSaved();
  const racesVersion = useRacesVersion();

  const races = useMemo(
    () => getRaces().filter((r) => savedIds.has(r.id)),
    [savedIds, racesVersion],
  );

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: c.background }]} edges={['top']}>
      <Text style={[styles.title, { color: c.text }]}>{t('myraces.title')}</Text>
      <FlatList
        data={races}
        keyExtractor={(r) => r.id}
        contentContainerStyle={styles.list}
        renderItem={({ item, index }) => (
          <Animated.View
            entering={FadeInDown.duration(320).delay(Math.min(index, 8) * 45)}>
            <RaceCard
              race={item}
              onPress={() => router.push({ pathname: '/race/[id]', params: { id: item.id } })}
            />
          </Animated.View>
        )}
        ListEmptyComponent={
          <Animated.View entering={FadeIn.duration(400)} style={styles.emptyWrap}>
            <Text style={[styles.empty, { color: c.textSecondary }]}>{t('myraces.empty')}</Text>
          </Animated.View>
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  title: {
    fontSize: 28,
    fontWeight: '700',
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.two,
  },
  list: { padding: Spacing.three, gap: Spacing.two, flexGrow: 1, paddingBottom: 96 },
  emptyWrap: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingTop: Spacing.six },
  empty: { textAlign: 'center', fontSize: 15, lineHeight: 22 },
});
