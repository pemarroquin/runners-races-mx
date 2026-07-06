import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import {
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  useColorScheme,
} from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CityPicker } from '@/components/city-picker';
import { RaceCard } from '@/components/race-card';
import { Colors, Spacing } from '@/constants/theme';
import { useI18n } from '@/lib/i18n';
import { getRaces, type DistanceTag } from '@/lib/races';
import { useRacesVersion } from '@/lib/races-provider';
import { useRegion } from '@/lib/region-context';
import { raceInRegion } from '@/lib/regions';

type Filter = 'all' | DistanceTag;
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'filters.all' },
  { key: '5K', label: 'filters.5K' },
  { key: '10K', label: 'filters.10K' },
  { key: 'Half', label: 'filters.half' },
  { key: 'Full', label: 'filters.full' },
];

export default function FeedScreen() {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = Colors[scheme];
  const router = useRouter();
  const { t, locale, setLocale } = useI18n();

  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [pickerOpen, setPickerOpen] = useState(false);
  const racesVersion = useRacesVersion();
  const { region, method } = useRegion();
  const locationInUse = method === 'gps' || method === 'ip';

  const races = useMemo(() => {
    const q = query.trim().toLowerCase();
    return getRaces().filter((r) => {
      if (!raceInRegion(r, region)) return false;
      const matchesQuery =
        !q || r.name.toLowerCase().includes(q) || r.city.toLowerCase().includes(q);
      const matchesFilter = filter === 'all' || r.distanceTags.includes(filter);
      return matchesQuery && matchesFilter;
    });
  }, [query, filter, racesVersion, region]);

  // Distinguish "region has no data at all" from "filters matched nothing".
  const regionHasData = useMemo(
    () => getRaces().some((r) => raceInRegion(r, region)),
    [racesVersion, region],
  );

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: c.background }]} edges={['top']}>
      <View
        style={[
          styles.header,
          { backgroundColor: c.background, borderBottomColor: c.backgroundSelected },
        ]}>
      <View style={styles.headerRow}>
        <View>
          <Text style={[styles.title, { color: c.text }]}>{t('feed.title')}</Text>
          <Pressable
            onPress={() => setPickerOpen(true)}
            hitSlop={6}
            accessibilityLabel={
              locationInUse ? `${region.name} — ${t('city.locationOn')}` : region.name
            }>
            <Text style={[styles.subtitle, { color: c.textSecondary }]}>
              {locationInUse && <Text style={{ color: c.accent }}>◎ </Text>}
              {region.name} ▾
            </Text>
          </Pressable>
        </View>
        <View style={styles.langRow}>
          {(['es', 'en'] as const).map((l) => (
            <Pressable
              key={l}
              onPress={() => setLocale(l)}
              style={[
                styles.langBtn,
                { borderColor: c.backgroundSelected },
                locale === l && { backgroundColor: c.text, borderColor: c.text },
              ]}>
              <Text
                style={[styles.langText, { color: locale === l ? c.background : c.textSecondary }]}>
                {l.toUpperCase()}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder={t('feed.search')}
        placeholderTextColor={c.textSecondary}
        style={[styles.search, { backgroundColor: c.backgroundElement, color: c.text }]}
      />

      <View style={styles.filterRow}>
        {FILTERS.map((f) => {
          const active = filter === f.key;
          return (
            <Pressable
              key={f.key}
              onPress={() => setFilter(f.key)}
              style={[
                styles.chip,
                { backgroundColor: active ? c.text : c.backgroundElement },
              ]}>
              <Text style={[styles.chipText, { color: active ? c.background : c.text }]}>
                {t(f.label)}
              </Text>
            </Pressable>
          );
        })}
      </View>
      </View>

      <FlatList
        data={races}
        keyExtractor={(r) => r.id}
        contentContainerStyle={styles.list}
        keyboardShouldPersistTaps="handled"
        renderItem={({ item, index }) => (
          // Staggered reveal, capped at the first 8 rows so rows mounted while
          // scrolling (or while typing in search) get a quick plain fade
          // instead of an ever-growing delay queue.
          <Animated.View
            entering={FadeInDown.duration(320).delay(Math.min(index, 8) * 45)}>
            <RaceCard
              race={item}
              onPress={() => router.push({ pathname: '/race/[id]', params: { id: item.id } })}
            />
          </Animated.View>
        )}
        ListEmptyComponent={
          <Text style={[styles.empty, { color: c.textSecondary }]}>
            {regionHasData ? t('feed.empty') : t('city.emptyRegion', { city: region.name })}
          </Text>
        }
      />

      <CityPicker visible={pickerOpen} onClose={() => setPickerOpen(false)} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  // Solid, elevated header so list content never bleeds through while scrolling.
  header: {
    zIndex: 1,
    paddingBottom: Spacing.two,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.two,
  },
  title: { fontSize: 28, fontWeight: '700' },
  subtitle: { fontSize: 14, marginTop: 2 },
  langRow: { flexDirection: 'row', gap: Spacing.one },
  langBtn: { borderWidth: 1, borderRadius: 6, paddingHorizontal: Spacing.two, paddingVertical: 4 },
  langText: { fontSize: 12, fontWeight: '700' },
  search: {
    marginHorizontal: Spacing.three,
    marginTop: Spacing.three,
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    fontSize: 15,
  },
  filterRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.one,
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.two,
  },
  chip: { paddingHorizontal: Spacing.three, paddingVertical: Spacing.one, borderRadius: 20 },
  chipText: { fontSize: 13, fontWeight: '600' },
  list: { padding: Spacing.three, gap: Spacing.two, paddingBottom: 96 },
  empty: { textAlign: 'center', marginTop: Spacing.six, fontSize: 15 },
});
