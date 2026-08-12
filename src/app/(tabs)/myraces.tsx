import { useRouter } from 'expo-router';
import { useCallback, useMemo } from 'react';
import { Pressable, SectionList, StyleSheet, Text, View, useColorScheme } from 'react-native';
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
  const { savedIds, dropMissing, storageError } = useSaved();
  const allRaces = useRaces();

  const races = useMemo(
    () => allRaces.filter((r) => savedIds.has(r.id)),
    [savedIds, allRaces],
  );

  // Saved ids the catalog no longer contains. Counted rather than inferred
  // from `races.length` alone so the message stays right if a race is ever
  // saved twice under different ids.
  const missingCount = useMemo(() => {
    const present = new Set(races.map((r) => r.id));
    return Array.from(savedIds).filter((id) => !present.has(id)).length;
  }, [savedIds, races]);

  const clearMissing = useCallback(
    () => dropMissing(new Set(allRaces.map((r) => r.id))),
    [dropMissing, allRaces],
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
    // Upcoming reads soonest-first (inherited from the source sort, which is
    // ascending by date). Past has to be reversed: the same ascending order
    // buries the race you just ran at the bottom under everything older.
    past.reverse();
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
        ListHeaderComponent={
          // Both of these were tracked in state and rendered nowhere: a
          // browser that blocks storage made every save silently fail, and a
          // race dropped from the catalog just disappeared from this list.
          storageError !== null || missingCount > 0 ? (
            <View style={styles.notices}>
              {storageError !== null && (
                <View style={[styles.notice, { backgroundColor: c.backgroundElement }]}>
                  <Text style={[styles.noticeText, { color: c.textSecondary }]}>
                    {t('myraces.storageBlocked')}
                  </Text>
                </View>
              )}
              {missingCount > 0 && (
                <View style={[styles.notice, { backgroundColor: c.backgroundElement }]}>
                  <Text style={[styles.noticeText, { color: c.textSecondary }]}>
                    {t('myraces.missing', { count: missingCount })}
                  </Text>
                  <Pressable onPress={clearMissing} accessibilityRole="button" hitSlop={10}>
                    <Text style={[styles.noticeAction, { color: c.accent }]}>
                      {t('myraces.clearMissing')}
                    </Text>
                  </Pressable>
                </View>
              )}
            </View>
          ) : null
        }
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
  notices: { gap: Spacing.two, marginBottom: Spacing.two },
  notice: { borderRadius: Spacing.two, padding: Spacing.three, gap: Spacing.one },
  noticeText: { fontSize: 13, lineHeight: 19 },
  noticeAction: { fontSize: 13, fontWeight: '700' },
});
