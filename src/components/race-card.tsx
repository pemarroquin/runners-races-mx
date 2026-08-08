import { Pressable, StyleSheet, Text, View, useColorScheme } from 'react-native';

import { GlassRadii } from '@/constants/glass';
import { Colors, Spacing } from '@/constants/theme';
import { useCountdown, useI18n } from '@/lib/i18n';
import { daysUntil, distanceTagLabelKey, formatDate, type Race } from '@/lib/races';

export function RaceCard({ race, onPress }: { race: Race; onPress: () => void }) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = Colors[scheme];
  const { t, locale } = useI18n();
  const countdown = useCountdown();
  const days = daysUntil(race.date);
  const dateLabel = formatDate(race.date, locale);
  const displayDate = dateLabel ?? countdown(null);
  const statusText =
    race.status === 'canceled'
      ? t('common.canceled')
      : race.status === 'changed'
        ? t('common.changed')
        : countdown(days);
  const cityLabel = `${race.city}, ${race.state}`;
  const accessibilityLabel = [race.name, displayDate, cityLabel, statusText]
    .filter(Boolean)
    .join(', ');

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessible={true}
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [
        styles.card,
        { backgroundColor: c.backgroundElement },
        // High-frequency interaction: instant tactile scale, no animation lib
        // (Emil — frequent interactions get feedback, not choreography).
        pressed && styles.pressed,
      ]}>
      <View style={styles.headerRow}>
        <Text style={[styles.date, { color: c.textSecondary }]}>{displayDate}</Text>
        {race.status === 'changed' || race.status === 'canceled' ? (
          <View style={[styles.statusPill, { backgroundColor: c.accent }]}>
            <Text style={styles.statusPillText}>{statusText}</Text>
          </View>
        ) : (
          <Text
            style={[
              styles.countdown,
              { color: days !== null && days < 0 ? c.textSecondary : c.text },
            ]}>
            {statusText}
          </Text>
        )}
      </View>

      <Text style={[styles.name, { color: c.text }]} numberOfLines={2}>
        {race.name}
      </Text>
      <Text style={[styles.city, { color: c.textSecondary }]}>{cityLabel}</Text>

      <View style={styles.tagRow}>
        {race.distanceTags.map((tag) => (
          <View key={tag} style={[styles.tag, { backgroundColor: c.backgroundSelected }]}>
            <Text style={[styles.tagText, { color: c.text }]}>{t(distanceTagLabelKey(tag))}</Text>
          </View>
        ))}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: Spacing.three,
    padding: Spacing.three,
    gap: Spacing.one,
  },
  pressed: { opacity: 0.75, transform: [{ scale: 0.98 }] },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  date: { fontSize: 13, fontWeight: '500', textTransform: 'uppercase', letterSpacing: 0.5 },
  countdown: { fontSize: 13, fontWeight: '600' },
  statusPill: { paddingHorizontal: Spacing.two, paddingVertical: 2, borderRadius: GlassRadii.pill },
  statusPillText: { color: '#ffffff', fontSize: 11, fontWeight: '700' },
  name: { fontSize: 17, fontWeight: '600', marginTop: Spacing.half },
  city: { fontSize: 14 },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.one, marginTop: Spacing.one },
  tag: { paddingHorizontal: Spacing.two, paddingVertical: 3, borderRadius: GlassRadii.pill },
  tagText: { fontSize: 12, fontWeight: '600' },
});
