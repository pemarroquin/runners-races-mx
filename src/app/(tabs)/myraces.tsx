import { useRouter } from 'expo-router';
import { useMemo } from 'react';
import { SectionList, StyleSheet, Text, View, useColorScheme } from 'react-native';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { RaceCard } from '@/components/race-card';
import { BottomTabInset, Colors, Spacing } from '@/constants/theme';
import { useI18n } from '@/lib/i18n';
import { daysUntil, type Race } from '@/lib/races';
import { useRaces } from '@/lib/races-provider';
import { useSaved } from '@/lib/saved';

interface RaceSection {
  key: 'upcoming' | 'past';
  title: string;
  data: Race[];
}

export default function MyRacesScreen() {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = Colors[scheme];
  const router = useRouter();
  const { t } = useI18n();
  const { savedIds } = useSaved();
  const allRaces = useRaces();

  const races = useMemo(
    () => allRaces.filter((r) => savedIds.has(r.id)),
    [savedIds, allRaces],
  );

  // Undated races (daysUntil === null) are treated as upcoming — there's no
  // date to have passed. Only a strictly-past date moves a race to "Past".
  const sections = useMemo<RaceSection[]>(() => {
    const upcoming: Race[] = [];
    const past: Race[] = [];
    for (const r of races) {
      const days = daysUntil(r.date);
      if (days !== null && days < 0) past.push(r);
      else upcoming.push(r);
    }
    const result: RaceSection[] = [];
    if (upcoming.length > 0) {
      result.push({ key: 'upcoming', title: t('myraces.upcomingSection'), data: upcoming });
    }
    if (past.length > 0) {
      result.push({ key: 'past', title: t('myraces.pastSection'), data: past });
    }
    return result;
  }, [races, t]);

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: c.background }]} edges={['top']}>
      <Text style={[styles.title, { color: c.text }]}>{t('myraces.title')}</Text>
      <SectionList
        sections={sections}
        keyExtractor={(r) => r.id}
        contentContainerStyle={styles.list}
        stickySectionHeadersEnabled={false}
        renderSectionHeader={({ section }) => (
          <Text style={[styles.sectionTitle, { color: c.textSecondary }]}>{section.title}</Text>
        )}
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
  list: { padding: Spacing.three, gap: Spacing.two, flexGrow: 1, paddingBottom: BottomTabInset },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: Spacing.two,
  },
  emptyWrap: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingTop: Spacing.six },
  empty: { textAlign: 'center', fontSize: 15, lineHeight: 22 },
});
